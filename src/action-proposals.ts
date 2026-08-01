/** Generic, governed proposal inbox and explicit approved-action executor. */

import {
  commitEntryVersion,
  EntryVersionError,
  loadOwnedRestoreSnapshot,
} from "./entry-version-service";
import { withStatus } from "./tags";
import { createEdge, deleteEdge, isValidEdgeType, type EdgeType } from "./graph";
import { isManagedMirror } from "./integrations-mirror";
import {
  ACTION_TYPES,
  EPISTEMIC_STATUS_VALUES,
  STATUS_VALUES,
  isValidTransition,
  type ActionProposal,
  type ActionType,
  type ActorContext,
  type Env,
  type EpistemicStatus,
  type HumanActorContext,
  type MemoryStatus,
  type ProposalRiskLevel,
} from "./types";
import {
  decideOperatorAction,
  requireAllowedDecision,
  type OperatorPolicyDecision,
} from "./operator-policy";
import { verifyServiceActor } from "./service-actor";
import { withMandatoryAudit } from "./mandatory-audit";
import { errorMessage, parseStringArray, sha256Hex, sqlChanges, stableJson } from "./governance-utils";

const ACTION_TYPE_SET = new Set<string>(ACTION_TYPES);
const SUPPORTED_EXECUTOR_ACTIONS = new Set<string>([
  "entry.create",
  "entry.append",
  "entry.update",
  "entry.restore",
  "entry.status.set",
  "entry.epistemic-status.set",
  "edge.publish",
  "edge.remove",
]);
const VERSIONED_EXECUTOR_ACTIONS = new Set<string>([
  "entry.create",
  "entry.append",
  "entry.update",
  "entry.restore",
  "entry.status.set",
  "entry.epistemic-status.set",
]);
const RISK_LEVELS = new Set<string>(["low", "medium", "high", "critical"]);

interface ProposalRow {
  id: string;
  action_type: string;
  proposer_kind: "human" | "service" | "system";
  proposer_id: string;
  visibility_scope: string;
  payload_json: string;
  payload_hash: string | null;
  target_ids: string;
  expected_preconditions: string;
  expected_revision: number | null;
  status: ActionProposal["status"];
  risk_level: ProposalRiskLevel;
  reason: string;
  evidence_json: string;
  autonomy_profile: string;
  policy_version: string;
  idempotency_key: string;
  expires_at: number | null;
  reviewer_kind: "human" | "service" | "system" | null;
  reviewer_id: string | null;
  review_reason: string | null;
  reviewed_at: number | null;
  executor_kind: "human" | "service" | "system" | null;
  executor_id: string | null;
  execution_started_at: number | null;
  executed_at: number | null;
  rejected_at: number | null;
  failed_at: number | null;
  stale_at: number | null;
  expired_at: number | null;
  result_json: string | null;
  result_hash: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: number;
  updated_at: number;
}

export interface CreateActionProposalInput {
  actor: ActorContext;
  actionType: ActionType;
  payload: Record<string, unknown>;
  targetIds?: readonly string[];
  expectedPreconditions?: Record<string, unknown>;
  expectedRevision?: number | null;
  visibilityScope?: "private" | "team";
  riskLevel?: ProposalRiskLevel;
  reason: string;
  evidence?: readonly unknown[];
  idempotencyKey: string;
  expiresAt?: number | null;
  correlationId?: string | null;
  now?: number;
}

export interface ReviewActionProposalInput {
  actor: ActorContext;
  proposalId: string;
  decision: "approve" | "reject";
  reason: string;
  correlationId?: string | null;
  now?: number;
}

export interface ExecuteActionProposalInput {
  actor: ActorContext;
  proposalId: string;
  correlationId?: string | null;
  now?: number;
}

export interface ListActionProposalsInput {
  actor: ActorContext;
  statuses?: readonly ActionProposal["status"][];
  limit?: number;
  now?: number;
}

export interface EntryProposalExecutionResult {
  proposalId: string;
  actionType:
    | "entry.create"
    | "entry.append"
    | "entry.update"
    | "entry.restore"
    | "entry.status.set"
    | "entry.epistemic-status.set";
  entryId: string;
  episodeId: string;
  revision: number;
}

export interface EdgeProposalExecutionResult {
  proposalId: string;
  actionType: "edge.publish" | "edge.remove";
  sourceId: string;
  targetId: string;
  edgeType: EdgeType;
}

export type ProposalExecutionResult = EntryProposalExecutionResult | EdgeProposalExecutionResult;

export class ActionProposalError extends Error {
  constructor(
    readonly code:
      | "invalid_input"
      | "not_found"
      | "idempotency_conflict"
      | "transition_conflict"
      | "human_review_required"
      | "forbidden"
      | "expired"
      | "stale"
      | "unsupported_action",
    message: string,
  ) {
    super(message);
    this.name = "ActionProposalError";
  }
}

function mapProposal(row: ProposalRow): ActionProposal {
  if (!ACTION_TYPE_SET.has(row.action_type)) {
    throw new ActionProposalError("unsupported_action", `Unsupported proposal action: ${row.action_type}`);
  }
  return {
    id: row.id,
    actionType: row.action_type as ActionType,
    proposerKind: row.proposer_kind,
    proposerId: row.proposer_id,
    visibilityScope: row.visibility_scope,
    payloadJson: row.payload_json,
    payloadHash: row.payload_hash,
    targetIds: parseStringArray(row.target_ids),
    expectedPreconditions: row.expected_preconditions,
    expectedRevision: row.expected_revision,
    status: row.status,
    riskLevel: row.risk_level,
    reason: row.reason,
    evidenceJson: row.evidence_json,
    autonomyProfile: row.autonomy_profile,
    policyVersion: row.policy_version,
    idempotencyKey: row.idempotency_key,
    expiresAt: row.expires_at,
    reviewerKind: row.reviewer_kind,
    reviewerId: row.reviewer_id,
    reviewReason: row.review_reason,
    reviewedAt: row.reviewed_at,
    executorKind: row.executor_kind,
    executorId: row.executor_id,
    executionStartedAt: row.execution_started_at,
    executedAt: row.executed_at,
    rejectedAt: row.rejected_at,
    failedAt: row.failed_at,
    staleAt: row.stale_at,
    expiredAt: row.expired_at,
    resultJson: row.result_json,
    resultHash: row.result_hash,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function loadProposalRow(env: Pick<Env, "DB">, id: string): Promise<ProposalRow | null> {
  return env.DB.prepare(`SELECT * FROM action_proposals WHERE id = ?`).bind(id).first<ProposalRow>();
}

export async function getActionProposal(env: Pick<Env, "DB">, id: string): Promise<ActionProposal | null> {
  const row = await loadProposalRow(env, id);
  return row ? mapProposal(row) : null;
}

async function resolveActor(
  env: Pick<Env, "DB">,
  actor: ActorContext,
  now: number,
): Promise<{ actor: ActorContext; subjectUserId: string; autonomyProfile: string }> {
  if (actor.kind === "human") {
    const user = await env.DB.prepare(
      `SELECT role, status FROM users WHERE id = ?`,
    ).bind(actor.userId).first<{ role: string; status: string }>();
    if (!user || user.status !== "active" || (user.role !== "admin" && user.role !== "member")) {
      throw new ActionProposalError("forbidden", "An active human team member is required.");
    }
    const verified: HumanActorContext = {
      ...actor,
      actorId: actor.userId,
      role: user.role,
      scopes: new Set(actor.scopes),
    };
    return { actor: verified, subjectUserId: verified.userId, autonomyProfile: "human-reviewed" };
  }
  if (actor.kind === "service") {
    const verified = await verifyServiceActor(env, actor, now);
    return {
      actor: verified.actor,
      subjectUserId: verified.ownerUserId,
      autonomyProfile: verified.autonomyProfile,
    };
  }
  return { actor, subjectUserId: actor.systemId, autonomyProfile: "system" };
}

async function proposalOwnerUserId(
  env: Pick<Env, "DB">,
  row: ProposalRow,
): Promise<string | null> {
  const payload = parseRecord(row.payload_json);
  if (typeof payload?.ownerUserId === "string") return payload.ownerUserId;
  if (row.proposer_kind === "human") return row.proposer_id;
  if (row.proposer_kind === "service") {
    const service = await env.DB.prepare(
      `SELECT owner_user_id FROM service_identities WHERE id = ?`,
    ).bind(row.proposer_id).first<{ owner_user_id: string }>();
    return service?.owner_user_id ?? null;
  }
  return null;
}

async function actorCanAccessProposal(
  env: Pick<Env, "DB">,
  actor: ActorContext,
  row: ProposalRow,
): Promise<boolean> {
  if (actor.kind === "system") return true;
  if (actor.kind === "service") {
    return row.proposer_kind === "service" && row.proposer_id === actor.serviceIdentityId
      || row.visibility_scope === "team";
  }
  if (actor.role === "admin" || row.visibility_scope === "team") return true;
  return await proposalOwnerUserId(env, row) === actor.userId;
}

export async function listActionProposals(
  env: Pick<Env, "DB">,
  input: ListActionProposalsInput,
): Promise<ActionProposal[]> {
  const now = input.now ?? Date.now();
  const resolved = await resolveActor(env, input.actor, now);
  const decision = decideOperatorAction({
    actor: resolved.actor,
    operation: "proposal.read",
    autonomyProfile: resolved.autonomyProfile,
  });
  requireAllowedDecision(decision);

  const statuses = [...new Set<ActionProposal["status"]>(input.statuses ?? ["pending"])];
  if (statuses.length === 0) throw new ActionProposalError("invalid_input", "At least one valid proposal status is required.");
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? 50), 1), 100);
  const placeholders = statuses.map(() => "?").join(", ");
  const { results } = await env.DB.prepare(
    `SELECT * FROM action_proposals
     WHERE status IN (${placeholders})
     ORDER BY created_at DESC, id DESC LIMIT ?`,
  ).bind(...statuses, Math.min(limit * 4, 400)).all<ProposalRow>();

  const visible: ActionProposal[] = [];
  for (const row of results) {
    if (await actorCanAccessProposal(env, resolved.actor, row)) visible.push(mapProposal(row));
    if (visible.length >= limit) break;
  }
  return visible;
}

