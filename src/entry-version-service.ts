/**
 * Canonical versioned writes for the Memory pillar.
 *
 * A mutation has two representations: `rawContent` is the exact input that
 * produced the mutation, while `materializedContent` is the complete state a
 * reader should see after it. Vectorize is staged before D1 with IDs scoped to
 * the immutable episode. D1 then commits the entry projection, provenance,
 * citation rows, and stale-vector cleanup intent as one guarded batch.
 */

import { chunkText, embed } from "./helpers";
import {
  ENTRY_MUTATION_KINDS,
  DOCUMENT_TITLE_ORIGINS,
  type DocumentTitleOrigin,
  type EntryMutationKind,
  type EntryVisibility,
  type Env,
  type EpistemicStatus,
} from "./types";
import { getStatus } from "./tags";
import { isMaintenanceReadOnly } from "./config";
import {
  abandonCaptureAttempt,
  assertCaptureStageIntact,
  beginCaptureStage,
  CAPTURE_STAGE_LEASE_MS,
  CaptureStageLostError,
  captureArtifactGuard,
  captureReceiptInsertStatement,
  captureStageReleaseStatement,
  captureReceiptInserted,
  captureReceiptError,
  loadCommittedCaptureView,
  reloadCommittedReceipt,
  type CaptureReceiptCommitDescriptor,
} from "./capture-receipts";

export type VersionedMutationKind = Exclude<EntryMutationKind, "legacy">;

/** Trusted status-change metadata supplied only by server handlers. */
export interface CommitStatusChangeInput {
  axis: "lifecycle" | "epistemic";
  reason: string | null;
  actor: { kind: "human" | "service" | "system"; id: string };
  reviewer: { kind: "human"; id: string } | null;
  proposalId: string | null;
}

/** The persisted status_change_json envelope. */
export interface EpisodeStatusChange {
  version: 1;
  axis: "lifecycle" | "epistemic";
  from: string | null;
  to: string;
  reason: string | null;
  reason_status: "provided" | "not_provided";
  actor: { kind: "human" | "service" | "system"; id: string };
  reviewer: { kind: "human"; id: string } | null;
  proposal_id: string | null;
  revision: number;
  recorded_at: number;
}

export interface CommitEntryVersionInput {
  kind: VersionedMutationKind;
  actorUserId: string;
  entryId?: string;
  expectedRevision?: number;
  rawContent: string;
  materializedContent: string;
  tags?: string[];
  source?: string;
  sourceUrl?: string | null;
  visibility?: EntryVisibility;
  contentType?: string;
  title?: string;
  titleOrigin?: DocumentTitleOrigin;
  restoredFromSnapshotId?: string;
  forceCreate?: boolean;
  validFrom?: number | null;
  validTo?: number | null;
  epistemicStatus?: EpistemicStatus;
  page?: number | null;
  pageEnd?: number | null;
  /** Primarily useful to make an upstream request idempotency key auditable. */
  mutationId?: string;
  /** Injectable clock for deterministic maintenance jobs and tests. */
  now?: number;
  /**
   * Keyed-capture retry identity. When present the capture is create-only,
   * fenced by a durable stage intent, and records exactly one receipt.
   */
  captureReceipt?: CaptureReceiptCommitDescriptor;
  /**
   * Trusted status-change metadata for an actual axis change. Only the axis,
   * reason, actor, reviewer and proposal id are accepted; from/to/revision and
   * the timestamp are derived here from loaded and proposed state.
   */
  statusChange?: CommitStatusChangeInput;
}

export interface CommitEntryVersionResult {
  entryId: string;
  episodeId: string;
  mutationId: string;
  revision: number;
  currentRevision: number;
  captureOutcome?: "created" | "replayed";
  warnings?: string[];
  created: boolean;
  snapshotId: string | null;
  documentId: string | null;
  sectionIds: string[];
  passageIds: string[];
  vectorIds: string[];
  cleanupQueueId: string | null;
  cleanupPending: boolean;
}

export type EntryVersionErrorCode =
  | "invalid_input"
  | "not_found"
  | "not_owner"
  | "revision_conflict"
  | "vector_stage_failed"
  | "database_commit_failed";

export class EntryVersionError extends Error {
  readonly code: EntryVersionErrorCode;
  readonly cause?: unknown;
  readonly cleanupError?: unknown;

  constructor(
    code: EntryVersionErrorCode,
    message: string,
    options: { cause?: unknown; cleanupError?: unknown } = {},
  ) {
    super(message);
    this.name = "EntryVersionError";
    this.code = code;
    this.cause = options.cause;
    this.cleanupError = options.cleanupError;
  }
}

export class EntryVersionValidationError extends EntryVersionError {
  constructor(message: string) {
    super("invalid_input", message);
    this.name = "EntryVersionValidationError";
  }
}

export class EntryVersionNotFoundError extends EntryVersionError {
  constructor(message = "Entry was not found") {
    super("not_found", message);
    this.name = "EntryVersionNotFoundError";
  }
}

export class EntryVersionOwnershipError extends EntryVersionError {
  constructor() {
    super("not_owner", "The actor does not own this entry");
    this.name = "EntryVersionOwnershipError";
  }
}

export class EntryVersionRevisionConflictError extends EntryVersionError {
  readonly expectedRevision: number;
  readonly actualRevision: number | null;

