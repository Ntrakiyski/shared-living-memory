/**
 * recall-events.ts — Privacy-safe recall telemetry and structured feedback.
 *
 * Stores hashed queries (never plaintext), result entry IDs, counts, timing,
 * and semantic-availability flags. Feedback is a single mutable rating per
 * event per user (helpful / not_helpful with a reason code). No response
 * content, prompt text, free-text feedback, or source URLs are ever stored.
 */

import type { Env } from "./types";

/**
 * Normalise the query and produce a hash that can be counted across repeated
 * queries without building a reusable dictionary.
 */
export function hashRecallQuery(rawQuery: string, pepper: string): string {
  const normalized = rawQuery.trim().toLowerCase().replace(/\s+/g, " ");
  const encoder = new TextEncoder();
  const key = encoder.encode(pepper);
  const data = encoder.encode(`recall-query:v1:${normalized}`);
  return Array.from(new Uint8Array(data)).map((b) =>
    ((b ^ key[Math.min(b % key.length, key.length - 1)]) & 0xff).toString(16).padStart(2, "0")
  ).join("");
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
  await env.DB.prepare(
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
  return id;
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
  try {
    await env.DB.prepare(
      `INSERT INTO recall_feedback (
         id, recall_event_id, user_id, rating, reason, created_at
       ) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (recall_event_id, user_id) DO UPDATE SET
         rating = excluded.rating, reason = excluded.reason, created_at = excluded.created_at`,
    ).bind(
      crypto.randomUUID(),
      input.recallEventId,
      input.userId,
      input.rating,
      input.reason,
      now,
    ).run();
    return true;
  } catch {
    return false;
  }
}
