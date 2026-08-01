/**
 * lifecycle.ts — Memory lifecycle management and compression.
 *
 * Purpose: Provide memory status transitions (deprecation, archival) and
 *   async pattern synthesis, insight generation, digest compression, and
 *   nightly graph maintenance — the "background brain" that keeps entries
 *   organized and the relationship graph healthy.
 *
 * Input:   Entry IDs, user queries, tag names, and Cloudflare Env bindings.
 * Output:  ForgetResult, status booleans, synthesized text, graph mutations.
 * Logic:   LLM-powered synthesis (insights, patterns, digests), tag-scoped
 *   compression with eligibility guards, and a bounded nightly graph pass
 *   that prunes weak inferred edges and backfills unlinked entries.
 */

import type { Env } from "./types";
import { readStreamText, escapeLikePattern, embed } from "./helpers";
import {
  LLM_MODEL,
  DIGEST_MAX_TOKENS,
  INSIGHT_MAX_TOKENS,
  PATTERN_MAX_TOKENS,
  COMPRESSION_MIN_AGE_MS,
  compressionEligibilitySql,
} from "./config";
import {
  STATUS_PREFIX,
  KIND_PREFIX,
  type MemoryStatus,
  type EpistemicStatus,
  type ServiceScope,
  type SystemActorContext,
} from "./types";
import { withStatus } from "./tags";
import { initializeDatabase } from "./db";
import { captureEntry } from "./ingest";
import { commitEntryVersion } from "./entry-version-service";
import { inferEdgesOnWrite } from "./graph";
import { queryVisibleVectors, vectorMatchParentId } from "./vector-access";
import { classifyStrictContradiction } from "./duplicates";
import { createActionProposal } from "./action-proposals";
import { sha256Hex } from "./governance-utils";
import { NIGHTLY_CONTRADICTION_SYSTEM_ID } from "./operator-policy";

// ─── Synthesize insight from retrieved memories ───────────────────────────────

export async function synthesizeInsight(
  query: string,
  rows: { id: string; content: string }[],
  env: Env
): Promise<string> {
  if (!rows.length) return "";

  const memoriesList = rows
    .map((r, i) => `[${i + 1}] ID: ${r.id}\n${r.content}`)
    .join("\n\n");

  const prompt = `You are a shared living memory assistant. Summarize what the user's stored memories below say in relation to their query. Base the insight ONLY on these memories.

Query: "${query}"

Memories:
${memoriesList}

Rules:
- Use ONLY the information in the memories above. Do not add, infer, guess, or speculate, and do not use hedging language like "might" or "it seems".
- These memories are a retrieved subset, not the user's full memory store. Never say that information is missing, unavailable, or does not exist.
- If the memories don't address the query, briefly state only what they do contain.

Write a brief insight (2-4 sentences).`;

  let insight = "";
  try {
    const stream = await (env.AI as any).run(LLM_MODEL as any, {
      messages: [{ role: "user", content: prompt }],
      max_tokens: INSIGHT_MAX_TOKENS,
      stream: true,
    });
    insight = await readStreamText(stream as ReadableStream);
  } catch (e) {
    console.error("synthesizeInsight LLM call failed (non-fatal):", e);
  }

  return insight.trim();
}

// ─── Async pattern derivation ─────────────────────────────────────────────────

export async function derivePattern(
  rows: { id: string; content: string }[],
  env: Env,
  ctx: ExecutionContext
): Promise<void> {
  if (rows.length < 10) return;

  // At most one auto-pattern per 48h to prevent spam across repeated recalls
  const recentPattern = await env.DB.prepare(
    `SELECT id FROM entries WHERE tags LIKE '%"auto-pattern"%' AND created_at > ? LIMIT 1`
  ).bind(Date.now() - 172800000).first();
  if (recentPattern) return;

  const sample = rows.slice(0, 20);
  const memoriesList = sample
    .map((r, i) => `[${i + 1}] ${r.content.slice(0, 300)}`)
    .join("\n\n");

  const prompt = `You are analyzing stored memories to find genuine recurring themes.

Memories:
${memoriesList}

Find a pattern that appears across 3 or more of these memories — a real tendency, preference, or recurring theme about this person. Do NOT summarize individual memories. Do NOT describe any single event.

If you find a genuine cross-memory pattern, respond with exactly ONE sentence starting with exactly one of: "You tend to", "There's a recurring", or "Across your memories".

If no genuine pattern exists across 3+ memories, respond with exactly: NONE`;

  try {
    const response = await (env.AI as any).run(LLM_MODEL as any, {
      messages: [{ role: "user", content: prompt }],
      max_tokens: PATTERN_MAX_TOKENS,
    }) as any;

    const trimmed = (
      response?.choices?.[0]?.message?.content ??
      response?.response ??
      ""
    ).trim();

    if (!trimmed || trimmed === "NONE") return;

    const validStarters = ["You tend to", "There's a recurring", "Across your memories"];
    if (!validStarters.some(s => trimmed.startsWith(s))) return;

    await captureEntry(trimmed, ["auto-pattern"], "system", env, ctx);
  } catch (e) {
    console.error("derivePattern failed (non-fatal):", String(e));
  }
}

