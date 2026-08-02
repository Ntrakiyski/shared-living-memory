/**
 * Ingest — Entry storage, dedup/merge writes, and vector lifecycle
 *
 * Input:    raw content, tags, source, owner user id
 * Output:   CaptureResult (blocked | stored | flagged | contradiction | merged | replaced)
 *           plus side-effects: D1 rows, Vectorize vectors, graph edges
 *
 * Logic:
 *   1. captureEntry — the main write path: deduplicate, merge/replace, or insert
 *   2. appendToEntry — incremental append through canonical versioning
 *   3. scheduleClassifyAndTag — async importance/kind classification after write
 *   4. reindexAllVectors — canonical current-version vector rebuild
 */

import type {
  AwarenessDelivery,
  CaptureRejectionCode,
  CaptureResult,
  CaptureVisibility,
  Env,
} from "./types";
import { embed } from "./helpers";
import { classifyEntry, extractHashtags } from "./classification";
import { checkDuplicateAndContradiction } from "./duplicates";
import { getStatus, withKind, withStatus } from "./tags";
import { createEdge, inferEdgesOnWrite, neighborsFromVectorQuery } from "./graph";
import {
  commitEntryVersion,
  stageVersionVectors,
  type PlannedPassage,
} from "./entry-version-service";
import { getSystemUserId } from "./db";
import {
  discardOverlapAwarenessIntent,
  reconcileOverlapAwarenessIntent,
  stageOverlapAwarenessIntent,
} from "./awareness-events";

export type ReindexFailureCode =
  | "current_episode_missing"
  | "current_episode_metadata_missing"
  | "invalid_projection_metadata"
  | "vector_upsert_failed"
  | "projection_persist_failed"
  | "stale_delete_failed";

export interface ReindexFailure {
  entry_id: string;
  code: ReindexFailureCode;
  entry_vector_count: number;
  passage_count: number;
  passage_vector_count: number;
}

export interface ReindexResult {
  entries_processed: number;
  passages_processed: number;
  failed: number;
  stale_deleted: number;
  failures: ReindexFailure[];
}

interface ReindexOptions {
  pendingBefore?: number;
  limit?: number;
}

interface ReindexEntryRow {
  id: string;
  content: string;
  tags: string;
  source: string;
  created_at: number;
  vector_ids: string;
  owner_user_id: string;
  visibility: string;
  current_episode_id: string | null;
  current_mutation_id: string | null;
  revision: number;
}

interface ReindexPassageRow {
  id: string;
  content: string;
  section: string | null;
  section_id: string | null;
  start_offset: number | null;
  end_offset: number | null;
  vector_ids: string;
}

function parseTrackedIds(raw: unknown): string[] | null {
  if (typeof raw !== "string") return null;
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) && value.every(id => typeof id === "string" && id.length > 0)
      ? [...new Set(value)]
      : null;
  } catch {
    return null;
  }
}

function countTrackedIds(rows: ReindexPassageRow[]): number {
  return rows.reduce((count, row) => count + (parseTrackedIds(row.vector_ids)?.length ?? 0), 0);
}

function reindexFailure(
  entry: ReindexEntryRow,
  passages: ReindexPassageRow[],
  code: ReindexFailureCode,
): ReindexFailure {
  return {
    entry_id: entry.id,
    code,
    entry_vector_count: parseTrackedIds(entry.vector_ids)?.length ?? 0,
    passage_count: passages.length,
    passage_vector_count: countTrackedIds(passages),
  };
}

function safeErrorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

