/**
 * erasure.ts — Complete, dependency-safe permanent erasure for entries.
 *
 * One traversal serves direct forget (REST / MCP / lifecycle) and the private
 * entry purge inside deactivation. D1 is the durable authority: a Vectorize
 * outage never leaves searchable content after the D1 projection is gone. On a
 * genuine remote failure the tracked vector IDs (never content) are queued by
 * erasure operation ID and retried by the active repair schedule; the erasure
 * receipt only reaches `complete` once every queued vector has been deleted.
 *
 * The only retained erasure receipt is metadata: operation ID, actor, entry
 * UUID, vector count, timestamps, and status. It never stores content, tags,
 * URLs, source titles, prompts, queries, or output excerpts.
 */

import type { ActorContext, Env } from "./types";
import { INTEGRATION_PROVIDERS, loadIntegration, saveIntegration } from "./integrations";
import { sqlChanges } from "./governance-utils";

export const ERASURE_CLEANUP_REASON_PREFIX = "erasure:";

export const VECTOR_DELETE_BATCH_SIZE = 1_000;

export type ErasureReceiptStatus = "complete" | "pending_cleanup" | "stale";

export type EraseEntryResult =
  | { status: "not_found" }
  | { status: "complete"; operationId: string; vectorCount: number }
  | { status: "pending_cleanup"; operationId: string; vectorCount: number };

export interface TrackedEntryVectors {
  vectorIds: string[];
  cleanupQueueIds: string[];
}

export interface ErasureStatusView {
  operationId: string;
  entryId: string;
  ownerUserId: string;
  status: ErasureReceiptStatus;
  vectorCount: number;
  createdAt: number;
  completedAt: number | null;
}

type OwnedEntryRow = {
  id: string;
  owner_user_id: string;
  vector_ids: string;
};

function parseVectorIds(raw: string, label: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Cannot forget entry: malformed vector_ids for ${label}`);
  }
  if (
    !Array.isArray(parsed)
    || !parsed.every((id) => typeof id === "string" && id.length > 0)
  ) {
    throw new Error(`Cannot forget entry: malformed vector_ids for ${label}`);
  }
  return parsed;
}

/**
 * Every vector that could still be searched for this entry: the entry's own
 * list, every passage's list, and stale vectors recorded in entry-version
 * cleanup rows. Malformed tracking fails safely before any mutation so no
 * orphaned vector ID can ever be lost.
 */
export async function collectTrackedEntryVectors(
  env: Pick<Env, "DB">,
  entry: OwnedEntryRow,
): Promise<TrackedEntryVectors> {
  const vectorIds = new Set(parseVectorIds(entry.vector_ids, `entry ${entry.id}`));
  const passages = await env.DB.prepare(
    `SELECT id, vector_ids FROM passages WHERE entry_id = ?`,
  ).bind(entry.id).all<{ id: string; vector_ids: string }>();
  for (const passage of passages.results) {
    for (const id of parseVectorIds(passage.vector_ids, `passage ${passage.id}`)) {
      vectorIds.add(id);
    }
  }

  const prefix = `entry-version:${entry.id}:`;
  const cleanup = await env.DB.prepare(
    `SELECT id, vector_ids FROM vector_cleanup_queue
     WHERE substr(reason, 1, ?) = ?`,
  ).bind(prefix.length, prefix).all<{ id: string; vector_ids: string }>();
  for (const item of cleanup.results) {
    for (const id of parseVectorIds(item.vector_ids, `cleanup queue ${item.id}`)) {
      vectorIds.add(id);
    }
  }

  return {
    vectorIds: [...vectorIds],
    cleanupQueueIds: cleanup.results.map((row) => row.id),
  };
}

/**
 * Every owned artifact id for an entry, including the entry itself: episodes,
 * snapshots, passages, passage-only documents and sections.
 */
export async function collectEntryArtifactIds(
  env: Pick<Env, "DB">,
  entryId: string,
): Promise<Set<string>> {
  const { results } = await env.DB.prepare(
    `SELECT id FROM entries WHERE id = ?
     UNION
     SELECT id FROM episodes WHERE entry_id = ?
     UNION
     SELECT id FROM entry_snapshots WHERE entry_id = ?
     UNION
     SELECT id FROM passages WHERE entry_id = ?
     UNION
     SELECT d.id FROM documents d
       WHERE d.episode_id IN (SELECT id FROM episodes WHERE entry_id = ?)
          OR d.id IN (
            SELECT document_id FROM passages
            WHERE entry_id = ? AND document_id IS NOT NULL
          )
     UNION
     SELECT s.id FROM document_sections s
       WHERE s.document_id IN (
         SELECT d.id FROM documents d
         WHERE d.episode_id IN (SELECT id FROM episodes WHERE entry_id = ?)
            OR d.id IN (
              SELECT document_id FROM passages
              WHERE entry_id = ? AND document_id IS NOT NULL
            )
       )`,
  ).bind(
    entryId,
    entryId,
    entryId,
    entryId,
    entryId,
    entryId,
    entryId,
    entryId,
  ).all<{ id: string }>();
  return new Set(results.map((row) => row.id));
}

function payloadContainsArtifact(value: unknown, artifactIds: ReadonlySet<string>): boolean {
  if (typeof value === "string") return artifactIds.has(value);
  if (Array.isArray(value)) {
    return value.some((item) => payloadContainsArtifact(item, artifactIds));
  }
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>)
      .some((item) => payloadContainsArtifact(item, artifactIds));
  }
  return false;
}

function proposalTouchesArtifacts(
  proposal: { target_ids: string; payload_json: string },
  artifactIds: ReadonlySet<string>,
): boolean {
  for (const raw of [proposal.target_ids, proposal.payload_json]) {
    try {
      if (payloadContainsArtifact(JSON.parse(raw), artifactIds)) return true;
    } catch {
      for (const id of artifactIds) {
        if (raw.includes(`\"${id}\"`)) return true;
      }
    }
  }
  return false;
}

