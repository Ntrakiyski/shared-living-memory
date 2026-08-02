/**
 * Resumable, administrator-governed user deactivation.
 *
 * D1 is the authorization source of truth: the target is made non-active
 * before any asynchronous cleanup starts. Private memory is removed only
 * after every tracked vector has been deleted successfully. Public memory is
 * retained by transferring custody to an active administrator while keeping
 * created_by_user_id unchanged.
 */

import {
  INTEGRATION_PROVIDERS,
  deleteIntegration,
  redactIntegrationError,
} from "./integrations";
import type { Env, HumanActorContext, ServiceScope, UserDeactivation } from "./types";
import { eraseEntryArtifacts } from "./erasure";

const DEFAULT_BATCH_SIZE = 10;
const MAX_BATCH_SIZE = 50;
const ERROR_LIMIT = 500;

type UserRow = {
  id: string;
  status: string;
  role: string;
};

type StoredDeactivation = {
  id: string;
  user_id: string;
  requested_by_user_id: string;
  transfer_to_user_id: string | null;
  transfer_cursor: string | null;
  processed_entries: number;
  status: string;
  last_error: string | null;
  requested_at: number;
  started_at: number | null;
  updated_at: number;
  completed_at: number | null;
};

type OwnedEntry = {
  id: string;
  visibility: string;
  vector_ids: string;
};

export type UserDeactivationErrorCode =
  | "INVALID_INPUT"
  | "ADMIN_REQUIRED"
  | "TARGET_NOT_ACTIVE"
  | "ACTIVE_DEACTIVATION_EXISTS"
  | "ACTIVE_REPLACEMENT_ADMIN_REQUIRED"
  | "LAST_ACTIVE_ADMIN"
  | "DEACTIVATION_NOT_FOUND"
  | "DEACTIVATION_NOT_RESUMABLE"
  | "EXPORT_NOT_ACKNOWLEDGED";

export class UserDeactivationError extends Error {
  constructor(
    readonly code: UserDeactivationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "UserDeactivationError";
  }
}

export interface RequestUserDeactivationInput {
  requesterUserId: string;
  targetUserId: string;
  /**
   * Active administrator that receives retained public memory. Required —
   * the deactivation cannot be requested without a designated custodian.
   */
  transferToUserId: string;
  /**
   * Fixed acknowledgement that the target has exported private data before
   * deactivation permanently purges it. "completed" means the export
   * succeeded; "waived" means the operator explicitly accepted data loss.
   */
  privateExportAcknowledgement: "completed" | "waived";
  deactivationId?: string;
  now?: number;
}

export interface ResumeUserDeactivationInput {
  deactivationId: string;
  actorUserId: string;
  batchSize?: number;
  now?: number;
}

export interface UserDeactivationProgress {
  deactivation: UserDeactivation;
  processedThisRun: number;
  remainingEntries: number;
  phase: "entries" | "blocked" | "completed";
  error?: string;
}

export interface PendingDeactivationRunResult {
  selected: number;
  attempted: number;
  completed: number;
  stillRunning: number;
  blocked: number;
  skippedNoAdmin: number;
  processedEntries: number;
  remainingJobs: number;
}

function requiredId(label: string, value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new UserDeactivationError("INVALID_INPUT", `${label} is required`);
  }
  return value.trim();
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, ERROR_LIMIT);
}

function changes(result: D1Result<unknown> | undefined): number {
  return Number(result?.meta?.changes ?? 0);
}

function toDeactivation(row: StoredDeactivation): UserDeactivation {
  return {
    id: row.id,
    userId: row.user_id,
    requestedByUserId: row.requested_by_user_id,
    transferToUserId: row.transfer_to_user_id,
    transferCursor: row.transfer_cursor,
    processedEntries: Number(row.processed_entries),
    status: row.status as UserDeactivation["status"],
    lastError: row.last_error,
    requestedAt: Number(row.requested_at),
    startedAt: row.started_at === null ? null : Number(row.started_at),
    updatedAt: Number(row.updated_at),
    completedAt: row.completed_at === null ? null : Number(row.completed_at),
  };
}