// Rebuild current projections through the same version-scoped staging primitive
// as normal writes. Historical passages are immutable and deliberately untouched.
export async function reindexAllVectors(
  env: Env,
  ownerUserId?: string,
  options: ReindexOptions = {},
): Promise<ReindexResult> {
  const result: ReindexResult = {
    entries_processed: 0,
    passages_processed: 0,
    failed: 0,
    stale_deleted: 0,
    failures: [],
  };
  const predicates = ["1 = 1"];
  const bindings: (string | number)[] = [];
  if (ownerUserId) {
    predicates.push("e.owner_user_id = ?");
    bindings.push(ownerUserId);
  }
  if (options.pendingBefore !== undefined) {
    predicates.push("e.vector_ids = '[]'", "e.created_at < ?");
    bindings.push(options.pendingBefore);
  }
  const limit = options.limit === undefined ? "" : ` LIMIT ${Math.max(1, Math.min(100, Math.trunc(options.limit)))}`;
  const { results: entries } = await env.DB.prepare(
    `SELECT e.id, e.content, e.tags, e.source, e.created_at, e.vector_ids,
            e.owner_user_id, e.visibility, e.current_episode_id, e.revision,
            ep.mutation_id AS current_mutation_id
     FROM entries e
     LEFT JOIN episodes ep ON ep.id = e.current_episode_id AND ep.entry_id = e.id
     WHERE ${predicates.join(" AND ")}
     ORDER BY e.created_at DESC, e.id ASC${limit}`,
  ).bind(...bindings).all<ReindexEntryRow>();

  for (const entry of entries) {
    const passages = entry.current_episode_id
      ? (await env.DB.prepare(
          `SELECT id, content, section, section_id, start_offset, end_offset, vector_ids
           FROM passages
           WHERE entry_id = ? AND episode_id = ?
           ORDER BY start_offset ASC, id ASC`,
        ).bind(entry.id, entry.current_episode_id).all<ReindexPassageRow>()).results
      : (await env.DB.prepare(
          `SELECT id, content, section, section_id, start_offset, end_offset, vector_ids
           FROM passages
           WHERE entry_id = ? AND episode_id IS NULL
           ORDER BY start_offset ASC, id ASC`,
        ).bind(entry.id).all<ReindexPassageRow>()).results;
    const fail = (code: ReindexFailureCode) => {
      result.failed++;
      result.failures.push(reindexFailure(entry, passages, code));
    };

    if (!entry.current_episode_id) {
      fail("current_episode_missing");
      continue;
    }
    if (!entry.current_mutation_id) {
      fail("current_episode_metadata_missing");
      continue;
    }
    const tags = parseTrackedIds(entry.tags);
    const oldEntryIds = parseTrackedIds(entry.vector_ids);
    const passageIds = passages.map(passage => parseTrackedIds(passage.vector_ids));
    if (!tags || !oldEntryIds || passageIds.some(ids => ids === null)
        || !entry.owner_user_id
        || (entry.visibility !== "private" && entry.visibility !== "public")) {
      fail("invalid_projection_metadata");
      continue;
    }

    const plannedPassages: PlannedPassage[] = passages.map(passage => ({
      id: passage.id,
      content: passage.content,
      section: passage.section,
      sectionId: passage.section_id,
      startOffset: passage.start_offset ?? 0,
      endOffset: passage.end_offset ?? passage.content.length,
      vectorId: `pv:${passage.id}`,
    }));
    let staged: Awaited<ReturnType<typeof stageVersionVectors>>;
    try {
      staged = await stageVersionVectors(env, {
        entryId: entry.id,
        episodeId: entry.current_episode_id,
        mutationId: entry.current_mutation_id,
        content: entry.content,
        tags,
        source: entry.source,
        ownerUserId: entry.owner_user_id,
        visibility: entry.visibility,
        now: entry.created_at,
        passages: plannedPassages,
        // Canonical IDs may already be the last-known-good vectors. A failed
        // upsert must not delete those overlapping IDs during cleanup.
        cleanupOnFailure: false,
      });
    } catch (error) {
      console.error("Re-index vector upsert failed", { entry_id: entry.id, error: safeErrorMessage(error) });
      fail("vector_upsert_failed");
      continue;
    }

    const oldTrackedIds = [...new Set([
      ...oldEntryIds,
      ...passageIds.flatMap(ids => ids ?? []),
    ])];
    const newTrackedIds = new Set(staged.allVectorIds);
    const oldTrackedIdSet = new Set(oldTrackedIds);
    const newlyStagedIds = staged.allVectorIds.filter(id => !oldTrackedIdSet.has(id));
    const staleIds = oldTrackedIds.filter(id => !newTrackedIds.has(id));
    const cleanupQueueId = staleIds.length ? crypto.randomUUID() : null;
    const now = Date.now();
    const projectionGuard = {
      sql: `AND (
        SELECT COUNT(*) FROM passages p
        WHERE p.entry_id = ? AND p.episode_id = ?
      ) = ?`,
      bindings: [entry.id, entry.current_episode_id, plannedPassages.length],
    };
    const statements: D1PreparedStatement[] = [
      env.DB.prepare(
        `UPDATE entries SET vector_ids = ?
         WHERE id = ? AND owner_user_id = ? AND revision = ? AND current_episode_id = ?
         ${projectionGuard.sql}`,
      ).bind(
        JSON.stringify(staged.entryVectorIds), entry.id, entry.owner_user_id,
        entry.revision, entry.current_episode_id, ...projectionGuard.bindings,
      ),
      ...plannedPassages.map(passage => env.DB.prepare(
        `UPDATE passages SET vector_ids = ?
         WHERE id = ? AND entry_id = ? AND episode_id = ?
           AND EXISTS (
             SELECT 1 FROM entries e
             WHERE e.id = ? AND e.owner_user_id = ?
               AND e.revision = ? AND e.current_episode_id = ?
           )
           ${projectionGuard.sql}`,
      ).bind(
        JSON.stringify([passage.vectorId]), passage.id, entry.id, entry.current_episode_id,
        entry.id, entry.owner_user_id, entry.revision, entry.current_episode_id,
        ...projectionGuard.bindings,
      )),
    ];
    if (cleanupQueueId) {
      statements.push(env.DB.prepare(
        `INSERT INTO vector_cleanup_queue (
           id, vector_ids, reason, attempts, last_error, created_at, updated_at
         )
         SELECT ?, ?, ?, 0, NULL, ?, ?
         FROM entries
         WHERE id = ? AND owner_user_id = ? AND revision = ? AND current_episode_id = ?
           ${projectionGuard.sql}`,
      ).bind(
        cleanupQueueId,
        JSON.stringify(staleIds),
        `entry-version:${entry.id}:semantic-reindex:${entry.current_episode_id}`,
        now,
        now,
        entry.id,
        entry.owner_user_id,
        entry.revision,
        entry.current_episode_id,
        ...projectionGuard.bindings,
      ));
    }

    try {
      const persisted = await env.DB.batch(statements);
      if (persisted.some(item => Number(item.meta?.changes ?? 0) !== 1)) {
        throw new Error("guarded projection persistence failed");
      }
    } catch (error) {
      console.error("Re-index projection persistence failed", { entry_id: entry.id, error: safeErrorMessage(error) });
      if (newlyStagedIds.length) {
        const abortedCleanupId = crypto.randomUUID();
        try {
          await env.DB.prepare(
            `INSERT INTO vector_cleanup_queue (
               id, vector_ids, reason, attempts, last_error, created_at, updated_at
             ) VALUES (?, ?, ?, 0, NULL, ?, ?)`,
          ).bind(
            abortedCleanupId,
            JSON.stringify(newlyStagedIds),
            `entry-version:${entry.id}:semantic-reindex-aborted:${entry.current_episode_id}`,
            Date.now(),
            Date.now(),
          ).run();
          try {
            await env.VECTORIZE.deleteByIds(newlyStagedIds);
            await env.DB.prepare(
              `DELETE FROM vector_cleanup_queue WHERE id = ?`,
            ).bind(abortedCleanupId).run();
          } catch (cleanupError) {
            try {
              await env.DB.prepare(
                `UPDATE vector_cleanup_queue
                 SET attempts = attempts + 1, last_error = ?, updated_at = ?
                 WHERE id = ?`,
              ).bind(safeErrorMessage(cleanupError), Date.now(), abortedCleanupId).run();
            } catch (diagnosticError) {
              console.error("Re-index aborted cleanup diagnostic update failed", {
                entry_id: entry.id,
                error: safeErrorMessage(diagnosticError),
              });
            }
          }
        } catch (queueError) {
          console.error("Re-index aborted cleanup queue insert failed", {
            entry_id: entry.id,
            error: safeErrorMessage(queueError),
          });
          try {
            await env.VECTORIZE.deleteByIds(newlyStagedIds);
          } catch (cleanupError) {
            console.error("Re-index aborted cleanup unreconciled", {
              entry_id: entry.id,
              error: safeErrorMessage(cleanupError),
            });
          }
        }
      }
      fail("projection_persist_failed");
      continue;
    }

    result.entries_processed++;
    result.passages_processed += passages.length;
    if (!cleanupQueueId) continue;
    try {
      await env.VECTORIZE.deleteByIds(staleIds);
      await env.DB.prepare(`DELETE FROM vector_cleanup_queue WHERE id = ?`).bind(cleanupQueueId).run();
      result.stale_deleted += staleIds.length;
    } catch (error) {
      try {
        await env.DB.prepare(
          `UPDATE vector_cleanup_queue
           SET attempts = attempts + 1, last_error = ?, updated_at = ?
           WHERE id = ?`,
        ).bind(safeErrorMessage(error), Date.now(), cleanupQueueId).run();
      } catch (queueError) {
        // The cleanup row was committed with the projection update. A
        // best-effort diagnostic update must not prevent exact batch results.
        console.error("Re-index cleanup queue diagnostic update failed", {
          entry_id: entry.id,
          error: safeErrorMessage(queueError),
        });
      }
      fail("stale_delete_failed");
    }
  }

  return result;
}