/**
 * Legacy/generic action proposals whose target ids or payload reference any
 * artifact of the entry. These must be purged with their events so no proposal
 * can resolve back to deleted content.
 */
export async function collectEntryProposalIds(
  env: Pick<Env, "DB">,
  artifactIds: ReadonlySet<string>,
): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, target_ids, payload_json FROM action_proposals`,
  ).all<{ id: string; target_ids: string; payload_json: string }>();
  return results
    .filter((proposal) => proposalTouchesArtifacts(proposal, artifactIds))
    .map((proposal) => proposal.id);
}

/**
 * proposal_events is append-only during normal operation. Compliance purge
 * removes the two guards and restores them in the same atomic D1 batch, so no
 * non-compliance writer can observe an unguarded table.
 */
export function appendProposalPurgeStatements(
  statements: D1PreparedStatement[],
  env: Pick<Env, "DB">,
  proposalIds: readonly string[],
): void {
  if (proposalIds.length === 0) return;
  statements.push(
    env.DB.prepare(`DROP TRIGGER IF EXISTS proposal_events_no_update`),
    env.DB.prepare(`DROP TRIGGER IF EXISTS proposal_events_no_delete`),
  );
  for (const proposalId of proposalIds) {
    statements.push(
      env.DB.prepare(`DELETE FROM proposal_events WHERE proposal_id = ?`).bind(proposalId),
      env.DB.prepare(`DELETE FROM action_proposals WHERE id = ?`).bind(proposalId),
    );
  }
  statements.push(
    env.DB.prepare(
      `CREATE TRIGGER proposal_events_no_update
       BEFORE UPDATE ON proposal_events
       BEGIN
         SELECT RAISE(ABORT, 'proposal_events are append-only');
       END`,
    ),
    env.DB.prepare(
      `CREATE TRIGGER proposal_events_no_delete
       BEFORE DELETE ON proposal_events
       BEGIN
         SELECT RAISE(ABORT, 'proposal_events are append-only');
       END`,
    ),
  );
}

/**
 * Delete every tracked vector from the Vectorize index in bounded batches.
 * Deletion is idempotent, so a later retry is always safe.
 */
export async function deleteTrackedVectors(
  env: Pick<Env, "DB" | "VECTORIZE">,
  vectorIds: readonly string[],
): Promise<void> {
  for (let offset = 0; offset < vectorIds.length; offset += VECTOR_DELETE_BATCH_SIZE) {
    await env.VECTORIZE.deleteByIds(vectorIds.slice(offset, offset + VECTOR_DELETE_BATCH_SIZE));
  }
}

/**
 * Queue tracked vector IDs for the repair schedule under the erasure operation
 * ID. Only IDs are stored — never content.
 */
export async function enqueueErasureCleanup(
  env: Pick<Env, "DB">,
  operationId: string,
  entryId: string,
  vectorIds: readonly string[],
  now: number,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO vector_cleanup_queue (
       id, vector_ids, reason, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(),
    JSON.stringify(vectorIds),
    `${ERASURE_CLEANUP_REASON_PREFIX}${operationId}:${entryId}`,
    now,
    now,
  ).run();
}

/**
 * Build the dependency-safe D1 deletion batch for an entry: proposals first,
 * then graph and provenance (edge proposals, edges, edge versions), then
 * document/section provenance, then passages, snapshots, episodes, awareness
 * and overlap rows, stale entry-version cleanup rows, and finally the entry
 * itself. Child content is removed before the row that references it.
 */
export function buildErasureStatements(
  env: Pick<Env, "DB">,
  entryId: string,
  opts: {
    cleanupQueueIds?: readonly string[];
    proposalIds?: readonly string[];
    deleteEntry?: { ownerUserId?: string; excludePublic?: boolean } | null;
  } = {},
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  appendProposalPurgeStatements(statements, env, opts.proposalIds ?? []);
  statements.push(
    env.DB.prepare(
      `DELETE FROM edge_proposals WHERE source_id = ? OR target_id = ?`,
    ).bind(entryId, entryId),
    env.DB.prepare(
      `DELETE FROM edges WHERE source_id = ? OR target_id = ?`,
    ).bind(entryId, entryId),
    env.DB.prepare(
      `DELETE FROM edge_versions WHERE source_id = ? OR target_id = ?`,
    ).bind(entryId, entryId),
    env.DB.prepare(
      `DELETE FROM document_sections
       WHERE document_id IN (
         SELECT d.id FROM documents d
         WHERE d.episode_id IN (SELECT id FROM episodes WHERE entry_id = ?)
            OR d.id IN (
              SELECT document_id FROM passages
              WHERE entry_id = ? AND document_id IS NOT NULL
            )
       )`,
    ).bind(entryId, entryId),
    env.DB.prepare(
      `DELETE FROM documents
       WHERE episode_id IN (SELECT id FROM episodes WHERE entry_id = ?)
          OR id IN (
            SELECT document_id FROM passages
            WHERE entry_id = ? AND document_id IS NOT NULL
          )`,
    ).bind(entryId, entryId),
    env.DB.prepare(`DELETE FROM passages WHERE entry_id = ?`).bind(entryId),
    env.DB.prepare(`DELETE FROM entry_snapshots WHERE entry_id = ?`).bind(entryId),
    env.DB.prepare(`DELETE FROM episodes WHERE entry_id = ?`).bind(entryId),
    env.DB.prepare(
      `DELETE FROM awareness_events
       WHERE entry_a_id = ? OR entry_b_id = ? OR trigger_entry_id = ?`,
    ).bind(entryId, entryId, entryId),
    env.DB.prepare(
      `DELETE FROM overlap_awareness_reconciliation
       WHERE new_entry_id = ? OR matched_entry_id = ?`,
    ).bind(entryId, entryId),
  );
  for (const queueId of opts.cleanupQueueIds ?? []) {
    statements.push(
      env.DB.prepare(`DELETE FROM vector_cleanup_queue WHERE id = ?`).bind(queueId),
    );
  }
  if (opts.deleteEntry) {
    let sql = `DELETE FROM entries WHERE id = ?`;
    const bindings: string[] = [entryId];
    if (opts.deleteEntry.ownerUserId) {
      sql += ` AND owner_user_id = ?`;
      bindings.push(opts.deleteEntry.ownerUserId);
    }
    if (opts.deleteEntry.excludePublic) {
      sql += ` AND visibility <> 'public'`;
    }
    statements.push(env.DB.prepare(sql).bind(...bindings));
  }
  return statements;
}

function receiptInsert(
  env: Pick<Env, "DB">,
  input: {
    operationId: string;
    entryId: string;
    ownerUserId: string;
    actorUserId: string;
    vectorCount: number;
    status: ErasureReceiptStatus;
    now: number;
  },
): D1PreparedStatement {
  const completedAt = input.status === "complete" ? input.now : null;
  return env.DB.prepare(
    `INSERT INTO erasure_receipts (
       operation_id, entry_id, owner_user_id, actor_user_id,
       vector_count, status, created_at, updated_at, completed_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    input.operationId,
    input.entryId,
    input.ownerUserId,
    input.actorUserId,
    input.vectorCount,
    input.status,
    input.now,
    input.now,
    completedAt,
  );
}