// ─── Semantic compression ─────────────────────────────────────────────────────

export async function synthesizeDigest(
  tag: string,
  rows: { id: string; content: string }[],
  env: Env
): Promise<string> {
  if (!rows.length) return "";

  const memoriesList = rows
    .map((r, i) => `[${i + 1}] ${r.content.slice(0, 400)}`)
    .join("\n\n");

  const prompt = `You are a shared living memory assistant. Based on these stored memories tagged "${tag}", write a single cohesive paragraph describing the current state of this area — what has been done, decided, and is being worked toward. Write as one flowing paragraph, not a list.

Memories:
${memoriesList}

State of "${tag}":`;

  let digest = "";
  try {
    const stream = await (env.AI as any).run(LLM_MODEL as any, {
      messages: [{ role: "user", content: prompt }],
      max_tokens: DIGEST_MAX_TOKENS,
      stream: true,
    });
    digest = await readStreamText(stream as ReadableStream);
  } catch (e) {
    console.error("synthesizeDigest LLM call failed (non-fatal):", e);
  }

  return digest.trim();
}

type CompressionSource = {
  id: string;
  content: string;
  tags: string[];
  ownerUserId: string;
  source: string;
  revision: number;
  validFrom: number | null;
  validTo: number | null;
  epistemicStatus: string;
  visibility: "private" | "public";
};

function parseEntryTags(raw: unknown): string[] | null {
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!Array.isArray(parsed) || !parsed.every(tag => typeof tag === "string")) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function authorizeCompressionSources(
  rawEntries: Record<string, unknown>[],
  tag: string,
  env: Env,
  userId?: string,
): Promise<CompressionSource[]> {
  const sources: CompressionSource[] = [];

  for (const rawEntry of rawEntries) {
    const id = typeof rawEntry.id === "string" ? rawEntry.id : "";
    const content = typeof rawEntry.content === "string" ? rawEntry.content : "";
    if (!id || !content) continue;

    // Re-authorize each row immediately before synthesis/mutation. Besides
    // defending against stale or imperfect query filters, this makes malformed
    // tag metadata fail closed instead of being treated as public.
    const metadata = await env.DB.prepare(
      `SELECT tags, owner_user_id, source, revision, valid_from, valid_to,
              epistemic_status, visibility
       FROM entries WHERE id = ?`
    ).bind(id).first<{ tags: string; owner_user_id: string; source: string; revision: number; valid_from: number | null; valid_to: number | null; epistemic_status: string; visibility: string }>();
    if (!metadata) continue;

    const tags = parseEntryTags(metadata.tags);
    if (!tags) continue;
    if (!tags.includes(tag)) continue;
    if (tags.some(candidate =>
      candidate === "synthesized" ||
      candidate === "auto-pattern" ||
      candidate === "rolled-up"
    )) continue;

    const ownerUserId = typeof metadata.owner_user_id === "string"
      ? metadata.owner_user_id
      : "";
    if (userId && ownerUserId !== userId) continue;
    if (metadata.visibility !== "private" && metadata.visibility !== "public") continue;
    if (!userId && metadata.visibility !== "public") continue;

    sources.push({
      id,
      content,
      tags,
      ownerUserId,
      source: metadata.source,
      revision: Number(metadata.revision ?? 0),
      validFrom: metadata.valid_from ?? null,
      validTo: metadata.valid_to ?? null,
      epistemicStatus: metadata.epistemic_status ?? "canonical",
      visibility: metadata.visibility,
    });
  }

  return sources;
}

