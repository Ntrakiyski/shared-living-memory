/**
 * mcp-results.ts — Shared result envelope, safe domain-error mapping, serializer.
 *
 * Purpose: one honest result shape for every new or modified MCP handler and the
 *   new REST endpoints, so a caller can distinguish "no results" from "the
 *   dependency failed" and never sees raw SQL, hashes or credentials.
 * Input: domain values or thrown domain errors.
 * Output: `SlmResult<T>` objects plus a text-safe serializer.
 * Logic: a server-generated request id per call, a fixed error table, and
 *   post-commit cleanup failures reported as success-with-warning rather than
 *   as a failed write.
 */

import type { ActorContext, Env } from "./types";
import type { BatchCaptureItem, BatchCaptureResult } from "./ingest";
import { decideOperatorAction, OperatorPolicyError } from "./operator-policy";
import { sanitizeSourceMetadataForOutput } from "./source-metadata";

export interface SlmSuccess<T> {
  ok: true;
  data: T;
  request_id: string;
  warnings: string[];
}

export interface SlmFailure {
  ok: false;
  error: {
    code: string;
    message: string;
    retryable: boolean;
    details?: Record<string, unknown>;
  };
  request_id: string;
}

export type SlmResult<T> = SlmSuccess<T> | SlmFailure;

/** A server-generated identifier for this request. Never derived from input. */
export function requestId(): string {
  return crypto.randomUUID();
}

export function okResult<T>(data: T, warnings: string[] = [], id = requestId()): SlmSuccess<T> {
  return { ok: true, data, request_id: id, warnings };
}

export function failResult(
  code: string,
  message: string,
  retryable: boolean,
  details?: Record<string, unknown>,
  id = requestId(),
): SlmFailure {
  return {
    ok: false,
    error: { code, message, retryable, ...(details ? { details } : {}) },
    request_id: id,
  };
}

/** Non-retryable by default: bounded input problems do not improve on retry. */
export const NON_RETRYABLE_CODES = new Set([
  "invalid_request",
  "invalid_cursor",
  "invalid_profile",
  "invalid_credentials",
  "forbidden",
  "not_found_or_inaccessible",
  "not_owner",
  "revision_conflict",
  "invalid_transition",
  "idempotency_conflict",
  "capture_erased",
]);

/** Retryable only under the per-operation rules in Section 15. */
export const RETRYABLE_CODES = new Set([
  "receipt_unavailable",
  "storage_unavailable",
  "semantic_unavailable",
  "rate_limited",
]);

