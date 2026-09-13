/**
 * capture-receipts.ts — Retry identity for keyed capture.
 *
 * Purpose: one durable, actor-namespaced receipt per idempotency key so a
 *   retried capture replays its original commit instead of creating a second
 *   memory. An erased key is terminal: a replay never recreates deleted content.
 * Input: verified actor namespace, the caller's retry key, and the normalized
 *   write meaning of the capture.
 * Output: key/request digests, authorized receipt lookups, typed commit
 *   descriptors, and the D1 statements that stage, fence and tombstone receipts.
 * Logic: SHA-256 over an actor-namespaced trimmed key; a request hash over the
 *   normalized write meaning only (never client labels, timestamps or generated
 *   ids); erased state is evaluated before any payload comparison.
 */

import { sha256Hex, stableJson, sqlChanges } from "./governance-utils";
import type { Env, EntryVisibility } from "./types";

// ─── Fixed contract values ────────────────────────────────────────────────────

/** Capture with a retry key is always create-only: no merge, replace or dedupe. */
export const CAPTURE_MODE_CREATE_ONLY = "create-only";
export const CAPTURE_MODE_SMART = "smart";

/** Retry-key bound: trimmed, 1–240 Unicode code points. */
export const IDEMPOTENCY_KEY_MIN_CODE_POINTS = 1;
export const IDEMPOTENCY_KEY_MAX_CODE_POINTS = 240;

/** Capture-stage lease: 600000ms, compared against database time. */
export const CAPTURE_STAGE_LEASE_MS = 600_000;

/**
 * Marks "the transport default applies" inside a request hash. A literal
 * marker — not the resolved display name — is hashed, so renaming an account or
 * service cannot change the meaning of an already-recorded retry.
 */
export const ACTOR_DEFAULT_SOURCE_MARKER = "__actor_default_source__";

/** SQLite expression for the current time in epoch milliseconds. */
export const DB_NOW_MS_SQL =
  "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";

export type CaptureActorKind = "human" | "service";
export type CaptureReceiptState = "committed" | "erased";

/** The authenticated actor namespace a retry key belongs to. */
export interface CaptureActorNamespace {
  kind: CaptureActorKind;
  actorId: string;
}

/** Everything that makes two keyed captures "the same request". */
export interface CaptureWriteMeaning {
  /** Exact raw input, before hashtag extraction or materialization. */
  content: string;
  /** Deduplicated, lowercase, sorted tags as they will be persisted. */
  tags: readonly string[];
  /** Explicit source declaration, or ACTOR_DEFAULT_SOURCE_MARKER. */
  sourceDeclaration: string;
  sourceUrl: string | null;
  sourceTitle: string | null;
  visibility: EntryVisibility;
  contentType: string;
}

export interface CaptureReceiptRow {
  actor_kind: CaptureActorKind;
  actor_id: string;
  key_hash: string;
  request_hash: string | null;
  entry_id: string;
  episode_id: string | null;
  mutation_id: string | null;
  revision: number | null;
  state: CaptureReceiptState;
  created_at: number;
  erased_at: number | null;
}

/**
 * The original committed capture as recorded by the receipt. `revision` is the
 * revision produced by that capture and is deliberately not the entry's current
 * revision — later edits do not rewrite history.
 */
export interface CaptureReplayDescriptor {
  entryId: string;
  episodeId: string | null;
  mutationId: string | null;
  revision: number | null;
  requestHash: string;
  committedAt: number;
}

export type CaptureReceiptLookup =
  | { status: "absent" }
  | { status: "erased"; entryId: string; erasedAt: number | null }
  | { status: "replayed"; descriptor: CaptureReplayDescriptor }
  | { status: "conflict"; entryId: string }
  | { status: "unavailable"; entryId: string };

/**
 * Typed input to the version service. Generated entry/episode/revision values
 * are produced inside commitEntryVersion and are never accepted from callers.
 */
export interface CaptureReceiptCommitDescriptor {
  actorKind: CaptureActorKind;
  actorId: string;
  keyHash: string;
  requestHash: string;
  /** Capture-attempt id: the durable stage-intent row that owns this commit. */
  attemptId: string;
}

export type CaptureReceiptErrorCode =
  | "capture_erased"
  | "idempotency_conflict"
  | "receipt_unavailable";