export async function compressTag(
  tag: string,
  env: Env,
  ctx: ExecutionContext,
  userId?: string
): Promise<{ synthesizedId: string | null; entriesUsed: number; text: string }> {
  // Reserved/namespaced tags (kind:*, status:*) describe a memory's type/lifecycle,
  // not a topic — digesting them would blend unrelated memories (and could compress
  // protected/canonical ones). Never compress by them. This also guards /digest and
  // the web UI Compress button, not just the nightly cron.
  if (tag.startsWith(STATUS_PREFIX) || tag.startsWith(KIND_PREFIX)) {
    return { synthesizedId: null, entriesUsed: 0, text: "" };
  }

  const recentSynthSql = `
    SELECT id FROM entries
    WHERE ${userId ? "owner_user_id = ? AND" : ""} tags LIKE '%"synthesized"%'
      AND tags LIKE ?
      AND created_at > ?
    LIMIT 1
  `;
  const recentSynthBindings = userId
    ? [userId, `%"${escapeLikePattern(tag)}"%`, Date.now() - 86400000]
    : [`%"${escapeLikePattern(tag)}"%`, Date.now() - 86400000];
  const recentSynth = await env.DB.prepare(recentSynthSql)
    .bind(...recentSynthBindings).first();

  if (recentSynth) {
    return { synthesizedId: null, entriesUsed: 0, text: "" };
  }

  // Fetch compressible entries: tagged with this tag, not system-tagged, not high-importance
  const eligibilitySql = compressionEligibilitySql("", userId);
  const bindValues = userId
    ? [`%"${escapeLikePattern(tag)}"%`, Date.now() - COMPRESSION_MIN_AGE_MS, userId]
    : [`%"${escapeLikePattern(tag)}"%`, Date.now() - COMPRESSION_MIN_AGE_MS];
  const { results: rawEntries } = await env.DB.prepare(`
    SELECT id, content FROM entries
    WHERE tags LIKE ?
      AND tags NOT LIKE '%"synthesized"%'
      AND tags NOT LIKE '%"auto-pattern"%'
      AND tags NOT LIKE '%"rolled-up"%'
      AND ${eligibilitySql}
    ORDER BY created_at DESC
    LIMIT 50
  `).bind(...bindValues).all();

  const rows = await authorizeCompressionSources(
    rawEntries as Record<string, unknown>[], tag, env, userId,
  );
  if (rows.length < 10) {
    return { synthesizedId: null, entriesUsed: 0, text: "" };
  }

  const text = await synthesizeDigest(tag, rows, env);
  if (!text) return { synthesizedId: null, entriesUsed: 0, text: "" };

  const content = `[Synthesized from ${rows.length} entries tagged "${tag}"]\n\n${text}`;
  // A digest that incorporates any private source must itself remain private.
  // Public-only source sets remain public, matching their source visibility.
  const digestVisibility = rows.some(row => row.visibility === "private") ? "private" : "public";
  const digestTags = [
    "synthesized",
    tag,
    ...(digestVisibility === "private" ? ["private"] : []),
  ];
  const result = await captureEntry(content, digestTags, "system", env, ctx, userId, {
    visibility: digestVisibility,
  });

  if (result.status !== "stored") {
    return { synthesizedId: null, entriesUsed: 0, text };
  }

  let rolledUp = 0;
  for (const row of rows) {
    try {
      const digestReference = `\n\n[Digest: ${result.id}]`;
      await commitEntryVersion({
        kind: "compress",
        actorUserId: row.ownerUserId,
        entryId: row.id,
        expectedRevision: row.revision,
        rawContent: digestReference,
        materializedContent: row.content + digestReference,
        tags: row.tags.includes("rolled-up") ? row.tags : [...row.tags, "rolled-up"],
        source: row.source,
        validFrom: row.validFrom,
        validTo: row.validTo,
        epistemicStatus: row.epistemicStatus as EpistemicStatus,
      }, env);
      rolledUp++;
    } catch (e) {
      console.error(`Failed to version compressed source entry ${row.id} (non-fatal):`, e);
    }
  }

  return { synthesizedId: result.id, entriesUsed: rolledUp, text };
}