function ensureProposalInput(input: CreateActionProposalInput): void {
  if (!ACTION_TYPE_SET.has(input.actionType)) throw new ActionProposalError("invalid_input", "Action is not whitelisted.");
  if (!input.reason.trim()) throw new ActionProposalError("invalid_input", "Proposal reason is required.");
  if (!input.idempotencyKey.trim() || input.idempotencyKey.length > 240) {
    throw new ActionProposalError("invalid_input", "A bounded idempotency key is required.");
  }
  if (input.expectedRevision !== undefined && input.expectedRevision !== null
      && (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0)) {
    throw new ActionProposalError("invalid_input", "Expected revision must be a non-negative integer.");
  }
  if (input.riskLevel && !RISK_LEVELS.has(input.riskLevel)) {
    throw new ActionProposalError("invalid_input", "Invalid proposal risk level.");
  }
}

interface ProposalPreparation {
  payload: Record<string, unknown>;
  targetIds: string[];
  expectedPreconditions: Record<string, unknown>;
  expectedRevision: number | null;
  forcePrivateInbox: boolean;
}

function requirePayloadString(
  payload: Record<string, unknown>,
  field: string,
  actionType: ActionType,
): string {
  const value = payload[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new ActionProposalError("invalid_input", `${actionType} requires non-empty ${field}.`);
  }
  return value;
}

function assertAuthoritativeTargets(
  supplied: readonly string[] | undefined,
  authoritative: readonly string[],
): void {
  if (!supplied) return;
  const actual = [...new Set(supplied)].sort();
  const expected = [...new Set(authoritative)].sort();
  if (actual.length !== expected.length || actual.some((id, index) => id !== expected[index])) {
    throw new ActionProposalError("invalid_input", "target_ids must exactly match the action payload targets.");
  }
}

async function prepareExistingEntryProposal(
  env: Pick<Env, "DB">,
  input: CreateActionProposalInput,
  subjectUserId: string,
): Promise<ProposalPreparation> {
  const entryId = requirePayloadString(input.payload, "entryId", input.actionType).trim();
  if (input.expectedRevision === undefined || input.expectedRevision === null) {
    throw new ActionProposalError("invalid_input", `${input.actionType} requires expected_revision.`);
  }
  const entry = await env.DB.prepare(
    `SELECT id, revision, owner_user_id, visibility, current_episode_id
     FROM entries WHERE id = ?`,
  ).bind(entryId).first<EntryPreconditionRow>();
  if (!entry || entry.owner_user_id !== subjectUserId) {
    throw new ActionProposalError("not_found", "Owned entry target was not found.");
  }
  if (entry.visibility !== "private" && entry.visibility !== "public") {
    throw new ActionProposalError("forbidden", "Entry visibility is invalid.");
  }
  if (entry.revision !== input.expectedRevision) {
    throw new ActionProposalError("stale", "The proposed entry revision is already stale.");
  }
  assertAuthoritativeTargets(input.targetIds, [entryId]);

  if (input.actionType === "entry.append") {
    requirePayloadString(input.payload, "addition", input.actionType);
  } else if (input.actionType === "entry.update") {
    requirePayloadString(input.payload, "content", input.actionType);
  } else if (input.actionType === "entry.restore") {
    const snapshotId = requirePayloadString(input.payload, "snapshotId", input.actionType).trim();
    const snapshot = await env.DB.prepare(
      `SELECT s.id FROM entry_snapshots s
       JOIN entries e ON e.id = s.entry_id
       WHERE s.id = ? AND s.entry_id = ? AND e.owner_user_id = ?`,
    ).bind(snapshotId, entryId, subjectUserId).first<{ id: string }>();
    if (!snapshot) throw new ActionProposalError("not_found", "Owned restore snapshot was not found.");
  } else if (input.actionType === "entry.status.set") {
    const status = requirePayloadString(input.payload, "status", input.actionType);
    if (!(STATUS_VALUES as readonly string[]).includes(status)) {
      throw new ActionProposalError("invalid_input", `status must be one of: ${STATUS_VALUES.join(", ")}`);
    }
  } else if (input.actionType === "entry.epistemic-status.set") {
    const status = requirePayloadString(input.payload, "status", input.actionType);
    if (!(EPISTEMIC_STATUS_VALUES as readonly string[]).includes(status)) {
      throw new ActionProposalError("invalid_input", `status must be one of: ${EPISTEMIC_STATUS_VALUES.join(", ")}`);
    }
  }

  return {
    payload: { ...input.payload, entryId, ownerUserId: subjectUserId },
    targetIds: [entryId],
    expectedRevision: input.expectedRevision,
    expectedPreconditions: {
      ...(input.expectedPreconditions ?? {}),
      entry_exists: true,
      owner_user_id: subjectUserId,
      visibility: entry.visibility,
      current_episode_id: entry.current_episode_id,
      ...(input.actionType === "entry.restore"
        ? { snapshot_id: String(input.payload.snapshotId) }
        : {}),
    },
    forcePrivateInbox: entry.visibility === "private" || input.actionType === "entry.restore",
  };
}

