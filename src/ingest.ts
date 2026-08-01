/**
 * Ingest — Entry storage, dedup/merge writes, and vector lifecycle
 *
 * Input:    raw content, tags, source, owner user id
 * Output:   CaptureResult (blocked | stored | flagged | contradiction | merged | replaced)
 *           plus side-effects: D1 rows, Vectorize vectors, graph edges
 *
 * Logic:
 *   1. captureEntry — the main write path: deduplicate, merge/replace, or insert
 *   2. storeEntry — chunk + embed + insert vectors + persist vector_ids
 *   3. appendToEntry — incremental append (single vector or full re-embed)
 *   4. scheduleClassifyAndTag — async importance/kind classification after write
 *   5. reindexAllVectors — bulk migration helper to add ownership metadata
 */

import type {
  AwarenessDelivery,
  CaptureRejectionCode,
  CaptureResult,
  CaptureVisibility,
  Env,
} from "./types";
import { chunkText, embed } from "./helpers";
import { classifyEntry, extractHashtags } from "./classification";
import { checkDuplicateAndContradiction } from "./duplicates";
import { getStatus, withKind, withStatus } from "./tags";
import { createEdge, inferEdgesOnWrite, neighborsFromVectorQuery } from "./graph";
import { commitEntryVersion } from "./entry-version-service";
import { sha256Hex } from "./governance-utils";
import { getSystemUserId } from "./db";
import {
  discardOverlapAwarenessIntent,
  reconcileOverlapAwarenessIntent,
  stageOverlapAwarenessIntent,
} from "./awareness-events";

// ─── Store entry (full embed + chunk) ────────────────────────────────────────
// Returns the list of vector IDs inserted so forget() can clean up exactly.

// Build and upsert an entry's complete vector set without changing D1. Update
// paths use this staging primitive so a failed embed/write cannot destroy the
// last known-good content/vector references. Upsert is required because stable
// entry/chunk ids must replace prior vectors during edits and re-indexing.
export async function stageEntryVectors(
  env: Env,
  id: string,
  content: string,
  tags: string[],
  source: string,
  now: number,
  ownerUserId?: string,
  isPrivate?: boolean
): Promise<string[]> {
  const chunks = chunkText(content);

  const vectors = await Promise.all(
    chunks.map(async (chunk, i) => {
      const metadata: Record<string, any> = {
        content: chunk,
        parentId: id,
        chunkIndex: i,
        totalChunks: chunks.length,
        tags,
        source,
        created_at: now,
        owner_user_id: ownerUserId ?? "",
        is_private: isPrivate ?? false,
      };

      tags.forEach(t => {
        metadata[`tag_${t}`] = true;
      });

      return {
        id: chunks.length === 1 ? id : `${id}-chunk-${i}`,
        values: await embed(chunk, env),
        metadata,
      };
    })
  );

  await env.VECTORIZE.upsert(vectors);
  return vectors.map(v => v.id);
}

export async function storeEntry(
  env: Env,
  id: string,
  content: string,
  tags: string[],
  source: string,
  now: number,
  ownerUserId?: string,
  isPrivate?: boolean
): Promise<string[]> {
  const vectorIds = await stageEntryVectors(
    env, id, content, tags, source, now, ownerUserId, isPrivate,
  );

  // Persist exact vector IDs so forget() can clean up without guessing
  await env.DB.prepare(
    `UPDATE entries SET vector_ids = ? WHERE id = ?`
  ).bind(JSON.stringify(vectorIds), id).run();

  return vectorIds;
}

// Delete vectors that are no longer referenced after a re-embed. Ids reused by
// the new embedding must survive: single-chunk entries are keyed by the entry
// id, so the re-embedded vector reuses the old id. Deleting the full old set
// would remove the vector we just inserted, leaving the entry unsearchable.
export async function deleteStaleVectors(env: Env, oldIds: string[], newIds: string[]): Promise<void> {
  const stale = oldIds.filter(v => !newIds.includes(v));
  if (stale.length) await env.VECTORIZE.deleteByIds(stale);
}

