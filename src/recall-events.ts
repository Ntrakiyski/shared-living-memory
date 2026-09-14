/**
 * recall-events.ts — Privacy-safe recall telemetry and structured feedback.
 *
 * Stores hashed queries (never plaintext), result entry IDs, counts, timing,
 * and semantic-availability flags. Feedback is a single mutable rating per
 * event per user (helpful / not_helpful with a reason code). No response
 * content, prompt text, free-text feedback, or source URLs are ever stored.
 */

import type { Env } from "./types";
import { readWriteMode } from "./config";
import { sqlChanges } from "./governance-utils";

/**
 * Normalise the query and produce a hash that can be counted across repeated
 * queries without building a reusable dictionary.
 */
export async function hashRecallQuery(rawQuery: string, pepper: string): Promise<string> {
  if (!pepper) throw new Error("Recall telemetry requires a secret hash key");
  const normalized = rawQuery.trim().toLowerCase().replace(/\s+/g, " ");
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(pepper), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const data = encoder.encode(`recall-query:v1:${normalized}`);
  const digest = await crypto.subtle.sign("HMAC", key, data);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export interface RecallEventEmit {
  userId: string;
  client: string;
  queryHash: string;
  resultEntryIds: string[];
  resultCount: number;
  semanticUnavailable: boolean;
  durationMs: number;
}

export async function emitRecallEvent(
  env: Pick<Env, "DB">,
  input: RecallEventEmit,
  now: number = Date.now(),
): Promise<string> {
  const id = crypto.randomUUID();
  const result = await env.DB.prepare(
    `INSERT INTO recall_events (
       id, user_id, client, query_hash, result_entry_ids,
       result_count, semantic_unavailable, duration_ms, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id,
    input.userId,
    input.client,
    input.queryHash,
    JSON.stringify(input.resultEntryIds),
    input.resultCount,
    input.semanticUnavailable ? 1 : 0,
    input.durationMs,
    now,
  ).run();
  if (!result.success || sqlChanges(result) !== 1) throw new Error("Recall event was not stored");
  return id;
}

export interface RecallEventInput {
  userId: string;
  client: "mcp" | "rest";
  query: string;
  resultEntryIds: string[];
  semanticUnavailable: boolean;
  durationMs: number;
}

/** A failed telemetry write must neither fail a read nor advertise a rateable ID. */
export async function recordRecallEvent(
  env: Pick<Env, "DB" | "AUTH_TOKEN" | "SLM_WRITE_MODE">,
  input: RecallEventInput,
  now = Date.now(),
): Promise<{ recall_event_id: string | null; warnings: string[] }> {
  const unavailable = { recall_event_id: null, warnings: ["recall_feedback_unavailable"] };
  if (readWriteMode(env) !== "enabled") return unavailable;
  try {
    const recall_event_id = await emitRecallEvent(env, {
      ...input,
      queryHash: await hashRecallQuery(input.query, env.AUTH_TOKEN),
      resultCount: input.resultEntryIds.length,
    }, now);
    return { recall_event_id, warnings: [] };
  } catch {
    // Do not log queries, keys, or provider errors containing bound parameters.
    return unavailable;
  }
}

export type RecallRating = "helpful" | "not_helpful";
export type RecallFeedbackReason =
  | "irrelevant" | "missing" | "stale"
  | "conflicting" | "unsupported" | "too_much" | "other";

export async function submitRecallFeedback(
  env: Pick<Env, "DB">,
  input: {
    recallEventId: string;
    userId: string;
    rating: RecallRating;
    reason: RecallFeedbackReason;
  },
  now: number = Date.now(),
): Promise<boolean> {
  const result = await env.DB.prepare(
    `INSERT INTO recall_feedback (
       id, recall_event_id, user_id, rating, reason, created_at
     ) SELECT ?, id, user_id, ?, ?, ? FROM recall_events
     WHERE id = ? AND user_id = ?
     ON CONFLICT (recall_event_id, user_id) DO UPDATE SET
       rating = excluded.rating, reason = excluded.reason, created_at = excluded.created_at`,
  ).bind(
    crypto.randomUUID(),
    input.rating,
    input.reason,
    now,
    input.recallEventId,
    input.userId,
  ).run();
  if (!result.success) throw new Error("Recall feedback storage unavailable");
  return sqlChanges(result) === 1;
}