// ─── Snapshot helper ─────────────────────────────────────────────────────────
// Creates an entry_snapshots row (backup before destructive mutation).
// Reads content/tags/source from the entry, inserts snapshot, returns the ID.
// Fire-and-forget: caller should .catch() the returned promise.

export async function createSnapshot(env: Env, entryId: string): Promise<string | null> {
  const row = await env.DB.prepare(`SELECT content, tags, source FROM entries WHERE id = ?`).bind(entryId).first() as Record<string, any> | null;
  if (!row) return null;
  const snapshotId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO entry_snapshots (id, entry_id, content, tags, source, created_at) VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(snapshotId, entryId, row.content, row.tags ?? "[]", row.source ?? "api", Date.now()).run();
  return snapshotId;
}

// ─── Append to existing entry ─────────────────────────────────────────────────
// Appends use the same versioned commit as every other knowledge mutation.
// The exact addition is retained in the episode ledger and the complete new
// entry state is re-embedded under version-scoped vector ids.

export async function appendToEntry(
  env: Env,
  id: string,
  existingContent: string,
  addition: string,
  tags: string[],
  source: string,
  ownerUserId?: string,
  ctx?: ExecutionContext
): Promise<void> {
  const row = await env.DB.prepare(
    `SELECT content, tags, source, owner_user_id, revision
     FROM entries WHERE id = ?`
  ).bind(id).first() as Record<string, any> | null;
  if (!row) throw new Error(`No entry found with ID: ${id}`);

  const actorUserId = ownerUserId || (row.owner_user_id as string);
  if (!actorUserId) throw new Error("Entry ownership is required for append");
  if (ownerUserId && row.owner_user_id && row.owner_user_id !== ownerUserId) {
    throw new Error(`No entry found with ID: ${id}`);
  }

  const timestamp = new Date().toLocaleDateString();
  const separator = `\n\n[Update ${timestamp}]: `;
  const authoritativeContent = (row.content as string) ?? existingContent;
  const authoritativeTags: string[] = JSON.parse((row.tags as string) ?? JSON.stringify(tags));
  const authoritativeSource = (row.source as string) ?? source;
  const newContent = authoritativeContent + separator + addition;

  await commitEntryVersion({
    kind: "append",
    actorUserId,
    entryId: id,
    expectedRevision: Number(row.revision ?? 0),
    rawContent: addition,
    materializedContent: newContent,
    tags: authoritativeTags,
    source: authoritativeSource,
  }, env);

  // Graph inference is derived state and may remain asynchronous/non-fatal.
  try {
    const values = await embed(addition, env);
    await inferEdgesOnWrite(id, await neighborsFromVectorQuery(values, env, actorUserId), env);
  } catch (e) {
    console.error("Append auto-link failed (non-fatal):", e);
  }
}

