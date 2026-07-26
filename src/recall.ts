/**
 * Recall / search pipeline
 *
 * Purpose: Semantic + keyword hybrid search over the shared-living-memory entry store.
 *          Embeds the query, runs Vectorize cosine search and D1 keyword LIKE
 *          search in parallel, fuses via Reciprocal Rank Fusion, reranks with
 *          time-decay / importance / tag-boost scoring, deduplicates, optionally
 *          expands via the relationship graph, hydrates from D1, and synthesizes
 *          an insight summary.
 *
 * Input:   query string, topK, optional tag/after/before/kind/hops/userId filters.
 *          Env bindings (DB, VECTORIZE, AI) and ExecutionContext for waitUntil.
 *
 * Output:  RecallSearchResult — { matches: RecallMatch[], insight: string,
 *          semanticUnavailable: boolean }.
 *
 * Logic:   parseTimePhrase → embed + inferQueryTags → Vectorize query (or tag-path
 *          vector fetch) ‖ keywordSearch → fuseDenseAndKeyword (RRF) →
 *          rerankWithTimeDecay → dedupe → expandGraph → D1 hydration →
 *          cross-user mention flagging → synthesizeInsight → derivePattern.
 */

import type { Env } from "./types";
import { MemoryKind, KIND_VALUES } from "./types";
import {
  getHalfLifeMs,
  cosineSim,
  embed,
  escapeLikePattern,
  tokenizeQuery,
  readStreamText,
  getRetentionScore,
} from "./helpers";
import {
  GRAPH_MAX_HOPS,
  GRAPH_HOP_DECAY,
  VECTORIZE_TOP_K_MULTIPLIER,
  VECTORIZE_GET_BY_IDS_BATCH,
  D1_MAX_BOUND_PARAMS,
  DUPLICATE_FLAG_THRESHOLD,
  RRF_K,
  KEYWORD_CANDIDATE_LIMIT,
  TAG_BOOST_MAX,
  TAG_BOOST_STEP,
  CONTRADICTION_IMPORTANCE_STEP,
  VECTORIZE_FIX_HINT,
  LLM_MODEL,
  INSIGHT_MAX_TOKENS,
  CHUNK_OVERLAP_CHARS,
  STALENESS_RECALL_PENALTY,
} from "./config";
import { buildVisibilityClause } from "./tags";
import { expandGraph } from "./graph";
import { inferQueryTags, extractHashtags } from "./classification";
import { synthesizeInsight } from "./lifecycle";
import { queryVisibleVectors, vectorMatchParentId } from "./vector-access";

// ─── Time-decay reranking ─────────────────────────────────────────────────────

export interface VectorizeMatch {
  id: string;
  score: number;
  metadata?: Record<string, unknown>;
}

export function rerankWithTimeDecay(
  matches: VectorizeMatch[],
  recallCounts: Map<string, number> = new Map(),
  importanceScores: Map<string, number> = new Map(),
  queryTags: string[] = [],
  contradictionWins: Map<string, number> = new Map(),
  contradictionLosses: Map<string, number> = new Map(),
  retentionScores: Map<string, number> = new Map()
): VectorizeMatch[] {
  const now = Date.now();

  return matches
    .map(match => {
      const meta = match.metadata as any;
      const createdAt = meta?.created_at ?? now;
      const tags: string[] = Array.isArray(meta?.tags) ? meta.tags : [];
      const ageMs = now - createdAt;
      const parentId = (meta?.parentId ?? match.id) as string;
      const rc = recallCounts.get(parentId) ?? 0;

      const halfLifeMs = getHalfLifeMs(tags);
      const recencyMultiplier = Math.exp(-ageMs / halfLifeMs);
      // Frequency can compensate for recency loss but never push above a fresh entry (cap at 1.0).
      // Without the cap, high recall counts overwhelm recency and bury newly-stored memories.
      const frequencyMultiplier = 1 + Math.log1p(rc);
      const combinedMultiplier = Math.min(1.0, recencyMultiplier * frequencyMultiplier);
      const isShortAppend = match.id.includes("-update-") &&
        typeof meta?.content === "string" && meta.content.length < CHUNK_OVERLAP_CHARS;
      const appendPenalty = isShortAppend ? 0.2 : 1.0;
      const rolledUpPenalty = tags.includes("rolled-up") ? 0.4 : 1.0;

      // Retention score: spaced repetition decay from last recall time
      const retentionScore = retentionScores.get(parentId) ?? 1.0;

      // Effective importance = classifier score adjusted by net contradiction history.
      const imp = importanceScores.get(parentId) ?? 0;
      const wins = contradictionWins.get(parentId) ?? 0;
      const losses = contradictionLosses.get(parentId) ?? 0;
      const net = wins - losses;
      let importanceMultiplier: number;
      if (imp === 0 && net === 0) {
        importanceMultiplier = 1.0;
      } else {
        const base = imp === 0 ? 3 : imp;
        const adj = Math.sign(net) * Math.log1p(Math.abs(net)) * CONTRADICTION_IMPORTANCE_STEP;
        const effectiveImp = Math.max(1, Math.min(5, base + adj));
        importanceMultiplier = 0.8 + (effectiveImp / 5) * 0.4;
      }

      // Tag boost: applied outside the recency ≤1.0 cap so a tag-relevant memory can
      // surface above a marginally-closer but irrelevant one.
      const overlap = queryTags.length ? tags.filter(t => queryTags.includes(t)).length : 0;
      const tagBoost = overlap ? Math.min(TAG_BOOST_MAX, 1 + overlap * TAG_BOOST_STEP) : 1.0;

      return { ...match, score: match.score * combinedMultiplier * appendPenalty * rolledUpPenalty * importanceMultiplier * tagBoost * retentionScore };
    })
    .sort((a, b) => b.score - a.score);
}

