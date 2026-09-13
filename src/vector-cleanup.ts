/**
 * vector-cleanup.ts — Durable reconciliation for Vectorize work recorded in D1.
 *
 * Two job kinds share one table and are drained through separate code paths so
 * one kind can never starve or be mistaken for the other:
 *
 *  - `delete`         stale vectors whose D1 commit already happened.
 *  - `capture_stage`  a durable capture-stage intent. Its planned vector ids
 *                     belong to one in-flight keyed capture. It is removed only
 *                     after confirmed safe cleanup or confirmed committed
 *                     authority — never merely because its lease expired.
 */

import type { Env } from "./types";
import { reconcileErasureReceipts } from "./erasure";
import { DB_NOW_MS_SQL } from "./capture-receipts";

export interface VectorCleanupResult {
  processed: number;
  deleted: number;
  failed: number;
  remaining: number;
}

export interface CaptureStageCleanupResult {
  processed: number;
  /** Intents whose attempt never committed: their vectors were removed. */
  abandoned: number;
  /** Intents whose attempt did commit: vectors preserved, intent removed. */
  preserved: number;
  /** Intents left for a later pass because authority could not be confirmed. */
  deferred: number;
  remaining: number;
}

function parseVectorIds(raw: string): string[] | null {
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) && value.every(id => typeof id === "string" && id.length > 0)
      ? [...new Set(value)]
      : null;
  } catch {
    return null;
  }
}

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

function boundedLimit(limit: number): number {
  return Math.max(1, Math.min(100, Math.trunc(limit)));
}

/**
 * Drain `delete` jobs only. Capture-stage intents are excluded from this query
 * so an unexpired or repeatedly failing intent can never starve deletion work,
 * and an intent can never reach the unconditional delete branch.
 */
