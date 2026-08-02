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
import { escapeLikePattern } from "./helpers";

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
  if (params.tag) { conds.push(`tags LIKE ?`); bindings.push(`%"${escapeLikePattern(params.tag)}"%`); }
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