export interface MappedError {
  code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

/**
 * Map a thrown domain error to a safe code, message and retry decision. Raw
 * messages are never forwarded: the caller learns the field and the limit, not
 * the rejected value.
 */
export function mapDomainError(error: unknown): MappedError {
  if (error instanceof OperatorPolicyError) return { code: "forbidden", message: "The credential is not authorized for this action.", retryable: false };
  const candidate = error as { code?: unknown; retryable?: unknown; details?: unknown; name?: unknown } | null;
  const code = typeof candidate?.code === "string" ? candidate.code : null;

  if (code === "capture_erased") {
    return {
      code,
      message: "This capture was permanently erased and will not be recreated.",
      retryable: false,
      details: sanitizeDetails(candidate?.details),
    };
  }
  if (code === "idempotency_conflict") {
    return {
      code,
      message: "This idempotency key was already used with different content.",
      retryable: false,
      details: sanitizeDetails(candidate?.details),
    };
  }
  if (code === "receipt_unavailable") {
    return {
      code,
      message: "The committed capture for this key is temporarily unavailable. Retry the same key.",
      retryable: true,
      details: sanitizeDetails(candidate?.details),
    };
  }

  // Capture validation codes identify the field and its limit, never the value.
  switch (code) {
    case "content_too_large":
      return { code, message: "Content exceeds the maximum capture size.", retryable: false, details: { field: "content" } };
    case "too_many_tags":
      return { code, message: "Too many tags were supplied.", retryable: false, details: { field: "tags", max: 25 } };
    case "tag_too_long":
      return { code, message: "A tag exceeds the maximum length.", retryable: false, details: { field: "tags", max_code_points: 64 } };
    case "source_url_too_long":
      return { code, message: "The source URL exceeds the maximum length.", retryable: false, details: { field: "source_url", max_code_points: 2048 } };
    case "source_title_too_long":
      return { code, message: "The source title exceeds the maximum length.", retryable: false, details: { field: "source_title", max_code_points: 512 } };
    case "secret_detected":
      return { code, message: "The value looks like a credential and was not stored.", retryable: false, details: { field: "content" } };
    case "invalid_input":
    case "invalid_request":
      return { code: "invalid_request", message: "The request was not valid.", retryable: false, details: sanitizeDetails(candidate?.details) };
    case "invalid_actor":
    case "inactive_service":
    case "inactive_credential":
    case "expired_credential":
    case "scope_escalation":
    case "invalid_credentials":
      return { code: "invalid_credentials", message: "The credential is no longer active or valid.", retryable: false };
    case "forbidden":
    case "human_review_required":
      return { code: "forbidden", message: "This account is not authorized for the requested action.", retryable: false };
    case "not_found_or_inaccessible":
    case "not_found":
      return { code: "not_found_or_inaccessible", message: "No such record is available to this account.", retryable: false };
    case "not_owner":
      return {
        code,
        message: "Only the memory owner can change this record directly. The current content stays readable.",
        retryable: false,
      };
    case "stale":
    case "revision_conflict":
      return {
        code: "revision_conflict",
        message: "The record changed since it was read. Re-read it and retry with the current revision.",
        retryable: false,
        details: sanitizeDetails(candidate?.details),
      };
    case "invalid_transition":
      return { code, message: "That status change is not allowed.", retryable: false, details: sanitizeDetails(candidate?.details) };
    case "invalid_cursor":
      return { code, message: "The cursor is not valid for this query.", retryable: false };
    case "invalid_profile":
      return { code, message: "X-SLM-Tool-Profile must be capture, review or full.", retryable: false };
    case "vector_stage_failed":
      return { code: "semantic_unavailable", message: "Semantic storage is temporarily unavailable.", retryable: true };
    case "database_commit_failed":
    case "storage_unavailable":
      return { code: "storage_unavailable", message: "Shared Living Memory storage is temporarily unavailable.", retryable: true };
    case "semantic_unavailable":
      return { code, message: "Semantic search is temporarily unavailable; keyword retrieval still works.", retryable: true };
    default:
      break;
  }

  // An unrecognized failure is treated as a transient storage problem, so the
  // caller may retry it rather than being told it is permanently invalid.
  const retryable = typeof candidate?.retryable === "boolean"
    ? candidate.retryable
    : code === null || RETRYABLE_CODES.has(code);
  return {
    code: code ?? "storage_unavailable",
    message: "The operation could not be completed.",
    retryable,
  };
}

function sanitizeDetails(details: unknown): Record<string, unknown> | undefined {
  if (!details || typeof details !== "object" || Array.isArray(details)) return undefined;
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details as Record<string, unknown>)) {
    if (value === null || typeof value === "number" || typeof value === "boolean") {
      safe[key] = value;
      continue;
    }
    if (typeof value === "string" && value.length <= 512 && !/secret|token|key|hash|password/i.test(key)) {
      safe[key] = value;
    }
  }
  return Object.keys(safe).length ? safe : undefined;
}

/**
 * Report a write that committed but whose post-commit cleanup or audit step did
 * not finish. The caller is told the truth: the write happened.
 */
export function committedWithWarning<T>(
  committed: T,
  warning: string,
  id = requestId(),
): SlmSuccess<T> {
  return { ok: true, data: committed, request_id: id, warnings: [warning] };
}

/** Text-safe rendering for clients that negotiate an older protocol version. */
export function summarizeResult(result: SlmResult<unknown>): string {
  if (result.ok) {
    const warnings = result.warnings.length ? ` Warnings: ${result.warnings.join("; ")}` : "";
    return `OK (${result.request_id}).${warnings}`;
  }
  return `Error ${result.error.code} (${result.request_id}): ${result.error.message}`;
}

/** MCP tool result shape for a failed tool: `isError` is explicit. */
export function toToolError(result: SlmFailure): {
  isError: true;
  structuredContent: Record<string, unknown>;
  content: { type: "text"; text: string }[];
} {
  return {
    isError: true,
    // The SDK types structuredContent as an open object; the envelope is a
    // closed interface, so it is widened at this single boundary.
    structuredContent: result as unknown as Record<string, unknown>,
    content: [{ type: "text", text: summarizeResult(result) }],
  };
}

export function toToolSuccess<T>(result: SlmSuccess<T>, text: string): {
  structuredContent: Record<string, unknown>;
  content: { type: "text"; text: string }[];
} {
  return {
    structuredContent: result as unknown as Record<string, unknown>,
    content: [{ type: "text", text: text + (result.warnings.length ? `\nWarnings: ${result.warnings.join("; ")}` : "") }],
  };
}

/** Environment-derived metadata surfaced by /health, /ready and whoami. */
export interface DeploymentMetadata {
  id: string;
  environment: string;
  canonical_url: string;
  release_id: string;
  write_mode: string;
}