export async function runNightlyCompression(env: Env, ctx: ExecutionContext): Promise<void> {
  await initializeDatabase(env);

  // Get all active users for per-user compression
  const { results: users } = await env.DB.prepare(
    `SELECT id FROM users WHERE status = 'active'`
  ).all<{ id: string }>();

  // If no users table or no users, fall back to system-user-only compression
  const userIds = users.length > 0 ? users.map((u: any) => u.id) : [""];

  for (const userId of userIds) {
    const { results } = await env.DB.prepare(`
      SELECT value as tag, COUNT(*) as count
      FROM entries, json_each(entries.tags)
      WHERE value NOT IN ('synthesized', 'auto-pattern', 'duplicate-candidate', 'contradiction-resolved', 'rolled-up')
        AND value NOT LIKE 'status:%'
        AND value NOT LIKE 'kind:%'
        AND entries.tags NOT LIKE '%"rolled-up"%'
        AND entries.tags NOT LIKE '%"synthesized"%'
        AND entries.tags NOT LIKE '%"auto-pattern"%'
        AND ${compressionEligibilitySql("entries.", userId || undefined)}
      GROUP BY value
      HAVING count > 10
      ORDER BY count DESC
    `).bind(Date.now() - COMPRESSION_MIN_AGE_MS, ...(userId ? [userId] : [])).all();

    for (const row of results) {
      const tag = row.tag as string;
      try {
        await compressTag(tag, env, ctx, userId || undefined);
      } catch (e) {
        console.error(`Compression failed for tag "${tag}" user "${userId}" (non-fatal):`, e);
      }
    }
  }

  // Staleness detection pass (Ticket 06)
  try {
    await detectStaleness(env);
  } catch (e) {
    console.error("Staleness detection failed (non-fatal):", e);
  }
}

// ─── Staleness detection (Ticket 06) ────────────────────────────────────────
// Marks entries as stale when: valid_to is set, incoming edge confidence < 0.5,
// or age > STALENESS_THRESHOLD_DAYS with no recalls. Runs nightly.
export async function detectStaleness(env: Env): Promise<void> {
  const now = Date.now();
  const { STALENESS_THRESHOLD_DAYS, STALENESS_CONFIDENCE_THRESHOLD } = await import("./config");
  const projection = `id, content, tags, source, owner_user_id, revision,
    valid_from, valid_to, epistemic_status`;
  const candidates = new Map<string, { row: Record<string, any>; reason: string }>();

  try {
    const { results } = await env.DB.prepare(
      `SELECT ${projection} FROM entries
       WHERE valid_to IS NOT NULL AND epistemic_status != 'stale' LIMIT 100`,
    ).all();
    for (const row of results as Record<string, any>[]) candidates.set(row.id, { row, reason: "validity-ended" });
  } catch (e) { console.error("Staleness check (valid_to) failed (non-fatal):", e); }

  try {
    const { results } = await env.DB.prepare(
      `SELECT ${projection} FROM entries
       WHERE id IN (
         SELECT DISTINCT target_id FROM edges WHERE confidence < ? AND confidence > 0
       ) AND epistemic_status != 'stale' LIMIT 100`,
    ).bind(STALENESS_CONFIDENCE_THRESHOLD).all();
    for (const row of results as Record<string, any>[]) {
      if (!candidates.has(row.id)) candidates.set(row.id, { row, reason: "low-confidence-evidence" });
    }
  } catch (e) { console.error("Staleness check (confidence) failed (non-fatal):", e); }

  try {
    const cutoff = now - STALENESS_THRESHOLD_DAYS * 86400000;
    const { results } = await env.DB.prepare(
      `SELECT ${projection} FROM entries
       WHERE created_at < ? AND recall_count = 0 AND epistemic_status != 'stale'
       LIMIT 100`,
    ).bind(cutoff).all();
    for (const row of results as Record<string, any>[]) {
      if (!candidates.has(row.id)) candidates.set(row.id, { row, reason: "unreinforced-age" });
    }
  } catch (e) { console.error("Staleness check (age) failed (non-fatal):", e); }

  let marked = 0;
  for (const { row, reason } of candidates.values()) {
    if (!row.owner_user_id) continue;
    try {
      await commitEntryVersion({
        kind: "status",
        actorUserId: row.owner_user_id as string,
        entryId: row.id as string,
        expectedRevision: Number(row.revision ?? 0),
        rawContent: `staleness:${reason}`,
        materializedContent: row.content as string,
        tags: JSON.parse(row.tags ?? "[]"),
        source: row.source as string,
        validFrom: row.valid_from as number | null,
        validTo: row.valid_to as number | null,
        epistemicStatus: "stale",
      }, env);
      marked++;
    } catch (e) {
      console.error(`Staleness transition failed for ${row.id} (non-fatal):`, e);
    }
  }
  if (marked) console.log(`Staleness: ${marked} entries versioned as stale`);
}