async function loadDeactivation(
  env: Env,
  id: string,
): Promise<UserDeactivation | null> {
  const row = await env.DB.prepare(
    `SELECT id, user_id, requested_by_user_id, transfer_to_user_id,
            transfer_cursor, processed_entries, status, last_error,
            requested_at, started_at, updated_at, completed_at
     FROM user_deactivations
     WHERE id = ?`,
  ).bind(id).first<StoredDeactivation>();
  return row ? toDeactivation(row) : null;
}

async function loadUser(env: Env, id: string): Promise<UserRow | null> {
  return env.DB.prepare(
    `SELECT id, status, role FROM users WHERE id = ?`,
  ).bind(id).first<UserRow>();
}

function requireActiveAdmin(user: UserRow | null): asserts user is UserRow {
  if (!user || user.status !== "active" || user.role !== "admin") {
    throw new UserDeactivationError(
      "ADMIN_REQUIRED",
      "An active administrator is required",
    );
  }
}

async function requireReplacementAdmin(
  env: Env,
  replacementId: string | null,
  targetId: string,
): Promise<void> {
  if (!replacementId || replacementId === targetId) {
    throw new UserDeactivationError(
      "ACTIVE_REPLACEMENT_ADMIN_REQUIRED",
      "An active replacement administrator is required",
    );
  }
  const replacement = await loadUser(env, replacementId);
  if (!replacement || replacement.status !== "active" || replacement.role !== "admin") {
    throw new UserDeactivationError(
      "ACTIVE_REPLACEMENT_ADMIN_REQUIRED",
      "The replacement custodian must be an active administrator",
    );
  }
}

/**
 * Starts deactivation atomically. Authentication is cut off immediately, and
 * service credentials owned by the target are revoked in the same D1 batch.
 */