  constructor(
    expectedRevision: number,
    actualRevision: number | null,
    cleanupError?: unknown,
  ) {
    super(
      "revision_conflict",
      `Entry revision conflict: expected ${expectedRevision}, found ${actualRevision ?? "unknown"}`,
      { cleanupError },
    );
    this.name = "EntryVersionRevisionConflictError";
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

export class EntryVersionVectorStageError extends EntryVersionError {
  constructor(cause: unknown, cleanupError?: unknown) {
    super("vector_stage_failed", "Could not stage entry version vectors", {
      cause,
      cleanupError,
    });
    this.name = "EntryVersionVectorStageError";
  }
}

export class EntryVersionCommitError extends EntryVersionError {
  constructor(cause: unknown, cleanupError?: unknown) {
    super("database_commit_failed", "Could not commit the entry version", {
      cause,
      cleanupError,
    });
    this.name = "EntryVersionCommitError";
  }
}

interface CurrentEntryRow {
  id: string;
  content: string;
  tags: string;
  source: string;
  created_at: number;
  vector_ids: string;
  owner_user_id: string;
  valid_from: number | null;
  valid_to: number | null;
  recorded_at: number | null;
  epistemic_status: EpistemicStatus;
  current_episode_id: string | null;
  revision: number;
  visibility: EntryVisibility;
  current_content_type: string | null;
  current_source_url: string | null;
  current_materialized_content: string | null;
  current_document_title: string | null;
  current_document_title_origin: DocumentTitleOrigin | null;
  current_page: number | null;
  current_page_end: number | null;
}

interface RestoreSnapshotRow {
  id: string;
  entry_id: string;
  episode_id: string | null;
  owner_user_id: string;
}

export interface OwnedRestoreSnapshot {
  id: string;
  entry_id: string;
  episode_id: string | null;
  content: string;
  tags: string;
  source: string;
  created_at: number;
  valid_from: number | null;
  valid_to: number | null;
  epistemic_status: EpistemicStatus | null;
  source_title: string | null;
  source_title_origin: DocumentTitleOrigin | null;
  source_url: string | null;
  content_type: string | null;
}

interface Header {
  level: number;
  title: string;
  offset: number;
}

export interface PlannedSection extends Header {
  id: string;
  parentId: string | null;
  orderIndex: number;
  endOffset: number;
}

export interface PlannedPassage {
  id: string;
  content: string;
  section: string | null;
  sectionId: string | null;
  startOffset: number;
  endOffset: number;
  vectorId: string;
}

interface PlannedVector {
  id: string;
  values: number[];
  metadata: Record<string, string | number | boolean | string[]>;
}

const PASSAGE_CHUNK_CHARS = 1500;
const PASSAGE_OVERLAP_CHARS = 400;
const VERSIONED_MUTATION_KINDS = new Set<EntryMutationKind>(
  ENTRY_MUTATION_KINDS.filter((kind) => kind !== "legacy"),
);
const CONTENT_REPLACING_MUTATION_KINDS = new Set<VersionedMutationKind>([
  "capture",
  "update",
  "merge",
  "replace",
  "restore",
]);

function uuid(): string {
  return crypto.randomUUID();
}

function parseJsonArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function findHeaders(content: string): Header[] {
  const headers: Header[] = [];
  const pattern = /^(#{1,4})\s+(.+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    headers.push({
      level: match[1].length,
      title: match[2].trim(),
      offset: match.index,
    });
  }
  return headers;
}

function deriveDocumentTitle(content: string, sourceUrl: string | null): string {
  return findHeaders(content)[0]?.title
    || sourceUrl
    || "Untitled Document";
}

function planSections(headers: Header[], contentLength: number): PlannedSection[] {
  const planned: PlannedSection[] = [];
  for (let index = 0; index < headers.length; index++) {
    let parentId: string | null = null;
    for (let prior = index - 1; prior >= 0; prior--) {
      if (headers[prior].level < headers[index].level) {
        parentId = planned[prior].id;
        break;
      }
    }
    planned.push({
      ...headers[index],
      id: uuid(),
      parentId,
      orderIndex: index,
      endOffset: headers[index + 1]?.offset ?? contentLength,
    });
  }
  return planned;
}

function addPassageChunks(
  result: PlannedPassage[],
  content: string,
  episodeId: string,
  start: number,
  end: number,
  section: string | null,
  sectionId: string | null,
): void {
  if (end <= start) return;
  for (let offset = start; offset < end; offset += PASSAGE_CHUNK_CHARS - PASSAGE_OVERLAP_CHARS) {
    const chunkEnd = Math.min(offset + PASSAGE_CHUNK_CHARS, end);
    const id = uuid();
    result.push({
      id,
      content: content.slice(offset, chunkEnd),
      section,
      sectionId,
      startOffset: offset,
      endOffset: chunkEnd,
      vectorId: `pv:${id}`,
    });
    if (chunkEnd >= end) break;
  }
}

function planPassages(
  content: string,
  episodeId: string,
  sections: PlannedSection[],
): PlannedPassage[] {
  const passages: PlannedPassage[] = [];
  if (sections.length === 0) {
    addPassageChunks(passages, content, episodeId, 0, content.length, null, null);
    return passages;
  }

  if (sections[0].offset > 0) {
    addPassageChunks(passages, content, episodeId, 0, sections[0].offset, null, null);
  }
  for (const section of sections) {
    addPassageChunks(
      passages,
      content,
      episodeId,
      section.offset,
      section.endOffset,
      section.title,
      section.id,
    );
  }
  return passages;
}

export function planVersionPassages(
  content: string,
  episodeId: string,
): { sections: PlannedSection[]; passages: PlannedPassage[] } {
  const sections = planSections(findHeaders(content), content.length);
  return { sections, passages: planPassages(content, episodeId, sections) };
}

function isDocumentVersion(
  contentType: string,
  sourceUrl: string | null,
  sections: PlannedSection[],
): boolean {
  return contentType.toLowerCase() === "research" || sourceUrl !== null || sections.length > 0;
}