// ─── Temporal phrase parsing ──────────────────────────────────────────────────
export function parseTimePhrase(query: string, now: number): { after?: number; before?: number; cleanQuery: string } {
  const MS_DAY = 86400000;
  const MS_WEEK = 7 * MS_DAY;
  const d = new Date(now);
  const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const startOfWeek = (date: Date) => {
    const dow = date.getDay();
    const diff = dow === 0 ? -6 : 1 - dow;
    return startOfDay(new Date(date.getFullYear(), date.getMonth(), date.getDate() + diff));
  };

  type TimeResult = { after?: number; before?: number };
  const patterns: Array<[RegExp, (m: RegExpMatchArray) => TimeResult]> = [
    [/\blast\s+(\d+)\s+days?\b/i, m => ({ after: now - parseInt(m[1]) * MS_DAY })],
    [/\blast\s+(\d+)\s+weeks?\b/i, m => ({ after: now - parseInt(m[1]) * MS_WEEK })],
    [/\blast\s+week\b/i, () => ({ after: now - MS_WEEK })],
    [/\bthis\s+week\b/i, () => ({ after: startOfWeek(d) })],
    [/\blast\s+month\b/i, () => ({
      after: new Date(d.getFullYear(), d.getMonth() - 1, 1).getTime(),
      before: new Date(d.getFullYear(), d.getMonth(), 1).getTime(),
    })],
    [/\bthis\s+month\b/i, () => ({ after: new Date(d.getFullYear(), d.getMonth(), 1).getTime() })],
    [/\byesterday\b/i, () => {
      const s = startOfDay(d) - MS_DAY;
      return { after: s, before: s + MS_DAY };
    }],
    [/\btoday\b/i, () => ({ after: startOfDay(d) })],
    [/\baround\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})\b/i, m => {
      const MONTHS: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
      const month = MONTHS[m[1].toLowerCase().slice(0, 3)];
      const center = new Date(d.getFullYear(), month, parseInt(m[2])).getTime();
      return { after: center - 3 * MS_DAY, before: center + 3 * MS_DAY };
    }],
  ];

  for (const [pattern, handler] of patterns) {
    const match = query.match(pattern);
    if (match) {
      const { after, before } = handler(match);
      const cleanQuery = query.replace(pattern, '').replace(/\s+/g, ' ').trim() || query;
      return { after, before, cleanQuery };
    }
  }

  return { cleanQuery: query };
}

// ─── Shared search path ───────────────────────────────────────────────────────
// Used by both the `recall` MCP tool and GET /recall — the full semantic
// search pipeline (embed → vector query → time-decay rerank → dedupe → D1
// hydration → insight synthesis) lives here once; callers format the result.

export interface RecallMatch {
  id: string;
  content: string;
  score: number;
  createdAt: number;
  tags: string[];
  source: string;
  isUpdate: boolean;
  hop: number; // 0 = direct match; ≥1 = surfaced via graph expansion (issue #16)
  crossUserMention?: { entryId: string; ownerUsername: string; similarity: number };
  passages?: {
    id: string;
    content: string;
    section: string | null;
    documentId?: string | null;
    sectionId?: string | null;
    sourceUrl?: string | null;
    documentTitle?: string | null;
    page?: number | null;
    pageEnd?: number | null;
    startOffset: number | null;
    endOffset: number | null;
  }[];
  relations?: { type: string; confidence: number; targetId: string; targetContent?: string }[];
  epistemicStatus?: string;
  ownerUserId?: string;
  visibility?: "private" | "public";
}

export interface RecallSearchResult {
  matches: RecallMatch[];
  insight: string;
  // True when the dense (Vectorize) step could not run — recall fell back to
  // keyword-only. Lets callers tell the user semantic search is unavailable.
  semanticUnavailable: boolean;
  // Cross-user contradiction proposals detected during recall
  proposed_edges: { source_id: string; target_id: string; type: string; reason: string }[];
}

// Render recall matches as the MCP tool's text reply. Crucially includes each entry's
// ID so an LLM can act on a result (link, connections, append, update, forget) without
// a second list_recent round-trip — recall used to drop the ID, which left tools unable
// to reference the memories they just found.
export function renderRecallText(matches: RecallMatch[], insight: string): string {
  const text = matches.map((m, i) => {
    const date = new Date(m.createdAt).toLocaleDateString();
    const tagList = m.tags.length ? ` [${m.tags.join(", ")}]` : "";
    const src = m.source ? ` · ${m.source}` : "";
    const score = (m.score * 100).toFixed(0);
    const updateLabel = m.isUpdate ? " [updated]" : "";
    const hopLabel = m.hop > 0 ? ` [related · ${m.hop} hop${m.hop > 1 ? "s" : ""}]` : "";
    const crossUserLabel = m.crossUserMention ? ` · also by ${m.crossUserMention.ownerUsername}` : "";
    const epistemicLabel = m.epistemicStatus && m.epistemicStatus !== "canonical" ? ` [${m.epistemicStatus}]` : "";
    const passageLabel = m.passages?.length
      ? `\nEVIDENCE:\n${m.passages.map(p => {
          const citation = [
            p.documentTitle ? `title="${p.documentTitle}"` : null,
            p.sourceUrl ? `url=${p.sourceUrl}` : null,
            p.page != null ? `page=${p.page}` : null,
            p.pageEnd != null ? `pageEnd=${p.pageEnd}` : null,
            p.section ? `section="${p.section}"` : null,
            p.startOffset != null ? `startOffset=${p.startOffset}` : null,
            p.endOffset != null ? `endOffset=${p.endOffset}` : null,
          ].filter((value): value is string => value !== null);
          const excerpt = p.content.length > 160 ? `${p.content.slice(0, 157)}...` : p.content;
          return `- ${citation.length ? `[${citation.join("; ")}] ` : ""}"${excerpt}"`;
        }).join("\n")}`
      : "";
    const relationLabel = m.relations?.length ? `\nLINKS: ${m.relations.slice(0, 3).map(r => `${r.type}(${(r.confidence * 100).toFixed(0)}%)→${r.targetId.slice(0, 8)}`).join(", ")}` : "";
    return `${i + 1}. [${date}${src}${tagList}] (${score}% match)${updateLabel}${hopLabel}${crossUserLabel}${epistemicLabel}\nID: ${m.id}\n${m.content}${passageLabel}${relationLabel}`;
  }).join("\n\n");
  return insight ? `**Insight:** ${insight}\n\n---\n\n${text}` : text;
}

// ─── Hybrid recall: keyword search + Reciprocal Rank Fusion ────────────────────

interface KeywordRow {
  id: string;
  content: string;
  tags: string;
  source: string;
  created_at: number;
  owner_user_id: string;
  visibility: "private" | "public";
  current_visibility?: "private" | "public";
  historical_state?: number;
  episode_id?: string | null;
  vector_ids?: string;
}