export async function drainVectorCleanupQueue(
  env: Env,
  limit = 25,
): Promise<VectorCleanupResult> {
  const bounded = boundedLimit(limit);
  const { results } = await env.DB.prepare(
    `SELECT id, vector_ids, attempts, reason
     FROM vector_cleanup_queue
     WHERE kind = 'delete'
     ORDER BY attempts ASC, updated_at ASC, id ASC
     LIMIT ?`,
  ).bind(bounded).all<{ id: string; vector_ids: string; attempts: number; reason: string }>();

  let deleted = 0;
  let failed = 0;
  for (const item of results) {
    const vectorIds = parseVectorIds(item.vector_ids);
    if (!vectorIds) {
      failed++;
      await env.DB.prepare(
        `UPDATE vector_cleanup_queue
         SET attempts = attempts + 1, last_error = ?, updated_at = ?
         WHERE id = ?`,
      ).bind("invalid vector_ids JSON", Date.now(), item.id).run();
      continue;
    }

    try {
      if (vectorIds.length) await env.VECTORIZE.deleteByIds(vectorIds);
      await env.DB.prepare(`DELETE FROM vector_cleanup_queue WHERE id = ?`).bind(item.id).run();
      deleted++;
    } catch (error) {
      failed++;
      await env.DB.prepare(
        `UPDATE vector_cleanup_queue
         SET attempts = attempts + 1, last_error = ?, updated_at = ?
         WHERE id = ?`,
      ).bind(message(error), Date.now(), item.id).run();
    }
  }

  // Always retry receipts, including when no queue rows remain after a crash
  // or a previous receipt update failed. The SQL guards remaining work.
  try {
    await reconcileErasureReceipts(env, bounded);
  } catch (error) {
    console.error("Erasure receipt reconciliation failed (retrying on next drain):", error);
  }

  const count = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM vector_cleanup_queue WHERE kind = 'delete'`,
  ).first<{ count: number }>();
  return {
    processed: results.length,
    deleted,
    failed,
    remaining: Number(count?.count ?? 0),
  };
}

interface CaptureStageRow {
  id: string;
  vector_ids: string;
  stage_entry_id: string | null;
  stage_episode_id: string | null;
  claim_token: string | null;
  attempts: number;
}

/**
 * Durable authority for a staged attempt: a committed receipt for the planned
 * entry means the capture completed; anything else means the attempt is
 * abandoned. Never inferred from vector presence or local timing.
 */
async function attemptCommitted(env: Env, row: CaptureStageRow): Promise<boolean> {
  if (!row.stage_entry_id) return false;
  const receipt = await env.DB.prepare(
    `SELECT actor_id FROM capture_receipts
     WHERE entry_id = ? AND state = 'committed' LIMIT 1`,
  ).bind(row.stage_entry_id).first<{ actor_id: string }>();
  return receipt !== null;
}

/**
 * Repair expired capture-stage intents. Claiming an intent permanently fences
 * the original attempt from committing; a crash after the claim leaves the row
 * claimable again by a later pass, and vector deletion is idempotent.
 */
export async function drainCaptureStageIntents(
  env: Env,
  limit = 25,
): Promise<CaptureStageCleanupResult> {
  const bounded = boundedLimit(limit);
  const { results } = await env.DB.prepare(
    `SELECT id, vector_ids, stage_entry_id, stage_episode_id, claim_token, attempts
     FROM vector_cleanup_queue
     WHERE kind = 'capture_stage'
       AND lease_expires_at IS NOT NULL
       AND lease_expires_at <= ${DB_NOW_MS_SQL}
     ORDER BY attempts ASC, updated_at ASC, id ASC
     LIMIT ?`,
  ).bind(bounded).all<CaptureStageRow>();

  let abandoned = 0;
  let preserved = 0;
  let deferred = 0;

  for (const row of results) {
    const claimToken = crypto.randomUUID();
    try {
      // Take over any previous claim: the lease already expired, so the original
      // attempt is fenced out either way.
      await env.DB.prepare(
        `UPDATE vector_cleanup_queue
         SET claim_token = ?, attempts = attempts + 1, updated_at = ?
         WHERE id = ?`,
      ).bind(claimToken, Date.now(), row.id).run();
    } catch (error) {
      deferred++;
      console.error(`Capture-stage claim failed for ${row.id} (non-fatal):`, error);
      continue;
    }

    let committed: boolean;
    try {
      // Authoritative check before any remote deletion attempt.
      committed = await attemptCommitted(env, row);
    } catch (error) {
      deferred++;
      await recordStageFailure(env, row.id, `authority check deferred: ${message(error)}`);
      continue;
    }

    if (committed) {
      // Confirmed committed authority: keep the vectors, drop the intent.
      preserved++;
      await removeClaimedIntent(env, row.id, claimToken);
      continue;
    }

    const vectorIds = parseVectorIds(row.vector_ids);
    if (!vectorIds) {
      deferred++;
      await recordStageFailure(env, row.id, "invalid vector_ids JSON");
      continue;
    }

    try {
      if (vectorIds.length) await env.VECTORIZE.deleteByIds(vectorIds);
    } catch (error) {
      deferred++;
      await recordStageFailure(env, row.id, message(error));
      continue;
    }

    abandoned++;
    await removeClaimedIntent(env, row.id, claimToken);
  }

  const count = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM vector_cleanup_queue WHERE kind = 'capture_stage'`,
  ).first<{ count: number }>();
  return {
    processed: results.length,
    abandoned,
    preserved,
    deferred,
    remaining: Number(count?.count ?? 0),
  };
}

async function removeClaimedIntent(env: Env, id: string, claimToken: string): Promise<void> {
  try {
    await env.DB.prepare(
      `DELETE FROM vector_cleanup_queue WHERE id = ? AND claim_token = ?`,
    ).bind(id, claimToken).run();
  } catch (error) {
    // The row stays claimable; a later pass repeats the authoritative check.
    console.error(`Capture-stage cleanup removal failed for ${id} (non-fatal):`, error);
  }
}

async function recordStageFailure(env: Env, id: string, error: string): Promise<void> {
  try {
    await env.DB.prepare(
      `UPDATE vector_cleanup_queue SET last_error = ?, updated_at = ? WHERE id = ?`,
    ).bind(error, Date.now(), id).run();
  } catch {
    // The durable row is still the recovery record even when the note fails.
  }
}
