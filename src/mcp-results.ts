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

import type { Env } from "./types";

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
    case "invalid_request":
      return { code, message: "The request was not valid.", retryable: false, details: sanitizeDetails(candidate?.details) };
    case "not_found_or_inaccessible":
    case "not_found":
      return { code: "not_found_or_inaccessible", message: "No such record is available to this account.", retryable: false };
    case "not_owner":
      return {
        code,
        message: "Only the memory owner can change this record directly. The current content stays readable.",
        retryable: false,
      };
    case "revision_conflict":
      return {
        code,
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
    case "storage_unavailable":
      return { code, message: "Shared Living Memory storage is temporarily unavailable.", retryable: true };
    case "semantic_unavailable":
      return { code, message: "Semantic search is temporarily unavailable; keyword retrieval still works.", retryable: true };
    default:
      break;
  }

  const retryable = typeof candidate?.retryable === "boolean"
    ? candidate.retryable
    : RETRYABLE_CODES.has(code ?? "");
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
  structuredContent: SlmFailure;
  content: { type: "text"; text: string }[];
} {
  return {
    isError: true,
    structuredContent: result,
    content: [{ type: "text", text: summarizeResult(result) }],
  };
}

export function toToolSuccess<T>(result: SlmSuccess<T>, text: string): {
  structuredContent: SlmSuccess<T>;
  content: { type: "text"; text: string }[];
} {
  return {
    structuredContent: result,
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
  owner: { id: string; username: string };
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
  return {
    read_current: true,
    read_history: actorIsOwner,
    mutate_directly: actorIsOwner,
    // Direct cross-owner mutation is never granted; a non-owner may propose.
    submit_change_proposal: !actorIsOwner,
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
  ownerUsername: string,
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
    owner: { id: row.owner_user_id, username: ownerUsername },
    visibility: row.visibility === "public" ? "public" : "private",
    lifecycle_status: lifecycleStatusFromTags(tags),
    epistemic_status: row.epistemic_status ?? "canonical",
    permissions: entryPermissions(actor, row.owner_user_id),
  };
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

/** Report a bounded page's shape so a caller can tell truncation from absence. */
export function pageCounts(returned: number, total: number): { returned: number; total: number; truncated: boolean } {
  return { returned, total, truncated: total > returned };
}