interface EntryStateRow {
  id: string;
  content: string;
  tags: string;
  source: string;
  created_at: number;
  owner_user_id: string;
  current_episode_id: string | null;
  valid_from: number | null;
  valid_to: number | null;
  recorded_at: number | null;
  epistemic_status: string;
  revision: number;
  visibility: "private" | "public";
}

function parseStringArray(raw: unknown): string[] | null {
  if (typeof raw !== "string") return null;
  try {
    const values = JSON.parse(raw);
    return Array.isArray(values) && values.every(value => typeof value === "string") ? values : null;
  } catch {
    return null;
  }
}

function isVisibleEntryRow(
  row: { visibility: unknown; owner_user_id: string },
  userId?: string,
): boolean {
  if (typeof row.owner_user_id !== "string" || !row.owner_user_id) return false;
  if (row.visibility !== "private" && row.visibility !== "public") return false;
  return (!!userId && row.owner_user_id === userId) || row.visibility === "public";
}

function isVisibleKeywordRow(row: KeywordRow, userId?: string): boolean {
  if (typeof row.owner_user_id !== "string" || !row.owner_user_id) return false;
  if (userId && row.owner_user_id === userId) return true;
  const currentVisibility = row.current_visibility ?? row.visibility;
  return currentVisibility === "public" && row.visibility === "public";
}