/**
 * Remove integration itemMap entries that reference the deleted entry so no
 * provider mirror can lead back to content that no longer exists. Best-effort:
 * a KV failure must never fail the erasure that already committed in D1.
 */
export async function removeEntryIntegrationMappings(
  env: Pick<Env, "OAUTH_KV">,
  ownerUserId: string,
  entryId: string,
): Promise<void> {
  for (const provider of Object.values(INTEGRATION_PROVIDERS)) {
    try {
      const record = await loadIntegration(env, ownerUserId, provider.id);
      if (!record) continue;
      const before = Object.keys(record.itemMap).length;
      for (const [externalId, mapping] of Object.entries(record.itemMap)) {
        if (mapping.entryId === entryId) delete record.itemMap[externalId];
      }
      if (Object.keys(record.itemMap).length !== before) {
        await saveIntegration(env, ownerUserId, record);
      }
    } catch {
      // The durable D1 erasure is authoritative; mirror map cleanup retries
      // on the next forget/erasure of this user's entries.
    }
  }
}

/**
 * Shared permanent erasure path for direct forget and deactivation. Deletes
 * the complete D1 projection in one atomic batch and, when the remote delete
 * succeeds, emits a completed erasure receipt. On a genuine remote failure the
 * entry is still removed so stale vectors immediately fail D1 reauthorization,
 * the vector IDs are queued under the operation ID, and the receipt stays
 * `pending_cleanup` until the repair schedule drains the queue.
 *
 * `extraBatchStatements` lets deactivation advance its transfer cursor in the
 * same atomic D1 batch so a committed erasure is never left behind a stale
 * cursor.
 */
