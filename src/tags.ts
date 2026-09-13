/**
 * tags.ts — Tag extraction, status/kind prefix helpers, visibility clause builder,
 *   and shared entry-listing filter builder.
 *
 * Purpose: Isolate all tag-related logic — reading/writing status/kind tag prefixes,
 *   building SQL visibility clauses for per-user scoping, and constructing the
 *   WHERE/ORDER/LIMIT clause shared by list_recent and GET /list.
 * Input: Entry text, tag arrays, owner user IDs, and filter parameters.
 * Output: SQL fragments, tag arrays, status and kind values.
 * Logic: Pure functions + SQL fragment builders.
 */

import { STATUS_PREFIX, KIND_PREFIX, STATUS_VALUES, KIND_VALUES } from "./types";
import type { MemoryStatus, MemoryKind } from "./types";

// ─── Automatic overwrite protection ───────────────────────────────────────────
// A memory is protected from AUTOMATIC replacement/merge when it is high
// importance, legacy-canonical, or epistemic canonical/qualified. Epistemic
// protection is deliberately independent of the legacy status tag: an entry
// with a stale `status:draft` tag but epistemic_status=canonical stays
// protected, so a legacy tag cannot un-protect reviewed content. Explicit
// authorized versioned correction through the versioned write path is still
// possible — this predicate only gates similarity-driven automation.
export const OVERWRITE_IMPORTANCE_THRESHOLD = 4;

export function isProtectedFromAutomaticOverwrite(input: {
  tags: readonly string[];
  importanceScore?: number | null;
  epistemicStatus?: string | null;
}): boolean {
  if (Number(input.importanceScore ?? 0) >= OVERWRITE_IMPORTANCE_THRESHOLD) return true;
  if (getStatus([...input.tags]) === "canonical") return true;
  return input.epistemicStatus === "canonical" || input.epistemicStatus === "qualified";
}

// ─── Status / kind tag helpers ─────────────────────────────────────────────────

export function getStatus(tags: string[]): MemoryStatus | null {
  const tag = tags.find(t => t.startsWith(STATUS_PREFIX));
  if (!tag) return null;
  const value = tag.slice(STATUS_PREFIX.length) as MemoryStatus;
  return (STATUS_VALUES as readonly string[]).includes(value) ? value : null;
}

export function withStatus(tags: string[], status: MemoryStatus): string[] {
  const cleaned = tags.filter(t => !t.startsWith(STATUS_PREFIX));
  return [...cleaned, `${STATUS_PREFIX}${status}`];
}

export function getKind(tags: string[]): MemoryKind | null {
  const tag = tags.find(t => t.startsWith(KIND_PREFIX));
  if (!tag) return null;
  const value = tag.slice(KIND_PREFIX.length) as MemoryKind;
  return (KIND_VALUES as readonly string[]).includes(value) ? value : null;
}

// ─── Recall eligibility ────────────────────────────────────────────────────────
// Entries whose lifecycle status is 'deprecated' (tag) or whose epistemic status
// is 'superseded' / 'retracted' (replaced or withdrawn) are no longer trustworthy
// enough to surface in recall or graph traversal. Shared gate so every recall
// surface — hybrid search, tag path, and graph expansion — excludes the same set.
export function isRecallEligible(tags: string[], epistemicStatus?: string | null): boolean {
  if (getStatus(tags) === "deprecated") return false;
  const status = epistemicStatus ?? "canonical";
  return status !== "superseded" && status !== "retracted";
}

export function withKind(tags: string[], kind: MemoryKind): string[] {
  const cleaned = tags.filter(t => !t.startsWith(KIND_PREFIX));
  return [...cleaned, `${KIND_PREFIX}${kind}`];
}

// ─── Visibility clause ─────────────────────────────────────────────────────────

// Users see their own private entries + all public entries, never others' private entries.
export function buildVisibilityClause(userId: string): { sql: string; bind: string[] } {
  return {
    sql: `(owner_user_id = ? OR visibility = 'public')`,
    bind: [userId],
  };
}

// ─── Shared entry-listing filter builder ─────────────────────────────────────
// Builds the WHERE/ORDER/LIMIT clause shared by list_recent and GET /list so
// both stay in sync on which filters (tag, after, before) are supported.

