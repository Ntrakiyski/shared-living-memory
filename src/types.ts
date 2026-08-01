/**
 * types.ts — Shared type definitions used across modules.
 *
 * Purpose: Define all cross-module interfaces, enums, and type aliases in one place.
 * Input: None (type-only module).
 * Output: Env, RecallMatch, MemoryStatus, MemoryKind, CaptureResult, etc.
 * Logic: Type definitions only — no runtime logic.
 */

// ─── Cloudflare Worker environment bindings ────────────────────────────────────
// Bindings come from the generated Cloudflare.Env (see `wrangler types`);
// VECTORIZE_GRACE_MS is widened from its generated literal default so tests
// and per-deploy vars can override it.

export interface Env extends Omit<Cloudflare.Env, "VECTORIZE_GRACE_MS"> {
  VECTORIZE_GRACE_MS?: string;
}

// ─── Memory lifecycle ──────────────────────────────────────────────────────────

export const STATUS_PREFIX = "status:";
export const KIND_PREFIX = "kind:";
export const KIND_VALUES = ["episodic", "semantic"] as const;
export const MEMORY_KIND_VALUES = KIND_VALUES;
export type MemoryKind = (typeof KIND_VALUES)[number];

export const STATUS_VALUES = ["canonical", "draft", "deprecated"] as const;
export type MemoryStatus = (typeof STATUS_VALUES)[number];

// ─── Epistemic status (Ticket 06) ────────────────────────────────────────────
export const EPISTEMIC_STATUS_VALUES = ["candidate", "reviewed", "canonical", "qualified", "stale", "superseded", "retracted"] as const;
export type EpistemicStatus = (typeof EPISTEMIC_STATUS_VALUES)[number];

// ─── Epistemic state machine (Ticket 10) ─────────────────────────────────────
export const VALID_EPISTEMIC_TRANSITIONS: Record<EpistemicStatus, readonly EpistemicStatus[]> = {
  candidate:   ["reviewed"],
  reviewed:    ["canonical"],
  canonical:   ["qualified", "superseded"],
  qualified:   ["canonical", "superseded"],
  stale:       ["reviewed", "retracted"],
  superseded:  ["retracted"],
  retracted:   [],
};

export function isValidTransition(from: EpistemicStatus, to: EpistemicStatus): boolean {
  return VALID_EPISTEMIC_TRANSITIONS[from]?.includes(to) ?? false;
}

// ─── Recall results ────────────────────────────────────────────────────────────

export interface RecallMatch {
  id: string;
  content: string;
  score: number;
  createdAt: number;
  tags: string[];
  source: string;
  isUpdate: boolean;
  hop: number; // 0 = direct match; ≥1 = surfaced via graph expansion (issue #16)
  crossUserMention?: { entryId: string; ownerUsername: string; similarity: number };
  passages?: { id: string; content: string; section: string | null; startOffset: number | null; endOffset: number | null }[];
  relations?: { type: string; confidence: number; targetId: string; targetContent?: string }[];
  epistemicStatus?: string;
}

// ─── Ingestion capture result ──────────────────────────────────────────────────

export type CaptureVisibility = "private" | "public";

export interface CaptureRequest {
  content: string;
  tags?: string[];
  source?: string;
  source_url?: string;
  source_title?: string;
  visibility?: CaptureVisibility;
}

export interface CaptureStoredResponse {
  ok: true;
  id: string;
  action: "stored" | "merged" | "replaced" | "stored_separately";
  visibility: CaptureVisibility;
  warnings: string[];
}

export interface CaptureDuplicateResponse {
  ok: false;
  error: "duplicate";
  action: "blocked_duplicate";
  match_id: string;
  match_score: number;
  warnings: string[];
}

export type CaptureResponse = CaptureStoredResponse | CaptureDuplicateResponse;