async function prepareEdgeProposal(
  env: Pick<Env, "DB">,
  input: CreateActionProposalInput,
  subjectUserId: string,
): Promise<ProposalPreparation> {
  if (input.expectedRevision !== undefined && input.expectedRevision !== null) {
    throw new ActionProposalError("invalid_input", `${input.actionType} does not use expected_revision.`);
  }
  const sourceId = requirePayloadString(input.payload, "sourceId", input.actionType).trim();
  const targetId = requirePayloadString(input.payload, "targetId", input.actionType).trim();
  const edgeType = requirePayloadString(input.payload, "type", input.actionType).trim();
  if (sourceId === targetId) throw new ActionProposalError("invalid_input", "An edge cannot link an entry to itself.");
  if (!isValidEdgeType(edgeType)) throw new ActionProposalError("invalid_input", "Unknown edge type.");
  assertAuthoritativeTargets(input.targetIds, [sourceId, targetId]);

  const rows: EntryPreconditionRow[] = [];
  for (const id of [sourceId, targetId]) {
    const row = await env.DB.prepare(
      `SELECT id, revision, owner_user_id, visibility, current_episode_id
       FROM entries WHERE id = ?`,
    ).bind(id).first<EntryPreconditionRow>();
    if (!row || (row.visibility !== "private" && row.visibility !== "public")) {
      throw new ActionProposalError("not_found", "Visible edge endpoint was not found.");
    }
    rows.push(row);
  }
  if (rows[0].visibility !== rows[1].visibility) {
    throw new ActionProposalError("forbidden", "Edges cannot cross private and public visibility.");
  }
  if (rows[0].visibility === "private"
      && (rows[0].owner_user_id !== subjectUserId || rows[1].owner_user_id !== subjectUserId)) {
    throw new ActionProposalError("not_found", "Owned private edge endpoints were not found.");
  }
  const edge = await env.DB.prepare(
    `SELECT source_id FROM edges
     WHERE ((source_id = ? AND target_id = ?) OR (source_id = ? AND target_id = ?))
       AND type = ? LIMIT 1`,
  ).bind(sourceId, targetId, targetId, sourceId, edgeType).first<{ source_id: string }>();
  if (input.actionType === "edge.remove" && !edge) {
    throw new ActionProposalError("not_found", "The edge selected for removal was not found.");
  }
  if (input.actionType === "edge.publish") {
    for (const field of ["weight", "confidence"] as const) {
      const value = input.payload[field];
      if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1)) {
        throw new ActionProposalError("invalid_input", `${field} must be a number from 0 to 1.`);
      }
    }
    if (input.payload.metadata !== undefined
        && (!input.payload.metadata || typeof input.payload.metadata !== "object" || Array.isArray(input.payload.metadata))) {
      throw new ActionProposalError("invalid_input", "metadata must be an object.");
    }
  }

  return {
    payload: { ...input.payload, sourceId, targetId, type: edgeType },
    targetIds: [sourceId, targetId],
    expectedRevision: null,
    expectedPreconditions: {
      ...(input.expectedPreconditions ?? {}),
      source_exists: true,
      target_exists: true,
      source_visibility: rows[0].visibility,
      target_visibility: rows[1].visibility,
      source_owner_user_id: rows[0].owner_user_id,
      target_owner_user_id: rows[1].owner_user_id,
      edge_type: edgeType,
      edge_present: Boolean(edge),
    },
    forcePrivateInbox: rows[0].visibility === "private",
  };
}

async function prepareProposal(
  env: Pick<Env, "DB">,
  input: CreateActionProposalInput,
  subjectUserId: string,
): Promise<ProposalPreparation> {
  if (input.actionType === "entry.create") {
    if (input.expectedRevision !== undefined && input.expectedRevision !== null) {
      throw new ActionProposalError("invalid_input", "entry.create does not use expected_revision.");
    }
    const content = requirePayloadString(input.payload, "content", input.actionType);
    const entryId = typeof input.payload.entryId === "string" && input.payload.entryId.trim()
      ? input.payload.entryId.trim()
      : `op:${(await sha256Hex(`entry.create:${input.idempotencyKey}`)).slice(0, 32)}`;
    assertAuthoritativeTargets(input.targetIds, [entryId]);
    const visibility = input.payload.visibility === "public" ? "public" : "private";
    return {
      payload: { ...input.payload, content, entryId, ownerUserId: subjectUserId },
      targetIds: [entryId],
      expectedRevision: null,
      expectedPreconditions: { ...(input.expectedPreconditions ?? {}), entry_absent: true },
      forcePrivateInbox: visibility === "private",
    };
  }
  if (input.actionType === "edge.publish" || input.actionType === "edge.remove") {
    return prepareEdgeProposal(env, input, subjectUserId);
  }
  return prepareExistingEntryProposal(env, input, subjectUserId);
}

function sameProposal(existing: ProposalRow, signature: {
  actionType: ActionType;
  proposerKind: ActorContext["kind"];
  proposerId: string;
  payloadJson: string;
  targetIdsJson: string;
  preconditionsJson: string;
  expectedRevision: number | null;
  visibilityScope: string;
  riskLevel: ProposalRiskLevel;
  reason: string;
  evidenceJson: string;
  expiresAt: number | null;
}): boolean {
  return existing.action_type === signature.actionType
    && existing.proposer_kind === signature.proposerKind
    && existing.proposer_id === signature.proposerId
    && existing.payload_json === signature.payloadJson
    && existing.target_ids === signature.targetIdsJson
    && existing.expected_preconditions === signature.preconditionsJson
    && existing.expected_revision === signature.expectedRevision
    && existing.visibility_scope === signature.visibilityScope
    && existing.risk_level === signature.riskLevel
    && existing.reason === signature.reason
    && existing.evidence_json === signature.evidenceJson
    && existing.expires_at === signature.expiresAt;
}

