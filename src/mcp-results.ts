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