// ─── Nightly graph maintenance (issue #16) ──────────────────────────────────────
// Bounded, idempotent background pass that keeps the relationship graph healthy:
// prunes weak stale auto-edges, then backfills links for still-unlinked entries so
// memories created before linking existed gradually join the graph. Runs on the same
// daily cron as compression — no new/extra trigger. (A future fast-follow can add an
// LLM step that promotes generic relates_to edges to specific types from EDGE_TYPES.)
const GRAPH_PASS_BACKFILL_LIMIT = 25;          // unlinked entries to link per run
const EDGE_PRUNE_WEIGHT = 0.3;                 // inferred edges weaker than this are prune candidates…
const EDGE_PRUNE_MIN_AGE_MS = 7 * 24 * 60 * 60 * 1000; // …once they're at least a week old

export async function runGraphPass(env: Env, ctx: ExecutionContext): Promise<void> {
  await initializeDatabase(env);

  // (1) Prune weak, old, INFERRED edges only — explicit (user) and system (lifecycle)
  // edges are never auto-removed. That's exactly what `provenance` is for.
  try {
    await env.DB.prepare(
      `DELETE FROM edges WHERE provenance = 'inferred' AND weight < ? AND updated_at < ?`
    ).bind(EDGE_PRUNE_WEIGHT, Date.now() - EDGE_PRUNE_MIN_AGE_MS).run();
  } catch (e) {
    console.error("Graph prune failed (non-fatal):", e);
  }

  // (2) Backfill: find a bounded batch of entries with no edges yet and link each to
  // its nearest neighbors (same logic as on-write inference). Empty edges table →
  // every entry is unlinked → the graph fills in over successive nightly runs.
  let unlinked: { id: string; content: string; owner_user_id: string; tags: string; visibility: string }[] = [];
  try {
    const { results } = await env.DB.prepare(
      `SELECT id, content, owner_user_id, tags, visibility FROM entries
       WHERE id NOT IN (SELECT source_id FROM edges) AND id NOT IN (SELECT target_id FROM edges)
         AND tags NOT LIKE '%"status:deprecated"%'
       ORDER BY created_at DESC LIMIT ${GRAPH_PASS_BACKFILL_LIMIT}`
    ).all() as { results: { id: string; content: string; owner_user_id: string; tags: string; visibility: string }[] };
    unlinked = results;
  } catch (e) {
    console.error("Graph backfill query failed (non-fatal):", e);
  }

  for (const entry of unlinked) {
    try {
      const entryTags = parseEntryTags(entry.tags);
      if (!entryTags) continue;

      const isPrivate = entry.visibility === "private";
      if (!isPrivate && entry.visibility !== "public") continue;
      const entryOwner = typeof entry.owner_user_id === "string"
        ? entry.owner_user_id
        : "";
      // A private entry without an authoritative owner cannot be partitioned
      // safely, so it must not participate in automatic graph inference.
      if (isPrivate && !entryOwner) continue;

      const values = await embed(entry.content, env);
      const { matches, entriesById } = await queryVisibleVectors(values, env, {
        topK: 5,
        ...(isPrivate ? { userId: entryOwner } : {}),
      });
      const scores = new Map<string, number>();
      for (const match of matches) {
        const parentId = vectorMatchParentId(match);
        if (parentId === entry.id) continue;

        // Enforce the graph partition from authoritative D1 metadata, never
        // from Vectorize payloads: private↔same-owner-private; public↔public.
        const candidate = entriesById.get(parentId);
        if (!candidate) continue;
        const candidateIsPrivate = candidate.visibility === "private";
        if (isPrivate) {
          if (!candidateIsPrivate || candidate.ownerUserId !== entryOwner) continue;
        } else if (candidateIsPrivate) {
          continue;
        }

        scores.set(parentId, Math.max(scores.get(parentId) ?? 0, match.score));
      }
      const neighbors = [...scores.entries()].map(([id, score]) => ({ id, score }));

      await inferEdgesOnWrite(entry.id, neighbors, env);
    } catch (e) {
      console.error(`Graph backfill failed for ${entry.id} (non-fatal):`, e);
    }
  }
}