export class CaptureReceiptError extends Error {
  readonly code: CaptureReceiptErrorCode;
  readonly retryable: boolean;
  readonly details: Record<string, unknown>;

  constructor(
    code: CaptureReceiptErrorCode,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "CaptureReceiptError";
    this.code = code;
    this.retryable = code === "receipt_unavailable";
    this.details = details;
  }
}

/** Thrown when the durable stage intent is gone, claimed or expired. */
export class CaptureStageLostError extends Error {
  readonly attemptId: string;
  constructor(attemptId: string) {
    super("The capture attempt lost its stage-intent fence");
    this.name = "CaptureStageLostError";
    this.attemptId = attemptId;
  }
}

// ─── Normalization and hashing ────────────────────────────────────────────────

/** Trim only. Case and internal punctuation are part of the caller's key. */
export function normalizeIdempotencyKey(raw: string): string {
  return typeof raw === "string" ? raw.trim() : "";
}

export function idempotencyKeyCodePoints(key: string): number {
  return [...key].length;
}

export function isValidIdempotencyKey(raw: unknown): raw is string {
  if (typeof raw !== "string") return false;
  const key = normalizeIdempotencyKey(raw);
  const length = idempotencyKeyCodePoints(key);
  return length >= IDEMPOTENCY_KEY_MIN_CODE_POINTS
    && length <= IDEMPOTENCY_KEY_MAX_CODE_POINTS;
}

/**
 * Digest of the trimmed retry key. The actor namespace is supplied by the
 * composite primary key, never folded into this digest, so the same key can be
 * used independently by two actors.
 */
export async function captureKeyHash(rawKey: string): Promise<string> {
  return sha256Hex(normalizeIdempotencyKey(rawKey));
}

/**
 * Legacy service fingerprint. Older service keys derived a deterministic entry
 * id and mutation id from this exact shape; it is retained only so an existing
 * capture can be recognized once and then backfilled into the new format.
 */
export async function legacyServiceKeyHash(
  serviceIdentityId: string,
  rawKey: string,
): Promise<string> {
  return sha256Hex(`${serviceIdentityId}:${normalizeIdempotencyKey(rawKey)}`);
}

export function legacyServiceEntryId(keyHash: string): string {
  return `opdraft:${keyHash.slice(0, 40)}`;
}

/**
 * Order-preserving legacy request fingerprint. Kept only for reading captures
 * written before this release; never used for new writes.
 */
export async function legacyServiceRequestHash(meaning: {
  content: string;
  tags: readonly string[];
  source: string;
  sourceUrl: string | null;
  contentType: string | null;
  title: string | null;
}): Promise<string> {
  return sha256Hex(stableJson({
    content: meaning.content,
    tags: [...meaning.tags],
    source: meaning.source,
    sourceUrl: meaning.sourceUrl,
    contentType: meaning.contentType,
    title: meaning.title,
  }));
}

export function legacyServiceMutationId(keyHash: string, requestHash: string): string {
  return `operator:${keyHash.slice(0, 24)}:${requestHash}`;
}

/** Deduplicated, lowercase, sorted tags — order is not part of retry identity. */
export function normalizedCaptureTags(tags: readonly string[]): string[] {
  return [...new Set(tags.map((tag) => tag.toLowerCase()))].sort();
}

/**
 * Hash of the normalized write meaning. Excludes client labels, timestamps,
 * request ids and generated artifacts; includes the effective visibility and
 * the actor-default marker rather than a mutable display name.
 */
export async function captureRequestHash(meaning: CaptureWriteMeaning): Promise<string> {
  return sha256Hex(stableJson({
    mode: CAPTURE_MODE_CREATE_ONLY,
    content: meaning.content,
    tags: normalizedCaptureTags(meaning.tags),
    source: meaning.sourceDeclaration,
    sourceUrl: meaning.sourceUrl,
    sourceTitle: meaning.sourceTitle,
    visibility: meaning.visibility,
    contentType: meaning.contentType,
  }));
}

// ─── Receipt lookup ───────────────────────────────────────────────────────────

interface ReceiptLookupRow extends CaptureReceiptRow {
  live_entry_id: string | null;
  live_revision: number | null;
}