export function buildEntryFilterQuery(params: {
  n: number;
  tag?: string;
  after?: number;
  before?: number;
  userId?: string;
  user?: string;
  visibility?: string;
}): { sql: string; bindings: (string | number)[] } {
  const conds: string[] = [];
  const bindings: (string | number)[] = [];
  if (params.tag) { conds.push(`EXISTS (SELECT 1 FROM json_each(tags) WHERE json_each.value = ?)`); bindings.push(params.tag); }
  if (params.after !== undefined) { conds.push(`created_at >= ?`); bindings.push(params.after); }
  if (params.before !== undefined) { conds.push(`created_at <= ?`); bindings.push(params.before); }
  if (params.user) {
    conds.push(`owner_user_id = (SELECT id FROM users WHERE username = ?)`);
    bindings.push(params.user);
  }
  if (params.visibility === 'public') {
    conds.push(`visibility = 'public'`);
  } else if (params.visibility === 'private' && params.userId) {
    conds.push(`owner_user_id = ? AND visibility = 'private'`);
    bindings.push(params.userId);
  } else if (params.userId) {
    const vis = buildVisibilityClause(params.userId);
    conds.push(vis.sql);
    bindings.push(...vis.bind);
  }

  let sql = `SELECT id, content, tags, source, created_at, vector_ids,
                    owner_user_id, created_by_user_id, visibility, revision
             FROM entries`;
  if (conds.length) sql += ` WHERE ` + conds.join(` AND `);
  sql += ` ORDER BY created_at DESC LIMIT ?`;
  bindings.push(params.n);

  return { sql, bindings };
}

// ─── Stable keyset pagination (Section 11) ───────────────────────────────────
// A cursor is a navigation token, never proof of authorization: every page
// re-evaluates visibility, ownership and scope. It is unsigned because it
// carries no authority. `context_hash` binds a cursor to the filters and actor
// that produced it, so a token cannot be replayed against a different query.

export const BROWSE_CURSOR_VERSION = 1;
export const BROWSE_CURSOR_MAX_CHARS = 2_048;
export const BROWSE_DEFAULT_PAGE_SIZE = 10;
export const BROWSE_MIN_PAGE_SIZE = 1;
export const BROWSE_MAX_PAGE_SIZE = 50;

export interface BrowseCursor {
  v: number;
  last_created_at: number;
  last_id: string;
  context_hash: string;
}

export interface BrowseContextInput {
  actorKind: string;
  actorId: string;
  ownerUserId: string;
  tag?: string | null;
  after?: number | null;
  before?: number | null;
  user?: string | null;
  visibility?: string | null;
}

export class InvalidBrowseCursorError extends Error {
  readonly code = "invalid_cursor";
  constructor(message = "The cursor is not valid for this query") {
    super(message);
    this.name = "InvalidBrowseCursorError";
  }
}

/** Normalized tag semantics: absent and empty are the same as "no tag filter". */
export function normalizeBrowseTag(tag: string | null | undefined): string | null {
  const trimmed = typeof tag === "string" ? tag.trim() : "";
  return trimmed ? trimmed.toLowerCase() : null;
}

function normalizeBrowseTimestamp(value: number | null | undefined, field: string): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new InvalidBrowseCursorError(`${field} must be a nonnegative integer millisecond timestamp`);
  }
  return value;
}

/**
 * The normalized filter + actor identity a cursor belongs to. Page size is
 * deliberately excluded so a caller may change it between pages.
 */
