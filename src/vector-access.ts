/**
 * Vectorize access-control helpers.
 *
 * Vectorize metadata filters are an index-side candidate reduction, not an
 * authorization boundary. A visible query is therefore split into two
 * supported, implicit-AND filters (caller's entries and public entries), then
 * every returned parent entry is re-authorized against D1 before it can be
 * consumed by duplicate detection, graph inference, or an LLM prompt.
 */

import type { Env } from "./types";

export interface ScopedVectorMatch {
  id: string;
  score: number;
  metadata?: Record<string, unknown>;
}

export interface VectorEntryScope {
  id: string;
  ownerUserId: string;
  tags: string[];
  visibility: "private" | "public";
  currentEpisodeId: string | null;
}

export interface VisibleVectorQueryResult {
  matches: ScopedVectorMatch[];
  entriesById: Map<string, VectorEntryScope>;
}

export interface VisibleVectorQueryOptions {
  topK: number;
  userId?: string;
}

function parentIdFor(match: ScopedVectorMatch): string | null {
  const parentId = match.metadata?.parentId ?? match.id;
  return typeof parentId === "string" && parentId.length > 0 ? parentId : null;
}

function parseTags(raw: string): string[] | null {
  if (typeof raw !== "string") return null;
  try {
    const tags = JSON.parse(raw);
    return Array.isArray(tags) && tags.every(tag => typeof tag === "string") ? tags : null;
  } catch {
    return null;
  }
}

function isVisible(row: VectorEntryScope, userId: string | undefined): boolean {
  if (userId && row.ownerUserId === userId) return true;
  return row.visibility === "public";
}

function matchesCurrentEpisode(match: ScopedVectorMatch, row: VectorEntryScope): boolean {
  const value = match.metadata?.episodeId ?? match.metadata?.episode_id;
  const vectorEpisodeId = typeof value === "string" && value.length > 0 ? value : null;
  return row.currentEpisodeId !== null && vectorEpisodeId === row.currentEpisodeId;
}

/**
 * Query vectors visible to a caller and verify each result against D1.
 *
 * Cloudflare Vectorize filters only support implicit AND. Own-or-public is
 * represented as two filtered queries and merged locally. Anonymous/system
 * callers get the public query only. There is deliberately no unfiltered
 * fallback if a filtered query or D1 hydration fails.
 */
export async function queryVisibleVectors(
  values: number[],
  env: Env,
  options: VisibleVectorQueryOptions,
): Promise<VisibleVectorQueryResult> {
  const requestedTopK = Number.isFinite(options.topK) ? Math.floor(options.topK) : 1;
  // returnMetadata="all" supports at most 50 results, and two scoped queries
  // then hydrate at most D1's 100-bound-parameter ceiling.
  const topK = Math.max(1, Math.min(50, requestedTopK));
  const userId = options.userId?.trim() || undefined;
  const filters: VectorizeVectorMetadataFilter[] = userId
    ? [
        { owner_user_id: { $eq: userId } },
        { is_private: { $eq: false } },
      ]
    : [{ is_private: { $eq: false } }];

  const queryResults = await Promise.all(
    filters.map(filter => env.VECTORIZE.query(values, {
      topK,
      returnMetadata: "all",
      filter,
    })),
  );

  // Own public vectors are returned by both filtered queries. Keep one copy,
  // preferring the strongest score if the index returns inconsistent scores.
  const byVectorId = new Map<string, ScopedVectorMatch>();
  for (const result of queryResults) {
    for (const match of result.matches) {
      if (typeof match.id !== "string" || !Number.isFinite(match.score)) continue;
      const normalized: ScopedVectorMatch = {
        id: match.id,
        score: match.score,
        metadata: match.metadata as Record<string, unknown> | undefined,
      };
      const current = byVectorId.get(normalized.id);
      if (!current || normalized.score > current.score) byVectorId.set(normalized.id, normalized);
    }
  }

  const merged = [...byVectorId.values()].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const parentIds = [...new Set(merged.map(parentIdFor).filter((id): id is string => id !== null))];
  if (!parentIds.length) return { matches: [], entriesById: new Map() };

  const placeholders = parentIds.map(() => "?").join(", ");
  const { results } = await env.DB.prepare(
    `SELECT id, tags, owner_user_id, visibility, current_episode_id
     FROM entries WHERE id IN (${placeholders})`,
  ).bind(...parentIds).all() as {
    results: { id: string; tags: string; owner_user_id: string | null; visibility: string; current_episode_id: string | null }[];
  };

  const entriesById = new Map<string, VectorEntryScope>();
  for (const row of results) {
    if (typeof row.id !== "string" || typeof row.owner_user_id !== "string") continue;
    const tags = parseTags(row.tags);
    if (!tags) continue;
    if (row.visibility !== "private" && row.visibility !== "public") continue;
    const scoped: VectorEntryScope = {
      id: row.id,
      ownerUserId: row.owner_user_id,
      tags,
      visibility: row.visibility,
      currentEpisodeId: row.current_episode_id ?? null,
    };
    if (isVisible(scoped, userId)) entriesById.set(scoped.id, scoped);
  }

  const matches = merged
    .filter(match => {
      const parentId = parentIdFor(match);
      const entry = parentId === null ? undefined : entriesById.get(parentId);
      return entry !== undefined && matchesCurrentEpisode(match, entry);
    })
    .slice(0, topK);

  return { matches, entriesById };
}

export function vectorMatchParentId(match: ScopedVectorMatch): string {
  return parentIdFor(match) ?? match.id;
}