export async function createActionProposal(
  env: Pick<Env, "DB">,
  input: CreateActionProposalInput,
): Promise<ActionProposal> {
  ensureProposalInput(input);
  const now = input.now ?? Date.now();
  const resolved = await resolveActor(env, input.actor, now);
  const policy = decideOperatorAction({
    actor: resolved.actor,
    operation: "proposal.create",
    proposedAction: input.actionType,
    autonomyProfile: resolved.autonomyProfile,
  });
  requireAllowedDecision(policy);
  const prepared = await prepareProposal(env, input, resolved.subjectUserId);
  if (prepared.forcePrivateInbox && input.visibilityScope === "team") {
    throw new ActionProposalError("forbidden", "A proposal touching private memory cannot be team-visible.");
  }
  const { payload, targetIds, expectedPreconditions, expectedRevision } = prepared;
  const payloadJson = stableJson(payload);
  const targetIdsJson = stableJson(targetIds);
  const preconditionsJson = stableJson(expectedPreconditions);
  const visibilityScope = prepared.forcePrivateInbox ? "private" : input.visibilityScope ?? "private";
  const riskLevel = input.riskLevel ?? "medium";
  const reason = input.reason.trim();
  const evidenceJson = stableJson(input.evidence ?? []);
  const expiresAt = input.expiresAt ?? null;
  const signature = {
    actionType: input.actionType,
    proposerKind: resolved.actor.kind,
    proposerId: resolved.actor.actorId,
    payloadJson,
    targetIdsJson,
    preconditionsJson,
    expectedRevision,
    visibilityScope,
    riskLevel,
    reason,
    evidenceJson,
    expiresAt,
  };

  return withMandatoryAudit(
    env,
    {
      actor: resolved.actor,
      subjectUserId: resolved.subjectUserId,
      operation: "proposal.create",
      decision: policy,
      correlationId: input.correlationId,
      targetIds,
      redactedRequest: { actionType: input.actionType, riskLevel: input.riskLevel ?? "medium", targetCount: targetIds.length },
      now,
    },
    async () => {
      const existing = await env.DB.prepare(
        `SELECT * FROM action_proposals WHERE idempotency_key = ?`,
      ).bind(input.idempotencyKey).first<ProposalRow>();
      if (existing) {
        if (!sameProposal(existing, signature)) {
          throw new ActionProposalError("idempotency_conflict", "Idempotency key is already bound to a different proposal.");
        }
        return mapProposal(existing);
      }

      const id = crypto.randomUUID();
      const eventId = crypto.randomUUID();
      const payloadHash = await sha256Hex(payloadJson);
      try {
        const createdEventJson = stableJson({ actionType: input.actionType, riskLevel });
        const createdEventHash = await sha256Hex(createdEventJson);
        await env.DB.batch([
          env.DB.prepare(
            `INSERT INTO action_proposals (
               id, action_type, proposer_kind, proposer_id, visibility_scope,
               payload_json, payload_hash, target_ids, expected_preconditions,
               expected_revision, status, risk_level, reason, evidence_json,
               autonomy_profile, policy_version, idempotency_key, expires_at,
               created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).bind(
            id,
            input.actionType,
            resolved.actor.kind,
            resolved.actor.actorId,
            visibilityScope,
            payloadJson,
            payloadHash,
            targetIdsJson,
            preconditionsJson,
            expectedRevision,
            riskLevel,
            reason,
            evidenceJson,
            policy.autonomyProfile,
            policy.policyVersion,
            input.idempotencyKey,
            expiresAt,
            now,
            now,
          ),
          env.DB.prepare(
            `INSERT INTO proposal_events (
               id, proposal_id, sequence, event_type, actor_kind, actor_id,
               data_json, data_hash, created_at
             ) VALUES (?, ?, 1, 'created', ?, ?, ?, ?, ?)`,
          ).bind(
            eventId,
            id,
            resolved.actor.kind,
            resolved.actor.actorId,
            createdEventJson,
            createdEventHash,
            now,
          ),
        ]);
      } catch (error) {
        // A concurrent creator may have won the unique idempotency-key race.
        const raced = await env.DB.prepare(
          `SELECT * FROM action_proposals WHERE idempotency_key = ?`,
        ).bind(input.idempotencyKey).first<ProposalRow>();
        if (raced && sameProposal(raced, signature)) return mapProposal(raced);
        if (raced) throw new ActionProposalError("idempotency_conflict", "Idempotency key is already bound to a different proposal.");
        throw error;
      }
      const created = await loadProposalRow(env, id);
      if (!created) throw new ActionProposalError("transition_conflict", "Proposal insert was not visible after commit.");
      return mapProposal(created);
    },
    (proposal) => ({ proposalId: proposal.id, status: proposal.status }),
  );
}

async function expirePendingProposal(
  env: Pick<Env, "DB">,
  row: ProposalRow,
  actor: ActorContext,
  now: number,
): Promise<void> {
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE action_proposals
       SET status = 'expired', expired_at = ?, updated_at = ?
       WHERE id = ? AND status = 'pending' AND expires_at IS NOT NULL AND expires_at <= ?`,
    ).bind(now, now, row.id, now),
    env.DB.prepare(
      `INSERT INTO proposal_events (
         id, proposal_id, sequence, event_type, actor_kind, actor_id, data_json, created_at
       )
       SELECT ?, ?, COALESCE((SELECT MAX(sequence) + 1 FROM proposal_events WHERE proposal_id = ?), 1),
              'expired', ?, ?, '{}', ?
       WHERE changes() = 1`,
    ).bind(crypto.randomUUID(), row.id, row.id, actor.kind, actor.actorId, now),
  ]);
  if (sqlChanges(results[0]) === 0) {
    throw new ActionProposalError("transition_conflict", "Proposal changed while expiry was evaluated.");
  }
}

function reviewIsIdempotent(row: ProposalRow, reviewer: HumanActorContext, decision: "approve" | "reject"): boolean {
  if (decision === "approve") {
    return row.status === "pending" && row.reviewer_kind === "human" && row.reviewer_id === reviewer.actorId;
  }
  return row.status === "rejected" && row.reviewer_kind === "human" && row.reviewer_id === reviewer.actorId;
}

export async function reviewActionProposal(
  env: Pick<Env, "DB">,
  input: ReviewActionProposalInput,
): Promise<ActionProposal> {
  if (!input.proposalId || !input.reason.trim()) {
    throw new ActionProposalError("invalid_input", "Proposal id and review reason are required.");
  }
  const now = input.now ?? Date.now();
  const resolved = await resolveActor(env, input.actor, now);
  const operation = input.decision === "approve" ? "proposal.approve" : "proposal.reject";
  const policy = decideOperatorAction({ actor: resolved.actor, operation, autonomyProfile: resolved.autonomyProfile });
  requireAllowedDecision(policy);
  if (resolved.actor.kind !== "human") {
    throw new ActionProposalError("human_review_required", "Only a human may review proposals.");
  }
  const reviewer = resolved.actor;

  return withMandatoryAudit(
    env,
    {
      actor: reviewer,
      subjectUserId: resolved.subjectUserId,
      operation,
      decision: policy,
      proposalId: input.proposalId,
      targetIds: [input.proposalId],
      redactedRequest: { proposalId: input.proposalId, decision: input.decision },
      correlationId: input.correlationId,
      now,
    },
    async () => {
      const current = await loadProposalRow(env, input.proposalId);
      if (!current) throw new ActionProposalError("not_found", "Proposal was not found.");
      if (!await actorCanAccessProposal(env, reviewer, current)) {
        throw new ActionProposalError("forbidden", "This proposal is not visible to the reviewer.");
      }
      if (reviewIsIdempotent(current, reviewer, input.decision)) return mapProposal(current);
      if (current.expires_at !== null && current.expires_at <= now && current.status === "pending") {
        await expirePendingProposal(env, current, reviewer, now);
        throw new ActionProposalError("expired", "Proposal has expired.");
      }
      if (current.status !== "pending" || current.reviewer_kind !== null) {
        throw new ActionProposalError("transition_conflict", "Proposal is no longer awaiting review.");
      }

      const nextStatus = input.decision === "approve" ? "pending" : "rejected";
      const eventType = input.decision === "approve" ? "approved" : "rejected";
      const results = await env.DB.batch([
        env.DB.prepare(
          `UPDATE action_proposals
           SET status = ?, reviewer_kind = 'human', reviewer_id = ?, review_reason = ?,
               reviewed_at = ?, rejected_at = CASE WHEN ? = 'rejected' THEN ? ELSE rejected_at END,
               updated_at = ?
           WHERE id = ? AND status = 'pending' AND reviewer_kind IS NULL`,
        ).bind(nextStatus, reviewer.actorId, input.reason.trim(), now, nextStatus, now, now, current.id),
        env.DB.prepare(
          `INSERT INTO proposal_events (
             id, proposal_id, sequence, event_type, actor_kind, actor_id, data_json, created_at
           )
           SELECT ?, ?, COALESCE((SELECT MAX(sequence) + 1 FROM proposal_events WHERE proposal_id = ?), 1),
                  ?, 'human', ?, ?, ?
           WHERE changes() = 1`,
        ).bind(
          crypto.randomUUID(),
          current.id,
          current.id,
          eventType,
          reviewer.actorId,
          stableJson({ reason: input.reason.trim() }),
          now,
        ),
      ]);
      if (sqlChanges(results[0]) === 0) {
        const raced = await loadProposalRow(env, current.id);
        if (raced && reviewIsIdempotent(raced, reviewer, input.decision)) return mapProposal(raced);
        throw new ActionProposalError("transition_conflict", "Proposal was reviewed concurrently.");
      }
      const reviewed = await loadProposalRow(env, current.id);
      if (!reviewed) throw new ActionProposalError("not_found", "Proposal disappeared after review.");
      return mapProposal(reviewed);
    },
    (proposal) => ({ proposalId: proposal.id, status: proposal.status, reviewed: proposal.reviewerKind === "human" }),
  );
}

interface EntryPreconditionRow {
  id: string;
  revision: number;
  owner_user_id: string;
  visibility: string;
  current_episode_id: string | null;
}

function parseRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

async function preconditionsMatch(env: Pick<Env, "DB">, row: ProposalRow): Promise<boolean> {
  const expected = parseRecord(row.expected_preconditions);
  if (!expected) return false;
  const targetIds = parseStringArray(row.target_ids);

  if (row.action_type === "edge.publish" || row.action_type === "edge.remove") {
    const payload = parseRecord(row.payload_json);
    if (!payload || typeof payload.sourceId !== "string" || typeof payload.targetId !== "string"
        || typeof payload.type !== "string" || !isValidEdgeType(payload.type)) return false;
    if (targetIds.length !== 2 || !targetIds.includes(payload.sourceId) || !targetIds.includes(payload.targetId)) return false;
    const endpoints: EntryPreconditionRow[] = [];
    for (const id of [payload.sourceId, payload.targetId]) {
      const endpoint = await env.DB.prepare(
        `SELECT id, revision, owner_user_id, visibility, current_episode_id
         FROM entries WHERE id = ?`,
      ).bind(id).first<EntryPreconditionRow>();
      if (!endpoint) return false;
      endpoints.push(endpoint);
    }
    if (expected.source_exists !== true || expected.target_exists !== true) return false;
    if (endpoints[0].visibility !== expected.source_visibility
        || endpoints[1].visibility !== expected.target_visibility
        || endpoints[0].owner_user_id !== expected.source_owner_user_id
        || endpoints[1].owner_user_id !== expected.target_owner_user_id
        || payload.type !== expected.edge_type) return false;
    const edge = await env.DB.prepare(
      `SELECT id FROM edges
       WHERE ((source_id = ? AND target_id = ?) OR (source_id = ? AND target_id = ?))
         AND type = ? LIMIT 1`,
    ).bind(payload.sourceId, payload.targetId, payload.targetId, payload.sourceId, payload.type)
      .first<{ id: string }>();
    return Boolean(edge) === expected.edge_present;
  }

  const targetId = targetIds[0];
  if (!targetId) return row.expected_revision === null && expected.entry_absent !== true;
  const entry = await env.DB.prepare(
    `SELECT id, revision, owner_user_id, visibility, current_episode_id FROM entries WHERE id = ?`,
  ).bind(targetId).first<EntryPreconditionRow>();
  if (expected.entry_absent === true && entry) return false;
  if (expected.entry_exists === true && !entry) return false;
  if (row.expected_revision !== null && entry?.revision !== row.expected_revision) return false;
  if (typeof expected.owner_user_id === "string" && entry?.owner_user_id !== expected.owner_user_id) return false;
  if (typeof expected.visibility === "string" && entry?.visibility !== expected.visibility) return false;
  if (Object.prototype.hasOwnProperty.call(expected, "current_episode_id")
      && entry?.current_episode_id !== expected.current_episode_id) return false;
  if (typeof expected.snapshot_id === "string") {
    const snapshot = await env.DB.prepare(
      `SELECT id FROM entry_snapshots WHERE id = ? AND entry_id = ?`,
    ).bind(expected.snapshot_id, targetId).first<{ id: string }>();
    if (!snapshot) return false;
  }
  return true;
}

async function appendTransitionEvent(
  env: Pick<Env, "DB">,
  row: ProposalRow,
  actor: ActorContext,
  fromStatus: "pending" | "executing",
  toStatus: "stale" | "failed",
  now: number,
  errorCode: string,
  message: string,
): Promise<void> {
  const timeColumn = toStatus === "stale" ? "stale_at" : "failed_at";
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE action_proposals
       SET status = ?, ${timeColumn} = ?, updated_at = ?, error_code = ?, error_message = ?
       WHERE id = ? AND status = ?`,
    ).bind(toStatus, now, now, errorCode, message.slice(0, 500), row.id, fromStatus),
    env.DB.prepare(
      `INSERT INTO proposal_events (
         id, proposal_id, sequence, event_type, actor_kind, actor_id, data_json, created_at
       )
       SELECT ?, ?, COALESCE((SELECT MAX(sequence) + 1 FROM proposal_events WHERE proposal_id = ?), 1),
              ?, ?, ?, ?, ?
       WHERE changes() = 1`,
    ).bind(
      crypto.randomUUID(), row.id, row.id, toStatus, actor.kind, actor.actorId,
      stableJson({ errorCode, message: message.slice(0, 200) }), now,
    ),
  ]);
  if (sqlChanges(results[0]) === 0) {
    throw new ActionProposalError("transition_conflict", `Proposal could not transition to ${toStatus}.`);
  }
}

interface ActionEntryRow extends EntryPreconditionRow {
  content: string;
  tags: string;
  source: string;
  valid_from: number | null;
  valid_to: number | null;
  epistemic_status: EpistemicStatus;
}

function parseEntryTags(value: string): string[] {
  const tags = parseStringArray(value);
  if (stableJson(tags) !== stableJson(JSON.parse(value))) {
    throw new ActionProposalError("invalid_input", "Entry tags are malformed.");
  }
  return tags;
}

async function loadOwnedActionEntry(
  env: Pick<Env, "DB">,
  row: ProposalRow,
  payload: Record<string, unknown>,
): Promise<ActionEntryRow> {
  if (typeof payload.entryId !== "string" || typeof payload.ownerUserId !== "string") {
    throw new ActionProposalError("invalid_input", `Approved ${row.action_type} payload is invalid.`);
  }
  const ownerUserId = await proposalOwnerUserId(env, row);
  if (!ownerUserId || payload.ownerUserId !== ownerUserId) {
    throw new ActionProposalError("forbidden", "Proposal owner binding is invalid.");
  }
  const entry = await env.DB.prepare(
    `SELECT id, content, tags, source, owner_user_id, revision, visibility,
            current_episode_id, valid_from, valid_to, epistemic_status
     FROM entries WHERE id = ?`,
  ).bind(payload.entryId).first<ActionEntryRow>();
  if (!entry || entry.owner_user_id !== ownerUserId) {
    throw new ActionProposalError("forbidden", "The proposal does not own its target entry.");
  }
  if (row.expected_revision === null || entry.revision !== row.expected_revision) {
    throw new ActionProposalError("stale", "The target entry revision changed before execution.");
  }
  return entry;
}

function entryResult(
  row: ProposalRow,
  actionType: EntryProposalExecutionResult["actionType"],
  committed: { entryId: string; episodeId: string; revision: number },
): EntryProposalExecutionResult {
  return {
    proposalId: row.id,
    actionType,
    entryId: committed.entryId,
    episodeId: committed.episodeId,
    revision: committed.revision,
  };
}

async function ensureDeprecatedProjection(
  env: Env,
  row: ProposalRow,
  artifact: EntryProposalExecutionResult,
  now: number,
): Promise<void> {
  const payload = parseRecord(row.payload_json);
  if (row.action_type !== "entry.status.set" || payload?.status !== "deprecated") return;
  const current = await env.DB.prepare(
    `SELECT revision, vector_ids, tags FROM entries WHERE id = ?`,
  ).bind(artifact.entryId).first<{ revision: number; vector_ids: string; tags: string }>();
  if (!current || current.revision !== artifact.revision) return;
  const vectorIds = parseStringArray(current.vector_ids);
  if (!vectorIds.length) return;
  const queueId = `proposal-deprecate:${row.id}`;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO vector_cleanup_queue (
         id, vector_ids, reason, attempts, last_error, created_at, updated_at
       ) VALUES (?, ?, ?, 0, NULL, ?, ?)`,
    ).bind(queueId, JSON.stringify(vectorIds), `operator-deprecate:${row.id}`, now, now),
    env.DB.prepare(
      `UPDATE entries SET vector_ids = '[]', updated_at = ?
       WHERE id = ? AND revision = ?`,
    ).bind(now, artifact.entryId, artifact.revision),
  ]);
  try {
    await env.VECTORIZE.deleteByIds(vectorIds);
    await env.DB.prepare(`DELETE FROM vector_cleanup_queue WHERE id = ?`).bind(queueId).run();
  } catch (error) {
    await env.DB.prepare(
      `UPDATE vector_cleanup_queue
       SET attempts = attempts + 1, last_error = ?, updated_at = ? WHERE id = ?`,
    ).bind(errorMessage(error).slice(0, 500), now, queueId).run();
  }
}