function vectorEpisodeId(match: VectorizeMatch): string | null {
  const metadata = match.metadata as Record<string, unknown> | undefined;
  const value = metadata?.episode_id ?? metadata?.episodeId;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function vectorMatchesState(match: VectorizeMatch, state: EntryStateRow): boolean {
  // Legacy entries and legacy vectors did not carry version lineage. Preserve
  // them, but once both sides identify an episode the vector must be for the
  // selected state. This drops stale version-scoped entry and passage vectors.
  const vectorEpisode = vectorEpisodeId(match);
  return !state.current_episode_id || !vectorEpisode || vectorEpisode === state.current_episode_id;
}

// Keyword candidates: entries whose content contains any query token, bounded by
// KEYWORD_CANDIDATE_LIMIT. Relevance ranking happens in fuseDenseAndKeyword.
async function keywordSearch(
  tokens: string[],
  env: Env,
  userId?: string,
  knownAt?: number,
  asOf?: number,
): Promise<KeywordRow[]> {
  if (!tokens.length) return [];
  if (knownAt !== undefined || asOf !== undefined) {
    // Build the bitemporal projection before applying the keyword predicate.
    // knownAt bounds transaction time; asOf selects versions whose world-valid
    // interval contains the requested instant. Among eligible versions, the
    // most recently recorded state is the team's best knowledge projection.
    const where = tokens.map(() => "content LIKE ?").join(" OR ");
    const visibilitySql = userId
      ? `(owner_user_id = ? OR (current_visibility = 'public' AND visibility = 'public'))`
      : `(current_visibility = 'public' AND visibility = 'public')`;
    const temporalPredicates: string[] = [];
    const bindings: (string | number)[] = [];
    if (knownAt !== undefined) {
      temporalPredicates.push(`COALESCE(recorded_at, version_created_at) <= ?`);
      bindings.push(knownAt);
    }
    if (asOf !== undefined) {
      temporalPredicates.push(`(valid_from IS NULL OR valid_from <= ?)`);
      temporalPredicates.push(`(valid_to IS NULL OR valid_to > ?)`);
      bindings.push(asOf, asOf);
    }
    bindings.push(...tokens.map(token => `%${token}%`));
    if (userId) bindings.push(userId);
    bindings.push(KEYWORD_CANDIDATE_LIMIT);

    const { results } = await env.DB.prepare(
      `WITH version_candidates AS (
         SELECT e.id, e.content, e.tags, e.source, e.created_at,
                e.owner_user_id, e.visibility,
                e.visibility AS current_visibility, 0 AS historical_state,
                e.current_episode_id AS episode_id, e.vector_ids,
                e.recorded_at, e.created_at AS version_created_at,
                e.valid_from, e.valid_to, e.revision, e.id AS version_id
         FROM entries e
         UNION ALL
         SELECT e.id, s.content, s.tags, s.source, e.created_at,
                e.owner_user_id,
                CASE WHEN s.visibility = 'public' THEN 'public' ELSE 'private' END AS visibility,
                e.visibility AS current_visibility, 1 AS historical_state,
                s.episode_id, '[]' AS vector_ids,
                s.recorded_at, s.created_at AS version_created_at,
                s.valid_from, s.valid_to, COALESCE(s.revision, 0), s.id AS version_id
         FROM entry_snapshots s
         JOIN entries e ON e.id = s.entry_id
       ),
       ranked_versions AS (
         SELECT *,
                ROW_NUMBER() OVER (
                  PARTITION BY id
                  ORDER BY COALESCE(recorded_at, version_created_at) DESC,
                           revision DESC, historical_state ASC, version_id DESC
                ) AS version_rank
         FROM version_candidates
         WHERE ${temporalPredicates.join(" AND ")}
       )
       SELECT id, content, tags, source, created_at, owner_user_id,
              visibility, current_visibility, historical_state, episode_id, vector_ids
       FROM ranked_versions
       WHERE version_rank = 1 AND (${where}) AND ${visibilitySql}
       ORDER BY created_at DESC
       LIMIT ?`
    ).bind(...bindings).all();
    return (results as unknown as KeywordRow[]).filter(row => isVisibleKeywordRow(row, userId));
  }

  const where = tokens.map(() => "content LIKE ?").join(" OR ");
  const visClause = userId ? buildVisibilityClause(userId) : { sql: "visibility = 'public'", bind: [] as unknown[] };
  const fullWhere = `(${where}) AND ${visClause.sql}`;
  const bindValues = visClause
    ? [...tokens.map(t => `%${t}%`), ...visClause.bind]
    : tokens.map(t => `%${t}%`);
  const { results } = await env.DB.prepare(
    `SELECT id, content, tags, source, created_at, owner_user_id, visibility FROM entries WHERE ${fullWhere} ORDER BY created_at DESC LIMIT ?`
  ).bind(...bindValues, KEYWORD_CANDIDATE_LIMIT).all();
  return (results as unknown as KeywordRow[]).filter(row => isVisibleKeywordRow(row, userId));
}

async function loadEntryStates(
  entryIds: string[],
  env: Env,
  userId?: string,
  knownAt?: number,
  asOf?: number,
): Promise<Map<string, EntryStateRow>> {
  const ids = [...new Set(entryIds.filter(id => typeof id === "string" && id.length > 0))];
  const currentRows: Record<string, any>[] = [];
  for (let i = 0; i < ids.length; i += D1_MAX_BOUND_PARAMS) {
    const batch = ids.slice(i, i + D1_MAX_BOUND_PARAMS);
    const placeholders = batch.map(() => "?").join(", ");
    const { results } = await env.DB.prepare(
      `SELECT id, content, tags, source, created_at, owner_user_id,
              current_episode_id, valid_from, valid_to, recorded_at,
              epistemic_status, revision, visibility
       FROM entries
       WHERE id IN (${placeholders})`
    ).bind(...batch).all() as { results: Record<string, any>[] };
    // Some lightweight D1-compatible adapters project only their legacy
    // recall columns even when newer columns are requested. Re-read only those
    // incomplete rows; real D1 returns every named column in the query above.
    for (const row of results) {
      if (Object.prototype.hasOwnProperty.call(row, "current_episode_id") &&
          Object.prototype.hasOwnProperty.call(row, "valid_from")) continue;
      const complete = await env.DB.prepare(
        `SELECT * FROM entries WHERE id = ?`
      ).bind(row.id).first<Record<string, any>>();
      if (complete) Object.assign(row, complete);
    }
    currentRows.push(...results);
  }

  const currentById = new Map(currentRows.map(row => [row.id as string, row]));
  const snapshotsByEntry = new Map<string, Record<string, any>[]>();
  if (knownAt !== undefined || asOf !== undefined) {
    const snapshotCandidateIds = currentRows.map(row => row.id as string);
    const knowledgeCutoff = knownAt ?? Number.MAX_SAFE_INTEGER;
    const batchSize = Math.max(1, D1_MAX_BOUND_PARAMS - 1);
    for (let i = 0; i < snapshotCandidateIds.length; i += batchSize) {
      const batch = snapshotCandidateIds.slice(i, i + batchSize);
      const placeholders = batch.map(() => "?").join(", ");
      const { results } = await env.DB.prepare(
        `SELECT id, entry_id, content, tags, source, created_at, episode_id,
                recorded_at, valid_from, valid_to, epistemic_status, revision,
                visibility
         FROM entry_snapshots
         WHERE entry_id IN (${placeholders})
           AND recorded_at IS NOT NULL
           AND recorded_at <= ?
         ORDER BY recorded_at DESC, created_at DESC, id DESC`
      ).bind(...batch, knowledgeCutoff).all() as { results: Record<string, any>[] };
      for (const row of results) {
        const entryId = row.entry_id as string;
        if (typeof entryId !== "string") continue;
        const snapshots = snapshotsByEntry.get(entryId) ?? [];
        snapshots.push(row);
        snapshotsByEntry.set(entryId, snapshots);
      }
    }
  }

  const states = new Map<string, EntryStateRow>();
  for (const id of ids) {
    const current = currentById.get(id);
    if (!current || typeof current.owner_user_id !== "string" || !current.owner_user_id) continue;
    if (current.visibility !== "private" && current.visibility !== "public") continue;
    const isOwner = !!userId && current.owner_user_id === userId;
    // Current D1 visibility is the revocation boundary: privatizing a memory
    // must immediately suppress every historical public projection.
    if (!isOwner && current.visibility !== "public") continue;

    const versionRecordedAt = (version: Record<string, any>): number =>
      Number(version.recorded_at ?? version.created_at);
    const validAt = (version: Record<string, any>): boolean => {
      if (asOf === undefined) return true;
      const validFrom = version.valid_from == null ? null : Number(version.valid_from);
      const validTo = version.valid_to == null ? null : Number(version.valid_to);
      return (validFrom === null || validFrom <= asOf) && (validTo === null || validTo > asOf);
    };
    const candidates = [current, ...(snapshotsByEntry.get(id) ?? [])]
      .filter(version => knownAt === undefined || versionRecordedAt(version) <= knownAt)
      .filter(validAt)
      .sort((left, right) =>
        versionRecordedAt(right) - versionRecordedAt(left) ||
        Number(right.revision ?? 0) - Number(left.revision ?? 0) ||
        (right === current ? 1 : 0) - (left === current ? 1 : 0) ||
        String(right.id ?? "").localeCompare(String(left.id ?? ""))
      );
    const selected = candidates[0];
    const useCurrent = selected === current;
    if (!selected || typeof selected.content !== "string" || !parseStringArray(selected.tags)) continue;
    const selectedVisibility = useCurrent ? current.visibility : selected.visibility;
    // A later publication cannot authorize a projection selected from before
    // that publication's transaction time.
    if (selectedVisibility !== "private" && selectedVisibility !== "public") continue;
    if (!isOwner && selectedVisibility !== "public") continue;

    states.set(id, {
      id,
      content: selected.content,
      tags: selected.tags,
      source: typeof selected.source === "string" ? selected.source : "api",
      // created_at is the identity's creation time. recorded_at below identifies
      // when this particular state entered the system.
      created_at: Number(current.created_at),
      owner_user_id: current.owner_user_id,
      current_episode_id: (useCurrent ? current.current_episode_id : selected.episode_id) ?? null,
      valid_from: selected.valid_from == null ? null : Number(selected.valid_from),
      valid_to: selected.valid_to == null ? null : Number(selected.valid_to),
      recorded_at: selected.recorded_at == null ? null : Number(selected.recorded_at),
      epistemic_status: typeof selected.epistemic_status === "string" ? selected.epistemic_status : "canonical",
      revision: Number.isFinite(Number(selected.revision)) ? Number(selected.revision) : 0,
      visibility: selectedVisibility,
    });
  }
  return states;
}

// Reciprocal Rank Fusion. Dense candidates contribute 1/(k+rank); keyword candidates
// contribute weight/(k+rank), where weight = number of distinct query tokens the entry
// matched — so an exact multi-token/identifier hit outweighs entries that merely share a
// common word, and an entry present in BOTH lists accumulates from both.
export function rrfFuse(
  denseRanked: string[],
  keywordRanked: { id: string; weight: number }[],
  k = RRF_K
): Map<string, number> {
  const scores = new Map<string, number>();
  denseRanked.forEach((id, i) => scores.set(id, (scores.get(id) ?? 0) + 1 / (k + i)));
  keywordRanked.forEach((e, i) => scores.set(e.id, (scores.get(e.id) ?? 0) + e.weight / (k + i)));
  return scores;
}

// Fuse a dense match list (Vectorize chunks, or tag-path cosine scores) with keyword rows
// into one per-parent candidate list scored by RRF, ready for rerankWithTimeDecay. With
// allowKeywordOnly=false (tag path) keyword is a re-ranking signal only — it never
// introduces an entry the dense pass didn't already surface.
function fuseDenseAndKeyword(
  denseMatches: VectorizeMatch[],
  keywordRows: KeywordRow[],
  tokens: string[],
  allowKeywordOnly: boolean
): VectorizeMatch[] {
  const denseByParent = new Map<string, VectorizeMatch>();
  for (const m of [...denseMatches].sort((a, b) => b.score - a.score)) {
    const pid = ((m.metadata as any)?.parentId ?? m.id) as string;
    if (!denseByParent.has(pid)) denseByParent.set(pid, m);
  }
  const denseRanked = [...denseByParent.keys()];

  const keywordRanked = keywordRows
    .map(r => ({ row: r, weight: tokens.reduce((n, t) => n + (r.content.toLowerCase().includes(t) ? 1 : 0), 0) }))
    .filter(x => x.weight > 0 && (allowKeywordOnly || denseByParent.has(x.row.id)))
    .sort((a, b) => b.weight - a.weight || b.row.created_at - a.row.created_at || (a.row.id < b.row.id ? -1 : 1));

  const fused = rrfFuse(denseRanked, keywordRanked.map(x => ({ id: x.row.id, weight: x.weight })));
  const keywordRowById = new Map(keywordRows.map(r => [r.id, r]));

  const out: VectorizeMatch[] = [];
  for (const [pid, score] of fused) {
    const dm = denseByParent.get(pid);
    if (dm) {
      out.push({ id: dm.id, score, metadata: dm.metadata });
    } else {
      const r = keywordRowById.get(pid)!;
      out.push({ id: pid, score, metadata: { parentId: pid, created_at: r.created_at, tags: JSON.parse(r.tags ?? "[]"), content: r.content, source: r.source } });
    }
  }
  return out;
}

export async function recallEntries(
  params: { query: string; topK: number; tag?: string; after?: number; before?: number; kind?: MemoryKind; hops?: number; userId?: string; asOf?: number; knownAt?: number },
  env: Env,
  ctx: ExecutionContext
): Promise<RecallSearchResult> {
  const { query, topK } = params;
  let { tag, after, before, kind } = params;
  const asOf = params.asOf;
  const knownAt = params.knownAt;
  const hops = Math.max(0, Math.min(GRAPH_MAX_HOPS, params.hops ?? 0));
  const userId = params.userId;
  const now = Date.now();
  let semanticUnavailable = false;

  let embedQuery = query;
  if (after === undefined && before === undefined) {
    const parsed = parseTimePhrase(query, now);
    after = parsed.after;
    before = parsed.before;
    embedQuery = parsed.cleanQuery;
  }

  const tokens = tokenizeQuery(embedQuery);
  const [values, queryTags] = await Promise.all([
    embed(embedQuery, env),
    inferQueryTags(embedQuery, env),
  ]);

  let keywordRows: KeywordRow[] = [];
  let results: { matches: VectorizeMatch[] };
  if (tag && knownAt === undefined && asOf === undefined) {
    // Tag path: score the tag's own vectors directly. An unconstrained Vectorize
    // query caps at 50 candidates, silently dropping tagged entries whose global
    // semantic rank falls outside the top 50 (issue #141). D1 is the source of
    // truth for tags and already stores each entry's vector_ids.
    const { results: tagRows } = await env.DB.prepare(
      `SELECT id, vector_ids, content, tags, source, created_at, owner_user_id, visibility FROM entries WHERE tags LIKE ?`
    ).bind(`%"${escapeLikePattern(tag)}"%`).all();
    if (!tagRows.length) return { matches: [], insight: "", semanticUnavailable, proposed_edges: [] };

    // D1 is authoritative for visibility. Invalid ownership/visibility fails closed.
    const visibleTagRows = (tagRows as unknown as (KeywordRow & { vector_ids: string })[])
      .filter(row => isVisibleEntryRow(row, userId));
    if (!visibleTagRows.length) return { matches: [], insight: "", semanticUnavailable, proposed_edges: [] };

    keywordRows = visibleTagRows as unknown as KeywordRow[];

    const vectorIds = [...new Set(
      visibleTagRows.flatMap(row => parseStringArray(row.vector_ids) ?? [])
    )];
    if (!vectorIds.length) return { matches: [], insight: "", semanticUnavailable, proposed_edges: [] };

    const vectors: VectorizeVector[] = [];
    try {
      for (let i = 0; i < vectorIds.length; i += VECTORIZE_GET_BY_IDS_BATCH) {
        vectors.push(...await env.VECTORIZE.getByIds(vectorIds.slice(i, i + VECTORIZE_GET_BY_IDS_BATCH)));
      }
    } catch (e) {
      console.error("Vectorize getByIds failed (degrading to keyword-only):", e);
      semanticUnavailable = true;
    }

    results = {
      matches: vectors.map(v => ({
        id: v.id,
        score: cosineSim(values, v.values as number[]),
        metadata: v.metadata,
      })) as VectorizeMatch[],
    };
  } else {
    // Cloudflare Vectorize caps topK at 50 when returnMetadata="all" (error 40025).
    // Run the keyword search in parallel with the dense query.
    const vectorizeTopK = Math.min(topK * VECTORIZE_TOP_K_MULTIPLIER, 50);
    const denseQuery = async (): Promise<{ matches: VectorizeMatch[] }> => {
      try {
        const scoped = await queryVisibleVectors(values, env, { topK: vectorizeTopK, userId });
        return { matches: scoped.matches };
      } catch (e) {
        // This is the authoritative signal that the Vectorize index is unreachable —
        // semanticUnavailable drives the dashboard banner (checkVectorizeHealth/GET /health
        // is the full health probe; this catch fires only when the query itself throws).
        console.error("Vectorize query failed (degrading to keyword-only):", e);
        semanticUnavailable = true;
        return { matches: [] as VectorizeMatch[] };
      }
    };
    const [denseResults, kwRows] = await Promise.all([
      denseQuery(),
      keywordSearch(tokens, env, userId, knownAt, asOf),
    ]);
    results = denseResults;
    keywordRows = kwRows;

    if (!semanticUnavailable && results.matches.length && results.matches[0].score < DUPLICATE_FLAG_THRESHOLD) {
      try {
        const scoped = await queryVisibleVectors(values, env, { topK: 50, userId });
        results = { matches: scoped.matches };
      } catch (e) {
        // Narrow query already succeeded with real matches, so the index works.
        // A transient widen failure must not claim semantic search is unavailable.
        console.error("Vectorize widen-query failed (non-fatal, keeping narrow results):", e);
      }
    }
  }

  // Resolve the authoritative state *before* collapsing vector chunks by parent.
  // Otherwise a higher-scoring stale vector can displace the current vector and
  // cause the whole parent entry to disappear after version filtering.
  const rawCandidateParentIds = [...new Set([
    ...results.matches.map(match => ((match.metadata as any)?.parentId ?? match.id) as string),
    ...keywordRows.map(row => row.id),
  ])];
  const stateByEntry = await loadEntryStates(rawCandidateParentIds, env, userId, knownAt, asOf);
  const versionAuthorizedDense = results.matches.filter(match => {
    const parentId = ((match.metadata as any)?.parentId ?? match.id) as string;
    const state = stateByEntry.get(parentId);
    return !!state && vectorMatchesState(match, state);
  });
  const authorizedKeywordRows = keywordRows.filter(row => stateByEntry.has(row.id));

  // Always-on hybrid retrieval: fuse dense + keyword candidates via RRF. On the tag path
  // keyword is a re-ranking signal only (allowKeywordOnly=false); on the default path it can
  // also surface exact-identifier matches the dense top-K missed entirely.
  const fusedMatches = fuseDenseAndKeyword(versionAuthorizedDense, authorizedKeywordRows, tokens, !tag || semanticUnavailable);
  if (!fusedMatches.length) return { matches: [], insight: "", semanticUnavailable, proposed_edges: [] };

  // State loading re-authorized every parent against D1 and selected the current
  // or historical projection. Missing/malformed rows fail closed.
  const visibleFusedMatches = fusedMatches.filter(match => {
    const parentId = ((match.metadata as any)?.parentId ?? match.id) as string;
    return stateByEntry.has(parentId) && vectorMatchesState(match, stateByEntry.get(parentId)!);
  });
  if (!visibleFusedMatches.length) return { matches: [], insight: "", semanticUnavailable, proposed_edges: [] };

  // Fetch recall_count, importance_score, and last_recalled_at for all candidates.
  // The tag path can produce far more than 100 candidates, so chunk the IN query
  // to stay under D1's bound-parameter limit.
  const candidateIds = [...new Set(visibleFusedMatches.map(m => (m.metadata as any)?.parentId ?? m.id))] as string[];
  const rcRows: { id: string; recall_count: number; importance_score: number; contradiction_wins: number; contradiction_losses: number; last_recalled_at: number | null; created_at: number; epistemic_status: string }[] = [];
  for (let i = 0; i < candidateIds.length; i += D1_MAX_BOUND_PARAMS) {
    const batch = candidateIds.slice(i, i + D1_MAX_BOUND_PARAMS);
    const rcPlaceholders = batch.map(() => "?").join(", ");
    const { results: rows } = await env.DB.prepare(
      `SELECT id, recall_count, importance_score, contradiction_wins, contradiction_losses, last_recalled_at, created_at, epistemic_status FROM entries WHERE id IN (${rcPlaceholders})`
    ).bind(...batch).all() as { results: { id: string; recall_count: number; importance_score: number; contradiction_wins: number; contradiction_losses: number; last_recalled_at: number | null; created_at: number; epistemic_status: string }[] };
    rcRows.push(...rows);
  }
  const recallCounts = new Map(rcRows.map(r => [r.id, r.recall_count ?? 0]));
  const importanceScores = new Map(rcRows.map(r => [r.id, r.importance_score ?? 0]));
  const contradictionWins = new Map(rcRows.map(r => [r.id, r.contradiction_wins ?? 0]));
  const contradictionLosses = new Map(rcRows.map(r => [r.id, r.contradiction_losses ?? 0]));
  const retentionScores = new Map(rcRows.map(r => [r.id, getRetentionScore(r.last_recalled_at ?? null, r.created_at, now)]));
  const reranked = rerankWithTimeDecay(visibleFusedMatches, recallCounts, importanceScores, queryTags, contradictionWins, contradictionLosses, retentionScores);

  const seen = new Set<string>();
  const deduped = reranked.filter((m) => {
    const parentId = (m.metadata as any)?.parentId ?? m.id;
    if (seen.has(parentId)) return false;
    seen.add(parentId);
    return true;
  }).slice(0, topK);

  if (!deduped.length) return { matches: [], insight: "", semanticUnavailable, proposed_edges: [] };

  const seedParentIds = deduped.map((m) => (m.metadata as any)?.parentId ?? m.id);

  // Multi-hop expansion (issue #16): walk the graph outward from the direct-match seeds
  // and fold in related memories. Each expanded node is scored as a fraction of the
  // WEAKEST seed (minSeedScore × decay^hop × edgeWeight), so a related node can never
  // outrank a direct match — recall never regresses — while neighbors still order by
  // graph distance and link strength. hops:0 → no expansion → byte-for-byte today's path.
  let expandedScored: { parentId: string; score: number; hop: number }[] = [];
  if (hops > 0) {
    const minSeedScore = deduped.reduce((mn, m) => Math.min(mn, m.score), Infinity);
    const expanded = await expandGraph(seedParentIds, { hops }, env, userId);
    expandedScored = expanded.map(n => ({
      parentId: n.id,
      hop: n.hop,
      score: minSeedScore * Math.pow(GRAPH_HOP_DECAY, n.hop) * n.viaWeight,
    }));
  }

  // Hydrate seeds and graph-expanded nodes through the same current/historical
  // projection, then apply valid-time and content filters to that selected state.
  const allParentIds = [...seedParentIds, ...expandedScored.map(e => e.parentId)];
  const expandedStates = await loadEntryStates(allParentIds, env, userId, knownAt, asOf);
  for (const [id, state] of expandedStates) stateByEntry.set(id, state);

  const d1Rows = allParentIds.flatMap(id => {
    const state = stateByEntry.get(id);
    if (!state) return [];
    const tags = parseStringArray(state.tags);
    if (!tags || tags.includes("auto-pattern") || tags.includes("status:deprecated")) return [];
    if (tag && !tags.includes(tag)) return [];
    if (kind && (KIND_VALUES as readonly string[]).includes(kind) && !tags.includes(`kind:${kind}`)) return [];
    if (after !== undefined && state.created_at < after) return [];
    if (before !== undefined && state.created_at > before) return [];
    if (asOf !== undefined) {
      if (state.valid_from !== null && state.valid_from > asOf) return [];
      if (state.valid_to !== null && state.valid_to <= asOf) return [];
    }
    return [state];
  });

  const d1Map = new Map(d1Rows.map(row => [row.id, row]));

  const seedMatches: RecallMatch[] = deduped.flatMap((m) => {
    const meta = m.metadata as Record<string, any>;
    const parentId = (meta?.parentId ?? m.id) as string;
    const row = d1Map.get(parentId);
    if (!row) {
      // D1 row not found — either filtered out (e.g. status:deprecated) or genuinely missing
      return [];
    }
    const stalePenalty = row.epistemic_status === "stale" ? STALENESS_RECALL_PENALTY : 1.0;
    return [{
      id: parentId,
      content: row.content as string,
      score: m.score * stalePenalty,
      createdAt: row.created_at as number,
      tags: JSON.parse(row.tags ?? "[]"),
      source: row.source as string,
      isUpdate: !!meta?.isUpdate,
      hop: 0,
      epistemicStatus: row.epistemic_status,
      ownerUserId: row.owner_user_id,
      visibility: row.visibility,
    }];
  });

  const expandedMatches: RecallMatch[] = expandedScored.flatMap((e) => {
    const row = d1Map.get(e.parentId);
    if (!row) return []; // filtered out (deprecated/kind/range) or missing
    return [{
      id: e.parentId,
      content: row.content as string,
      score: e.score,
      createdAt: row.created_at as number,
      tags: JSON.parse(row.tags ?? "[]"),
      source: row.source as string,
      isUpdate: false,
      hop: e.hop,
      epistemicStatus: row.epistemic_status,
      ownerUserId: row.owner_user_id,
      visibility: row.visibility,
    }];
  });

  // Seeds always outrank expanded by construction, so they fill the top and expanded
  // occupy only leftover slots — a direct match is never displaced by a neighbor.
  const matches: RecallMatch[] = [...seedMatches, ...expandedMatches]
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  // Normalize fused scores to 0–1 (top match = 1.0) so the displayed match % is a clean,
  // monotonically-decreasing scale rather than raw RRF values.
  const maxScore = matches.reduce((mx, m) => Math.max(mx, m.score), 0);
  if (maxScore > 0) for (const m of matches) m.score = m.score / maxScore;

  // ── Relations (Ticket 09): fetch linked edges for top results ─────────────
  const matchIdSet = new Set(matches.map(m => m.id));
  if (matchIdSet.size) {
    const ids = [...matchIdSet];
    const placeholders = ids.map(() => "?").join(", ");
    const { results: edgeRows } = await env.DB.prepare(
      `SELECT source_id, target_id, type, confidence FROM edges WHERE source_id IN (${placeholders}) OR target_id IN (${placeholders}) LIMIT 50`
    ).bind(...ids, ...ids).all() as { results: { source_id: string; target_id: string; type: string; confidence: number }[] };

    // Edges do not carry their own ACL. Hydrate every relation endpoint and
    // suppress missing/invisible targets so a public match cannot disclose the
    // id of another user's private memory through a legacy edge.
    let visibleRelationIds: Set<string> | null = null;
    if (edgeRows.length) {
      const relationIds = [...new Set(edgeRows.flatMap((edge) => [edge.source_id, edge.target_id]))];
      const relationPlaceholders = relationIds.map(() => "?").join(", ");
      const { results: relationRows } = await env.DB.prepare(
        `SELECT id, owner_user_id, visibility FROM entries WHERE id IN (${relationPlaceholders})`
      ).bind(...relationIds).all() as { results: { id: string; owner_user_id: string; visibility: string }[] };
      visibleRelationIds = new Set(relationRows.flatMap((row) => {
        return (userId && row.owner_user_id === userId) || row.visibility === "public" ? [row.id] : [];
      }));
    }

    const edgesByEntry = new Map<string, { type: string; confidence: number; targetId: string }[]>();
    for (const e of edgeRows) {
      const entryId = matchIdSet.has(e.source_id) ? e.source_id : matchIdSet.has(e.target_id) ? e.target_id : null;
      if (!entryId) continue;
      const targetId = entryId === e.source_id ? e.target_id : e.source_id;
      if (visibleRelationIds && !visibleRelationIds.has(targetId)) continue;
      if (!edgesByEntry.has(entryId)) edgesByEntry.set(entryId, []);
      edgesByEntry.get(entryId)!.push({ type: e.type, confidence: e.confidence ?? 1.0, targetId });
    }
    for (const m of matches) {
      const edges = edgesByEntry.get(m.id);
      if (edges?.length) m.relations = edges;
    }
  }

  // ── Citation hydration: independently fetch at most five passages per result ──
  // A single global LIMIT lets one long document starve every other match. Each
  // query is constrained to the selected episode and validates the document /
  // section linkage before exposing citation metadata.
  await Promise.all(matches.map(async match => {
    const state = stateByEntry.get(match.id);
    if (!state) return;
    const selectedEpisodeId = state.current_episode_id;
    const { results: passageRows } = await env.DB.prepare(
      `SELECT passages.id,
              passages.entry_id,
              passages.episode_id,
              passages.document_id,
              passages.section_id,
              passages.content,
              COALESCE(
                passages.section,
                (SELECT ds.title
                 FROM document_sections ds
                 WHERE ds.id = passages.section_id
                   AND ds.document_id = passages.document_id
                 LIMIT 1)
              ) AS section,
              (SELECT d.source_url
               FROM documents d
               WHERE d.id = passages.document_id
                 AND (d.episode_id IS NULL OR d.episode_id = passages.episode_id)
                 AND (d.owner_user_id = '' OR d.owner_user_id = ?)
               LIMIT 1) AS source_url,
              (SELECT d.title
               FROM documents d
               WHERE d.id = passages.document_id
                 AND (d.episode_id IS NULL OR d.episode_id = passages.episode_id)
                 AND (d.owner_user_id = '' OR d.owner_user_id = ?)
               LIMIT 1) AS document_title,
              COALESCE(
                passages.page,
                (SELECT ds.page_start
                 FROM document_sections ds
                 WHERE ds.id = passages.section_id
                   AND ds.document_id = passages.document_id
                 LIMIT 1)
              ) AS page,
              COALESCE(
                passages.page_end,
                (SELECT ds.page_end
                 FROM document_sections ds
                 WHERE ds.id = passages.section_id
                   AND ds.document_id = passages.document_id
                 LIMIT 1),
                passages.page
              ) AS page_end,
              COALESCE(
                passages.start_offset,
                (SELECT ds.start_offset
                 FROM document_sections ds
                 WHERE ds.id = passages.section_id
                   AND ds.document_id = passages.document_id
                 LIMIT 1)
              ) AS start_offset,
              COALESCE(
                passages.end_offset,
                (SELECT ds.end_offset
                 FROM document_sections ds
                 WHERE ds.id = passages.section_id
                   AND ds.document_id = passages.document_id
                 LIMIT 1)
              ) AS end_offset
       FROM passages
       WHERE entry_id = ?
         AND (? IS NULL OR episode_id = ?)
         AND (
           document_id IS NULL OR EXISTS (
             SELECT 1
             FROM documents d
             WHERE d.id = passages.document_id
               AND (d.episode_id IS NULL OR d.episode_id = passages.episode_id)
               AND (d.owner_user_id = '' OR d.owner_user_id = ?)
           )
         )
         AND (
           section_id IS NULL OR EXISTS (
             SELECT 1
             FROM document_sections ds
             WHERE ds.id = passages.section_id
               AND ds.document_id = passages.document_id
           )
         )
       ORDER BY created_at DESC, start_offset ASC, id ASC
       LIMIT 5`
    ).bind(
      state.owner_user_id,
      state.owner_user_id,
      match.id,
      selectedEpisodeId,
      selectedEpisodeId,
      state.owner_user_id,
    ).all() as { results: Record<string, any>[] };

    const selectedPassages = passageRows
      .filter(row => !selectedEpisodeId || !row.episode_id || row.episode_id === selectedEpisodeId)
      .slice(0, 5);
    if (selectedPassages.length) {
      match.passages = selectedPassages.map(row => ({
        id: row.id as string,
        content: row.content as string,
        section: row.section ?? null,
        documentId: row.document_id ?? null,
        sectionId: row.section_id ?? null,
        sourceUrl: row.source_url ?? null,
        documentTitle: row.document_title ?? null,
        page: row.page == null ? null : Number(row.page),
        pageEnd: row.page_end == null ? null : Number(row.page_end),
        startOffset: row.start_offset == null ? null : Number(row.start_offset),
        endOffset: row.end_offset == null ? null : Number(row.end_offset),
      }));
      return;
    }

    // Conversational notes intentionally have no passage children, but every
    // version still has a 1:1 document envelope. Cite the immutable raw episode
    // so every non-legacy recalled fact retains a resolvable provenance anchor.
    if (!selectedEpisodeId) return;
    const episode = await env.DB.prepare(
      `SELECT episode.id, episode.content,
              document.id AS document_id,
              document.title AS document_title,
              document.source_url
       FROM episodes AS episode
       JOIN documents AS document ON document.episode_id = episode.id
       WHERE episode.id = ?
         AND episode.entry_id = ?
         AND episode.owner_user_id = ?
         AND (document.owner_user_id = '' OR document.owner_user_id = ?)
       LIMIT 1`,
    ).bind(
      selectedEpisodeId,
      match.id,
      state.owner_user_id,
      state.owner_user_id,
    ).first<Record<string, any>>();
    if (!episode) return;
    match.passages = [{
      id: episode.id as string,
      content: episode.content as string,
      section: null,
      documentId: episode.document_id as string,
      sectionId: null,
      sourceUrl: episode.source_url ?? null,
      documentTitle: episode.document_title ?? null,
      page: null,
      pageEnd: null,
      startOffset: 0,
      endOffset: String(episode.content ?? "").length,
    }];
  }));

  // ── Cross-user mentions: flag high-similarity public entries from other users ──
  if (userId) {
    // Use D1 ownership, never mutable Vectorize metadata, for cross-user attribution.
    const crossUserOwnerIds = new Set<string>();
    for (const m of matches) {
      const ownerId = (d1Map.get(m.id) as any)?.owner_user_id;
      if (ownerId && ownerId !== userId) crossUserOwnerIds.add(ownerId);
    }
    if (crossUserOwnerIds.size) {
      const ownerIds = [...crossUserOwnerIds];
      const placeholders = ownerIds.map(() => "?").join(", ");
      const { results: ownerRows } = await env.DB.prepare(
        `SELECT id, username FROM users WHERE id IN (${placeholders})`
      ).bind(...ownerIds).all() as { results: { id: string; username: string }[] };
      const usernameMap = new Map(ownerRows.map(r => [r.id, r.username]));

      // Attach crossUserMention to matches owned by other users with high similarity
      const seenOwnerMatches = new Set<string>();
      for (const m of matches) {
        const ownerId = (d1Map.get(m.id) as any)?.owner_user_id;
        if (!ownerId || ownerId === userId) continue;
        const username = usernameMap.get(ownerId);
        if (!username) continue;
        // Only mention once per owner
        if (seenOwnerMatches.has(ownerId)) continue;
        seenOwnerMatches.add(ownerId);
        m.crossUserMention = { entryId: m.id, ownerUsername: username, similarity: m.score };
      }
    }
  }

  // Recall is a read operation. Contradiction proposal generation belongs to
  // the explicit scheduled maintenance/proposal pipeline, never this query.
  const proposed_edges: { source_id: string; target_id: string; type: string; reason: string }[] = [];

  // Synthesize over exactly what's shown (seeds + any surfaced neighbors) so the
  // insight stays grounded in the returned results.
  const insight = matches.length > 1
    ? await synthesizeInsight(embedQuery, matches.map(m => ({ id: m.id, content: m.content })), env)
    : "";

  return { matches, insight, semanticUnavailable, proposed_edges };
}
