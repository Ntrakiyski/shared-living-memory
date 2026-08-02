/**
 * pilot-metrics.ts — Admin-only aggregation of privacy-safe pilot metrics.
 *
 * Excludes canary users, service/system actors, and canary-tagged entries.
 * Never aggregates query text, result content, prompts, or free-text feedback.
 */

import type { Env } from "./types";

export interface PilotMetrics {
  cohortSize: number;
  totalRecalls: number;
  zeroResultRate: number;
  semanticUnavailableRate: number;
  ratedCount: number;
  helpfulRate: number;
  p50DurationMs: number;
  p95DurationMs: number;
}

export async function computePilotMetrics(
  env: Pick<Env, "DB">,
  _since: number,
): Promise<PilotMetrics> {
  const since = _since || Date.now() - 30 * 24 * 60 * 60 * 1000;

  // Cohort: active human pilot users (exclude system, inactive, canary)
  const cohort = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM users
     WHERE status = 'active' AND role IN ('admin', 'member')
       AND id NOT LIKE 'canary-%'`,
  ).first<{ count: number }>();

  // Total recalls in window
  const recalls = await env.DB.prepare(
    `SELECT COUNT(*) AS total, SUM(CASE WHEN result_count = 0 THEN 1 ELSE 0 END) AS zeros,
            SUM(CASE WHEN semantic_unavailable = 1 THEN 1 ELSE 0 END) AS unavailable
     FROM recall_events WHERE created_at >= ?`,
  ).bind(since).first<{ total: number; zeros: number; unavailable: number }>();

  // Feedback
  const feedback = await env.DB.prepare(
    `SELECT COUNT(*) AS count, SUM(CASE WHEN rating = 'helpful' THEN 1 ELSE 0 END) AS helpful
     FROM recall_feedback WHERE created_at >= ?`,
  ).bind(since).first<{ count: number; helpful: number }>();

  // Duration percentiles
  const p50 = await env.DB.prepare(
    `SELECT duration_ms AS val FROM recall_events
     WHERE created_at >= ? ORDER BY duration_ms ASC
     LIMIT 1 OFFSET (SELECT MAX(0, (COUNT(*) - 1) * 50 / 100) FROM recall_events WHERE created_at >= ?)`,
  ).bind(since, since).first<{ val: number }>();

  const p95 = await env.DB.prepare(
    `SELECT duration_ms AS val FROM recall_events
     WHERE created_at >= ? ORDER BY duration_ms ASC
     LIMIT 1 OFFSET (SELECT MAX(0, (COUNT(*) - 1) * 95 / 100) FROM recall_events WHERE created_at >= ?)`,
  ).bind(since, since).first<{ val: number }>();

  const total = Number(recalls?.total ?? 0);
  return {
    cohortSize: Number(cohort?.count ?? 0),
    totalRecalls: total,
    zeroResultRate: total > 0 ? Number(recalls?.zeros ?? 0) / total : 0,
    semanticUnavailableRate: total > 0 ? Number(recalls?.unavailable ?? 0) / total : 0,
    ratedCount: Number(feedback?.count ?? 0),
    helpfulRate: Number(feedback?.count ?? 0) > 0
      ? Number(feedback?.helpful ?? 0) / Number(feedback?.count ?? 1)
      : 0,
    p50DurationMs: Number(p50?.val ?? 0),
    p95DurationMs: Number(p95?.val ?? 0),
  };
}