/**
 * Load the receipt together with the authorized current projection in one
 * snapshot. Erased state is evaluated before any payload comparison so a replay
 * of an erased key can never fall through to a create.
 */
export async function lookupCaptureReceipt(
  env: Pick<Env, "DB">,
  namespace: CaptureActorNamespace,
  keyHash: string,
  requestHash: string,
  expectedOwnerUserId: string,
): Promise<CaptureReceiptLookup> {
  const row = await env.DB.prepare(
    `SELECT r.actor_kind, r.actor_id, r.key_hash, r.request_hash, r.entry_id,
            r.episode_id, r.mutation_id, r.revision, r.state, r.created_at,
            r.erased_at,
            e.id AS live_entry_id, e.revision AS live_revision
     FROM capture_receipts r
     LEFT JOIN entries e
       ON e.id = r.entry_id AND e.owner_user_id = ?
     WHERE r.actor_kind = ? AND r.actor_id = ? AND r.key_hash = ?`,
  ).bind(expectedOwnerUserId, namespace.kind, namespace.actorId, keyHash)
    .first<ReceiptLookupRow>();

  if (!row) return { status: "absent" };

  if (row.state === "erased") {
    // Terminal. Never compared, never recreated.
    return { status: "erased", entryId: row.entry_id, erasedAt: row.erased_at };
  }

  if (row.request_hash !== requestHash) {
    return { status: "conflict", entryId: row.entry_id };
  }

  if (row.live_entry_id === null) {
    // Committed receipt whose target is gone: never recaptured, never silent.
    return { status: "unavailable", entryId: row.entry_id };
  }

  return {
    status: "replayed",
    descriptor: {
      entryId: row.entry_id,
      episodeId: row.episode_id,
      mutationId: row.mutation_id,
      revision: row.revision === null ? null : Number(row.revision),
      requestHash: row.request_hash ?? requestHash,
      committedAt: Number(row.created_at),
    },
  };
}

/** Convert a non-replayable receipt outcome into its public domain error. */
export function captureReceiptError(lookup: CaptureReceiptLookup): CaptureReceiptError | null {
  switch (lookup.status) {
    case "erased":
      return new CaptureReceiptError(
        "capture_erased",
        "This capture was permanently erased and will not be recreated.",
        { entry_id: lookup.entryId },
      );
    case "conflict":
      return new CaptureReceiptError(
        "idempotency_conflict",
        "This idempotency key was already used with different content.",
        { entry_id: lookup.entryId },
      );
    case "unavailable":
      return new CaptureReceiptError(
        "receipt_unavailable",
        "The committed capture for this key is temporarily unavailable.",
        { entry_id: lookup.entryId },
      );
    default:
      return null;
  }
}

// ─── Durable stage intent and fencing ─────────────────────────────────────────

/**
 * Persist the capture-stage intent before any remote vector upsert. The planned
 * vector ids belong to this attempt only; the lease is compared against
 * database time so a Worker restart cannot extend or shorten it.
 */
export async function beginCaptureStage(
  env: Pick<Env, "DB">,
  input: {
    attemptId: string;
    entryId: string;
    episodeId: string;
    vectorIds: readonly string[];
    reason: string;
    leaseMs?: number;
  },
): Promise<void> {
  const leaseMs = input.leaseMs ?? CAPTURE_STAGE_LEASE_MS;
  await env.DB.prepare(
    `INSERT INTO vector_cleanup_queue (
       id, vector_ids, reason, attempts, last_error, created_at, updated_at,
       kind, stage_entry_id, stage_episode_id, lease_expires_at, claim_token
     ) VALUES (?, ?, ?, 0, NULL, ${DB_NOW_MS_SQL}, ${DB_NOW_MS_SQL},
               'capture_stage', ?, ?, ${DB_NOW_MS_SQL} + ?, NULL)`,
  ).bind(
    input.attemptId,
    JSON.stringify([...input.vectorIds]),
    input.reason,
    input.entryId,
    input.episodeId,
    leaseMs,
  ).run();
}

/**
 * True while this exact intent exists, is still unclaimed and has not expired.
 * Used before every remote upsert and again before the commit batch.
 */