async function findExecutedVersion(
  env: Env,
  row: ProposalRow,
  now: number,
): Promise<EntryProposalExecutionResult | null> {
  if (!VERSIONED_EXECUTOR_ACTIONS.has(row.action_type)) return null;
  const found = await env.DB.prepare(
    `SELECT ep.entry_id, ep.id AS episode_id, COALESCE(s.revision + 1, 1) AS revision
     FROM episodes ep
     LEFT JOIN entry_snapshots s
       ON s.entry_id = ep.entry_id AND s.mutation_id = ep.mutation_id
     WHERE ep.mutation_id = ?
     ORDER BY ep.created_at DESC, ep.id DESC LIMIT 1`,
  ).bind(`proposal:${row.id}`).first<{ entry_id: string; episode_id: string; revision: number }>();
  if (!found) return null;
  const artifact = {
    proposalId: row.id,
    actionType: row.action_type as EntryProposalExecutionResult["actionType"],
    entryId: found.entry_id,
    episodeId: found.episode_id,
    revision: Number(found.revision),
  };
  await ensureDeprecatedProjection(env, row, artifact, now);
  return artifact;
}

async function findExecutedEdge(
  env: Pick<Env, "DB">,
  row: ProposalRow,
): Promise<EdgeProposalExecutionResult | null> {
  const payload = parseRecord(row.payload_json);
  if (!payload || typeof payload.sourceId !== "string" || typeof payload.targetId !== "string"
      || typeof payload.type !== "string" || !isValidEdgeType(payload.type)) return null;
  const existing = await env.DB.prepare(
    `SELECT source_id, target_id, type FROM edges
     WHERE ((source_id = ? AND target_id = ?) OR (source_id = ? AND target_id = ?))
       AND type = ? AND json_extract(metadata, '$.proposal_id') = ? LIMIT 1`,
  ).bind(payload.sourceId, payload.targetId, payload.targetId, payload.sourceId, payload.type, row.id)
    .first<{ source_id: string; target_id: string; type: EdgeType }>();
  if (row.action_type === "edge.publish" && existing) {
    return {
      proposalId: row.id,
      actionType: "edge.publish",
      sourceId: existing.source_id,
      targetId: existing.target_id,
      edgeType: existing.type,
    };
  }
  if (row.action_type === "edge.remove" && !existing) {
    return {
      proposalId: row.id,
      actionType: "edge.remove",
      sourceId: payload.sourceId,
      targetId: payload.targetId,
      edgeType: payload.type,
    };
  }
  return null;
}