export async function browseContextHash(input: BrowseContextInput): Promise<string> {
  const after = normalizeBrowseTimestamp(input.after, "after");
  const before = normalizeBrowseTimestamp(input.before, "before");
  if (after !== null && before !== null && after > before) {
    throw new InvalidBrowseCursorError("after must not be later than before");
  }
  const canonical = JSON.stringify({
    actor_kind: input.actorKind,
    actor_id: input.actorId,
    owner_user_id: input.ownerUserId,
    tag: normalizeBrowseTag(input.tag),
    after,
    before,
    user: input.user?.trim() || null,
    visibility: input.visibility?.trim() || null,
  });
  return sha256Hex(canonical);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function encodeBrowseCursor(cursor: BrowseCursor): string {
  const token = btoa(JSON.stringify({
    v: cursor.v,
    last_created_at: cursor.last_created_at,
    last_id: cursor.last_id,
    context_hash: cursor.context_hash,
  }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  return token;
}

/**
 * Decode and fully validate a cursor. Malformed input, extra keys, wrong types
 * or version, an out-of-range id and a mismatched context all reject — this
 * never silently falls back to the first page.
 */
export function decodeBrowseCursor(
  token: string,
  expectedContextHash: string,
): BrowseCursor {
  if (typeof token !== "string" || token.length === 0 || token.length > BROWSE_CURSOR_MAX_CHARS) {
    throw new InvalidBrowseCursorError();
  }
  let parsed: unknown;
  try {
    const base64 = token.replace(/-/g, "+").replace(/_/g, "/");
    parsed = JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")));
  } catch {
    throw new InvalidBrowseCursorError();
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new InvalidBrowseCursorError();
  }
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join(",") !== "context_hash,last_created_at,last_id,v") {
    throw new InvalidBrowseCursorError();
  }
  if (record.v !== BROWSE_CURSOR_VERSION) throw new InvalidBrowseCursorError();
  const lastCreatedAt = record.last_created_at;
  const lastId = record.last_id;
  const contextHash = record.context_hash;
  if (typeof lastCreatedAt !== "number" || !Number.isSafeInteger(lastCreatedAt) || lastCreatedAt < 0) {
    throw new InvalidBrowseCursorError();
  }
  if (typeof lastId !== "string" || lastId.length < 1 || lastId.length > 200) {
    throw new InvalidBrowseCursorError();
  }
  if (typeof contextHash !== "string" || !/^[0-9a-f]{64}$/.test(contextHash)) {
    throw new InvalidBrowseCursorError();
  }
  if (contextHash !== expectedContextHash) {
    throw new InvalidBrowseCursorError("The cursor does not belong to this query");
  }
  return { v: BROWSE_CURSOR_VERSION, last_created_at: lastCreatedAt, last_id: lastId, context_hash: contextHash };
}

export function boundsCheckPageSize(n: unknown): number {
  const value = typeof n === "number" ? n : Number(n);
  if (!Number.isSafeInteger(value) || value < BROWSE_MIN_PAGE_SIZE || value > BROWSE_MAX_PAGE_SIZE) {
    throw new InvalidBrowseCursorError(
      `n must be an integer between ${BROWSE_MIN_PAGE_SIZE} and ${BROWSE_MAX_PAGE_SIZE}`,
    );
  }
  return value;
}

/**
 * Keyset query for one page. Fetches n+1 rows so the caller can emit exactly n
 * and know whether a further page exists. `ORDER BY created_at DESC, id DESC`
 * with a strict boundary means newer inserts never shift already-read positions.
 */
export function buildEntryPageQuery(params: {
  n: number;
  cursor?: { last_created_at: number; last_id: string } | null;
  tag?: string | null;
  after?: number | null;
  before?: number | null;
  userId?: string;
  user?: string;
  visibility?: string;
}): { sql: string; bindings: (string | number)[] } {
  const conds: string[] = [];
  const bindings: (string | number)[] = [];
  const tag = normalizeBrowseTag(params.tag ?? null);
  if (tag) { conds.push(`EXISTS (SELECT 1 FROM json_each(tags) WHERE json_each.value = ?)`); bindings.push(tag); }
  if (params.after !== undefined && params.after !== null) {
    conds.push(`created_at >= ?`);
    bindings.push(params.after);
  }
  if (params.before !== undefined && params.before !== null) {
    conds.push(`created_at <= ?`);
    bindings.push(params.before);
  }
  if (params.user) {
    conds.push(`owner_user_id = (SELECT id FROM users WHERE username = ?)`);
    bindings.push(params.user);
  }
  if (params.visibility === "public") {
    conds.push(`visibility = 'public'`);
  } else if (params.visibility === "private" && params.userId) {
    conds.push(`owner_user_id = ? AND visibility = 'private'`);
    bindings.push(params.userId);
  } else if (params.userId) {
    const vis = buildVisibilityClause(params.userId);
    conds.push(vis.sql);
    bindings.push(...vis.bind);
  }
  if (params.cursor) {
    // Strict keyset boundary, parenthesized with every other condition.
    conds.push(`(created_at < ? OR (created_at = ? AND id < ?))`);
    bindings.push(params.cursor.last_created_at, params.cursor.last_created_at, params.cursor.last_id);
  }

  let sql = `SELECT id, content, tags, source, created_at, vector_ids,
                    owner_user_id, created_by_user_id, visibility, revision,
                    epistemic_status
             FROM entries`;
  if (conds.length) sql += ` WHERE ` + conds.map((cond) => `(${cond})`).join(` AND `);
  sql += ` ORDER BY created_at DESC, id DESC LIMIT ?`;
  bindings.push(params.n + 1);

  return { sql, bindings };
}

/** Emit at most `n` rows and a cursor only when an extra row actually exists. */
export function paginateRows<T extends { id: string; created_at: number }>(
  rows: T[],
  n: number,
): { rows: T[]; nextCursor: { last_created_at: number; last_id: string } | null } {
  const emitted = rows.slice(0, n);
  const last = emitted[emitted.length - 1];
  const hasMore = rows.length > n;
  return {
    rows: emitted,
    nextCursor: hasMore && last
      ? { last_created_at: Number(last.created_at), last_id: last.id }
      : null,
  };
}