export async function captureStageIsIntact(
  env: Pick<Env, "DB">,
  attemptId: string,
): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT id FROM vector_cleanup_queue
     WHERE id = ? AND kind = 'capture_stage'
       AND claim_token IS NULL
       AND lease_expires_at IS NOT NULL
       AND lease_expires_at > ${DB_NOW_MS_SQL}`,
  ).bind(attemptId).first<{ id: string }>();
  return row !== null;
}

export async function assertCaptureStageIntact(
  env: Pick<Env, "DB">,
  attemptId: string,
): Promise<void> {
  if (!await captureStageIsIntact(env, attemptId)) {
    throw new CaptureStageLostError(attemptId);
  }
}

/** SQL predicate matching a stage intent that is still allowed to commit. */
function intactStagePredicate(attemptId: string): string {
  return `EXISTS (SELECT 1 FROM vector_cleanup_queue
            WHERE id = '${attemptId.replace(/'/g, "''")}'
              AND kind = 'capture_stage'
              AND claim_token IS NULL
              AND lease_expires_at IS NOT NULL
              AND lease_expires_at > ${DB_NOW_MS_SQL})`;
}

/** SQL predicate matching this attempt's committed receipt. */
function committedReceiptPredicate(descriptor: CaptureReceiptCommitDescriptor): string {
  const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;
  return `EXISTS (SELECT 1 FROM capture_receipts
            WHERE actor_kind = ${quote(descriptor.actorKind)}
              AND actor_id = ${quote(descriptor.actorId)}
              AND key_hash = ${quote(descriptor.keyHash)}
              AND state = 'committed')`;
}

/**
 * The receipt insert is the first statement of the capture batch and is guarded
 * by the stage fence. Everything that follows is guarded on this receipt, so a
 * lost fence leaves no partial rows behind.
 */
export function captureReceiptInsertStatement(
  env: Pick<Env, "DB">,
  descriptor: CaptureReceiptCommitDescriptor,
  values: { entryId: string; episodeId: string; mutationId: string; revision: number },
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO capture_receipts (
       actor_kind, actor_id, key_hash, request_hash, entry_id, episode_id,
       mutation_id, revision, state, created_at, erased_at
     )
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'committed', ${DB_NOW_MS_SQL}, NULL
     WHERE ${intactStagePredicate(descriptor.attemptId)}`,
  ).bind(
    descriptor.actorKind,
    descriptor.actorId,
    descriptor.keyHash,
    descriptor.requestHash,
    values.entryId,
    values.episodeId,
    values.mutationId,
    values.revision,
  );
}

/** Guards a fresh artifact insert on this attempt's committed receipt. */
export function captureArtifactGuard(descriptor: CaptureReceiptCommitDescriptor): string {
  return committedReceiptPredicate(descriptor);
}

/**
 * Remove the stage intent. Guarded so a fence that was claimed or expired
 * mid-flight keeps its row for the repair worker instead of disappearing.
 */
export function captureStageReleaseStatement(
  env: Pick<Env, "DB">,
  attemptId: string,
): D1PreparedStatement {
  return env.DB.prepare(
    `DELETE FROM vector_cleanup_queue WHERE id = ? AND ${intactStagePredicate(attemptId)}`,
  ).bind(attemptId);
}

/** Confirm the receipt insert won its fence; zero rows is an abandoned attempt. */
export function captureReceiptInserted(results: D1Result<unknown>[]): boolean {
  return sqlChanges(results[0]) === 1;
}

// ─── Erasure and legacy backfill ──────────────────────────────────────────────

/**
 * Tombstone every receipt that points at an erased entry, in the same atomic
 * batch as the deletion. The erased state clears every non-tombstone field so a
 * later replay has nothing to replay and nothing to compare.
 */
export function captureReceiptTombstoneStatement(
  env: Pick<Env, "DB">,
  entryId: string,
): D1PreparedStatement {
  return env.DB.prepare(
    `UPDATE capture_receipts
     SET state = 'erased', request_hash = NULL, episode_id = NULL,
         mutation_id = NULL, revision = NULL, erased_at = ${DB_NOW_MS_SQL}
     WHERE entry_id = ? AND state = 'committed'`,
  ).bind(entryId);
}