async function findExecutedArtifact(
  env: Env,
  row: ProposalRow,
  now: number,
): Promise<ProposalExecutionResult | null> {
  return VERSIONED_EXECUTOR_ACTIONS.has(row.action_type)
    ? findExecutedVersion(env, row, now)
    : findExecutedEdge(env, row);
}

async function proposalIntegrityHolds(row: ProposalRow): Promise<boolean> {
  if (!row.payload_hash || await sha256Hex(row.payload_json) !== row.payload_hash) return false;
  if (row.result_json !== null) {
    if (!row.result_hash || await sha256Hex(row.result_json) !== row.result_hash) return false;
  }
  return true;
}

function parseExecutionResult(row: ProposalRow): ProposalExecutionResult | null {
  if (!row.result_json) return null;
  try {
    const parsed = JSON.parse(row.result_json) as Record<string, unknown>;
    if (parsed.proposalId !== row.id || parsed.actionType !== row.action_type) return null;
    if (VERSIONED_EXECUTOR_ACTIONS.has(row.action_type)) {
      return typeof parsed.entryId === "string"
        && typeof parsed.episodeId === "string"
        && typeof parsed.revision === "number"
        ? parsed as unknown as EntryProposalExecutionResult
        : null;
    }
    return (row.action_type === "edge.publish" || row.action_type === "edge.remove")
      && typeof parsed.sourceId === "string"
      && typeof parsed.targetId === "string"
      && typeof parsed.edgeType === "string"
      && isValidEdgeType(parsed.edgeType)
      ? parsed as unknown as EdgeProposalExecutionResult
      : null;
  } catch {
    return null;
  }
}

async function executeEntryCreate(
  env: Env,
  row: ProposalRow,
  now: number,
): Promise<ProposalExecutionResult> {
  const payload = parseRecord(row.payload_json);
  if (!payload || typeof payload.content !== "string" || payload.content.length === 0
      || typeof payload.entryId !== "string" || typeof payload.ownerUserId !== "string") {
    throw new ActionProposalError("invalid_input", "Approved entry.create payload is invalid.");
  }
  if (await proposalOwnerUserId(env, row) !== payload.ownerUserId) {
    throw new ActionProposalError("forbidden", "Proposal owner binding is invalid.");
  }
  const visibility = payload.visibility === "public" ? "public" : "private";
  const requestedStatus = typeof payload.lifecycleStatus === "string" && STATUS_VALUES.includes(payload.lifecycleStatus as MemoryStatus)
    ? payload.lifecycleStatus as MemoryStatus
    : "draft";
  const requestedEpistemic = typeof payload.epistemicStatus === "string" && EPISTEMIC_STATUS_VALUES.includes(payload.epistemicStatus as EpistemicStatus)
    ? payload.epistemicStatus as EpistemicStatus
    : "candidate";
  const suppliedTags = Array.isArray(payload.tags)
    ? payload.tags.filter((tag): tag is string => typeof tag === "string")
    : [];
  let tags = suppliedTags.filter((tag) => tag !== "private" && !tag.startsWith("status:"));
  tags = withStatus(tags, requestedStatus);
  if (visibility === "private") tags.push("private");

  const committed = await commitEntryVersion({
    kind: "capture",
    actorUserId: payload.ownerUserId,
    entryId: payload.entryId,
    rawContent: payload.content,
    materializedContent: payload.content,
    tags,
    source: typeof payload.source === "string" ? payload.source : "operator-proposal",
    sourceUrl: typeof payload.sourceUrl === "string" ? payload.sourceUrl : null,
    visibility,
    contentType: typeof payload.contentType === "string" ? payload.contentType : undefined,
    title: typeof payload.title === "string" ? payload.title : undefined,
    epistemicStatus: requestedEpistemic,
    mutationId: `proposal:${row.id}`,
    now,
  }, env);
  return entryResult(row, "entry.create", committed);
}

async function executeEntryAppend(env: Env, row: ProposalRow, now: number): Promise<EntryProposalExecutionResult> {
  const payload = parseRecord(row.payload_json);
  if (!payload || typeof payload.addition !== "string" || !payload.addition.trim()) {
    throw new ActionProposalError("invalid_input", "Approved entry.append payload is invalid.");
  }
  const entry = await loadOwnedActionEntry(env, row, payload);
  if (await isManagedMirror(entry.id, entry.source, entry.owner_user_id, env)) {
    throw new ActionProposalError("forbidden", "Managed integration mirrors must be edited at their source.");
  }
  const date = new Date(now).toISOString().slice(0, 10);
  const committed = await commitEntryVersion({
    kind: "append",
    actorUserId: entry.owner_user_id,
    entryId: entry.id,
    expectedRevision: entry.revision,
    rawContent: payload.addition,
    materializedContent: `${entry.content}\n\n[Update ${date}]: ${payload.addition.trim()}`,
    tags: parseEntryTags(entry.tags),
    source: entry.source,
    validFrom: entry.valid_from,
    validTo: entry.valid_to,
    epistemicStatus: entry.epistemic_status,
    mutationId: `proposal:${row.id}`,
    now,
  }, env);
  return entryResult(row, "entry.append", committed);
}

async function executeEntryUpdate(env: Env, row: ProposalRow, now: number): Promise<EntryProposalExecutionResult> {
  const payload = parseRecord(row.payload_json);
  if (!payload || typeof payload.content !== "string" || !payload.content.trim()) {
    throw new ActionProposalError("invalid_input", "Approved entry.update payload is invalid.");
  }
  const entry = await loadOwnedActionEntry(env, row, payload);
  if (await isManagedMirror(entry.id, entry.source, entry.owner_user_id, env)) {
    throw new ActionProposalError("forbidden", "Managed integration mirrors must be edited at their source.");
  }
  const committed = await commitEntryVersion({
    kind: "update",
    actorUserId: entry.owner_user_id,
    entryId: entry.id,
    expectedRevision: entry.revision,
    rawContent: payload.content,
    materializedContent: payload.content.trim(),
    tags: parseEntryTags(entry.tags),
    source: entry.source,
    validFrom: entry.valid_from,
    validTo: entry.valid_to,
    epistemicStatus: entry.epistemic_status,
    mutationId: `proposal:${row.id}`,
    now,
  }, env);
  return entryResult(row, "entry.update", committed);
}