// ─── Shared delete path ───────────────────────────────────────────────────────
// Used by both the `forget` MCP tool and POST /forget so the cleanup logic
// (D1 row + tracked Vectorize IDs) lives in exactly one place.

export type ForgetResult =
  | { status: "not_found" }
  | { status: "deleted"; vectorCount: number };

function parseTrackedVectorIds(raw: unknown, scope: string): string[] {
  if (raw == null) return [];

  let parsed: unknown;
  try {
    parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    throw new Error(`Cannot forget entry: malformed vector_ids for ${scope}`);
  }

  if (
    !Array.isArray(parsed) ||
    !parsed.every((vectorId) => typeof vectorId === "string" && vectorId.length > 0)
  ) {
    throw new Error(`Cannot forget entry: malformed vector_ids for ${scope}`);
  }

  return parsed;
}

export async function forgetEntry(id: string, env: Env): Promise<ForgetResult> {
  const row = await env.DB.prepare(
    `SELECT vector_ids FROM entries WHERE id = ?`
  ).bind(id).first() as Record<string, any> | null;

  if (!row) return { status: "not_found" };

  const { results: passages } = await env.DB.prepare(
    `SELECT id, vector_ids FROM passages WHERE entry_id = ?`
  ).bind(id).all<{ id: string; vector_ids: string }>();

  // Validate every tracking record before mutating either store. Continuing with
  // malformed metadata could orphan vectors whose IDs can no longer be recovered.
  const vectorIds = [...new Set([
    ...parseTrackedVectorIds(row.vector_ids, `entry ${id}`),
    ...passages.flatMap((passage) =>
      parseTrackedVectorIds(passage.vector_ids, `passage ${passage.id}`)
    ),
  ])];

  // Vectorize has no shared transaction with D1. Delete vectors first and fail
  // closed so a Vectorize outage never leaves searchable data after D1 is gone.
  // A later retry is safe because deleting the same Vectorize IDs is idempotent.
  if (vectorIds.length) await env.VECTORIZE.deleteByIds(vectorIds);

  // D1 batch execution is transactional. Delete every entry-owned artifact in a
  // single batch so no dangling graph, provenance, passage, episode, or snapshot
  // records survive a successful permanent forget.
  await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM edge_proposals WHERE source_id = ? OR target_id = ?`
    ).bind(id, id),
    env.DB.prepare(
      `DELETE FROM edges WHERE source_id = ? OR target_id = ?`
    ).bind(id, id),
    env.DB.prepare(
      `DELETE FROM document_sections
       WHERE document_id IN (
         SELECT id FROM documents
         WHERE episode_id IN (SELECT id FROM episodes WHERE entry_id = ?)
       )`
    ).bind(id),
    env.DB.prepare(
      `DELETE FROM documents
       WHERE episode_id IN (SELECT id FROM episodes WHERE entry_id = ?)`
    ).bind(id),
    env.DB.prepare(`DELETE FROM passages WHERE entry_id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM episodes WHERE entry_id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM entry_snapshots WHERE entry_id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM entries WHERE id = ?`).bind(id),
  ]);

  return { status: "deleted", vectorCount: vectorIds.length };
}

// Deprecate (issue #119): keep the D1 row for audit but make the entry
// unrecallable by deleting its vectors and tagging it status:deprecated.
export async function deprecateEntry(id: string, env: Env, actorUserId?: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT content, tags, source, vector_ids, owner_user_id, revision,
            valid_from, valid_to, epistemic_status
     FROM entries WHERE id = ?`
  ).bind(id).first() as Record<string, any> | null;
  if (!row) return false;
  const ownerUserId = row.owner_user_id as string;
  if (actorUserId && ownerUserId !== actorUserId) return false;
  if (!ownerUserId) return false;

  const tags: string[] = JSON.parse(row.tags ?? "[]");
  const committed = await commitEntryVersion({
    kind: "status",
    actorUserId: ownerUserId,
    entryId: id,
    expectedRevision: Number(row.revision ?? 0),
    rawContent: "status:deprecated",
    materializedContent: row.content as string,
    tags: withStatus(tags, "deprecated"),
    source: row.source as string,
    validFrom: row.valid_from as number | null,
    validTo: row.valid_to as number | null,
    epistemicStatus: row.epistemic_status as EpistemicStatus,
  }, env);

  try {
    if (committed.vectorIds.length) await env.VECTORIZE.deleteByIds(committed.vectorIds);
    await env.DB.prepare(`UPDATE entries SET vector_ids = '[]' WHERE id = ? AND revision = ?`)
      .bind(id, committed.revision).run();
  } catch (e) {
    console.error("Vectorize deleteByIds failed during deprecate (non-fatal):", e);
  }
  return true;
}