export type CaptureResult =
  | { status: "blocked"; matchId: string; score: number }
  | { status: "stored"; id: string; crossUserNote?: string; awareness?: AwarenessDelivery }
  | { status: "flagged"; id: string; matchId: string; score: number; crossUserNote?: string; awareness?: AwarenessDelivery }
  | { status: "contradiction"; id: string; resolvedConflict: string; reason?: string; awareness?: AwarenessDelivery }
  | { status: "contradiction_protected"; id: string; canonicalId: string; reason?: string; awareness?: AwarenessDelivery }
  | { status: "contradiction_resolved"; id: string; replacedId?: string; mergedInto?: string; keptBoth?: boolean; reason?: string };

// ─── Memory Pillar: Episodes, Snapshots, Passages ────────────────────────────

export const ENTRY_MUTATION_KINDS = [
  "legacy",
  "capture",
  "update",
  "append",
  "merge",
  "replace",
  "restore",
  "compress",
  "status",
  "validity",
  "visibility",
] as const;
export type EntryMutationKind = (typeof ENTRY_MUTATION_KINDS)[number];

export interface Episode {
  id: string;
  entryId: string;
  content: string;
  contentType: string;
  source: string;
  createdAt: number;
  materializedContent: string;
  contentHash: string | null;
  mutationId: string | null;
  mutationKind: EntryMutationKind;
  parentEpisodeId: string | null;
  restoredFromSnapshotId: string | null;
  ownerUserId: string;
  sourceUrl: string | null;
}

export interface EntrySnapshot {
  id: string;
  entryId: string;
  content: string;
  tags: string;
  source: string;
  createdAt: number;
  episodeId: string | null;
  mutationId: string | null;
  mutationKind: EntryMutationKind;
  recordedAt: number | null;
  validFrom: number | null;
  validTo: number | null;
  epistemicStatus: EpistemicStatus | null;
  revision: number | null;
}

export interface Passage {
  id: string;
  entryId: string;
  episodeId: string | null;
  documentId: string | null;
  sectionId: string | null;
  content: string;
  section: string | null;
  page: number | null;
  pageEnd: number | null;
  startOffset: number | null;
  endOffset: number | null;
  vectorIds: string;
  createdAt: number;
}

export interface Document {
  id: string;
  title: string;
  sourceUrl: string | null;
  contentType: string;
  createdAt: number;
  episodeId: string | null;
  ownerUserId: string;
  contentHash: string | null;
  version: string | null;
}

export interface DocumentSection {
  id: string;
  documentId: string;
  parentSectionId: string | null;
  title: string;
  level: number;
  orderIndex: number;
  createdAt: number;
  pageStart: number | null;
  pageEnd: number | null;
  startOffset: number | null;
  endOffset: number | null;
}