export interface DeploymentMetadataResult {
  metadata: DeploymentMetadata;
  missing: string[];
}

export function readDeploymentMetadata(env: Partial<Env> & Record<string, unknown>): DeploymentMetadataResult {
  const read = (key: string): string => {
    const value = env[key];
    return typeof value === "string" ? value.trim() : "";
  };
  const metadata: DeploymentMetadata = {
    id: read("SLM_DEPLOYMENT_ID"),
    environment: read("SLM_ENVIRONMENT"),
    canonical_url: read("SLM_PUBLIC_BASE_URL"),
    release_id: read("SLM_RELEASE_ID"),
    write_mode: read("SLM_WRITE_MODE") || "enabled",
  };
  const missing = [
    ["SLM_DEPLOYMENT_ID", metadata.id],
    ["SLM_ENVIRONMENT", metadata.environment],
    ["SLM_PUBLIC_BASE_URL", metadata.canonical_url],
    ["SLM_RELEASE_ID", metadata.release_id],
  ].filter(([, value]) => !value).map(([key]) => key as string);
  return { metadata, missing };
}

// ─── Entry descriptor (Section 4.3) ──────────────────────────────────────────
// Every capture/read descriptor names its fields explicitly: never a bare
// ambiguous `id`, and never another owner's content.

export type LifecycleStatus = "canonical" | "draft" | "deprecated" | null;

export interface EntryDescriptorPermissions {
  read_current: boolean;
  read_history: boolean;
  mutate_directly: boolean;
  submit_change_proposal: boolean;
}

export interface EntryDescriptor {
  entry_id: string;
  revision: number;
  owner: { id: string; username: string | null };
  visibility: "private" | "public";
  lifecycle_status: LifecycleStatus;
  epistemic_status: string;
  permissions: EntryDescriptorPermissions;
}

export interface DescriptorActor {
  actorId: string;
  /** The account id that owns entries this actor writes. */
  ownerUserId: string;
  isService: boolean;
  actor?: ActorContext;
  autonomyProfile?: string;
}

export function descriptorActor(actor: ActorContext, autonomyProfile?: string): DescriptorActor {
  return {
    actorId: actor.actorId,
    ownerUserId: actor.kind === "human" ? actor.userId : actor.kind === "service" ? actor.ownerUserId : actor.systemId,
    isService: actor.kind === "service",
    actor,
    autonomyProfile,
  };
}

export function principalCapabilities(actor: ActorContext, autonomyProfile?: string) {
  const read = decideOperatorAction({ actor, operation: "memory.read", autonomyProfile }).effect === "allow";
  const capture = decideOperatorAction({
    actor, operation: "entry.create", autonomyProfile,
    directCapture: { visibility: "private", lifecycleStatus: "draft", epistemicStatus: "candidate", mayMerge: false, mayAutoDeprecate: false },
  }).effect === "allow";
  return {
    read_public: read,
    read_owner_private: read,
    direct_mutation_scope: actor.kind === "human" ? "owned_entries" : capture ? "private_drafts" : "none",
    proposal_review: actor.kind === "human" ? "account_policy" : "none",
    erase_owned_entries: actor.kind === "human",
  };
}

/**
 * Permissions are derived from the verified actor, the entry's owner and the
 * current policy — never from a role name alone. Service `read_history` is
 * allowed only for the service owner's entry, and proposal review/execution is
 * proposal-specific, so it is deliberately not asserted here.
 */
export function entryPermissions(
  actor: DescriptorActor,
  ownerUserId: string,
): EntryDescriptorPermissions {
  const actorIsOwner = Boolean(actor.ownerUserId) && actor.ownerUserId === ownerUserId;
  const canRead = !actor.isService || Boolean(actor.actor && decideOperatorAction({
    actor: actor.actor, operation: "memory.read", autonomyProfile: actor.autonomyProfile,
  }).effect === "allow");
  const canPropose = !actor.isService || Boolean(actor.actor && decideOperatorAction({
    actor: actor.actor, operation: "proposal.create", proposedAction: "entry.update", autonomyProfile: actor.autonomyProfile,
  }).effect === "allow");
  return {
    read_current: canRead,
    read_history: actorIsOwner && canRead,
    mutate_directly: actorIsOwner && !actor.isService,
    submit_change_proposal: actorIsOwner && canPropose,
  };
}

export function lifecycleStatusFromTags(tags: readonly string[]): LifecycleStatus {
  const tag = tags.find((candidate) => candidate.startsWith("status:"));
  if (!tag) return null;
  const value = tag.slice("status:".length);
  return value === "canonical" || value === "draft" || value === "deprecated" ? value : null;
}