export async function eraseEntryArtifacts(
  entryId: string,
  actor: ActorContext,
  env: Env,
  opts: {
    now?: number;
    /** Extra D1 statements appended to the atomic erasure batch. */
    extraBatchStatements?: (now: number) => D1PreparedStatement[];
    /** Ownership/visibility guard for the final entries DELETE. */
    deleteEntry?: { ownerUserId?: string; excludePublic?: boolean };
  } = {},
): Promise<EraseEntryResult> {
  const now = opts.now ?? Date.now();
  const row = await env.DB.prepare(
    `SELECT id, owner_user_id, vector_ids FROM entries WHERE id = ?`,
  ).bind(entryId).first<OwnedEntryRow>();
  if (!row) return { status: "not_found" };

  const tracked = await collectTrackedEntryVectors(env, row);
  const artifactIds = await collectEntryArtifactIds(env, entryId);
  const proposalIds = await collectEntryProposalIds(env, artifactIds);
  const operationId = crypto.randomUUID();

  let status: "complete" | "pending_cleanup";
  try {
    await deleteTrackedVectors(env, tracked.vectorIds);
    status = "complete";
  } catch {
    await enqueueErasureCleanup(env, operationId, entryId, tracked.vectorIds, now);
    status = "pending_cleanup";
  }

  const statements = buildErasureStatements(env, entryId, {
    cleanupQueueIds: tracked.cleanupQueueIds,
    proposalIds,
    deleteEntry: opts.deleteEntry ?? {},
  });
  statements.push(
    receiptInsert(env, {
      operationId,
      entryId,
      ownerUserId: row.owner_user_id,
      actorUserId: actor.actorId,
      vectorCount: tracked.vectorIds.length,
      status,
      now,
    }),
  );
  for (const extra of opts.extraBatchStatements?.(now) ?? []) statements.push(extra);
  await env.DB.batch(statements);

  await removeEntryIntegrationMappings(env, row.owner_user_id, entryId);

  return { status, operationId, vectorCount: tracked.vectorIds.length };
}