/**
 * Backfill a committed receipt for a legacy service capture. Guarded on the
 * entry still existing; a concurrent erase wins because the guard re-reads
 * within the same transaction.
 */
export function legacyReceiptBackfillStatement(
  env: Pick<Env, "DB">,
  descriptor: CaptureReceiptCommitDescriptor,
  values: { entryId: string; episodeId: string; mutationId: string; revision: number },
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO capture_receipts (
       actor_kind, actor_id, key_hash, request_hash, entry_id, episode_id,
       mutation_id, revision, state, created_at, erased_at
     )
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'committed', ${DB_NOW_MS_SQL}, NULL
     WHERE EXISTS (SELECT 1 FROM entries WHERE id = ?)
       AND NOT EXISTS (SELECT 1 FROM erasure_receipts WHERE entry_id = ?)`,
  ).bind(
    descriptor.actorKind,
    descriptor.actorId,
    descriptor.keyHash,
    descriptor.requestHash,
    values.entryId,
    values.episodeId,
    values.mutationId,
    values.revision,
    values.entryId,
    values.entryId,
  );
}

export function legacyReceiptBackfilled(results: D1Result<unknown>[]): boolean {
  return sqlChanges(results[0]) === 1;
}

/**
 * Read the original capture episode for a legacy deterministic draft id. The
 * earliest `capture` episode is the immutable record of how the retry key was
 * first used, including the source label that was actually resolved then.
 */
export async function loadLegacyCaptureProvenance(
  env: Pick<Env, "DB">,
  entryId: string,
): Promise<{
  entryId: string;
  ownerUserId: string;
  revision: number;
  episodeId: string;
  mutationId: string | null;
  content: string;
  tags: string;
  source: string;
  sourceUrl: string | null;
  contentType: string | null;
} | null> {
  const row = await env.DB.prepare(
    `SELECT e.id AS entry_id, e.owner_user_id, e.revision, e.tags,
            ep.id AS episode_id, ep.mutation_id, ep.content, ep.source,
            ep.source_url, ep.content_type
     FROM entries e
     JOIN episodes ep ON ep.entry_id = e.id AND ep.mutation_kind = 'capture'
     WHERE e.id = ?
     ORDER BY ep.created_at ASC, ep.id ASC
     LIMIT 1`,
  ).bind(entryId).first<{
    entry_id: string;
    owner_user_id: string;
    revision: number;
    tags: string;
    episode_id: string;
    mutation_id: string | null;
    content: string;
    source: string;
    source_url: string | null;
    content_type: string | null;
  }>();
  if (!row) return null;
  return {
    entryId: row.entry_id,
    ownerUserId: row.owner_user_id,
    revision: Number(row.revision),
    episodeId: row.episode_id,
    mutationId: row.mutation_id,
    content: row.content,
    tags: row.tags,
    source: row.source,
    sourceUrl: row.source_url,
    contentType: row.content_type,
  };
}

/** True when an erasure receipt already exists for this entry id. */
export async function entryHasErasureReceipt(
  env: Pick<Env, "DB">,
  entryId: string,
): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT operation_id FROM erasure_receipts WHERE entry_id = ? LIMIT 1`,
  ).bind(entryId).first<{ operation_id: string }>();
  return row !== null;
}

/**
 * Create or read an erased tombstone for a legacy capture whose entry was
 * deleted before receipts existed. Nothing is recreated.
 */
export async function ensureErasedCaptureTombstone(
  env: Pick<Env, "DB">,
  namespace: CaptureActorNamespace,
  keyHash: string,
  entryId: string,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO capture_receipts (
       actor_kind, actor_id, key_hash, request_hash, entry_id, episode_id,
       mutation_id, revision, state, created_at, erased_at
     ) VALUES (?, ?, ?, NULL, ?, NULL, NULL, NULL, 'erased',
               ${DB_NOW_MS_SQL}, ${DB_NOW_MS_SQL})
     ON CONFLICT(actor_kind, actor_id, key_hash) DO UPDATE
       SET state = 'erased', request_hash = NULL, episode_id = NULL,
           mutation_id = NULL, revision = NULL,
           erased_at = COALESCE(capture_receipts.erased_at, ${DB_NOW_MS_SQL})`,
  ).bind(namespace.kind, namespace.actorId, keyHash, entryId).run();
}