function sqlChangeCount(result: D1Result<unknown> | undefined): number {
  return Number(result?.meta?.changes ?? 0);
}

async function cleanupStagedVectors(env: Env, vectorIds: string[]): Promise<unknown | undefined> {
  if (vectorIds.length === 0) return undefined;
  try {
    await env.VECTORIZE.deleteByIds(vectorIds);
    return undefined;
  } catch (error) {
    return error;
  }
}

export interface StageVersionVectorsInput {
  entryId: string;
  episodeId: string;
  mutationId: string;
  content: string;
  tags: string[];
  source: string;
  ownerUserId: string;
  visibility: EntryVisibility;
  now: number;
  passages: PlannedPassage[];
  cleanupOnFailure?: boolean;
  /**
   * Durable capture-stage intent that must still be intact before and after the
   * remote upsert. A lost fence never commits and never leaves orphan vectors.
   */
  fenceAttemptId?: string;
}

/**
 * Every vector id this version will write. Computed separately from the upsert
 * so the durable stage intent can record the planned ids before any remote
 * write happens.
 */
export function planVersionVectorIds(
  episodeId: string,
  content: string,
  passages: PlannedPassage[],
): { entryVectorIds: string[]; allVectorIds: string[] } {
  const entryChunks = chunkText(content);
  // Vectorize IDs are capped at 64 bytes. The immutable episode UUID is enough
  // to namespace every projection chunk without including the mutable entry ID.
  const entryVectorIds = entryChunks.map((_, index) => `ev:${episodeId}:${index}`);
  return {
    entryVectorIds,
    allVectorIds: [...entryVectorIds, ...passages.map((passage) => passage.vectorId)],
  };
}

export async function stageVersionVectors(
  env: Env,
  details: StageVersionVectorsInput,
): Promise<{ entryVectorIds: string[]; allVectorIds: string[] }> {
  const entryChunks = chunkText(details.content);
  const { entryVectorIds, allVectorIds } = planVersionVectorIds(
    details.episodeId,
    details.content,
    details.passages,
  );
  let writeAttempted = false;

  const assertFence = async (): Promise<void> => {
    if (!details.fenceAttemptId) return;
    await assertCaptureStageIntact(env, details.fenceAttemptId);
  };
  const cleanup = async (): Promise<unknown | undefined> =>
    details.cleanupOnFailure === false ? undefined : await cleanupStagedVectors(env, allVectorIds);

  try {
    const isPrivate = details.visibility === "private";
    const entryVectors = await Promise.all(entryChunks.map(async (chunk, index): Promise<PlannedVector> => {
      const metadata: PlannedVector["metadata"] = {
        content: chunk,
        parentId: details.entryId,
        episodeId: details.episodeId,
        mutationId: details.mutationId,
        chunkIndex: index,
        totalChunks: entryChunks.length,
        // Quoted and dotted tags are valid values, but invalid metadata keys.
        tags: details.tags,
        source: details.source,
        created_at: details.now,
        owner_user_id: details.ownerUserId,
        is_private: isPrivate,
      };
      return {
        id: entryVectorIds[index],
        values: await embed(chunk, env),
        metadata,
      };
    }));

    const passageVectors = await Promise.all(details.passages.map(async (passage): Promise<PlannedVector> => ({
      id: passage.vectorId,
      values: await embed(passage.content, env),
      metadata: {
        content: passage.content,
        parentId: details.entryId,
        passageId: passage.id,
        episodeId: details.episodeId,
        mutationId: details.mutationId,
        section: passage.section ?? "",
        source: "passage",
        owner_user_id: details.ownerUserId,
        is_private: isPrivate,
      },
    })));

    await assertFence();
    writeAttempted = true;
    await env.VECTORIZE.upsert([...entryVectors, ...passageVectors]);
    // A fence lost while the upsert was in flight must not commit. This
    // attempt's vector ids are episode-scoped, so no winner can share them and
    // removing them is always safe.
    await assertFence();
    return { entryVectorIds, allVectorIds };
  } catch (cause) {
    const cleanupError = writeAttempted ? await cleanup() : undefined;
    if (cause instanceof CaptureStageLostError) {
      throw new EntryVersionVectorStageError(cause, cleanupError);
    }
    throw new EntryVersionVectorStageError(cause, cleanupError);
  }
}

async function loadCurrentEntry(env: Env, entryId: string): Promise<CurrentEntryRow | null> {
  return env.DB.prepare(
    `SELECT e.id, e.content, e.tags, e.source, e.created_at, e.vector_ids,
       e.owner_user_id, e.valid_from, e.valid_to, e.recorded_at,
       e.epistemic_status, e.current_episode_id, e.revision,
       e.visibility,
       ep.content_type AS current_content_type,
       ep.source_url AS current_source_url,
       ep.materialized_content AS current_materialized_content,
       (
         SELECT d.title FROM documents d
         WHERE d.episode_id = e.current_episode_id
         ORDER BY d.created_at DESC, d.id ASC LIMIT 1
       ) AS current_document_title,
       (
         SELECT d.title_origin FROM documents d
         WHERE d.episode_id = e.current_episode_id
         ORDER BY d.created_at DESC, d.id ASC LIMIT 1
       ) AS current_document_title_origin,
       (
         SELECT p.page FROM passages p
         WHERE p.episode_id = e.current_episode_id AND p.page IS NOT NULL
         ORDER BY p.start_offset ASC, p.id ASC LIMIT 1
       ) AS current_page,
       (
         SELECT p.page_end FROM passages p
         WHERE p.episode_id = e.current_episode_id AND p.page_end IS NOT NULL
         ORDER BY p.start_offset ASC, p.id ASC LIMIT 1
       ) AS current_page_end
     FROM entries e
     LEFT JOIN episodes ep ON ep.id = e.current_episode_id
     WHERE e.id = ?`,
  ).bind(entryId).first<CurrentEntryRow>();
}

