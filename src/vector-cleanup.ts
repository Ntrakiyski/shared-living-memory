/** Durable reconciliation for Vectorize deletions recorded with D1 commits. */

import type { Env } from "./types";
import { ERASURE_CLEANUP_REASON_PREFIX, finalizeErasureReceipt } from "./erasure";

export interface VectorCleanupResult {
  processed: number;
  deleted: number;
  failed: number;
  remaining: number;
}

/** `erasure:<operationId>:<entryId>` — the repair schedule keys receipt completion on this. */
function parseErasureOperationId(reason: string): string | null {
  if (!reason.startsWith(ERASURE_CLEANUP_REASON_PREFIX)) return null;
  const rest = reason.slice(ERASURE_CLEANUP_REASON_PREFIX.length);
  const operationId = rest.split(":")[0];
  return operationId && operationId.length > 0 ? operationId : null;
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

export async function drainVectorCleanupQueue(
  env: Env,
  limit = 25,
): Promise<VectorCleanupResult> {
  const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
  const { results } = await env.DB.prepare(
    `SELECT id, vector_ids, attempts, reason
     FROM vector_cleanup_queue
     ORDER BY attempts ASC, updated_at ASC, id ASC
     LIMIT ?`,
  ).bind(boundedLimit).all<{ id: string; vector_ids: string; attempts: number; reason: string }>();

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
      // The receipt for an erasure operation must not become `complete` until
      // every queued vector is gone. Finalizing is best-effort: the next drain
      // retries it and flagPendingErasures still alerts on a stuck receipt.
      const operationId = parseErasureOperationId(item.reason ?? "");
      if (operationId) {
        try {
          await finalizeErasureReceipt(env, operationId, Date.now());
        } catch (error) {
          console.error(`Erasure receipt finalization failed for ${operationId} (non-fatal):`, error);
        }
      }
    } catch (error) {
      failed++;
      await env.DB.prepare(
        `UPDATE vector_cleanup_queue
         SET attempts = attempts + 1, last_error = ?, updated_at = ?
         WHERE id = ?`,
      ).bind(message(error), Date.now(), item.id).run();
    }
  }

  const count = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM vector_cleanup_queue`,
  ).first<{ count: number }>();
  return {
    processed: results.length,
    deleted,
    failed,
    remaining: Number(count?.count ?? 0),
  };
}
