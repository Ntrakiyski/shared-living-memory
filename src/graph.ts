/**
 * graph.ts — Relationship graph: edge types, CRUD, traversal, and auto-linking.
 *
 * Purpose: Define the relationship graph subsystem — edge type registry, single
 *   writer/remover for edges, BFS graph traversal with hop/fanout/node caps,
 *   entry hydration, connection queries, full graph assembly for the dashboard,
 *   and automatic edge inference on new entry writes.
 * Input: Entry IDs, edge types, weights, Vectorize query results, user IDs.
 * Output: Graph neighbors, connections, full graph views, and persisted edge rows.
 * Logic: Code-validated edge type registry (no SQL CHECK constraints), symmetric
 *   edge normalization, BFS traversal with deprecated/visibility filtering,
 *   cosine-similarity-based auto-linking, and batched D1 queries within the
 *   100-bound-param limit.
 */

import type { Env, MemoryKind, MemoryStatus } from "./types";
import {
  D1_MAX_BOUND_PARAMS,
  EDGE_INFER_MAX,
  EDGE_INFER_THRESHOLD,
  EDGE_QUERY_BATCH,
  GRAPH_FANOUT_CAP,
  GRAPH_HOP_DECAY,
  GRAPH_MAX_HOPS,
  GRAPH_MAX_NODES,
} from "./config";
import { embed } from "./helpers";
import { getKind, getStatus, isRecallEligible } from "./tags";
import { queryVisibleVectors, vectorMatchParentId } from "./vector-access";
import { sanitizeSourceMetadataForOutput } from "./source-metadata";

// ─── Relationship graph (issue #16) ─────────────────────────────────────────────
// Edges live in a dedicated `edges` table — the one additive schema change. Edge
// types and provenance are validated in CODE against this registry rather than via
// SQL CHECK constraints, so adding a new type is a one-line change here that ships
// with a deploy and never requires a migration. Per-edge extension data goes in the
// edges.metadata JSON column (the edges analogue of entries.tags) — also no ALTER.

export const EDGE_TYPES = {
  relates_to:      { directed: false, label: "Related to",      allowedKinds: null },
  supersedes:      { directed: true,  label: "Supersedes",      allowedKinds: null },
  caused_by:       { directed: true,  label: "Caused by",       allowedKinds: null },
  decided:         { directed: true,  label: "Decided",         allowedKinds: ["episodic"] },
  about_person:    { directed: true,  label: "About person",    allowedKinds: null },
  part_of_project: { directed: true,  label: "Part of project", allowedKinds: null },
  follows:         { directed: true,  label: "Follows",         allowedKinds: ["episodic"] },
  corrects:        { directed: true,  label: "Corrects",        allowedKinds: null },
  contradicts:     { directed: true,  label: "Contradicts",     allowedKinds: null },
  clarifies:       { directed: true,  label: "Clarifies",       allowedKinds: null },
  temporal_after:  { directed: true,  label: "After (temporal)", allowedKinds: null },
  contextually_matches: { directed: false, label: "Contextually matches", allowedKinds: null },
  derives_from:        { directed: true,  label: "Derives from",        allowedKinds: null },
  supports:            { directed: true,  label: "Supports",            allowedKinds: null },
  evaluates_on:        { directed: true,  label: "Evaluates on",        allowedKinds: null },
  has_limitation:      { directed: true,  label: "Has limitation",      allowedKinds: null },
} as const satisfies Record<string, { directed: boolean; label: string; allowedKinds: readonly MemoryKind[] | null }>;

export type EdgeType = keyof typeof EDGE_TYPES;

export const PROVENANCE_VALUES = ["explicit", "inferred", "system"] as const;
export type EdgeProvenance = (typeof PROVENANCE_VALUES)[number];

export type EdgeActorKind = "human" | "service" | "system";

export interface EdgeMutationContext {
  actorKind: EdgeActorKind;
  actorId: string;
  mutationKind: string;
  mutationId?: string;
}