/**
 * Load one historical state and its immutable source envelope without allowing
 * a caller to infer whether another owner's entry or snapshot exists.
 */
export async function loadOwnedRestoreSnapshot(
  env: Env,
  ownerUserId: string,
  entryId: string,
  snapshotId?: string,
): Promise<OwnedRestoreSnapshot | null> {
  const requestedSnapshotId = snapshotId ?? null;
  const snapshot = await env.DB.prepare(
    `SELECT s.id, s.entry_id, s.episode_id, s.content, s.tags, s.source,
            s.created_at, s.valid_from, s.valid_to, s.epistemic_status,
            d.title AS source_title,
            d.title_origin AS source_title_origin,
            COALESCE(d.source_url, ep.source_url) AS source_url,
            COALESCE(d.content_type, ep.content_type) AS content_type
     FROM entry_snapshots s
     JOIN entries parent
       ON parent.id = s.entry_id AND parent.owner_user_id = ?
     LEFT JOIN episodes ep
       ON ep.id = s.episode_id
      AND ep.entry_id = s.entry_id
      AND ep.owner_user_id = parent.owner_user_id
     LEFT JOIN documents d
       ON d.episode_id = ep.id
      AND (d.owner_user_id = parent.owner_user_id OR d.owner_user_id = '')
     WHERE s.entry_id = ? AND (? IS NULL OR s.id = ?)
     ORDER BY s.created_at DESC, s.id DESC LIMIT 1`,
  ).bind(ownerUserId, entryId, requestedSnapshotId, requestedSnapshotId)
    .first<OwnedRestoreSnapshot>();
  if (snapshot && !snapshot.source_title?.trim()) {
    return {
      ...snapshot,
      source_title: null,
      source_title_origin: null,
    };
  }
  return snapshot;
}

async function loadRestoreSnapshot(
  env: Env,
  snapshotId: string,
): Promise<RestoreSnapshotRow | null> {
  return env.DB.prepare(
    `SELECT s.id, s.entry_id, s.episode_id, e.owner_user_id
     FROM entry_snapshots s
     JOIN entries e ON e.id = s.entry_id
     WHERE s.id = ?`,
  ).bind(snapshotId).first<RestoreSnapshotRow>();
}

function validateInput(input: CommitEntryVersionInput): void {
  if (!VERSIONED_MUTATION_KINDS.has(input.kind)) {
    throw new EntryVersionValidationError(`Unsupported mutation kind: ${String(input.kind)}`);
  }
  if (!input.actorUserId) throw new EntryVersionValidationError("actorUserId is required");
  if (input.titleOrigin !== undefined
      && !(DOCUMENT_TITLE_ORIGINS as readonly string[]).includes(input.titleOrigin)) {
    throw new EntryVersionValidationError("titleOrigin must be explicit or generated");
  }
  if (input.titleOrigin !== undefined && !input.title?.trim()) {
    throw new EntryVersionValidationError("titleOrigin requires a title");
  }
  if (typeof input.rawContent !== "string") {
    throw new EntryVersionValidationError("rawContent must be a string");
  }
  if (typeof input.materializedContent !== "string") {
    throw new EntryVersionValidationError("materializedContent must be a string");
  }
  if (input.materializedContent.length === 0) {
    throw new EntryVersionValidationError("materializedContent cannot be empty");
  }
  if (input.expectedRevision !== undefined && (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0)) {
    throw new EntryVersionValidationError("expectedRevision must be a non-negative integer");
  }
  if (input.kind === "restore") {
    if (!input.forceCreate) {
      throw new EntryVersionValidationError("restore must force-create a new entry");
    }
    if (!input.restoredFromSnapshotId) {
      throw new EntryVersionValidationError("restore requires restoredFromSnapshotId");
    }
  } else if (input.forceCreate) {
    throw new EntryVersionValidationError("forceCreate is reserved for restore");
  }
  if (input.kind !== "capture" && input.kind !== "restore" && !input.entryId) {
    throw new EntryVersionValidationError(`${input.kind} requires entryId`);
  }
}

/**
 * After a failed capture batch, decide whether a concurrent same-key attempt won.
 * Only the losing attempt's own unreferenced vectors and intent are cleaned; a
 * winner's committed artifacts are never touched.
 */