// ─── Shared write path ────────────────────────────────────────────────────────

// Classification is derived work and may run asynchronously, but any visible
// tag change still goes through the versioned mutation service. Classifier
// suggestions never promote an entry to canonical without governance.
function scheduleClassifyAndTag(
  entryId: string,
  content: string,
  actorUserId: string,
  env: Env,
  ctx: ExecutionContext,
): void {
  ctx.waitUntil(
    classifyEntry(content, env)
      .then(async ({ importance, kind }) => {
        await env.DB.prepare(`UPDATE entries SET importance_score = ? WHERE id = ?`).bind(importance, entryId).run();
        if (!kind) return;
        const row = await env.DB.prepare(
          `SELECT content, tags, source, owner_user_id, revision,
                  valid_from, valid_to, epistemic_status
           FROM entries WHERE id = ?`,
        ).bind(entryId).first() as Record<string, any> | null;
        if (!row || row.owner_user_id !== actorUserId || row.content !== content) return;
        const currentTags: string[] = JSON.parse(row.tags ?? "[]");
        const nextTags = withKind(currentTags, kind);
        if (JSON.stringify(nextTags) === JSON.stringify(currentTags)) return;
        await commitEntryVersion({
          kind: "status",
          actorUserId,
          entryId,
          expectedRevision: Number(row.revision ?? 0),
          rawContent: `classification:${kind}`,
          materializedContent: row.content as string,
          tags: nextTags,
          source: row.source as string,
          validFrom: row.valid_from as number | null,
          validTo: row.valid_to as number | null,
          epistemicStatus: row.epistemic_status,
        }, env);
      })
      .catch(e => console.error("Classification failed (non-fatal):", e))
  );
}