export interface VectorCleanupQueueItem {
  id: string;
  vectorIds: string;
  reason: string;
  attempts: number;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

// ─── Shared Knowledge Base: tenancy and lifecycle ───────────────────────────

export const USER_ROLES = ["member", "admin"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const ENTRY_VISIBILITIES = ["private", "public"] as const;
export type EntryVisibility = (typeof ENTRY_VISIBILITIES)[number];

export const USER_DEACTIVATION_STATUSES = [
  "pending",
  "running",
  "completed",
  "failed",
] as const;
export type UserDeactivationStatus = (typeof USER_DEACTIVATION_STATUSES)[number];

export interface UserDeactivation {
  id: string;
  userId: string;
  requestedByUserId: string;
  transferToUserId: string | null;
  transferCursor: string | null;
  processedEntries: number;
  status: UserDeactivationStatus;
  lastError: string | null;
  requestedAt: number;
  startedAt: number | null;
  updatedAt: number;
  completedAt: number | null;
}

export const AWARENESS_EVENT_TYPES = ["cross_user_overlap"] as const;
export type AwarenessEventType = (typeof AWARENESS_EVENT_TYPES)[number];

export interface AwarenessEventEndpoint {
  entryId: string;
  ownerUserId: string;
  ownerUsername: string;
  content: string;
  createdAt: number;
}

/**
 * A recipient-scoped signal that two currently-public team memories overlap.
 * Endpoint content is populated only after a live D1 visibility check.
 */
export interface AwarenessEvent {
  id: string;
  eventType: AwarenessEventType;
  recipientUserId: string;
  triggerEntryId: string;
  similarity: number;
  endpoints: readonly [AwarenessEventEndpoint, AwarenessEventEndpoint];
  createdAt: number;
  readAt: number | null;
}

export const OVERLAP_RECONCILIATION_STATUSES = [
  "pending",
  "completed",
  "discarded",
  "failed",
] as const;
export type OverlapReconciliationStatus =
  (typeof OVERLAP_RECONCILIATION_STATUSES)[number];

export type AwarenessDelivery =
  | { status: "not_applicable"; eventCount: 0 }
  | { status: "ready"; eventCount: 2; reconciliationId: string }
  | { status: "discarded"; eventCount: 0; reconciliationId: string }
  | { status: "pending_reconciliation"; eventCount: 0; reconciliationId: string };

// ─── Operator governance: identity, policy, proposals, and audit ────────────

export const ACTOR_KINDS = ["human", "service", "system"] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

export const SERVICE_SCOPES = [
  "memory:read",
  "memory:draft",
  "memory:propose",
  "memory:execute-approved",
  "proposal:read",
  "proposal:create",
  "proposal:execute-approved",
  "audit:write",
  "run:write",
] as const;
export type ServiceScope = (typeof SERVICE_SCOPES)[number];

interface ActorContextBase {
  actorId: string;
  authMethod: string;
  scopes: ReadonlySet<ServiceScope>;
}

export interface HumanActorContext extends ActorContextBase {
  kind: "human";
  userId: string;
  role: UserRole;
}

export interface ServiceActorContext extends ActorContextBase {
  kind: "service";
  serviceIdentityId: string;
  credentialId: string;
  ownerUserId: string;
}

export interface SystemActorContext extends ActorContextBase {
  kind: "system";
  systemId: string;
}

export type ActorContext =
  | HumanActorContext
  | ServiceActorContext
  | SystemActorContext;

export const SERVICE_IDENTITY_STATUSES = ["active", "suspended", "revoked"] as const;
export type ServiceIdentityStatus = (typeof SERVICE_IDENTITY_STATUSES)[number];

export const SERVICE_CREDENTIAL_STATUSES = ["active", "rotated", "revoked", "expired"] as const;
export type ServiceCredentialStatus = (typeof SERVICE_CREDENTIAL_STATUSES)[number];

export interface ServiceIdentity {
  id: string;
  name: string;
  description: string | null;
  ownerUserId: string;
  status: ServiceIdentityStatus;
  defaultAutonomyProfile: string;
  createdByUserId: string;
  createdAt: number;
  updatedAt: number;
  revokedAt: number | null;
}

export interface ServiceCredential {
  id: string;
  serviceIdentityId: string;
  credentialHash: string;
  credentialPrefix: string;
  scopes: readonly ServiceScope[];
  status: ServiceCredentialStatus;
  expiresAt: number | null;
  lastUsedAt: number | null;
  useCount: number;
  lastUsedMetadata: string | null;
  rotatedFromCredentialId: string | null;
  createdByUserId: string;
  createdAt: number;
  revokedAt: number | null;
  revokedByUserId: string | null;
}

export const POLICY_DECISION_EFFECTS = ["allow", "deny", "proposal_required"] as const;
export type PolicyDecisionEffect = (typeof POLICY_DECISION_EFFECTS)[number];

export interface PolicyDecision {
  effect: PolicyDecisionEffect;
  actionType: ActionType;
  autonomyLevel: "automatic" | "gated" | "never";
  requestedScopes: readonly ServiceScope[];
  grantedScopes: readonly ServiceScope[];
  reasonCode: string;
  reason: string;
  autonomyProfile: string;
  policyVersion: string;
  proposalId?: string;
}

// This is the application whitelist. Persisted proposals retain action_type as
// text so future additions require an explicit policy/code change, not a table
// rebuild. Destructive hard-delete is intentionally absent.
export const ACTION_TYPES = [
  "entry.create",
  "entry.append",
  "entry.update",
  "entry.restore",
  "entry.status.set",
  "entry.epistemic-status.set",
  "edge.publish",
  "edge.remove",
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export const ACTION_PROPOSAL_STATUSES = [
  "pending",
  "executing",
  "executed",
  "rejected",
  "failed",
  "stale",
  "expired",
] as const;
export type ActionProposalStatus = (typeof ACTION_PROPOSAL_STATUSES)[number];

export const PROPOSAL_RISK_LEVELS = ["low", "medium", "high", "critical"] as const;
export type ProposalRiskLevel = (typeof PROPOSAL_RISK_LEVELS)[number];

export interface ActionProposal {
  id: string;
  actionType: ActionType;
  proposerKind: ActorKind;
  proposerId: string;
  visibilityScope: string;
  payloadJson: string;
  payloadHash: string | null;
  targetIds: readonly string[];
  expectedPreconditions: string;
  expectedRevision: number | null;
  status: ActionProposalStatus;
  riskLevel: ProposalRiskLevel;
  reason: string;
  evidenceJson: string;
  autonomyProfile: string;
  policyVersion: string;
  idempotencyKey: string;
  expiresAt: number | null;
  reviewerKind: ActorKind | null;
  reviewerId: string | null;
  reviewReason: string | null;
  reviewedAt: number | null;
  executorKind: ActorKind | null;
  executorId: string | null;
  executionStartedAt: number | null;
  executedAt: number | null;
  rejectedAt: number | null;
  failedAt: number | null;
  staleAt: number | null;
  expiredAt: number | null;
  resultJson: string | null;
  resultHash: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ProposalEvent {
  id: string;
  proposalId: string;
  sequence: number;
  eventType: string;
  actorKind: ActorKind;
  actorId: string;
  dataJson: string;
  dataHash: string | null;
  createdAt: number;
}

export const AGENT_EVENT_TYPES = [
  "requested",
  "policy",
  "started",
  "succeeded",
  "failed",
] as const;
export type AgentEventType = (typeof AGENT_EVENT_TYPES)[number];

export interface AgentRunAudit {
  id: string;
  userId: string;
  actorKind: ActorKind;
  actorId: string;
  serviceIdentityId: string | null;
  credentialId: string | null;
  authMethod: string;
  autonomyProfile: string;
  policyVersion: string;
  correlationId: string | null;
  status: string;
  policyDecision: PolicyDecisionEffect | null;
  requestedScopes: readonly ServiceScope[];
  grantedScopes: readonly ServiceScope[];
  decisionReason: string | null;
  proposalId: string | null;
  targetIds: readonly string[];
  redactedRequestSummary: string | null;
  requestHash: string | null;
  redactedResultSummary: string | null;
  resultHash: string | null;
  errorCode: string | null;
  requestedAt: number | null;
  startedAt: number;
  succeededAt: number | null;
  failedAt: number | null;
  completedAt: number | null;
  toolCount: number;
}

export interface AgentEventAudit {
  id: string;
  runId: string;
  sequence: number;
  eventType: AgentEventType;
  toolName: string;
  actorKind: ActorKind;
  actorId: string;
  serviceIdentityId: string | null;
  credentialId: string | null;
  authMethod: string;
  autonomyProfile: string;
  policyVersion: string;
  correlationId: string | null;
  status: string;
  policyDecision: PolicyDecisionEffect | null;
  requestedScopes: readonly ServiceScope[];
  grantedScopes: readonly ServiceScope[];
  decisionReason: string | null;
  proposalId: string | null;
  targetIds: readonly string[];
  redactedInputSummary: string | null;
  inputHash: string | null;
  redactedOutputSummary: string | null;
  outputHash: string | null;
  durationMs: number | null;
  error: string | null;
  errorCode: string | null;
  createdAt: number;
}

export interface SecurityEvent {
  id: string;
  eventType: string;
  actorKind: ActorKind | null;
  actorId: string | null;
  serviceIdentityId: string | null;
  credentialId: string | null;
  authMethod: string | null;
  correlationId: string | null;
  sourceIpHash: string | null;
  userAgentHash: string | null;
  reason: string;
  errorCode: string | null;
  redactedSummary: string | null;
  summaryHash: string | null;
  metadata: string;
  createdAt: number;
}