async function recoverLostCaptureRace(
  env: Env,
  descriptor: CaptureReceiptCommitDescriptor,
  ownerUserId: string,
  stagedVectorIds: readonly string[],
  attempted: CommitEntryVersionResult,
): Promise<CommitEntryVersionResult | null> {
  let lookup: Awaited<ReturnType<typeof reloadCommittedReceipt>>;
  try {
    lookup = await reloadCommittedReceipt(env, descriptor, ownerUserId);
  } catch (cause) {
    // A failed lookup cannot prove that this attempt rolled back. Its durable
    // intent, if still present, owns reconciliation once authority is readable.
    throw new EntryVersionCommitError(cause);
  }
  if (lookup.status === "unavailable") throw captureReceiptError(lookup)!;
  if (lookup.status !== "replayed") {
    await abandonCaptureAttempt(env, descriptor, stagedVectorIds);
    const error = captureReceiptError(lookup);
    if (error) throw error;
    return null;
  }

  if (lookup.descriptor.entryId === attempted.entryId) {
    if (lookup.descriptor.episodeId !== attempted.episodeId
        || lookup.descriptor.mutationId !== attempted.mutationId) {
      throw new EntryVersionCommitError(new Error("Capture receipt does not match the attempted episode"));
    }
    // This attempt committed before the response was lost. Its planned
    // artifacts are now authoritative and must never enter losing cleanup.
    return { ...attempted, currentRevision: lookup.descriptor.currentRevision };
  }

  await abandonCaptureAttempt(env, descriptor, stagedVectorIds);
  let view: Awaited<ReturnType<typeof loadCommittedCaptureView>> = null;
  try {
    view = await loadCommittedCaptureView(env, lookup.descriptor);
  } catch {
    // The receipt still proves success even if optional metadata cannot load.
  }
  return {
    entryId: lookup.descriptor.entryId,
    episodeId: lookup.descriptor.episodeId ?? "",
    mutationId: lookup.descriptor.mutationId ?? "",
    revision: lookup.descriptor.revision ?? lookup.descriptor.currentRevision,
    currentRevision: view?.currentRevision ?? lookup.descriptor.currentRevision,
    captureOutcome: "replayed",
    warnings: view ? [] : ["metadata_unavailable: the committed capture metadata is temporarily unavailable"],
    created: true,
    snapshotId: null,
    documentId: view?.documentId ?? null,
    sectionIds: view?.sectionIds ?? [],
    passageIds: view?.passageIds ?? [],
    vectorIds: view?.vectorIds ?? [],
    cleanupQueueId: null,
    cleanupPending: false,
  };
}

/**
 * Commit one immutable version and project it into the mutable entry row.
 *
 * Provenance and citations are synchronous by design. Callers may schedule
 * classification or graph inference after this promise resolves, but must not
 * move any operation in this function behind waitUntil().
 */