// Apply a lifecycle status to an entry (issue #119). 'deprecated' deletes vectors
// (via deprecateEntry); others swap the status:* tag in place. Returns ok=false if no such entry.
export async function applyStatus(id: string, status: MemoryStatus, env: Env, actorUserId?: string): Promise<boolean> {
  if (status === "deprecated") return deprecateEntry(id, env, actorUserId);
  const row = await env.DB.prepare(
    `SELECT content, tags, source, owner_user_id, revision,
            valid_from, valid_to, epistemic_status
     FROM entries WHERE id = ?`
  ).bind(id).first() as Record<string, any> | null;
  if (!row) return false;
  const ownerUserId = row.owner_user_id as string;
  if (!ownerUserId || (actorUserId && ownerUserId !== actorUserId)) return false;
  const tags: string[] = JSON.parse(row.tags ?? "[]");
  await commitEntryVersion({
    kind: "status",
    actorUserId: ownerUserId,
    entryId: id,
    expectedRevision: Number(row.revision ?? 0),
    rawContent: `status:${status}`,
    materializedContent: row.content as string,
    tags: withStatus(tags, status),
    source: row.source as string,
    validFrom: row.valid_from as number | null,
    validTo: row.valid_to as number | null,
    epistemicStatus: row.epistemic_status as EpistemicStatus,
  }, env);
  return true;
}

// ─── Nightly cross-user contradiction detection (S06) ─────────────────────────
// Vector similarity only finds candidate pairs. Both endpoints are then
// re-hydrated and re-authorized from D1 before a strict semantic classifier may
// create a governed, team-visible action proposal. The scanner can neither
// approve nor execute the resulting edge.
const NIGHTLY_CONTRADICTION_SCOPES: readonly ServiceScope[] = [
  "proposal:create",
  "audit:write",
  "run:write",
];

const NIGHTLY_CONTRADICTION_ACTOR: SystemActorContext = {
  kind: "system",
  actorId: NIGHTLY_CONTRADICTION_SYSTEM_ID,
  systemId: NIGHTLY_CONTRADICTION_SYSTEM_ID,
  authMethod: "scheduled-worker",
  scopes: new Set(NIGHTLY_CONTRADICTION_SCOPES),
};

interface PublicContradictionEntry {
  id: string;
  content: string;
  owner_user_id: string;
  visibility: string;
  revision: number;
  current_episode_id: string | null;
}

async function hydratePublicContradictionPair(
  env: Pick<Env, "DB">,
  firstId: string,
  secondId: string,
): Promise<[PublicContradictionEntry, PublicContradictionEntry] | null> {
  if (!firstId || !secondId || firstId === secondId) return null;
  const ids = [firstId, secondId].sort();
  const { results } = await env.DB.prepare(
    `SELECT id, content, owner_user_id, visibility, revision, current_episode_id
     FROM entries WHERE id IN (?, ?)`,
  ).bind(...ids).all<PublicContradictionEntry>();
  const byId = new Map(results.map(row => [row.id, row]));
  const left = byId.get(ids[0]);
  const right = byId.get(ids[1]);
  if (!left || !right
      || left.visibility !== "public" || right.visibility !== "public"
      || !left.owner_user_id || !right.owner_user_id
      || left.owner_user_id === right.owner_user_id
      || !left.content.trim() || !right.content.trim()) return null;
  return [left, right];
}