/**
 * Flip a `pending_cleanup` erasure receipt to `complete` once the repair
 * schedule has drained every queued vector ID for that operation. Refuses to
 * complete a receipt that is not pending, so an already-complete receipt stays
 * complete and a stale receipt requires an operator decision.
 */
export async function finalizeErasureReceipt(
  env: Pick<Env, "DB">,
  operationId: string,
  now?: number,
): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE erasure_receipts
     SET status = 'complete', completed_at = ?, updated_at = ?
     WHERE operation_id = ? AND status = 'pending_cleanup'`,
  ).bind(now ?? Date.now(), now ?? Date.now(), operationId).run();
  return sqlChanges(result) === 1;
}

/**
 * Metadata-only status lookup for an erasure operation. Never returns content.
 */
export async function getErasureStatus(
  env: Pick<Env, "DB">,
  operationId: string,
): Promise<ErasureStatusView | null> {
  const row = await env.DB.prepare(
    `SELECT operation_id, entry_id, owner_user_id, status, vector_count,
            created_at, completed_at
     FROM erasure_receipts WHERE operation_id = ?`,
  ).bind(operationId).first<{
    operation_id: string;
    entry_id: string;
    owner_user_id: string;
    status: ErasureReceiptStatus;
    vector_count: number;
    created_at: number;
    completed_at: number | null;
  }>();
  if (!row) return null;
  return {
    operationId: row.operation_id,
    entryId: row.entry_id,
    ownerUserId: row.owner_user_id,
    status: row.status,
    vectorCount: row.vector_count,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

/**
 * Alert sweep for erasures stuck in `pending_cleanup`. After the threshold the
 * receipt is flagged `stale` and a security event is recorded so an operator
 * can inspect the metadata-only status endpoint. The repair schedule keeps
 * draining the queue regardless of receipt status.
 */
export async function flagPendingErasures(
  env: Pick<Env, "DB">,
  opts: { now?: number; staleAfterMs?: number } = {},
): Promise<number> {
  const now = opts.now ?? Date.now();
  const staleAfterMs = opts.staleAfterMs ?? 10 * 60 * 1000;
  const { results } = await env.DB.prepare(
    `SELECT operation_id, entry_id, created_at
     FROM erasure_receipts
     WHERE status = 'pending_cleanup' AND created_at < ?`,
  ).bind(now - staleAfterMs).all<{ operation_id: string; entry_id: string; created_at: number }>();

  for (const row of results) {
    await env.DB.prepare(
      `UPDATE erasure_receipts
       SET status = 'stale', updated_at = ?
       WHERE operation_id = ? AND status = 'pending_cleanup'`,
    ).bind(now, row.operation_id).run();
    await env.DB.prepare(
      `INSERT INTO security_events (
         id, event_type, actor_kind, actor_id, reason, error_code,
         metadata, created_at
       ) VALUES (?, ?, 'system', ?, ?, 'erasure_pending_stale', ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      "erasure_pending_stale",
      "_erasure-repair-schedule",
      `Erasure ${row.operation_id} for entry ${row.entry_id} has been pending cleanup since ${row.created_at}`,
      JSON.stringify({ operation_id: row.operation_id, entry_id: row.entry_id }),
      now,
    ).run();
  }
  return results.length;
}