export interface DescriptorRow {
  id: string;
  revision: number | null;
  owner_user_id: string;
  visibility: string | null;
  tags: string | null;
  epistemic_status: string | null;
}

export function buildEntryDescriptor(
  row: DescriptorRow,
  ownerUsername: string | null,
  actor: DescriptorActor,
): EntryDescriptor {
  let tags: string[] = [];
  try {
    const parsed = JSON.parse(row.tags ?? "[]");
    if (Array.isArray(parsed)) tags = parsed.filter((tag): tag is string => typeof tag === "string");
  } catch {
    tags = [];
  }
  return {
    entry_id: row.id,
    revision: Number(row.revision ?? 0),
    owner: { id: row.owner_user_id, username: ownerUsername || null },
    visibility: row.visibility === "public" ? "public" : "private",
    lifecycle_status: lifecycleStatusFromTags(tags),
    epistemic_status: row.epistemic_status ?? "canonical",
    permissions: entryPermissions(actor, row.owner_user_id),
  };
}

export function listingEntry(
  row: DescriptorRow & { content: string; created_at: number; source: string },
  ownerUsername: string | null,
  actor: DescriptorActor,
) {
  return {
    ...buildEntryDescriptor(row, ownerUsername, actor),
    ...boundContentExcerpt(row.content),
    created_at: Number(row.created_at),
    source: sanitizeSourceMetadataForOutput({ source: row.source }, row.owner_user_id === actor.ownerUserId ? "owner_mcp" : "team_public").source,
  };
}

/** Recheck current visibility when rendering metadata after retrieval or commit. */
export async function loadEntryDescriptor(env: Pick<Env, "DB">, entryId: string, actor: DescriptorActor): Promise<EntryDescriptor | null> {
  const row = await env.DB.prepare(
    `SELECT id, revision, owner_user_id, visibility, tags, epistemic_status FROM entries WHERE id = ?`,
  ).bind(entryId).first<DescriptorRow>();
  if (!row || (row.owner_user_id !== actor.ownerUserId && row.visibility !== "public")) return null;
  if (!row.owner_user_id || !Number.isSafeInteger(row.revision) || Number(row.revision) < 0) {
    throw Object.assign(new Error("Current projection metadata is unavailable"), { code: "storage_unavailable" });
  }
  const owner = await env.DB.prepare(`SELECT username FROM users WHERE id = ?`)
    .bind(row.owner_user_id).first<{ username: string }>();
  // Legacy ownership survives a missing user record; display metadata never
  // changes the owner ID or grants that owner's permissions to the reader.
  return buildEntryDescriptor(row, owner?.username ?? null, actor);
}

export interface RememberData {
  outcome: "created" | "merged" | "replaced" | "duplicate" | "replayed";
  capture_mode: "smart" | "create_only";
  entry: EntryDescriptor | null;
  receipt: { entry_id: string; episode_id: string | null; revision: number | null } | null;
  matched_entry: EntryDescriptor | null;
}

export interface CaptureCommitMetadata {
  outcome: "created" | "replayed";
  entryId: string;
  episodeId: string | null;
  committedRevision: number | null;
  warnings?: string[];
}

export async function captureResult(env: Pick<Env, "DB">, actor: DescriptorActor, commit: CaptureCommitMetadata): Promise<SlmSuccess<RememberData>> {
  const warnings = [...(commit.warnings ?? [])];
  let entry: EntryDescriptor | null = null;
  try { entry = await loadEntryDescriptor(env, commit.entryId, actor); } catch { /* The receipt remains authoritative after commit. */ }
  if (!entry) warnings.push("metadata_unavailable: current entry metadata is unavailable");
  return okResult({
    outcome: commit.outcome,
    capture_mode: "create_only",
    entry,
    receipt: { entry_id: commit.entryId, episode_id: commit.episodeId, revision: commit.committedRevision },
    matched_entry: null,
  }, [...new Set(warnings)]);
}

export interface CaptureBatchData {
  items: { client_item_id: string; status: "created" | "replayed" | "failed"; data?: RememberData; error?: MappedError }[];
  summary: { created: number; replayed: number; failed: number };
}