export interface EdgeVersion {
  id: string;
  edge_id: string;
  source_id: string;
  target_id: string;
  type: EdgeType;
  weight: number;
  provenance: EdgeProvenance;
  metadata: string;
  confidence: number;
  edge_created_at: number;
  edge_updated_at: number;
  revision: number;
  is_deleted: number;
  mutation_kind: string;
  mutation_id: string | null;
  actor_kind: EdgeActorKind;
  actor_id: string;
  recorded_at: number;
}

const DEFAULT_EDGE_WEIGHT = 0.5;

export function isValidEdgeType(type: string): type is EdgeType {
  return Object.prototype.hasOwnProperty.call(EDGE_TYPES, type);
}

// Symmetric (undirected) edges store the pair smaller-id-first so A→B and B→A
// collapse to one row; directed edges keep their natural order.
export function isSymmetric(type: EdgeType): boolean {
  return !EDGE_TYPES[type].directed;
}

export function edgeLabel(type: EdgeType): string {
  return EDGE_TYPES[type].label;
}

export function allowedKindsFor(type: EdgeType): readonly MemoryKind[] | null {
  return EDGE_TYPES[type].allowedKinds;
}

// The single writer for edges. Rejects self-links and unknown types (returns null),
// normalizes symmetric pairs, and upserts idempotently so re-linking the same pair
// keeps the stronger weight instead of erroring or duplicating.
export async function createEdge(
  sourceId: string,
  targetId: string,
  type: string,
  opts: {
    weight?: number;
    provenance?: EdgeProvenance;
    metadata?: Record<string, unknown>;
    confidence?: number;
    actorKind?: EdgeActorKind;
    actorId?: string;
    mutationKind?: string;
    mutationId?: string;
  },
  env: Env,
): Promise<{ id: string; source_id: string; target_id: string; type: EdgeType; revision: number } | null> {
  if (!isValidEdgeType(type)) return null;
  if (sourceId === targetId) return null;

  // Every edge must refer to two real entries. Private entries live in a separate
  // graph partition: because edges do not carry their own ACL, allowing a private
  // endpoint to connect to a public one could disclose the private entry id through
  // an otherwise-public relationship query.
  const srcRow = await env.DB.prepare("SELECT visibility, owner_user_id FROM entries WHERE id = ?").bind(sourceId).first() as { visibility: string; owner_user_id: string } | null;
  const tgtRow = await env.DB.prepare("SELECT visibility, owner_user_id FROM entries WHERE id = ?").bind(targetId).first() as { visibility: string; owner_user_id: string } | null;
  if (!srcRow || !tgtRow) return null;

  const privateFlag = (visibility: string): boolean | null =>
    visibility === "private" ? true : visibility === "public" ? false : null;
  const srcPrivate = privateFlag(srcRow.visibility);
  const tgtPrivate = privateFlag(tgtRow.visibility);
  if (srcPrivate === null || tgtPrivate === null) return null;
  if (srcPrivate !== tgtPrivate) return null;
  if (srcPrivate && srcRow.owner_user_id !== tgtRow.owner_user_id) return null;

  let source = sourceId;
  let target = targetId;
  if (isSymmetric(type) && source > target) [source, target] = [target, source];

  const weight = Math.max(0, Math.min(1, opts.weight ?? DEFAULT_EDGE_WEIGHT));
  const provenance = opts.provenance ?? "inferred";
  const defaultConfidence = provenance === "explicit" || provenance === "system" ? 1.0 : weight;
  const confidence = Math.max(0, Math.min(1, opts.confidence ?? defaultConfidence));
  const meta = { ...(opts.metadata ?? {}), confidence };
  const metadata = JSON.stringify(meta);
  const now = Date.now();
  const mutationId = opts.mutationId ?? crypto.randomUUID();
  const actorKind = opts.actorKind ?? "system";
  const actorId = opts.actorId ?? (provenance === "inferred" ? "_graph_inference" : "_legacy_graph_writer");
  const mutationKind = opts.mutationKind ?? `${provenance}-upsert`;
  // If the relationship was previously removed, continue its revision lineage
  // instead of silently creating a disconnected audit trail.
  const prior = await env.DB.prepare(
    `SELECT edge_id, revision FROM edge_versions
     WHERE source_id = ? AND target_id = ? AND type = ?
     ORDER BY revision DESC, recorded_at DESC LIMIT 1`,
  ).bind(source, target, type).first<{ edge_id: string; revision: number }>();
  const edgeId = prior?.edge_id ?? crypto.randomUUID();
  const initialRevision = Number(prior?.revision ?? 0) + 1;

  await env.DB.prepare(
    `INSERT INTO edges (
       id, source_id, target_id, type, weight, provenance, metadata,
       confidence, created_at, updated_at, revision, last_actor_kind,
       last_actor_id, last_mutation_kind, last_mutation_id
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source_id, target_id, type) DO UPDATE SET
       weight = max(edges.weight, excluded.weight),
       confidence = max(edges.confidence, excluded.confidence),
       provenance = CASE WHEN excluded.confidence >= edges.confidence THEN excluded.provenance ELSE edges.provenance END,
       metadata = CASE WHEN excluded.confidence >= edges.confidence THEN excluded.metadata ELSE edges.metadata END,
       updated_at = excluded.updated_at,
       revision = edges.revision + 1,
       last_actor_kind = excluded.last_actor_kind,
       last_actor_id = excluded.last_actor_id,
       last_mutation_kind = excluded.last_mutation_kind,
       last_mutation_id = excluded.last_mutation_id`
  ).bind(
    edgeId, source, target, type, weight, provenance, metadata, confidence,
    now, now, initialRevision, actorKind, actorId, mutationKind, mutationId,
  ).run();

  const current = await env.DB.prepare(
    `SELECT id, source_id, target_id, type, revision FROM edges
     WHERE source_id = ? AND target_id = ? AND type = ?`,
  ).bind(source, target, type).first<{
    id: string;
    source_id: string;
    target_id: string;
    type: EdgeType;
    revision: number;
  }>();
  return current ?? { id: edgeId, source_id: source, target_id: target, type, revision: initialRevision };
}