export async function requestUserDeactivation(
  input: RequestUserDeactivationInput,
  env: Env,
): Promise<UserDeactivation> {
  const requesterId = requiredId("requesterUserId", input.requesterUserId);
  const targetId = requiredId("targetUserId", input.targetUserId);
  const requester = await loadUser(env, requesterId);
  requireActiveAdmin(requester);

  const target = await loadUser(env, targetId);
  if (!target || target.status !== "active") {
    throw new UserDeactivationError(
      "TARGET_NOT_ACTIVE",
      "The target user must be active",
    );
  }

  const existing = await env.DB.prepare(
    `SELECT id FROM user_deactivations
     WHERE user_id = ? AND status IN ('pending', 'running')
     LIMIT 1`,
  ).bind(targetId).first<{ id: string }>();
  if (existing) {
    throw new UserDeactivationError(
      "ACTIVE_DEACTIVATION_EXISTS",
      "This user already has an active deactivation",
    );
  }

  const publicCount = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM entries
     WHERE owner_user_id = ? AND visibility = 'public'`,
  ).bind(targetId).first<{ count: number }>();

  const transferToUserId = requiredId("transferToUserId", input.transferToUserId);

  const acknowledgement = input.privateExportAcknowledgement;
  if (acknowledgement !== "completed" && acknowledgement !== "waived") {
    throw new UserDeactivationError(
      "EXPORT_NOT_ACKNOWLEDGED",
      `privateExportAcknowledgement must be "completed" or "waived" before deactivation`,
    );
  }

  // An administrator can leave only after another administrator exists, even
  // when the account currently owns no public memory.
  if (target.role === "admin") {
    const otherAdmins = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM users
       WHERE role = 'admin' AND status = 'active' AND id <> ?`,
    ).bind(targetId).first<{ count: number }>();
    if (Number(otherAdmins?.count ?? 0) === 0) {
      throw new UserDeactivationError(
        "LAST_ACTIVE_ADMIN",
        "The last active administrator cannot be deactivated",
      );
    }
    await requireReplacementAdmin(env, transferToUserId, targetId);
  } else if (Number(publicCount?.count ?? 0) > 0) {
    await requireReplacementAdmin(env, transferToUserId, targetId);
  } else {
    await requireReplacementAdmin(env, transferToUserId, targetId);
  }

  const now = input.now ?? Date.now();
  const deactivationId = input.deactivationId?.trim() || crypto.randomUUID();

  let results: D1Result<unknown>[];
  try {
    results = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO user_deactivations (
           id, user_id, requested_by_user_id, transfer_to_user_id,
           transfer_cursor, processed_entries, status, last_error,
           requested_at, started_at, updated_at, completed_at
         )
         SELECT ?, ?, ?, ?, NULL, 0, 'pending', NULL, ?, NULL, ?, NULL
         WHERE EXISTS (
           SELECT 1 FROM users
           WHERE id = ? AND status = 'active' AND role = 'admin'
         )
           AND EXISTS (
             SELECT 1 FROM users WHERE id = ? AND status = 'active'
           )
           AND (
             NOT EXISTS (
               SELECT 1 FROM users
               WHERE id = ? AND status = 'active' AND role = 'admin'
             )
             OR EXISTS (
               SELECT 1 FROM users
               WHERE role = 'admin' AND status = 'active' AND id <> ?
             )
           )
           AND (
             ? IS NULL
             OR EXISTS (
               SELECT 1 FROM users
               WHERE id = ? AND role = 'admin' AND status = 'active' AND id <> ?
             )
           )
           AND (
             NOT EXISTS (
               SELECT 1 FROM entries
               WHERE owner_user_id = ? AND visibility = 'public'
             )
             OR ? IS NOT NULL
           )
           AND NOT EXISTS (
             SELECT 1 FROM user_deactivations
             WHERE user_id = ? AND status IN ('pending', 'running')
           )`,
      ).bind(
        deactivationId,
        targetId,
        requesterId,
        transferToUserId,
        now,
        now,
        requesterId,
        targetId,
        targetId,
        targetId,
        transferToUserId,
        transferToUserId,
        targetId,
        targetId,
        transferToUserId,
        targetId,
      ),
      env.DB.prepare(
        `UPDATE users
         SET status = 'deactivating'
         WHERE id = ? AND status = 'active'
           AND EXISTS (
             SELECT 1 FROM user_deactivations
             WHERE id = ? AND user_id = ? AND requested_by_user_id = ?
               AND status = 'pending'
           )`,
      ).bind(targetId, deactivationId, targetId, requesterId),
      env.DB.prepare(
        `UPDATE service_credentials
         SET status = 'revoked', revoked_at = ?, revoked_by_user_id = ?
         WHERE service_identity_id IN (
           SELECT id FROM service_identities WHERE owner_user_id = ?
         )
           AND status <> 'revoked'
           AND EXISTS (
             SELECT 1 FROM user_deactivations
             WHERE id = ? AND user_id = ? AND requested_by_user_id = ?
               AND status = 'pending'
           )`,
      ).bind(now, requesterId, targetId, deactivationId, targetId, requesterId),
      env.DB.prepare(
        `UPDATE service_identities
         SET status = 'revoked', revoked_at = ?, updated_at = ?
         WHERE owner_user_id = ? AND status <> 'revoked'
           AND EXISTS (
             SELECT 1 FROM user_deactivations
             WHERE id = ? AND user_id = ? AND requested_by_user_id = ?
               AND status = 'pending'
           )`,
      ).bind(now, now, targetId, deactivationId, targetId, requesterId),
    ]);
  } catch (error) {
    if (/unique|constraint/i.test(errorMessage(error))) {
      throw new UserDeactivationError(
        "ACTIVE_DEACTIVATION_EXISTS",
        "This user already has an active deactivation",
      );
    }
    throw error;
  }

  if (changes(results[0]) !== 1 || changes(results[1]) !== 1) {
    // Every later statement is conditional on the inserted record, so a
    // failed guard cannot partially revoke or deactivate the account.
    throw new UserDeactivationError(
      "DEACTIVATION_NOT_RESUMABLE",
      "The deactivation could not be started because its authorization state changed",
    );
  }

  const created = await loadDeactivation(env, deactivationId);
  if (!created) {
    throw new UserDeactivationError(
      "DEACTIVATION_NOT_FOUND",
      "The deactivation record was not persisted",
    );
  }
  return created;
}

function appendProposalPurgeStatements(
  statements: D1PreparedStatement[],
  env: Env,
  proposalIds: readonly string[],
): void {
  if (proposalIds.length === 0) return;

  // proposal_events is append-only during normal operation. Compliance purge
  // removes the two guards and restores them in the same atomic D1 batch, so
  // no non-compliance writer can observe an unguarded table.
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

function advanceTransferCursor(
  env: Env,
  deactivation: UserDeactivation,
  entry: OwnedEntry,
  now: number,
): D1PreparedStatement {
  return env.DB.prepare(
    `UPDATE user_deactivations
     SET transfer_cursor = ?, processed_entries = processed_entries + 1,
         last_error = NULL, updated_at = ?
     WHERE id = ? AND status = 'running'
       AND COALESCE(transfer_cursor, '') = ?`,
  ).bind(
    entry.id,
    now,
    deactivation.id,
    deactivation.transferCursor ?? "",
  );
}

async function purgePrivateEntry(
  env: Env,
  deactivation: UserDeactivation,
  entry: OwnedEntry,
  now: number,
  actor: HumanActorContext,
): Promise<boolean> {
  // The shared erasure engine removes the whole D1 projection atomically and
  // either deletes the tracked vectors or queues them under the erasure
  // operation ID for the repair schedule. The transfer cursor advances in the
  // SAME D1 batch, so a committed erasure is never left behind a stale cursor.
  // On a genuine Vectorize failure the entry is still removed (stale vectors
  // then fail D1 reauthorization) and cleanup continues in the background.
  const cursorStatement = advanceTransferCursor(env, deactivation, entry, now);
  const result = await eraseEntryArtifacts(entry.id, actor, env, {
    now,
    deleteEntry: { ownerUserId: deactivation.userId, excludePublic: true },
    extraBatchStatements: () => [cursorStatement],
  });
  if (result.status === "not_found") {
    // The entry is already gone (e.g., forgotten while deactivation was
    // pending). The erasure early-returns before its batch, so advance the
    // cursor separately to keep the resume loop moving.
    return changes(await cursorStatement.run()) === 1;
  }
  return true;
}

async function transferPublicEntry(
  env: Env,
  deactivation: UserDeactivation,
  entry: OwnedEntry,
  now: number,
): Promise<boolean> {
  const transferTo = deactivation.transferToUserId;
  await requireReplacementAdmin(env, transferTo, deactivation.userId);

  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE entries
       SET owner_user_id = ?, updated_at = ?
       WHERE id = ? AND owner_user_id = ? AND visibility = 'public'
         AND EXISTS (
           SELECT 1 FROM users
           WHERE id = ? AND role = 'admin' AND status = 'active'
         )`,
    ).bind(transferTo, now, entry.id, deactivation.userId, transferTo),
    env.DB.prepare(
      `UPDATE episodes
       SET owner_user_id = ?
       WHERE entry_id = ?
         AND EXISTS (
           SELECT 1 FROM entries WHERE id = ? AND owner_user_id = ?
         )`,
    ).bind(transferTo, entry.id, entry.id, transferTo),
    env.DB.prepare(
      `UPDATE documents
       SET owner_user_id = ?
       WHERE episode_id IN (SELECT id FROM episodes WHERE entry_id = ?)
         AND EXISTS (
           SELECT 1 FROM entries WHERE id = ? AND owner_user_id = ?
         )`,
    ).bind(transferTo, entry.id, entry.id, transferTo),
    env.DB.prepare(
      `UPDATE user_deactivations
       SET transfer_cursor = ?, processed_entries = processed_entries + 1,
           last_error = NULL, updated_at = ?
       WHERE id = ? AND status = 'running'
         AND COALESCE(transfer_cursor, '') = ?
         AND EXISTS (
           SELECT 1 FROM entries WHERE id = ? AND owner_user_id = ?
         )`,
    ).bind(
      entry.id,
      now,
      deactivation.id,
      deactivation.transferCursor ?? "",
      entry.id,
      transferTo,
    ),
  ]);
  return changes(results.at(-1)) === 1;
}