// Re-index all vectors with ownership metadata. Called from POST /vectorize-pending?reindex=true
// or as a standalone migration step after adding owner_user_id/is_private to vector metadata.
export async function reindexAllVectors(env: Env, ownerUserId?: string): Promise<{ processed: number; failed: number }> {
  let processed = 0;
  let failed = 0;

  // Find all entries that have vectors
  const sql = `SELECT id, content, tags, source, created_at, vector_ids,
      owner_user_id, visibility FROM entries
    WHERE vector_ids != '[]'${ownerUserId ? " AND owner_user_id = ?" : ""}`;
  const { results: entries } = await env.DB.prepare(sql)
    .bind(...(ownerUserId ? [ownerUserId] : []))
    .all() as { results: Record<string, any>[] };

  for (const entry of entries) {
    const id = entry.id as string;
    const oldVectorIds: string[] = JSON.parse(entry.vector_ids as string ?? "[]");
    const tags: string[] = JSON.parse(entry.tags as string ?? "[]");
    const ownerUserId = (entry as any).owner_user_id as string ?? "";
    const visibility = entry.visibility as string;
    if (visibility !== "private" && visibility !== "public") {
      failed++;
      continue;
    }
    const isPrivate = visibility === "private";

    try {
      // Upsert first so a failed re-embed leaves the last known-good vectors
      // intact. Delete only ids that the new chunk layout no longer references.
      const newVectorIds = await storeEntry(
        env, id, entry.content as string, tags, entry.source as string,
        entry.created_at as number, ownerUserId || undefined, isPrivate
      );
      await deleteStaleVectors(env, oldVectorIds, newVectorIds);
      processed++;
    } catch (e) {
      console.error(`Re-index failed for entry ${id} (non-fatal):`, e);
      failed++;
    }
  }

  return { processed, failed };
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
  ["openai_project_key", /\bsk-(?:proj|svcacct)-[A-Za-z0-9_-]{20,}\b/],
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
  if (effectiveSourceUrl && Array.from(effectiveSourceUrl).length > SOURCE_URL_MAX_CODE_POINTS) {
    throw new CaptureRejectedError("source_url_too_long");
  }
  if (sourceTitle && Array.from(sourceTitle).length > SOURCE_TITLE_MAX_CODE_POINTS) {
    throw new CaptureRejectedError("source_title_too_long");
  }
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

// ─── Passage creation (Ticket 07) ───────────────────────────────────────────
// Chunk content into passages for citation-level recall.

const PASSAGE_CHUNK_CHARS = 1500;  // ~512 tokens
const PASSAGE_OVERLAP_CHARS = 400; // ~128 tokens

function findParentSection(headers: { level: number; title: string; offset: number }[], currentIndex: number): string | null {
  const currentLevel = headers[currentIndex].level;
  for (let i = currentIndex - 1; i >= 0; i--) {
    if (headers[i].level < currentLevel) return headers[i].title;
  }
  return null;
}

function chunkIntoPassages(content: string): { chunks: { text: string; section: string | null; startOffset: number; endOffset: number }[]; headers: { level: number; title: string; offset: number }[] } {
  const sections: { text: string; section: string | null; startOffset: number; endOffset: number }[] = [];
  // Split on markdown headers to detect sections
  const headerRegex = /^(#{1,4})\s+(.+)$/gm;
  const headers: { level: number; title: string; offset: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = headerRegex.exec(content)) !== null) {
    headers.push({ level: m[1].length, title: m[2].trim(), offset: m.index });
  }

  // If no headers, treat entire content as one section
  if (headers.length === 0) {
    for (let i = 0; i < content.length; i += PASSAGE_CHUNK_CHARS - PASSAGE_OVERLAP_CHARS) {
      const end = Math.min(i + PASSAGE_CHUNK_CHARS, content.length);
      sections.push({ text: content.slice(i, end), section: null, startOffset: i, endOffset: end });
      if (end >= content.length) break;
    }
    return { chunks: sections, headers: [] };
  }

  // Chunk within each section
  for (let h = 0; h < headers.length; h++) {
    const start = headers[h].offset;
    const end = h + 1 < headers.length ? headers[h + 1].offset : content.length;
    const sectionText = content.slice(start, end);
    const sectionName = headers[h].title;

    for (let i = 0; i < sectionText.length; i += PASSAGE_CHUNK_CHARS - PASSAGE_OVERLAP_CHARS) {
      const chunkEnd = Math.min(i + PASSAGE_CHUNK_CHARS, sectionText.length);
      sections.push({
        text: sectionText.slice(i, chunkEnd),
        section: sectionName,
        startOffset: start + i,
        endOffset: start + chunkEnd,
      });
      if (chunkEnd >= sectionText.length) break;
    }
  }

  return { chunks: sections, headers };
}

export async function createPassagesForEntry(
  entryId: string,
  episodeId: string,
  content: string,
  env: Env,
  ctx: ExecutionContext,
  ownerUserId?: string,
  isPrivate?: boolean
): Promise<void> {
  const { chunks, headers } = chunkIntoPassages(content);
  const now = Date.now();

  // Compatibility helper: preserve the same one-document-per-episode contract
  // as the canonical versioning service, even when no hierarchy is present.
  const docId = crypto.randomUUID();
  const sectionMap = new Map<string, string>(); // section title -> section id
  const title = headers[0]?.title ?? "Untitled Memory";
  try {
    await env.DB.prepare(
      `INSERT INTO documents (
         id, title, source_url, content_type, created_at, episode_id,
         owner_user_id, content_hash, version
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      docId,
      title,
      null,
      headers.length > 0 ? "research" : "text",
      now,
      episodeId,
      ownerUserId ?? "",
      await sha256Hex(content),
      "1",
    ).run();

    for (let i = 0; i < headers.length; i++) {
      const sectionId = crypto.randomUUID();
      const parentTitle = findParentSection(headers, i);
      const parentSectionId = parentTitle ? sectionMap.get(parentTitle) ?? null : null;
      await env.DB.prepare(
        `INSERT INTO document_sections (
           id, document_id, parent_section_id, title, level, order_index,
           created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind(sectionId, docId, parentSectionId, headers[i].title, headers[i].level, i, now).run();
      sectionMap.set(headers[i].title, sectionId);
    }
  } catch (e) {
    console.error("Document hierarchy insert failed (non-fatal):", e);
    return;
  }

  for (const chunk of chunks) {
    const passageId = crypto.randomUUID();
    try {
      await env.DB.prepare(
        `INSERT INTO passages (
           id, entry_id, episode_id, document_id, section_id, content,
           section, page, page_end, start_offset, end_offset, vector_ids,
           created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        passageId,
        entryId,
        episodeId,
        docId,
        chunk.section ? sectionMap.get(chunk.section) ?? null : null,
        chunk.text,
        chunk.section,
        null,
        null,
        chunk.startOffset,
        chunk.endOffset,
        "[]",
        now,
      ).run();
    } catch (e) {
      console.error("Passage insert failed (non-fatal):", e);
      continue;
    }

    // Vectorize passage — fire-and-forget
    ctx.waitUntil(
      (async () => {
        try {
          const values = await embed(chunk.text, env);
          const vectorId = `passage-${passageId}`;
          await env.VECTORIZE.insert([{ id: vectorId, values, metadata: { content: chunk.text, passageId, entryId, parentId: entryId, section: chunk.section ?? "", source: "passage", owner_user_id: ownerUserId ?? "", is_private: isPrivate ?? false } }]);
          await env.DB.prepare(`UPDATE passages SET vector_ids = ? WHERE id = ?`).bind(JSON.stringify([vectorId]), passageId).run();
        } catch (e) {
          console.error("Passage vectorize failed (non-fatal):", e);
        }
      })()
    );
  }
}