export class CaptureRejectedError extends Error {
  constructor(readonly code: CaptureRejectionCode, readonly detector?: string) {
    super(code);
    this.name = "CaptureRejectedError";
  }
}

interface CaptureOptions {
  visibility?: CaptureVisibility;
  sourceUrl?: string;
  sourceTitle?: string;
}

const SECRET_DETECTORS = [
  ["github_token", /\b(?:github_pat_[A-Za-z0-9_]{82}|gh[pousr]_[A-Za-z0-9]{36})\b/],
  ["slack_token", /\bxox[bpaors]-[A-Za-z0-9-]{30,}\b/],
  ["stripe_live_secret", /\bsk_live_[A-Za-z0-9]{24,}\b/],
  ["openai_project_key", /\bsk-(?:proj|svcacct)-[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/],
] as const;

export const CAPTURE_PAYLOAD_MAX_BYTES = 32 * 1024;
export const SOURCE_URL_MAX_CODE_POINTS = 2_048;
export const SOURCE_TITLE_MAX_CODE_POINTS = 512;

const PEM_PRIVATE_KEY_BLOCK = /-----BEGIN ([A-Z0-9 ]*PRIVATE KEY)-----\r?\n([\s\S]*?)\r?\n-----END \1-----/g;

function decodePemBody(body: string): Uint8Array | null {
  const encoded = body.replace(/\s/g, "");
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 === 1) return null;
  const padded = encoded.padEnd(encoded.length + ((4 - encoded.length % 4) % 4), "=");
  try {
    const decoded = atob(padded);
    return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function derSequenceContentOffset(bytes: Uint8Array): number | null {
  if (bytes.length < 4 || bytes[0] !== 0x30) return null;
  const firstLength = bytes[1];
  if (firstLength < 0x80) return firstLength + 2 === bytes.length ? 2 : null;
  const lengthBytes = firstLength & 0x7f;
  if (lengthBytes < 1 || lengthBytes > 4 || bytes.length < 2 + lengthBytes) return null;
  let contentLength = 0;
  for (let index = 0; index < lengthBytes; index++) {
    contentLength = (contentLength * 256) + bytes[2 + index];
  }
  const contentOffset = 2 + lengthBytes;
  return contentOffset + contentLength === bytes.length ? contentOffset : null;
}

function isPlausiblePrivateKeyContainer(label: string, bytes: Uint8Array): boolean {
  if (label === "OPENSSH PRIVATE KEY") {
    const signature = "openssh-key-v1\0";
    return bytes.length >= signature.length
      && signature.split("").every((character, index) => bytes[index] === character.charCodeAt(0));
  }
  const contentOffset = derSequenceContentOffset(bytes);
  if (contentOffset === null) return false;
  if (label === "ENCRYPTED PRIVATE KEY") return bytes[contentOffset] === 0x30;
  return bytes[contentOffset] === 0x02;
}

function containsPlausiblePemPrivateKey(content: string): boolean {
  for (const match of content.matchAll(PEM_PRIVATE_KEY_BLOCK)) {
    const decoded = decodePemBody(match[2]);
    if (decoded && isPlausiblePrivateKeyContainer(match[1], decoded)) return true;
  }
  return false;
}

export function detectHighConfidenceSecret(value: string): string | undefined {
  if (containsPlausiblePemPrivateKey(value)) return "pem_private_key";
  return SECRET_DETECTORS.find(([, pattern]) => pattern.test(value))?.[0];
}

function validateCaptureTags(tags: string[]): void {
  if (tags.length > 25) throw new CaptureRejectedError("too_many_tags");
  if (tags.some((tag) => Array.from(tag).length > 64)) {
    throw new CaptureRejectedError("tag_too_long");
  }
}

export function validateSourceMetadataInput(
  sourceUrl?: string,
  sourceTitle?: string,
): void {
  if (sourceUrl && Array.from(sourceUrl).length > SOURCE_URL_MAX_CODE_POINTS) {
    throw new CaptureRejectedError("source_url_too_long");
  }
  if (sourceTitle && Array.from(sourceTitle).length > SOURCE_TITLE_MAX_CODE_POINTS) {
    throw new CaptureRejectedError("source_title_too_long");
  }
  for (const value of [sourceUrl, sourceTitle]) {
    if (!value) continue;
    const detector = detectHighConfidenceSecret(value);
    if (detector) throw new CaptureRejectedError("secret_detected", detector);
  }
}

function validateCaptureInput(
  content: string,
  tags: string[],
  source: string,
  sourceUrl?: string,
  sourceTitle?: string,
): void {
  const effectiveSourceUrl = sourceUrl ?? (/^https?:\/\//i.test(source) ? source : undefined);
  const payloadStrings = [content, ...tags, source, ...(sourceUrl ? [sourceUrl] : []), ...(sourceTitle ? [sourceTitle] : [])];
  const encoder = new TextEncoder();
  const payloadBytes = payloadStrings.reduce((total, value) => total + encoder.encode(value).byteLength, 0);
  if (payloadBytes > CAPTURE_PAYLOAD_MAX_BYTES) {
    throw new CaptureRejectedError("content_too_large");
  }
  validateCaptureTags(tags);
  validateSourceMetadataInput(effectiveSourceUrl, sourceTitle);
  for (const value of payloadStrings) {
    const detector = detectHighConfidenceSecret(value);
    if (detector) throw new CaptureRejectedError("secret_detected", detector);
  }
}

export async function captureEntry(
  rawContent: string,
  tags: string[],
  source: string,
  env: Env,
  ctx: ExecutionContext,
  userId?: string,
  options: CaptureOptions = {},
): Promise<CaptureResult> {
  const inferredSourceUrl = /^https?:\/\//i.test(source) ? source : undefined;
  const requestedSourceUrl = options.sourceUrl ?? inferredSourceUrl;
  validateCaptureInput(rawContent, tags, source, options.sourceUrl, options.sourceTitle);
  const raw = rawContent.trim();
  const { cleanContent, hashtags } = extractHashtags(raw);
  const c = cleanContent || raw;
  const t = [...new Set([...tags.map(tag => tag.toLowerCase()), ...hashtags])];
  validateCaptureTags(t);
  const actorUserId = userId ?? await getSystemUserId(env);
  const sourceUrl = requestedSourceUrl ?? null;
  const visibility = options.visibility ?? "private";
  const effectiveVisibility = visibility;
  const researchLike = sourceUrl !== null
    || /^(research|paper|document)$/i.test(source)
    || /^(#{1,4})\s+/m.test(rawContent);

  const { duplicate: dup, contradiction, mergeAction, neighbors, crossUserSimilar } = await checkDuplicateAndContradiction(c, env, userId);

  const crossUserNote = crossUserSimilar
    ? `Similar content exists in ${crossUserSimilar.ownerUsername}'s public memories`
    : undefined;

  if (dup.status === "blocked") {
    return { status: "blocked", matchId: dup.matchId, score: dup.score };
  }

  let mergeSkipped: "target_not_owned" | "target_protected" | "visibility_mismatch" | undefined;

  // ── Smart merge: replace/merge existing entry — no new entry inserted ────────
  if (!researchLike && dup.status === "flagged" && mergeAction && mergeAction.action !== "keep_both") {
    const targetId = mergeAction.target_id;
    const newContent = mergeAction.action === "merge" ? mergeAction.merged_content : c;

    const targetRow = await env.DB.prepare(
      `SELECT content, tags, source, importance_score, owner_user_id, revision, visibility
       FROM entries WHERE id = ?`
    ).bind(targetId).first() as Record<string, any> | null;

    if (targetRow) {
      // A merge recommendation is never authority to mutate someone else's
      // memory. Preserve the incoming statement through the normal versioned
      // capture path below instead of returning a fabricated entry id.
      if (targetRow.owner_user_id && targetRow.owner_user_id !== actorUserId) {
        mergeSkipped = "target_not_owned";
      } else {
        const existingTags: string[] = JSON.parse(targetRow.tags ?? "[]");
        const existingSource = targetRow.source as string;
        const targetVisibility: CaptureVisibility = targetRow.visibility === "private" ? "private" : "public";

        // Similarity is never authority to cross a visibility boundary. Retain
        // the incoming statement separately at its explicitly requested scope;
        // the existing private/public target is never mutated or republished.
        if (targetVisibility !== effectiveVisibility) {
          mergeSkipped = "visibility_mismatch";
        } else if ((targetRow.importance_score as number) >= 4 || getStatus(existingTags) === "canonical") {
          // Protect high-importance or canonical memories from being silently
          // overwritten. The new statement is retained as its own candidate.
          mergeSkipped = "target_protected";
        } else {
          const committed = await commitEntryVersion({
            kind: mergeAction.action,
            actorUserId,
            entryId: targetId,
            expectedRevision: Number(targetRow.revision ?? 0),
            rawContent,
            materializedContent: newContent,
            tags: existingTags,
            source: existingSource,
            title: options.sourceTitle,
          }, env);

          // Re-classify the merged/replaced content — updates importance_score + kind (and canonical if warranted) on the target.
          scheduleClassifyAndTag(targetId, newContent, actorUserId, env, ctx);

          return mergeAction.action === "merge"
            ? { status: "merged", id: targetId, visibility: targetRow.visibility === "private" ? "private" : "public" }
            : { status: "replaced", id: targetId, visibility: targetRow.visibility === "private" ? "private" : "public" };
        }
      }
    }
    // target not found in DB — fall through to normal insert
  }

  // A semantic contradiction is not proof that the incumbent stopped being
  // true. Capture the competing statement as a draft and record the relation;
  // only an explicit temporal-supersession action may close valid_to.
  const baseTags = contradiction.detected
    ? withStatus([...t, "contradiction-candidate"], "draft")
    : t;
  const finalTags = dup.status === "flagged" ? [...baseTags, "duplicate-candidate"] : baseTags;

  // The durable reconciliation intent is staged before the memory commit. If
  // this write fails, capture aborts cleanly. Once capture succeeds, any event
  // delivery failure is truthful in the response and retryable from this row.
  const plannedEntryId = crypto.randomUUID();
  let awarenessIntentId: string | null = null;
  if (crossUserSimilar) {
    awarenessIntentId = await stageOverlapAwarenessIntent(env, {
      newEntryId: plannedEntryId,
      newOwnerUserId: actorUserId,
      matchedEntryId: crossUserSimilar.entryId,
      matchedOwnerUserId: crossUserSimilar.ownerUserId,
      similarity: crossUserSimilar.score,
      newEntryIsPublic: effectiveVisibility === "public",
    });
  }

  let committed;
  try {
    committed = await commitEntryVersion({
      kind: "capture",
      actorUserId,
      entryId: plannedEntryId,
      rawContent: rawContent,
      materializedContent: c,
      tags: finalTags,
      source,
      sourceUrl,
      title: options.sourceTitle,
      visibility: effectiveVisibility,
      contentType: researchLike ? "research" : "text",
      epistemicStatus: "candidate",
    }, env);
  } catch (error) {
    if (awarenessIntentId) {
      try {
        await discardOverlapAwarenessIntent(env, awarenessIntentId);
      } catch (discardError) {
        // A stranded intent is safe: reconciliation discards missing entries.
        console.error("Overlap-awareness intent cleanup failed", discardError);
      }
    }
    throw error;
  }
  const id = committed.entryId;

  let awareness: AwarenessDelivery | undefined;
  if (awarenessIntentId) {
    try {
      awareness = await reconcileOverlapAwarenessIntent(env, awarenessIntentId);
    } catch (error) {
      // The staged row remains the durable retry path even if the first read or
      // event batch fails before the service can update its attempt metadata.
      console.error("Overlap-awareness delivery deferred", error);
      awareness = {
        status: "pending_reconciliation",
        eventCount: 0,
        reconciliationId: awarenessIntentId,
      };
    }
  }

  scheduleClassifyAndTag(id, c, actorUserId, env, ctx);

  if (contradiction.detected && contradiction.conflicting_id) {
    const conflictId = contradiction.conflicting_id;
    const conflictRow = await env.DB.prepare(
      `SELECT tags FROM entries WHERE id = ?`
    ).bind(conflictId).first() as Record<string, any> | null;
    const conflictStatus = conflictRow ? getStatus(JSON.parse(conflictRow.tags ?? "[]")) : null;

    if (conflictStatus === "canonical") {
      try {
        await createEdge(id, conflictId, "contradicts", {
          provenance: "system",
          confidence: 0.85,
          actorKind: "system",
          actorId: "_ingest_conflict_classifier",
          mutationKind: "classifier-link",
        }, env);
      } catch (e) {
        console.error("Contradiction edge creation failed (non-fatal):", e);
      }
      return {
        status: "contradiction_protected",
        id,
        canonicalId: conflictId,
        visibility: effectiveVisibility,
        reason: contradiction.reason,
        ...(awareness ? { awareness } : {}),
      };
    }

    // A non-canonical conflict is still a conflict, not an automatic temporal
    // supersession. Keep both states and let governance decide any lifecycle
    // transition explicitly.
    try {
      await createEdge(id, conflictId, "contradicts", {
        provenance: "system",
        confidence: 0.85,
        actorKind: "system",
        actorId: "_ingest_conflict_classifier",
        mutationKind: "classifier-link",
      }, env);
    } catch (e) {
      console.error("Contradiction edge creation failed (non-fatal):", e);
    }
    return {
      status: "contradiction",
      id,
      resolvedConflict: conflictId,
      visibility: effectiveVisibility,
      reason: contradiction.reason,
      ...(awareness ? { awareness } : {}),
    };
  }

  // Reached here without contradiction handling (flagged-new-row or stored) — both
  // are genuinely new nodes, so auto-link to similar neighbors (#16).
  ctx.waitUntil(inferEdgesOnWrite(id, neighbors, env).catch(e => console.error("Edge inference failed (non-fatal):", e)));

  if (dup.status === "flagged") {
    return {
      status: "flagged",
      id,
      matchId: dup.matchId,
      score: dup.score,
      visibility: effectiveVisibility,
      crossUserNote,
      ...(mergeSkipped ? { mergeSkipped } : {}),
      ...(awareness ? { awareness } : {}),
    };
  }

  return {
    status: "stored",
    id,
    visibility: effectiveVisibility,
    crossUserNote,
    ...(awareness ? { awareness } : {}),
  };
}