// The single remover for edges. The WHERE is order-agnostic — it matches directed
// edges stated in either direction AND symmetric pairs regardless of the smaller-id-
// first normalization createEdge applied — so callers never re-derive that rule.
// Optional type narrows the delete to one relationship type; omitted removes every
// edge between the pair. Returns rows removed: 0 is not an error (idempotent delete,
// the mirror of createEdge's idempotent upsert).
export async function deleteEdge(
  sourceId: string,
  targetId: string,
  type: string | undefined,
  env: Env,
  context?: EdgeMutationContext,
): Promise<number> {
  let predicate = `((source_id = ? AND target_id = ?) OR (source_id = ? AND target_id = ?))`;
  const bindings: string[] = [sourceId, targetId, targetId, sourceId];
  if (type) {
    predicate += ` AND type = ?`;
    bindings.push(type);
  }
  const mutationId = context?.mutationId ?? crypto.randomUUID();
  const now = Date.now();
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE edges
       SET revision = revision + 1, updated_at = ?, last_actor_kind = ?,
           last_actor_id = ?, last_mutation_kind = ?, last_mutation_id = ?
       WHERE ${predicate}`,
    ).bind(
      now,
      context?.actorKind ?? "system",
      context?.actorId ?? "_legacy_graph_writer",
      context?.mutationKind ?? "explicit-remove",
      mutationId,
      ...bindings,
    ),
    env.DB.prepare(`DELETE FROM edges WHERE ${predicate}`).bind(...bindings),
  ]);
  const result = results[1];
  return result.meta.changes ?? 0;
}

interface EdgeEndpointAccess {
  id: string;
  owner_user_id: string;
  visibility: string;
}

async function edgeEndpointsVisible(
  sourceId: string,
  targetId: string,
  userId: string,
  env: Pick<Env, "DB">,
): Promise<boolean> {
  for (const id of [sourceId, targetId]) {
    const row = await env.DB.prepare(
      `SELECT id, owner_user_id, visibility FROM entries WHERE id = ?`,
    ).bind(id).first<EdgeEndpointAccess>();
    if (!row) return false;
    if (row.owner_user_id !== userId && row.visibility !== "public") return false;
  }
  return true;
}

/** Return one relationship's immutable ledger without exposing private endpoints. */
export async function getEdgeHistory(
  edgeId: string,
  userId: string,
  env: Pick<Env, "DB">,
): Promise<EdgeVersion[] | null> {
  const { results } = await env.DB.prepare(
    `SELECT id, edge_id, source_id, target_id, type, weight, provenance,
            metadata, confidence, edge_created_at, edge_updated_at, revision,
            is_deleted, mutation_kind, mutation_id, actor_kind, actor_id,
            recorded_at
     FROM edge_versions WHERE edge_id = ?
     ORDER BY revision DESC LIMIT 100`,
  ).bind(edgeId).all<EdgeVersion>();
  if (!results.length) return null;
  const latest = results[0];
  if (!await edgeEndpointsVisible(latest.source_id, latest.target_id, userId, env)) return null;
  return results;
}

/**
 * Restore an exact historical relationship state as a new revision. This is a
 * projection restore, never a rewrite of old events. Callers must authenticate
 * a human user; service identities intentionally have no direct restore tool.
 */
export async function restoreEdgeVersion(
  edgeId: string,
  revision: number,
  userId: string,
  env: Env,
): Promise<{ id: string; source_id: string; target_id: string; type: EdgeType; revision: number } | null> {
  const selected = await env.DB.prepare(
    `SELECT id, edge_id, source_id, target_id, type, weight, provenance,
            metadata, confidence, edge_created_at, edge_updated_at, revision,
            is_deleted, mutation_kind, mutation_id, actor_kind, actor_id,
            recorded_at
     FROM edge_versions WHERE edge_id = ? AND revision = ?`,
  ).bind(edgeId, revision).first<EdgeVersion>();
  if (!selected || !isValidEdgeType(selected.type)) return null;
  if (!await edgeEndpointsVisible(selected.source_id, selected.target_id, userId, env)) return null;

  const source = await env.DB.prepare(
    `SELECT visibility, owner_user_id FROM entries WHERE id = ?`,
  ).bind(selected.source_id).first<{ visibility: string; owner_user_id: string }>();
  const target = await env.DB.prepare(
    `SELECT visibility, owner_user_id FROM entries WHERE id = ?`,
  ).bind(selected.target_id).first<{ visibility: string; owner_user_id: string }>();
  if (!source || !target || source.visibility !== target.visibility) return null;
  if (source.visibility === "private" && source.owner_user_id !== target.owner_user_id) return null;
  if (source.visibility !== "private" && source.visibility !== "public") return null;

  const current = await env.DB.prepare(
    `SELECT id, revision FROM edges
     WHERE source_id = ? AND target_id = ? AND type = ?`,
  ).bind(selected.source_id, selected.target_id, selected.type)
    .first<{ id: string; revision: number }>();
  // A distinct live lineage for the same canonical relationship must be
  // resolved deliberately instead of being overwritten by a restore.
  if (current && current.id !== edgeId) return null;

  const latest = await env.DB.prepare(
    `SELECT MAX(revision) AS revision FROM edge_versions WHERE edge_id = ?`,
  ).bind(edgeId).first<{ revision: number | null }>();
  const nextRevision = Math.max(Number(latest?.revision ?? 0), Number(current?.revision ?? 0)) + 1;
  const now = Date.now();
  const mutationId = crypto.randomUUID();
  const write = await env.DB.prepare(
    `INSERT INTO edges (
       id, source_id, target_id, type, weight, provenance, metadata,
       confidence, created_at, updated_at, revision, last_actor_kind,
       last_actor_id, last_mutation_kind, last_mutation_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'human', ?, 'restore', ?)
     ON CONFLICT(source_id, target_id, type) DO UPDATE SET
       weight = excluded.weight,
       provenance = excluded.provenance,
       metadata = excluded.metadata,
       confidence = excluded.confidence,
       updated_at = excluded.updated_at,
       revision = edges.revision + 1,
       last_actor_kind = 'human',
       last_actor_id = excluded.last_actor_id,
       last_mutation_kind = 'restore',
       last_mutation_id = excluded.last_mutation_id
     WHERE edges.id = excluded.id`,
  ).bind(
    edgeId, selected.source_id, selected.target_id, selected.type,
    selected.weight, selected.provenance, selected.metadata,
    selected.confidence, selected.edge_created_at, now, nextRevision, userId,
    mutationId,
  ).run();
  if ((write.meta.changes ?? 0) !== 1) return null;

  return await env.DB.prepare(
    `SELECT id, source_id, target_id, type, revision FROM edges WHERE id = ?`,
  ).bind(edgeId).first<{
    id: string;
    source_id: string;
    target_id: string;
    type: EdgeType;
    revision: number;
  }>();
}

// ─── Graph traversal ────────────────────────────────────────────────────────────

export interface GraphNeighbor {
  id: string;
  hop: number;
  viaWeight: number;
  viaType: EdgeType;
  viaConfidence: number;
}

// Returns the subset of `ids` whose entry is no longer recall-eligible
// (status:deprecated tag, or epistemic superseded/retracted).
async function deprecatedIdsAmong(ids: string[], env: Env): Promise<Set<string>> {
  const deprecated = new Set<string>();
  for (let i = 0; i < ids.length; i += D1_MAX_BOUND_PARAMS) {
    const batch = ids.slice(i, i + D1_MAX_BOUND_PARAMS);
    const ph = batch.map(() => "?").join(", ");
    const { results } = await env.DB.prepare(
      `SELECT id, tags, epistemic_status FROM entries WHERE id IN (${ph})`
    ).bind(...batch).all() as { results: Record<string, any>[] };
    for (const r of results) {
      const tags = JSON.parse(r.tags ?? "[]");
      if (!isRecallEligible(tags, r.epistemic_status)) deprecated.add(r.id as string);
    }
  }
  return deprecated;
}

// Breadth-first traversal of the edges table outward from a set of seed nodes.
// Shared by recall (multi-hop expansion), GET /connections, and GET /graph. Bounded
// by hop/fanout/node caps so a heavily-connected node can't explode the query, and
// skips status:deprecated nodes by default so stale entries aren't traversed through.
export async function expandGraph(
  seedIds: string[],
  opts: { hops: number; fanoutCap?: number; maxNodes?: number; includeDeprecated?: boolean },
  env: Env,
  userId?: string,
): Promise<GraphNeighbor[]> {
  const hops = Math.max(0, Math.min(GRAPH_MAX_HOPS, opts.hops));
  if (hops === 0 || seedIds.length === 0) return [];
  const fanoutCap = opts.fanoutCap ?? GRAPH_FANOUT_CAP;
  const maxNodes = opts.maxNodes ?? GRAPH_MAX_NODES;

  const visited = new Set(seedIds);
  const out: GraphNeighbor[] = [];
  let frontier = [...seedIds];

  for (let hop = 1; hop <= hops && frontier.length && out.length < maxNodes; hop++) {
    // Pull every edge touching the current frontier, strongest first (batched).
    const edgeRows: { source_id: string; target_id: string; type: string; weight: number; confidence: number }[] = [];
    for (let i = 0; i < frontier.length; i += EDGE_QUERY_BATCH) {
      const batch = frontier.slice(i, i + EDGE_QUERY_BATCH);
      const ph = batch.map(() => "?").join(", ");
      const { results } = await env.DB.prepare(
        `SELECT source_id, target_id, type, weight, confidence FROM edges WHERE source_id IN (${ph}) OR target_id IN (${ph}) ORDER BY weight DESC`
      ).bind(...batch, ...batch).all() as { results: any[] };
      edgeRows.push(...results);
    }

    // For each frontier node, take its strongest unseen neighbors up to the fanout cap.
    const frontierSet = new Set(frontier);
    const perNodeCount = new Map<string, number>();
    const candidates: GraphNeighbor[] = [];
    for (const e of edgeRows) {
      let from: string | null = null;
      let to: string | null = null;
      if (frontierSet.has(e.source_id)) { from = e.source_id; to = e.target_id; }
      else if (frontierSet.has(e.target_id)) { from = e.target_id; to = e.source_id; }
      if (!from || !to || visited.has(to)) continue;
      const n = perNodeCount.get(from) ?? 0;
      if (n >= fanoutCap) continue;
      perNodeCount.set(from, n + 1);
      candidates.push({ id: to, hop, viaWeight: e.weight, viaType: e.type as EdgeType, viaConfidence: e.confidence ?? 1.0 });
    }

    // Drop deprecated nodes before they enter results or the next frontier.
    let allowed = candidates;
    if (!opts.includeDeprecated && candidates.length) {
      const deprecated = await deprecatedIdsAmong([...new Set(candidates.map(c => c.id))], env);
      allowed = candidates.filter(c => !deprecated.has(c.id));
    }

    // Visibility filter: anonymous callers get public entries only.
    if (allowed.length) {
      const candidateIds = [...new Set(allowed.map(c => c.id))];
      const visibleIds = await filterVisibleIds(candidateIds, userId, env);
      const visibleSet = new Set(visibleIds);
      allowed = allowed.filter(c => visibleSet.has(c.id));
    }

    const nextFrontier: string[] = [];
    for (const c of allowed) {
      if (visited.has(c.id)) continue; // first (strongest) wins; dedupe across this hop
      if (out.length >= maxNodes) break;
      visited.add(c.id);
      out.push(c);
      nextFrontier.push(c.id);
    }
    frontier = nextFrontier;
  }

  return out;
}

// Filter entry IDs to only those visible to the given user: own entries + all public.
// Used by expandGraph and runGraphPass to enforce visibility during traversal.
export async function filterVisibleIds(ids: string[], userId: string | undefined, env: Env): Promise<string[]> {
  if (!ids.length) return [];
  const visible: string[] = [];
  for (let i = 0; i < ids.length; i += D1_MAX_BOUND_PARAMS) {
    const batch = ids.slice(i, i + D1_MAX_BOUND_PARAMS);
    const ph = batch.map(() => "?").join(", ");
    const { results } = await env.DB.prepare(
      `SELECT id, visibility, owner_user_id FROM entries WHERE id IN (${ph})`
    ).bind(...batch).all() as { results: { id: string; visibility: string; owner_user_id: string }[] };
    for (const r of results) {
      if ((userId && r.owner_user_id === userId) || r.visibility === "public") visible.push(r.id);
    }
  }
  return visible;
}

// Hydrate graph node ids into full entry rows (id → row), batched within the D1
// bound-param limit. Shared by /connections and /graph.
async function hydrateGraphEntries(ids: string[], env: Env): Promise<Map<string, Record<string, any>>> {
  const map = new Map<string, Record<string, any>>();
  for (let i = 0; i < ids.length; i += D1_MAX_BOUND_PARAMS) {
    const batch = ids.slice(i, i + D1_MAX_BOUND_PARAMS);
    const ph = batch.map(() => "?").join(", ");
    const { results } = await env.DB.prepare(
      `SELECT id, content, tags, source, created_at, owner_user_id, visibility FROM entries WHERE id IN (${ph})`
    ).bind(...batch).all() as { results: Record<string, any>[] };
    for (const r of results) map.set(r.id as string, r);
  }
  return map;
}

export interface Connection {
  id: string;
  content: string;
  tags: string[];
  source: string | null;
  created_at: number;
  type: EdgeType;
  label: string;
  weight: number;
  confidence: number;
}

// 1-hop neighborhood of an entry, hydrated and annotated with edge type/weight.
// Backs both the `connections` MCP tool and GET /connections.
export async function getConnections(id: string, type: string | undefined, env: Env, userId?: string): Promise<Connection[]> {
  let neighbors = await expandGraph([id], { hops: 1 }, env, userId);
  if (type) neighbors = neighbors.filter(n => n.viaType === type);
  if (!neighbors.length) return [];

  const rows = await hydrateGraphEntries(neighbors.map(n => n.id), env);
  const out: Connection[] = [];
  for (const n of neighbors) {
    const row = rows.get(n.id);
    if (!row) continue; // neighbor was deleted (cascade should prevent this) — skip dangling
    const tags: string[] = JSON.parse(row.tags ?? "[]");
    if (!((userId && row.owner_user_id === userId) || row.visibility === "public")) continue;
    out.push({
      id: n.id,
      content: row.content as string,
      tags,
      source: sanitizeSourceMetadataForOutput(
        { source: row.source },
        userId && row.owner_user_id === userId ? "owner_mcp" : "team_public",
      ).source,
      created_at: row.created_at as number,
      type: n.viaType,
      label: edgeLabel(n.viaType),
      weight: n.viaWeight,
      confidence: n.viaConfidence,
    });
  }
  return out;
}

export interface GraphNode {
  id: string;
  label: string;
  tags: string[];
  kind: MemoryKind | null;
  status: MemoryStatus | null;
  importance: number;
  created_at: number;
}

export interface GraphView {
  nodes: GraphNode[];
  edges: { source: string; target: string; type: string; weight: number; confidence: number }[];
}

// Assemble a node+edge subgraph for the dashboard graph view. Either the 2-hop
// neighborhood of a seed entry, or (default) the most strongly-connected slice of the
// whole graph — uncapped unless the caller passes an explicit limit. Only edges whose
// BOTH endpoints are in the returned node set are included, so the client never has
// to handle dangling edges.
export async function buildGraph(opts: { seed?: string; limit?: number; userId?: string }, env: Env): Promise<GraphView> {
  const limit = opts.limit && opts.limit > 0 ? opts.limit : Infinity;

  // 1. Determine the candidate node id set.
  let nodeIds: string[];
  if (opts.seed) {
    const neighbors = await expandGraph([opts.seed], { hops: 2, maxNodes: limit, includeDeprecated: true }, env, opts.userId);
    nodeIds = [opts.seed, ...neighbors.map(n => n.id)].slice(0, limit);
  } else {
    const sql = Number.isFinite(limit)
      ? `SELECT source_id, target_id FROM edges ORDER BY weight DESC LIMIT ${limit * 4}`
      : `SELECT source_id, target_id FROM edges ORDER BY weight DESC`;
    const { results } = await env.DB.prepare(sql)
      .all() as { results: { source_id: string; target_id: string }[] };
    const ids: string[] = [];
    const seenIds = new Set<string>();
    for (const r of results) {
      for (const id of [r.source_id, r.target_id]) {
        if (ids.length >= limit) break;
        if (!seenIds.has(id)) { seenIds.add(id); ids.push(id); }
      }
      if (ids.length >= limit) break;
    }
    nodeIds = ids;
  }
  if (!nodeIds.length) return { nodes: [], edges: [] };

  // 2. Hydrate nodes (drop ids with no entry row — that's how dangling edges get pruned).
  const nodeRows = new Map<string, Record<string, any>>();
  for (let i = 0; i < nodeIds.length; i += D1_MAX_BOUND_PARAMS) {
    const batch = nodeIds.slice(i, i + D1_MAX_BOUND_PARAMS);
    const ph = batch.map(() => "?").join(", ");
    const { results } = await env.DB.prepare(
      `SELECT id, content, tags, importance_score, created_at, owner_user_id, visibility FROM entries WHERE id IN (${ph})`
    ).bind(...batch).all() as { results: Record<string, any>[] };
    for (const r of results) nodeRows.set(r.id as string, r);
  }

  const nodes: GraphNode[] = [];
  for (const id of nodeIds) {
    const r = nodeRows.get(id);
    if (!r) continue;
    const tags: string[] = JSON.parse(r.tags ?? "[]");
    if (!((opts.userId && r.owner_user_id === opts.userId) || r.visibility === "public")) continue;
    nodes.push({
      id,
      label: (r.content as string).slice(0, 80),
      tags,
      kind: getKind(tags) as MemoryKind | null,
      status: getStatus(tags) as MemoryStatus | null,
      importance: (r.importance_score as number) ?? 0,
      created_at: r.created_at as number,
    });
  }
  const nodeIdSet = new Set(nodes.map(n => n.id));
  if (!nodeIdSet.size) return { nodes: [], edges: [] };

  // 3. Edges with BOTH endpoints present. Fetch edges touching the node set (chunked,
  // 2 binds/id), then keep only the internal ones — never a dangling edge.
  const presentIds = [...nodeIdSet];
  const edgeSeen = new Set<string>();
  const edges: GraphView["edges"] = [];
  for (let i = 0; i < presentIds.length; i += EDGE_QUERY_BATCH) {
    const batch = presentIds.slice(i, i + EDGE_QUERY_BATCH);
    const ph = batch.map(() => "?").join(", ");
    const { results } = await env.DB.prepare(
      `SELECT source_id, target_id, type, weight, confidence FROM edges WHERE source_id IN (${ph}) OR target_id IN (${ph}) ORDER BY weight DESC`
    ).bind(...batch, ...batch).all() as { results: any[] };
    for (const e of results) {
      if (!nodeIdSet.has(e.source_id) || !nodeIdSet.has(e.target_id)) continue;
      const key = `${e.source_id}|${e.target_id}|${e.type}`;
      if (edgeSeen.has(key)) continue;
      edgeSeen.add(key);
      edges.push({ source: e.source_id, target: e.target_id, type: e.type, weight: e.weight, confidence: e.confidence ?? 1.0 });
    }
  }

  return { nodes, edges };
}

// Auto-link a freshly-stored entry to its most-similar existing neighbors with
// inferred `relates_to` edges. Reuses the similarity scores already computed during
// duplicate/contradiction detection — no extra embed or Vectorize query. Only the
// strongest few links above a confidence floor are kept so the graph stays sparse;
// the nightly graph pass later refines and types these.
//
// Threshold tuned for the bge-small-en-v1.5 embedding model, whose cosine scores are
// NOT spread across [0,1]: unrelated text lands ~0.4–0.6, mere keyword/concept overlap
// ~0.6–0.7, genuinely same-topic ~0.78–0.85, near-duplicate ≥0.85. We sit just below
// the 0.85 smart-merge band so we capture "clearly related but distinct" while
// rejecting loose overlap (e.g. "espresso filter" vs "Buy Me a Coffee", ~0.65). Lower
// toward ~0.74 if the graph feels too sparse; raise toward ~0.82 if noise returns.
export async function inferEdgesOnWrite(
  newId: string,
  neighbors: { id: string; score: number }[],
  env: Env,
): Promise<void> {
  const top = neighbors
    .filter(n => n.id !== newId && n.score >= EDGE_INFER_THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .slice(0, EDGE_INFER_MAX);
  for (const n of top) {
    await createEdge(newId, n.id, "relates_to", { weight: n.score, provenance: "inferred" }, env);
  }
}

// Compute auto-link neighbors from a query embedding: the topK Vectorize matches
// collapsed to parent ids (strongest score per parent). Lets the append path reuse the
// same inference as on capture without re-deriving the dedupe logic.
export async function neighborsFromVectorQuery(values: number[], env: Env, userId?: string): Promise<{ id: string; score: number }[]> {
  const { matches } = await queryVisibleVectors(values, env, { topK: 5, userId });
  const scores = new Map<string, number>();
  for (const m of matches) {
    const pid = vectorMatchParentId(m);
    scores.set(pid, Math.max(scores.get(pid) ?? 0, m.score));
  }
  return [...scores.entries()].map(([id, score]) => ({ id, score }));
}