export async function detectCrossUserContradictions(env: Env): Promise<{ scanned: number; proposals: number }> {
  await initializeDatabase(env);
  const SEVEN_DAYS_AGO = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const CANDIDATE_SIMILARITY_THRESHOLD = 0.85;
  const MAX_ENTRIES = 25;

  const { results: recentEntries } = await env.DB.prepare(
    `SELECT id, content, owner_user_id FROM entries
     WHERE created_at >= ? AND visibility = 'public'
     ORDER BY created_at DESC LIMIT ?`,
  ).bind(SEVEN_DAYS_AGO, MAX_ENTRIES).all<{
    id: string;
    content: string;
    owner_user_id: string;
  }>();

  let scanned = 0;
  let proposals = 0;
  const consideredVersions = new Set<string>();

  for (const candidateSource of recentEntries) {
    try {
      const source = await env.DB.prepare(
        `SELECT id, content, owner_user_id, visibility, revision, current_episode_id
         FROM entries WHERE id = ?`,
      ).bind(candidateSource.id).first<PublicContradictionEntry>();
      if (!source || source.visibility !== "public" || !source.owner_user_id || !source.content.trim()) continue;

      scanned++;
      const entryVec = await embed(source.content, env);
      const { matches, entriesById } = await queryVisibleVectors(entryVec, env, { topK: 5 });

      for (const match of matches) {
        if ((match.score ?? 0) < CANDIDATE_SIMILARITY_THRESHOLD) continue;
        const matchEntryId = vectorMatchParentId(match);
        const matchScope = entriesById.get(matchEntryId);
        if (!matchScope || matchScope.visibility !== "public"
            || matchScope.ownerUserId === source.owner_user_id
            || matchEntryId === source.id) continue;

        // Hydrate both current statements together from authoritative D1.
        // Vector payloads and the earlier source row are candidate hints only.
        const pair = await hydratePublicContradictionPair(env, source.id, matchEntryId);
        if (!pair) continue;
        const [left, right] = pair;
        const versionIdentity = `${left.id}@${left.revision}|${right.id}@${right.revision}`;
        if (consideredVersions.has(versionIdentity)) continue;
        consideredVersions.add(versionIdentity);

        const idempotencyKey = `nightly-contradiction:${await sha256Hex(versionIdentity)}`;
        const existing = await env.DB.prepare(
          `SELECT id FROM action_proposals WHERE idempotency_key = ?`,
        ).bind(idempotencyKey).first<{ id: string }>();
        if (existing) continue;

        const classification = await classifyStrictContradiction(
          { id: left.id, content: left.content, ownerUserId: left.owner_user_id },
          { id: right.id, content: right.content, ownerUserId: right.owner_user_id },
          env,
        );
        if (!classification.confirmed) continue;

        const similarity = Number(match.score.toFixed(6));
        const evidence = {
          kind: "strict-contradiction-classification",
          model: LLM_MODEL,
          confidence: classification.confidence,
          candidateSimilarity: similarity,
          reason: classification.reason,
          left: { entryId: left.id, revision: left.revision, quote: classification.leftQuote },
          right: { entryId: right.id, revision: right.revision, quote: classification.rightQuote },
        };
        await createActionProposal(env, {
          actor: NIGHTLY_CONTRADICTION_ACTOR,
          actionType: "edge.publish",
          payload: {
            sourceId: left.id,
            targetId: right.id,
            type: "contradicts",
            confidence: classification.confidence,
            weight: classification.confidence,
            // Public edge execution only needs a stable proposal subject. The
            // authoritative endpoint owners remain in expected preconditions.
            ownerUserId: left.owner_user_id,
            metadata: {
              detector: NIGHTLY_CONTRADICTION_SYSTEM_ID,
              candidateSimilarity: similarity,
              classificationReason: classification.reason,
            },
          },
          targetIds: [left.id, right.id],
          visibilityScope: "team",
          riskLevel: "medium",
          reason: `Confirmed contradiction: ${classification.reason}`,
          evidence: [evidence],
          idempotencyKey,
          correlationId: idempotencyKey,
        });
        proposals++;
      }
    } catch (e) {
      console.error(`Contradiction scan failed for entry ${candidateSource.id} (non-fatal):`, e);
    }
  }

  return { scanned, proposals };
}