async function executeEntryRestore(env: Env, row: ProposalRow, now: number): Promise<EntryProposalExecutionResult> {
  const payload = parseRecord(row.payload_json);
  if (!payload || typeof payload.snapshotId !== "string") {
    throw new ActionProposalError("invalid_input", "Approved entry.restore payload is invalid.");
  }
  const entry = await loadOwnedActionEntry(env, row, payload);
  const snapshot = await loadOwnedRestoreSnapshot(
    env,
    entry.owner_user_id,
    entry.id,
    payload.snapshotId,
  );
  if (!snapshot) throw new ActionProposalError("stale", "The approved restore snapshot no longer exists.");
  const tags = withStatus(
    [...new Set([
      ...parseEntryTags(snapshot.tags).filter((tag) => !tag.startsWith("status:") && tag !== "private"),
      "restored",
      "private",
    ])],
    "draft",
  );
  const committed = await commitEntryVersion({
    kind: "restore",
    actorUserId: entry.owner_user_id,
    forceCreate: true,
    restoredFromSnapshotId: snapshot.id,
    rawContent: snapshot.content,
    materializedContent: snapshot.content,
    tags,
    source: snapshot.source,
    sourceUrl: snapshot.source_url,
    contentType: snapshot.content_type ?? "text",
    title: snapshot.source_title ?? undefined,
    validFrom: snapshot.valid_from,
    validTo: snapshot.valid_to,
    epistemicStatus: "candidate",
    mutationId: `proposal:${row.id}`,
    now,
  }, env);
  return entryResult(row, "entry.restore", committed);
}

async function executeEntryStatus(env: Env, row: ProposalRow, now: number): Promise<EntryProposalExecutionResult> {
  const payload = parseRecord(row.payload_json);
  if (!payload || typeof payload.status !== "string"
      || !(STATUS_VALUES as readonly string[]).includes(payload.status)) {
    throw new ActionProposalError("invalid_input", "Approved entry.status.set payload is invalid.");
  }
  const entry = await loadOwnedActionEntry(env, row, payload);
  const committed = await commitEntryVersion({
    kind: "status",
    actorUserId: entry.owner_user_id,
    entryId: entry.id,
    expectedRevision: entry.revision,
    rawContent: `status:${payload.status}`,
    materializedContent: entry.content,
    tags: withStatus(parseEntryTags(entry.tags), payload.status as MemoryStatus),
    source: entry.source,
    validFrom: entry.valid_from,
    validTo: entry.valid_to,
    epistemicStatus: entry.epistemic_status,
    mutationId: `proposal:${row.id}`,
    now,
  }, env);
  const result = entryResult(row, "entry.status.set", committed);
  await ensureDeprecatedProjection(env, row, result, now);
  return result;
}

async function executeEntryEpistemicStatus(env: Env, row: ProposalRow, now: number): Promise<EntryProposalExecutionResult> {
  const payload = parseRecord(row.payload_json);
  if (!payload || typeof payload.status !== "string"
      || !(EPISTEMIC_STATUS_VALUES as readonly string[]).includes(payload.status)) {
    throw new ActionProposalError("invalid_input", "Approved entry.epistemic-status.set payload is invalid.");
  }
  const entry = await loadOwnedActionEntry(env, row, payload);
  const next = payload.status as EpistemicStatus;
  if (!isValidTransition(entry.epistemic_status, next)) {
    throw new ActionProposalError("stale", `Epistemic transition ${entry.epistemic_status} -> ${next} is not valid.`);
  }
  const committed = await commitEntryVersion({
    kind: "status",
    actorUserId: entry.owner_user_id,
    entryId: entry.id,
    expectedRevision: entry.revision,
    rawContent: `epistemic:${next}`,
    materializedContent: entry.content,
    tags: parseEntryTags(entry.tags),
    source: entry.source,
    validFrom: entry.valid_from,
    validTo: entry.valid_to,
    epistemicStatus: next,
    mutationId: `proposal:${row.id}`,
    now,
  }, env);
  return entryResult(row, "entry.epistemic-status.set", committed);
}

async function authorizeEdgeExecution(
  env: Pick<Env, "DB">,
  row: ProposalRow,
  payload: Record<string, unknown>,
): Promise<{ sourceId: string; targetId: string; edgeType: EdgeType }> {
  if (typeof payload.sourceId !== "string" || typeof payload.targetId !== "string"
      || typeof payload.type !== "string" || !isValidEdgeType(payload.type)) {
    throw new ActionProposalError("invalid_input", `Approved ${row.action_type} payload is invalid.`);
  }
  const subjectUserId = await proposalOwnerUserId(env, row);
  if (!subjectUserId) throw new ActionProposalError("forbidden", "Proposal owner could not be resolved.");
  const endpoints: EntryPreconditionRow[] = [];
  for (const id of [payload.sourceId, payload.targetId]) {
    const endpoint = await env.DB.prepare(
      `SELECT id, revision, owner_user_id, visibility, current_episode_id
       FROM entries WHERE id = ?`,
    ).bind(id).first<EntryPreconditionRow>();
    if (!endpoint) throw new ActionProposalError("stale", "An edge endpoint no longer exists.");
    endpoints.push(endpoint);
  }
  if (endpoints[0].visibility !== endpoints[1].visibility) {
    throw new ActionProposalError("stale", "Edge endpoints no longer share one visibility partition.");
  }
  if (endpoints[0].visibility === "private"
      && (endpoints[0].owner_user_id !== subjectUserId || endpoints[1].owner_user_id !== subjectUserId)) {
    throw new ActionProposalError("forbidden", "The proposal does not own its private edge endpoints.");
  }
  return { sourceId: payload.sourceId, targetId: payload.targetId, edgeType: payload.type };
}

async function executeEdgePublish(env: Env, row: ProposalRow, _now: number): Promise<EdgeProposalExecutionResult> {
  const payload = parseRecord(row.payload_json);
  if (!payload) throw new ActionProposalError("invalid_input", "Approved edge.publish payload is invalid.");
  const target = await authorizeEdgeExecution(env, row, payload);
  const metadata = payload.metadata && typeof payload.metadata === "object" && !Array.isArray(payload.metadata)
    ? payload.metadata as Record<string, unknown>
    : {};
  const edge = await createEdge(target.sourceId, target.targetId, target.edgeType, {
    provenance: "explicit",
    weight: typeof payload.weight === "number" ? payload.weight : 1,
    confidence: typeof payload.confidence === "number" ? payload.confidence : 1,
    metadata: { ...metadata, proposal_id: row.id, reviewer_id: row.reviewer_id },
    actorKind: row.reviewer_kind === "human" ? "human" : "system",
    actorId: row.reviewer_id ?? "_approved_proposal_executor",
    mutationKind: "proposal-publish",
    mutationId: `proposal:${row.id}`,
  }, env);
  if (!edge) throw new ActionProposalError("stale", "The approved edge can no longer be published.");
  return {
    proposalId: row.id,
    actionType: "edge.publish",
    sourceId: edge.source_id,
    targetId: edge.target_id,
    edgeType: edge.type,
  };
}

async function executeEdgeRemove(env: Env, row: ProposalRow): Promise<EdgeProposalExecutionResult> {
  const payload = parseRecord(row.payload_json);
  if (!payload) throw new ActionProposalError("invalid_input", "Approved edge.remove payload is invalid.");
  const target = await authorizeEdgeExecution(env, row, payload);
  await deleteEdge(target.sourceId, target.targetId, target.edgeType, env, {
    actorKind: row.reviewer_kind === "human" ? "human" : "system",
    actorId: row.reviewer_id ?? "_approved_proposal_executor",
    mutationKind: "proposal-remove",
    mutationId: `proposal:${row.id}`,
  });
  return {
    proposalId: row.id,
    actionType: "edge.remove",
    sourceId: target.sourceId,
    targetId: target.targetId,
    edgeType: target.edgeType,
  };
}

async function runExplicitExecutor(env: Env, row: ProposalRow, now: number): Promise<ProposalExecutionResult> {
  switch (row.action_type) {
    case "entry.create": return executeEntryCreate(env, row, now);
    case "entry.append": return executeEntryAppend(env, row, now);
    case "entry.update": return executeEntryUpdate(env, row, now);
    case "entry.restore": return executeEntryRestore(env, row, now);
    case "entry.status.set": return executeEntryStatus(env, row, now);
    case "entry.epistemic-status.set": return executeEntryEpistemicStatus(env, row, now);
    case "edge.publish": return executeEdgePublish(env, row, now);
    case "edge.remove": return executeEdgeRemove(env, row);
    default:
      throw new ActionProposalError("unsupported_action", `No approved executor is registered for ${row.action_type}.`);
  }
}