async function recordResumeError(env: Env, id: string, error: unknown, now: number): Promise<string> {
  const message = errorMessage(error);
  try {
    await env.DB.prepare(
      `UPDATE user_deactivations
       SET last_error = ?, updated_at = ?
       WHERE id = ? AND status IN ('pending', 'running')`,
    ).bind(message, now, id).run();
  } catch {
    // The original D1 record remains the resumable source of truth.
  }
  return message;
}

async function remainingOwnedEntries(env: Env, userId: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM entries WHERE owner_user_id = ?`,
  ).bind(userId).first<{ count: number }>();
  return Number(row?.count ?? 0);
}

async function purgePrivateProposalsByUser(env: Env, userId: string): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT id FROM action_proposals
     WHERE proposer_kind = 'human' AND proposer_id = ?
       AND visibility_scope = 'private'`,
  ).bind(userId).all<{ id: string }>();
  if (results.length === 0) return;
  const statements: D1PreparedStatement[] = [];
  appendProposalPurgeStatements(statements, env, results.map((row) => row.id));
  await env.DB.batch(statements);
}

async function finalizeDeactivation(
  env: Env,
  deactivation: UserDeactivation,
  actorUserId: string,
  now: number,
): Promise<UserDeactivation> {
  await purgePrivateProposalsByUser(env, deactivation.userId);

  // The provider registry is the only supported integration namespace. Each
  // deletion addresses this user's v2 key, never a deployment-global secret.
  for (const provider of Object.values(INTEGRATION_PROVIDERS)) {
    try {
      await deleteIntegration(env, deactivation.userId, provider.id);
    } catch (error) {
      throw new Error(redactIntegrationError(error));
    }
  }

  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE service_credentials
       SET status = 'revoked', revoked_at = COALESCE(revoked_at, ?),
           revoked_by_user_id = COALESCE(revoked_by_user_id, ?)
       WHERE service_identity_id IN (
         SELECT id FROM service_identities WHERE owner_user_id = ?
       ) AND status <> 'revoked'`,
    ).bind(now, actorUserId, deactivation.userId),
    env.DB.prepare(
      `UPDATE service_identities
       SET status = 'revoked', revoked_at = COALESCE(revoked_at, ?), updated_at = ?
       WHERE owner_user_id = ? AND status <> 'revoked'`,
    ).bind(now, now, deactivation.userId),
    env.DB.prepare(
      `UPDATE users
       SET status = 'inactive'
       WHERE id = ? AND status = 'deactivating'
         AND EXISTS (
           SELECT 1 FROM user_deactivations
           WHERE id = ? AND status = 'running'
         )
         AND NOT EXISTS (
           SELECT 1 FROM entries WHERE owner_user_id = ?
         )`,
    ).bind(deactivation.userId, deactivation.id, deactivation.userId),
    env.DB.prepare(
      `UPDATE user_deactivations
       SET status = 'completed', last_error = NULL, completed_at = ?, updated_at = ?
       WHERE id = ? AND status = 'running'
         AND EXISTS (
           SELECT 1 FROM users WHERE id = ? AND status = 'inactive'
         )`,
    ).bind(now, now, deactivation.id, deactivation.userId),
  ]);

  if (changes(results[2]) !== 1 || changes(results[3]) !== 1) {
    const current = await loadDeactivation(env, deactivation.id);
    if (current?.status === "completed") return current;
    throw new UserDeactivationError(
      "DEACTIVATION_NOT_RESUMABLE",
      "The account could not be finalized while owned memory remains",
    );
  }

  const completed = await loadDeactivation(env, deactivation.id);
  if (!completed) {
    throw new UserDeactivationError(
      "DEACTIVATION_NOT_FOUND",
      "The completed deactivation record is missing",
    );
  }
  return completed;
}

/**
 * Processes a bounded number of owned entries and can be called repeatedly.
 * External failures retain status=running and the previous cursor so retrying
 * is safe and does not reactivate the account.
 */
export async function resumeUserDeactivation(
  input: ResumeUserDeactivationInput,
  env: Env,
): Promise<UserDeactivationProgress> {
  const deactivationId = requiredId("deactivationId", input.deactivationId);
  const actorUserId = requiredId("actorUserId", input.actorUserId);
  requireActiveAdmin(await loadUser(env, actorUserId));

  // The erasure receipt records the administrator who drives the purge.
  const actor: HumanActorContext = {
    kind: "human",
    actorId: actorUserId,
    userId: actorUserId,
    role: "admin",
    authMethod: "personal_api_key",
    scopes: new Set<ServiceScope>(),
  };

  let deactivation = await loadDeactivation(env, deactivationId);
  if (!deactivation) {
    throw new UserDeactivationError(
      "DEACTIVATION_NOT_FOUND",
      "The deactivation does not exist",
    );
  }
  if (deactivation.status === "completed") {
    return {
      deactivation,
      processedThisRun: 0,
      remainingEntries: 0,
      phase: "completed",
    };
  }
  if (deactivation.status !== "pending" && deactivation.status !== "running") {
    throw new UserDeactivationError(
      "DEACTIVATION_NOT_RESUMABLE",
      `A ${deactivation.status} deactivation cannot be resumed`,
    );
  }

  const target = await loadUser(env, deactivation.userId);
  if (!target || target.status !== "deactivating") {
    throw new UserDeactivationError(
      "DEACTIVATION_NOT_RESUMABLE",
      "The target account is not in deactivating state",
    );
  }

  const startedAt = input.now ?? Date.now();
  await env.DB.prepare(
    `UPDATE user_deactivations
     SET status = 'running', started_at = COALESCE(started_at, ?),
         last_error = NULL, updated_at = ?
     WHERE id = ? AND status = 'pending'`,
  ).bind(startedAt, startedAt, deactivationId).run();
  deactivation = await loadDeactivation(env, deactivationId) ?? deactivation;

  const requestedBatchSize = Math.trunc(input.batchSize ?? DEFAULT_BATCH_SIZE);
  const batchSize = Math.max(1, Math.min(MAX_BATCH_SIZE, requestedBatchSize));
  let processedThisRun = 0;
  let resetCursorOnce = false;

  while (processedThisRun < batchSize) {
    const entry = await env.DB.prepare(
      `SELECT id, visibility, vector_ids
       FROM entries
       WHERE owner_user_id = ?
         AND (? IS NULL OR id > ?)
       ORDER BY id ASC
       LIMIT 1`,
    ).bind(
      deactivation.userId,
      deactivation.transferCursor,
      deactivation.transferCursor,
    ).first<OwnedEntry>();

    if (!entry) {
      const remaining = await remainingOwnedEntries(env, deactivation.userId);
      if (remaining > 0 && deactivation.transferCursor !== null && !resetCursorOnce) {
        // Defensive recovery for legacy/manual inserts whose ids sort before a
        // persisted cursor. Deactivating users cannot create new entries, but
        // resetting here prevents an administrative repair from being skipped.
        await env.DB.prepare(
          `UPDATE user_deactivations
           SET transfer_cursor = NULL, updated_at = ?
           WHERE id = ? AND status = 'running'`,
        ).bind(Date.now(), deactivation.id).run();
        deactivation = await loadDeactivation(env, deactivation.id) ?? deactivation;
        resetCursorOnce = true;
        continue;
      }
      break;
    }

    try {
      const operationTime = input.now ?? Date.now();
      const advanced = entry.visibility === "public"
        ? await transferPublicEntry(env, deactivation, entry, operationTime)
        : await purgePrivateEntry(env, deactivation, entry, operationTime, actor);
      deactivation = await loadDeactivation(env, deactivation.id) ?? deactivation;
      if (advanced) processedThisRun++;
      else if (deactivation.transferCursor !== entry.id) continue;
      else processedThisRun++;
    } catch (error) {
      const message = await recordResumeError(env, deactivation.id, error, Date.now());
      const current = await loadDeactivation(env, deactivation.id) ?? deactivation;
      return {
        deactivation: current,
        processedThisRun,
        remainingEntries: await remainingOwnedEntries(env, deactivation.userId),
        phase: "blocked",
        error: message,
      };
    }
  }

  const remaining = await remainingOwnedEntries(env, deactivation.userId);
  deactivation = await loadDeactivation(env, deactivation.id) ?? deactivation;
  if (remaining > 0) {
    return {
      deactivation,
      processedThisRun,
      remainingEntries: remaining,
      phase: "entries",
    };
  }

  try {
    const completed = await finalizeDeactivation(
      env,
      deactivation,
      actorUserId,
      input.now ?? Date.now(),
    );
    return {
      deactivation: completed,
      processedThisRun,
      remainingEntries: 0,
      phase: "completed",
    };
  } catch (error) {
    const message = await recordResumeError(env, deactivation.id, error, Date.now());
    const current = await loadDeactivation(env, deactivation.id) ?? deactivation;
    return {
      deactivation: current,
      processedThisRun,
      remainingEntries: await remainingOwnedEntries(env, deactivation.userId),
      phase: "blocked",
      error: message,
    };
  }
}

/**
 * Bounded scheduler coordinator for persisted deactivation jobs.
 *
 * This helper does not have a privileged mutation path. It deterministically
 * selects a real, currently-active administrator and then calls the same
 * resumeUserDeactivation entrypoint used by interactive administration. The
 * original requester is preferred only while their stored role/status still
 * authorizes them; otherwise the earliest active human administrator is used.
 */
export async function resumePendingDeactivations(
  env: Env,
  batchSize = DEFAULT_BATCH_SIZE,
  maxJobs = DEFAULT_BATCH_SIZE,
): Promise<PendingDeactivationRunResult> {
  const boundedBatchSize = Math.max(
    1,
    Math.min(MAX_BATCH_SIZE, Number.isFinite(batchSize) ? Math.trunc(batchSize) : DEFAULT_BATCH_SIZE),
  );
  const boundedMaxJobs = Math.max(
    0,
    Math.min(MAX_BATCH_SIZE, Number.isFinite(maxJobs) ? Math.trunc(maxJobs) : DEFAULT_BATCH_SIZE),
  );

  const { results: jobs } = await env.DB.prepare(
    `SELECT id, requested_by_user_id
     FROM user_deactivations
     WHERE status IN ('pending', 'running')
     ORDER BY updated_at ASC, requested_at ASC, id ASC
     LIMIT ?`,
  ).bind(boundedMaxJobs).all<{ id: string; requested_by_user_id: string }>();

  const result: PendingDeactivationRunResult = {
    selected: jobs.length,
    attempted: 0,
    completed: 0,
    stillRunning: 0,
    blocked: 0,
    skippedNoAdmin: 0,
    processedEntries: 0,
    remainingJobs: 0,
  };

  for (const job of jobs) {
    const actor = await env.DB.prepare(
      `SELECT id
       FROM users
       WHERE status = 'active'
         AND role = 'admin'
         AND normalized_username <> '_system'
       ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END,
                created_at ASC, id ASC
       LIMIT 1`,
    ).bind(job.requested_by_user_id).first<{ id: string }>();

    if (!actor) {
      result.skippedNoAdmin++;
      await recordResumeError(
        env,
        job.id,
        new Error("No active administrator is available to resume deactivation"),
        Date.now(),
      );
      continue;
    }

    result.attempted++;
    try {
      const progress = await resumeUserDeactivation({
        deactivationId: job.id,
        actorUserId: actor.id,
        batchSize: boundedBatchSize,
      }, env);
      result.processedEntries += progress.processedThisRun;
      if (progress.phase === "completed") result.completed++;
      else if (progress.phase === "blocked") result.blocked++;
      else result.stillRunning++;
    } catch (error) {
      result.blocked++;
      await recordResumeError(env, job.id, error, Date.now());
    }
  }

  const remaining = await env.DB.prepare(
    `SELECT COUNT(*) AS count
     FROM user_deactivations
     WHERE status IN ('pending', 'running')`,
  ).first<{ count: number }>();
  result.remainingJobs = Number(remaining?.count ?? 0);
  return result;
}