export async function commitEntryVersion(
  input: CommitEntryVersionInput,
  env: Env,
): Promise<CommitEntryVersionResult> {
  validateInput(input);

  // Second guard for background and internal callers: the request-level gate in
  // routes.ts and the MCP tool gate cannot cover a scheduled job, so the deepest
  // shared write refuses on its own while maintenance is read-only.
  if (isMaintenanceReadOnly(env)) {
    throw new EntryVersionValidationError(
      "Writes are disabled: Shared Living Memory is in read-only maintenance",
    );
  }

  const now = input.now ?? Date.now();
  const mutationId = input.mutationId ?? uuid();
  const forceCreateRestore = input.kind === "restore" && input.forceCreate === true;
  const targetEntryId = forceCreateRestore ? uuid() : (input.entryId ?? uuid());
  let restoreSnapshot: RestoreSnapshotRow | null = null;

  if (forceCreateRestore) {
    restoreSnapshot = await loadRestoreSnapshot(env, input.restoredFromSnapshotId!);
    if (!restoreSnapshot) throw new EntryVersionNotFoundError("Restore snapshot was not found");
    if (restoreSnapshot.owner_user_id !== input.actorUserId) {
      throw new EntryVersionOwnershipError();
    }
  }

  const current = forceCreateRestore ? null : await loadCurrentEntry(env, targetEntryId);
  let created = current === null;

  if (input.kind === "capture") {
    if (current) {
      throw new EntryVersionRevisionConflictError(input.expectedRevision ?? 0, current.revision);
    }
    created = true;
  } else if (!forceCreateRestore) {
    if (!current) throw new EntryVersionNotFoundError();
    if (current.owner_user_id !== input.actorUserId) throw new EntryVersionOwnershipError();
  }

  if (current && input.expectedRevision !== undefined && input.expectedRevision !== current.revision) {
    throw new EntryVersionRevisionConflictError(input.expectedRevision, current.revision);
  }

  const guardedRevision = current?.revision ?? 0;
  const newRevision = current ? guardedRevision + 1 : 1;
  const episodeId = uuid();
  const baselineEpisodeId = current && !current.current_episode_id ? uuid() : null;
  const baselineDocumentId = baselineEpisodeId ? uuid() : null;
  const parentEpisodeId = forceCreateRestore
    ? restoreSnapshot?.episode_id ?? null
    : current?.current_episode_id ?? baselineEpisodeId;
  const snapshotId = current ? uuid() : null;
  const source = input.source ?? current?.source ?? "api";
  const tags = input.tags ?? parseJsonArray(current?.tags);
  const sourceUrl = input.sourceUrl === undefined
    ? (current?.current_source_url ?? null)
    : input.sourceUrl;
  const contentType = input.contentType
    ?? current?.current_content_type
    ?? (sourceUrl ? "research" : "text");
  // Existing versions retain visibility. New captures are private unless the
  // caller explicitly publishes them.
  const visibility: EntryVisibility = current?.visibility
    ?? input.visibility
    ?? "private";
  const validFrom = input.validFrom === undefined
    ? (current?.valid_from ?? now)
    : input.validFrom;
  const validTo = input.validTo === undefined
    ? (current?.valid_to ?? null)
    : input.validTo;
  const epistemicStatus = input.epistemicStatus ?? current?.epistemic_status ?? "canonical";
  const episodeContentHash = await sha256Hex(input.rawContent);
  const documentContentHash = await sha256Hex(input.materializedContent);
  const baselineHash = baselineEpisodeId ? await sha256Hex(current!.content) : null;
  const { sections, passages: plannedPassages } = planVersionPassages(
    input.materializedContent,
    episodeId,
  );
  // Every immutable episode has exactly one document envelope. Conversational
  // notes may have no passage/section children, but the 1:1 envelope keeps
  // provenance and future enrichment unambiguous.
  const hasPassageEvidence = isDocumentVersion(contentType, sourceUrl, sections);
  const documentId = uuid();
  // Conversational notes cite their immutable episode. Passage-level evidence
  // is reserved for document-like material where offsets and hierarchy add
  // information beyond the episode itself.
  const passages = hasPassageEvidence ? plannedPassages : [];
  const page = input.page === undefined
    ? (current?.current_page ?? null)
    : input.page;
  const pageEnd = input.pageEnd === undefined
    ? (current?.current_page_end ?? page)
    : input.pageEnd;
  const incomingTitle = input.title?.trim() || null;
  const inheritedTitle = current
    && (!CONTENT_REPLACING_MUTATION_KINDS.has(input.kind)
      || current.current_document_title_origin === "explicit")
    ? current.current_document_title
    : null;
  const title = incomingTitle
    || inheritedTitle
    || deriveDocumentTitle(input.materializedContent, sourceUrl);
  const titleOrigin: DocumentTitleOrigin = incomingTitle
    ? (input.titleOrigin ?? "explicit")
    : inheritedTitle
      ? (current?.current_document_title_origin ?? "generated")
      : "generated";

  // ── Trusted status-change metadata ─────────────────────────────────────────
  // from/to, revision and the timestamp are derived here from loaded and
  // proposed state. A caller can never submit arbitrary actor or reviewer data.
  let statusChangeJson: string | null = null;
  if (input.statusChange) {
    const axis = input.statusChange.axis;
    let from: string | null;
    let to: string | null;
    if (axis === "epistemic") {
      from = current?.epistemic_status ?? null;
      to = epistemicStatus;
    } else {
      from = current ? getStatus(parseJsonArray(current.tags)) : null;
      to = getStatus(tags);
    }

    if (axis === "epistemic" && from === to) {
      throw new EntryVersionValidationError(
        `Epistemic self-transition ${String(to)} is not a valid status change`,
      );
    }
    if (axis === "lifecycle" && to === null) {
      throw new EntryVersionValidationError(
        "A lifecycle status change requires a lifecycle status tag",
      );
    }
    if (to !== null) {
      const payload: EpisodeStatusChange = {
        version: 1,
        axis,
        from,
        to,
        reason: input.statusChange.reason,
        reason_status: input.statusChange.reason === null ? "not_provided" : "provided",
        actor: input.statusChange.actor,
        reviewer: input.statusChange.reviewer,
        proposal_id: input.statusChange.proposalId,
        revision: newRevision,
        recorded_at: now,
      };
      statusChangeJson = JSON.stringify(payload);
    }
  }

  const captureReceipt = input.captureReceipt;
  if (captureReceipt) {
    if (input.kind !== "capture") {
      throw new EntryVersionValidationError(
        "A capture receipt may only be recorded by a capture mutation",
      );
    }
    if (!captureReceipt.attemptId || !captureReceipt.keyHash || !captureReceipt.requestHash) {
      throw new EntryVersionValidationError("Capture receipt metadata is incomplete");
    }
  }

  // Historical passage vectors are immutable episode evidence used by knownAt
  // recall. Only the mutable entry projection vectors become stale here.
  const oldVectorIds = current
    ? [...new Set(parseJsonArray(current.vector_ids))]
    : [];

  // A keyed capture records its durable stage intent before the first remote
  // upsert. If that insert fails, no vector write happens at all.
  if (captureReceipt) {
    const planned = planVersionVectorIds(episodeId, input.materializedContent, passages);
    await beginCaptureStage(env, {
      attemptId: captureReceipt.attemptId,
      entryId: targetEntryId,
      episodeId,
      vectorIds: planned.allVectorIds,
      reason: `capture-stage:${captureReceipt.attemptId}:${targetEntryId}`,
      leaseMs: CAPTURE_STAGE_LEASE_MS,
    });
  }

  const staged = await stageVersionVectors(env, {
    entryId: targetEntryId,
    episodeId,
    mutationId,
    content: input.materializedContent,
    tags,
    source,
    ownerUserId: input.actorUserId,
    visibility,
    now,
    passages,
    fenceAttemptId: captureReceipt?.attemptId,
  });

  if (captureReceipt) {
    // Fast fail before building the batch; the batch still re-checks the fence.
    await assertCaptureStageIntact(env, captureReceipt.attemptId);
  }

  const artifactGuard = captureReceipt
    ? captureArtifactGuard(captureReceipt, { entryId: targetEntryId, episodeId })
    : "";
  const artifactGuardSuffix = captureReceipt
    ? ` WHERE ${artifactGuard}`
    : "";
  const artifactGuardAnd = captureReceipt
    ? ` AND ${artifactGuard}`
    : "";

  const statements: D1PreparedStatement[] = [];
  let guardedUpdateIndex: number | null = null;
  let receiptInsertIndex: number | null = null;
  const cleanupQueueId = oldVectorIds.length > 0 ? uuid() : null;

  if (captureReceipt) {
    // Statement 0: the receipt is the authority every later insert is guarded
    // on. A lost fence inserts nothing here and therefore inserts nothing at all.
    receiptInsertIndex = 0;
    statements.push(captureReceiptInsertStatement(env, captureReceipt, {
      entryId: targetEntryId,
      episodeId,
      mutationId,
      revision: newRevision,
    }));
  }

  if (!current) {
    statements.push(env.DB.prepare(
      `INSERT INTO entries (
         id, content, tags, source, created_at, vector_ids, owner_user_id,
         valid_from, valid_to, recorded_at, epistemic_status,
         current_episode_id, revision, created_by_user_id, visibility,
         vector_sync_pending, updated_at
       ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?${artifactGuardSuffix}`,
    ).bind(
      targetEntryId,
      input.materializedContent,
      JSON.stringify(tags),
      source,
      now,
      JSON.stringify(staged.entryVectorIds),
      input.actorUserId,
      validFrom,
      validTo,
      now,
      epistemicStatus,
      episodeId,
      newRevision,
      input.actorUserId,
      visibility,
      now,
    ));
    statements.push(env.DB.prepare(
      `INSERT INTO episodes (
         id, entry_id, content, content_type, source, created_at,
         materialized_content, content_hash, mutation_id, mutation_kind,
         parent_episode_id, restored_from_snapshot_id, owner_user_id, source_url,
         status_change_json
       ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?${artifactGuardSuffix}`,
    ).bind(
      episodeId,
      targetEntryId,
      input.rawContent,
      contentType,
      source,
      now,
      input.materializedContent,
      episodeContentHash,
      mutationId,
      input.kind,
      parentEpisodeId,
      input.restoredFromSnapshotId ?? null,
      input.actorUserId,
      sourceUrl,
      statusChangeJson,
    ));
  } else {
    const guard = [targetEntryId, input.actorUserId, guardedRevision] as const;
    if (baselineEpisodeId) {
      statements.push(env.DB.prepare(
        `INSERT INTO episodes (
           id, entry_id, content, content_type, source, created_at,
           materialized_content, content_hash, mutation_id, mutation_kind,
           parent_episode_id, restored_from_snapshot_id, owner_user_id, source_url
         )
         SELECT ?, id, content, 'text', source,
                COALESCE(recorded_at, created_at), content, ?, ?, 'legacy',
                NULL, NULL, owner_user_id, NULL
         FROM entries
         WHERE id = ? AND owner_user_id = ? AND revision = ?
           AND current_episode_id IS NULL`,
      ).bind(
        baselineEpisodeId,
        baselineHash,
        `${mutationId}:baseline`,
        ...guard,
      ));
      statements.push(env.DB.prepare(
        `INSERT INTO documents (
           id, title, source_url, content_type, created_at, episode_id,
           owner_user_id, content_hash, version, title_origin
         )
         SELECT ?, COALESCE(NULLIF(?, ''), 'Untitled Memory'), ?, ?,
                COALESCE(recorded_at, created_at), ?, owner_user_id, ?, ?, 'generated'
         FROM entries
         WHERE id = ? AND owner_user_id = ? AND revision = ?
           AND current_episode_id IS NULL`,
      ).bind(
        baselineDocumentId,
        current!.current_document_title ?? current!.current_source_url ?? "Untitled Memory",
        current!.current_source_url,
        current!.current_content_type ?? "text",
        baselineEpisodeId,
        baselineHash,
        String(guardedRevision),
        ...guard,
      ));
    }

    statements.push(env.DB.prepare(
      `INSERT INTO entry_snapshots (
         id, entry_id, content, tags, source, created_at, episode_id,
         mutation_id, mutation_kind, recorded_at, valid_from, valid_to,
         epistemic_status, revision, visibility
       )
       SELECT ?, id, content, tags, source, ?, COALESCE(current_episode_id, ?),
              ?, ?, recorded_at, valid_from, valid_to, epistemic_status,
              revision, visibility
       FROM entries
       WHERE id = ? AND owner_user_id = ? AND revision = ?`,
    ).bind(
      snapshotId,
      now,
      baselineEpisodeId,
      mutationId,
      input.kind,
      ...guard,
    ));

    statements.push(env.DB.prepare(
      `INSERT INTO episodes (
         id, entry_id, content, content_type, source, created_at,
         materialized_content, content_hash, mutation_id, mutation_kind,
         parent_episode_id, restored_from_snapshot_id, owner_user_id, source_url,
         status_change_json
       )
       SELECT ?, id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, owner_user_id, ?, ?
       FROM entries
       WHERE id = ? AND owner_user_id = ? AND revision = ?${artifactGuardAnd}`,
    ).bind(
      episodeId,
      input.rawContent,
      contentType,
      source,
      now,
      input.materializedContent,
      episodeContentHash,
      mutationId,
      input.kind,
      parentEpisodeId,
      input.restoredFromSnapshotId ?? null,
      sourceUrl,
      statusChangeJson,
      ...guard,
    ));
  }

  if (documentId) {
    const documentBindings = [
      documentId,
      title,
      sourceUrl,
      contentType,
      now,
      episodeId,
      input.actorUserId,
      documentContentHash,
      String(newRevision),
      titleOrigin,
    ] as const;
    if (current) {
      statements.push(env.DB.prepare(
        `INSERT INTO documents (
           id, title, source_url, content_type, created_at, episode_id,
           owner_user_id, content_hash, version, title_origin
         )
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM entries
         WHERE id = ? AND owner_user_id = ? AND revision = ?`,
      ).bind(...documentBindings, targetEntryId, input.actorUserId, guardedRevision));
    } else {
      statements.push(env.DB.prepare(
        `INSERT INTO documents (
           id, title, source_url, content_type, created_at, episode_id,
           owner_user_id, content_hash, version, title_origin
         ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?${artifactGuardSuffix}`,
      ).bind(...documentBindings));
    }

    for (const section of sections) {
      const sectionBindings = [
        section.id,
        documentId,
        section.parentId,
        section.title,
        section.level,
        section.orderIndex,
        now,
        page,
        pageEnd,
        section.offset,
        section.endOffset,
      ] as const;
      if (current) {
        statements.push(env.DB.prepare(
          `INSERT INTO document_sections (
             id, document_id, parent_section_id, title, level, order_index,
             created_at, page_start, page_end, start_offset, end_offset
           )
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM entries
           WHERE id = ? AND owner_user_id = ? AND revision = ?`,
        ).bind(...sectionBindings, targetEntryId, input.actorUserId, guardedRevision));
      } else {
        statements.push(env.DB.prepare(
          `INSERT INTO document_sections (
             id, document_id, parent_section_id, title, level, order_index,
             created_at, page_start, page_end, start_offset, end_offset
           ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?${artifactGuardSuffix}`,
        ).bind(...sectionBindings));
      }
    }
  }

  for (const passage of passages) {
    const passageBindings = [
      passage.id,
      targetEntryId,
      episodeId,
      documentId,
      passage.sectionId,
      passage.content,
      passage.section,
      page,
      pageEnd,
      passage.startOffset,
      passage.endOffset,
      JSON.stringify([passage.vectorId]),
      now,
    ] as const;
    if (current) {
      statements.push(env.DB.prepare(
        `INSERT INTO passages (
           id, entry_id, episode_id, document_id, section_id, content,
           section, page, page_end, start_offset, end_offset, vector_ids, created_at
         )
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM entries
         WHERE id = ? AND owner_user_id = ? AND revision = ?`,
      ).bind(...passageBindings, targetEntryId, input.actorUserId, guardedRevision));
    } else {
      statements.push(env.DB.prepare(
        `INSERT INTO passages (
           id, entry_id, episode_id, document_id, section_id, content,
           section, page, page_end, start_offset, end_offset, vector_ids, created_at
         ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?${artifactGuardSuffix}`,
      ).bind(...passageBindings));
    }
  }

  if (current && cleanupQueueId) {
    statements.push(env.DB.prepare(
      `INSERT INTO vector_cleanup_queue (
         id, vector_ids, reason, attempts, last_error, created_at, updated_at
       )
       SELECT ?, ?, ?, 0, NULL, ?, ? FROM entries
       WHERE id = ? AND owner_user_id = ? AND revision = ?`,
    ).bind(
      cleanupQueueId,
      JSON.stringify(oldVectorIds),
      `entry-version:${targetEntryId}:${mutationId}`,
      now,
      now,
      targetEntryId,
      input.actorUserId,
      guardedRevision,
    ));
  }

  if (current) {
    guardedUpdateIndex = statements.length;
    statements.push(env.DB.prepare(
      `UPDATE entries
       SET content = ?, tags = ?, source = ?, vector_ids = ?,
           valid_from = ?, valid_to = ?, recorded_at = ?,
           epistemic_status = ?, current_episode_id = ?, revision = revision + 1,
           updated_at = ?, vector_sync_pending = 0
       WHERE id = ? AND owner_user_id = ? AND revision = ?`,
    ).bind(
      input.materializedContent,
      JSON.stringify(tags),
      source,
      JSON.stringify(staged.entryVectorIds),
      validFrom,
      validTo,
      now,
      epistemicStatus,
      episodeId,
      now,
      targetEntryId,
      input.actorUserId,
      guardedRevision,
    ));
  }

  // The stage intent is released in the same batch that records the receipt, so
  // a committed capture can never leave a live intent behind and an abandoned
  // attempt can never remove its own fence.
  if (captureReceipt) {
    statements.push(captureStageReleaseStatement(env, captureReceipt.attemptId));
  }

  const committedResult: CommitEntryVersionResult = {
    entryId: targetEntryId,
    episodeId,
    mutationId,
    revision: newRevision,
    currentRevision: newRevision,
    ...(captureReceipt ? { captureOutcome: "created" as const } : {}),
    created,
    snapshotId,
    documentId,
    sectionIds: sections.map(section => section.id),
    passageIds: passages.map(passage => passage.id),
    vectorIds: staged.entryVectorIds,
    cleanupQueueId,
    cleanupPending: false,
  };
  let results: D1Result<unknown>[];
  try {
    results = await env.DB.batch(statements);
  } catch (cause) {
    if (captureReceipt) {
      // A concurrent same-key attempt may have won the receipt race. The loser
      // reports the winner's committed capture and cleans only its own work.
      const winner = await recoverLostCaptureRace(
        env, captureReceipt, input.actorUserId, staged.allVectorIds, committedResult,
      );
      if (winner) return winner;
      throw new EntryVersionCommitError(cause);
    }
    const cleanupError = await cleanupStagedVectors(env, staged.allVectorIds);
    throw new EntryVersionCommitError(cause, cleanupError);
  }

  if (receiptInsertIndex !== null && !captureReceiptInserted(results)) {
    // The fence was claimed or expired between staging and commit. Nothing was
    // written; this attempt's own vectors are unreferenced and are removed.
    await abandonCaptureAttempt(env, captureReceipt!, staged.allVectorIds);
    throw new EntryVersionCommitError(new CaptureStageLostError(captureReceipt!.attemptId));
  }

  if (guardedUpdateIndex !== null && sqlChangeCount(results[guardedUpdateIndex]) !== 1) {
    const cleanupError = await cleanupStagedVectors(env, staged.allVectorIds);
    const latest = await loadCurrentEntry(env, targetEntryId);
    throw new EntryVersionRevisionConflictError(
      guardedRevision,
      latest?.revision ?? null,
      cleanupError,
    );
  }

  let cleanupPending = false;
  if (cleanupQueueId) {
    try {
      await env.VECTORIZE.deleteByIds(oldVectorIds);
      await env.DB.prepare(
        `DELETE FROM vector_cleanup_queue WHERE id = ?`,
      ).bind(cleanupQueueId).run();
    } catch (error) {
      cleanupPending = true;
      try {
        await env.DB.prepare(
          `UPDATE vector_cleanup_queue
           SET attempts = attempts + 1, last_error = ?, updated_at = ?
           WHERE id = ?`,
        ).bind(errorMessage(error), Date.now(), cleanupQueueId).run();
      } catch {
        // The committed queue row remains the durable recovery record even if
        // recording this attempt fails.
      }
    }
  }

  return { ...committedResult, cleanupPending };
}