/** Keep every outcome and receipt; only current metadata is optional after commit. */
export async function serializeCaptureBatch(env: Pick<Env, "DB">, actor: DescriptorActor, result: BatchCaptureResult): Promise<SlmSuccess<CaptureBatchData>> {
  const items: CaptureBatchData["items"] = [];
  const warnings: string[] = [];
  for (const item of result.items) {
    if (item.status === "failed" || !item.data) {
      items.push({ client_item_id: item.client_item_id, status: "failed", error: item.error });
      continue;
    }
    const captured = await captureResult(env, actor, {
      outcome: item.status, entryId: item.data.entry_id, episodeId: item.data.episode_id,
      committedRevision: item.data.committed_revision, warnings: item.data.warnings,
    });
    items.push({ client_item_id: item.client_item_id, status: item.status, data: captured.data });
    warnings.push(...captured.warnings);
  }
  return okResult({ items, summary: result.summary }, [...new Set(warnings)]);
}

/** Both transports use the same service policy callback, once per item. */
export async function captureServiceBatch(
  env: Pick<Env, "DB">,
  actor: DescriptorActor,
  items: BatchCaptureItem[],
  capture: (item: BatchCaptureItem) => Promise<CaptureCommitMetadata>,
): Promise<SlmSuccess<CaptureBatchData>> {
  const data: CaptureBatchData = { items: [], summary: { created: 0, replayed: 0, failed: 0 } };
  const warnings: string[] = [];
  for (const item of items) {
    try {
      if (item.visibility === "public") throw Object.assign(new Error("Service captures must be private"), { code: "forbidden" });
      const committed = await capture(item);
      const result = await captureResult(env, actor, committed);
      data.items.push({ client_item_id: item.client_item_id, status: committed.outcome, data: result.data });
      data.summary[committed.outcome]++;
      warnings.push(...result.warnings);
    } catch (error) {
      data.summary.failed++;
      data.items.push({ client_item_id: item.client_item_id, status: "failed", error: mapDomainError(error) });
    }
  }
  return okResult(data, [...new Set(warnings)]);
}

// ─── Output bounds (Section 4.5) ─────────────────────────────────────────────

/** Data budget for new MCP and opt-in REST listings. */
export const LISTING_DATA_MAX_BYTES = 131_072;
/** Per-content-excerpt budget, cut at a complete Unicode code-point boundary. */
export const CONTENT_EXCERPT_MAX_BYTES = 2_048;
/** Batch data budget. */
export const BATCH_DATA_MAX_BYTES = 32_768;

export function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export interface Excerpt {
  content: string;
  content_truncated: boolean;
  original_content_bytes: number;
}

/**
 * Cut at a complete Unicode code point. A surrogate pair is never split, so the
 * excerpt is always valid text.
 */
export function boundContentExcerpt(content: string, maxBytes = CONTENT_EXCERPT_MAX_BYTES): Excerpt {
  const originalBytes = utf8Bytes(content);
  if (originalBytes <= maxBytes) {
    return { content, content_truncated: false, original_content_bytes: originalBytes };
  }
  let used = 0;
  let cut = "";
  for (const codePoint of content) {
    const codePointBytes = utf8Bytes(codePoint);
    if (used + codePointBytes > maxBytes) break;
    cut += codePoint;
    used += codePointBytes;
  }
  return { content: cut, content_truncated: true, original_content_bytes: originalBytes };
}

/**
 * Emit the longest prefix of `items` whose serialized form fits `maxBytes`.
 * Always emits at least one item when the list is non-empty, because a single
 * descriptor is bounded by construction; callers must derive any cursor from
 * the FINAL EMITTED item so no omitted row is skipped.
 */
export function fitWithinBudget<T>(
  items: readonly T[],
  maxBytes = LISTING_DATA_MAX_BYTES,
): { items: T[]; omitted: number } {
  if (items.length === 0) return { items: [], omitted: 0 };
  const emitted: T[] = [];
  let used = 2; // the enclosing brackets
  for (const item of items) {
    const size = utf8Bytes(JSON.stringify(item)) + 1; // + separator
    if (emitted.length > 0 && used + size > maxBytes) break;
    emitted.push(item);
    used += size;
  }
  return { items: emitted, omitted: items.length - emitted.length };
}

/** Budget the complete data object, including the cursor derived from its last row. */
export function fitDataPage<T, D>(items: readonly T[], makeData: (rows: T[], omitted: boolean) => D, maxBytes = LISTING_DATA_MAX_BYTES): D {
  const rows = [...items];
  while (true) {
    const data = makeData(rows, rows.length < items.length);
    if (utf8Bytes(JSON.stringify(data)) <= maxBytes) return data;
    if (rows.length <= 1) throw Object.assign(new Error("Response metadata exceeds its budget"), { code: "storage_unavailable" });
    rows.pop();
  }
}

/** Report a bounded page's shape so a caller can tell truncation from absence. */
export function pageCounts(returned: number, total: number): { returned: number; total: number; truncated: boolean } {
  return { returned, total, truncated: total > returned };
}