async function finalizeExecution(
  env: Pick<Env, "DB">,
  row: ProposalRow,
  actor: ActorContext,
  result: ProposalExecutionResult,
  now: number,
): Promise<void> {
  const resultJson = stableJson(result);
  const resultHash = await sha256Hex(resultJson);
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE action_proposals
       SET status = 'executed', executed_at = ?, updated_at = ?,
           result_json = ?, result_hash = ?, error_code = NULL, error_message = NULL
       WHERE id = ? AND status = 'executing'`,
    ).bind(now, now, resultJson, resultHash, row.id),
    env.DB.prepare(
      `INSERT INTO proposal_events (
         id, proposal_id, sequence, event_type, actor_kind, actor_id,
         data_json, data_hash, created_at
       )
       SELECT ?, ?, COALESCE((SELECT MAX(sequence) + 1 FROM proposal_events WHERE proposal_id = ?), 1),
              'executed', ?, ?, ?, ?, ?
       WHERE changes() = 1`,
    ).bind(crypto.randomUUID(), row.id, row.id, actor.kind, actor.actorId, resultJson, resultHash, now),
  ]);
  if (sqlChanges(results[0]) === 0) {
    const current = await loadProposalRow(env, row.id);
    if (current?.status === "executed" && parseExecutionResult(current)) return;
    throw new ActionProposalError("transition_conflict", "Proposal could not be finalized.");
  }
}

export async function executeApprovedProposal(
  env: Env,
  input: ExecuteActionProposalInput,
): Promise<ProposalExecutionResult> {
  if (!input.proposalId) throw new ActionProposalError("invalid_input", "Proposal id is required.");
  const now = input.now ?? Date.now();
  const resolved = await resolveActor(env, input.actor, now);
  const initial = await loadProposalRow(env, input.proposalId);
  const proposedAction = initial && ACTION_TYPE_SET.has(initial.action_type)
    ? initial.action_type as ActionType
    : undefined;
  const policy = decideOperatorAction({
    actor: resolved.actor,
    operation: "proposal.execute",
    proposedAction,
    autonomyProfile: resolved.autonomyProfile,
  });
  requireAllowedDecision(policy);
  if (initial && !await actorCanAccessProposal(env, resolved.actor, initial)) {
    throw new ActionProposalError("forbidden", "This proposal is not visible to the executor.");
  }

  return withMandatoryAudit(
    env,
    {
      actor: resolved.actor,
      subjectUserId: resolved.subjectUserId,
      operation: "proposal.execute",
      decision: policy,
      proposalId: input.proposalId,
      targetIds: initial ? parseStringArray(initial.target_ids) : [input.proposalId],
      redactedRequest: { proposalId: input.proposalId, actionType: proposedAction ?? "unknown" },
      correlationId: input.correlationId,
      now,
    },
    async () => {
      let current = await loadProposalRow(env, input.proposalId);
      if (!current) throw new ActionProposalError("not_found", "Proposal was not found.");
      if (!ACTION_TYPE_SET.has(current.action_type)) {
        throw new ActionProposalError("unsupported_action", `Unsupported proposal action: ${current.action_type}`);
      }
      if (!(await proposalIntegrityHolds(current))) {
        if (current.status === "pending") {
          await appendTransitionEvent(env, current, resolved.actor, "pending", "stale", now, "integrity_failed", "Proposal payload integrity check failed.");
        } else if (current.status === "executing") {
          await appendTransitionEvent(env, current, resolved.actor, "executing", "failed", now, "integrity_failed", "Proposal payload integrity check failed.");
        }
        throw new ActionProposalError("stale", "Proposal payload or result integrity check failed.");
      }
      if (!SUPPORTED_EXECUTOR_ACTIONS.has(current.action_type)) {
        throw new ActionProposalError("unsupported_action", `No approved executor is registered for ${current.action_type}.`);
      }
      if (current.status === "executed") {
        const prior = parseExecutionResult(current);
        if (!prior) throw new ActionProposalError("transition_conflict", "Executed proposal has no valid result.");
        return prior;
      }
      if (current.status === "executing") {
        const artifact = await findExecutedArtifact(env, current, now);
        if (artifact) {
          await finalizeExecution(env, current, resolved.actor, artifact, now);
          return artifact;
        }
        if (current.executor_kind !== resolved.actor.kind || current.executor_id !== resolved.actor.actorId) {
          throw new ActionProposalError("transition_conflict", "Proposal is already claimed by another executor.");
        }
      } else {
        if (current.expires_at !== null && current.expires_at <= now && current.status === "pending") {
          await expirePendingProposal(env, current, resolved.actor, now);
          throw new ActionProposalError("expired", "Proposal has expired.");
        }
        if (current.status !== "pending") {
          throw new ActionProposalError("transition_conflict", `Proposal cannot execute from ${current.status}.`);
        }
        if (current.reviewer_kind !== "human" || !current.reviewer_id || current.reviewed_at === null) {
          throw new ActionProposalError("human_review_required", "Proposal requires explicit human approval.");
        }
        if (!(await preconditionsMatch(env, current))) {
          await appendTransitionEvent(env, current, resolved.actor, "pending", "stale", now, "precondition_failed", "Expected revision or entry precondition no longer holds.");
          throw new ActionProposalError("stale", "Proposal preconditions no longer hold.");
        }
        const claim = await env.DB.batch([
          env.DB.prepare(
            `UPDATE action_proposals
             SET status = 'executing', executor_kind = ?, executor_id = ?,
                 execution_started_at = ?, updated_at = ?
             WHERE id = ? AND status = 'pending'
               AND reviewer_kind = 'human' AND reviewed_at IS NOT NULL`,
          ).bind(resolved.actor.kind, resolved.actor.actorId, now, now, current.id),
          env.DB.prepare(
            `INSERT INTO proposal_events (
               id, proposal_id, sequence, event_type, actor_kind, actor_id, data_json, created_at
             )
             SELECT ?, ?, COALESCE((SELECT MAX(sequence) + 1 FROM proposal_events WHERE proposal_id = ?), 1),
                    'executing', ?, ?, '{}', ?
             WHERE changes() = 1`,
          ).bind(crypto.randomUUID(), current.id, current.id, resolved.actor.kind, resolved.actor.actorId, now),
        ]);
        if (sqlChanges(claim[0]) === 0) {
          const raced = await loadProposalRow(env, current.id);
          if (raced?.status === "executed") {
            const prior = parseExecutionResult(raced);
            if (prior) return prior;
          }
          throw new ActionProposalError("transition_conflict", "Proposal was claimed concurrently.");
        }
        current = (await loadProposalRow(env, current.id))!;
      }

      try {
        const result = await runExplicitExecutor(env, current, now);
        await finalizeExecution(env, current, resolved.actor, result, now);
        return result;
      } catch (error) {
        // If the action committed but finalization failed, leave it executing;
        // retry discovers the deterministic mutation artifact and finalizes it.
        const artifact = await findExecutedArtifact(env, current, now);
        if (artifact) throw error;
        const stale = error instanceof ActionProposalError && error.code === "stale"
          || error instanceof EntryVersionError && error.code === "revision_conflict";
        await appendTransitionEvent(
          env,
          current,
          resolved.actor,
          "executing",
          stale ? "stale" : "failed",
          now,
          stale ? "precondition_failed" : error instanceof ActionProposalError ? error.code : "executor_failed",
          errorMessage(error),
        );
        if (stale && !(error instanceof ActionProposalError && error.code === "stale")) {
          throw new ActionProposalError("stale", "Proposal preconditions changed during execution.");
        }
        throw error;
      }
    },
    (result) => result.actionType.startsWith("entry.")
      ? {
          proposalId: result.proposalId,
          actionType: result.actionType,
          entryId: (result as EntryProposalExecutionResult).entryId,
          revision: (result as EntryProposalExecutionResult).revision,
        }
      : {
          proposalId: result.proposalId,
          actionType: result.actionType,
          sourceId: (result as EdgeProposalExecutionResult).sourceId,
          targetId: (result as EdgeProposalExecutionResult).targetId,
        },
  );
}
