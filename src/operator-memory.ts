/** The only direct memory write exposed to a service operator. */

import {
  commitEntryVersion,
  EntryVersionCommitError,
  type CommitEntryVersionResult,
} from "./entry-version-service";
import {
  ACTOR_DEFAULT_SOURCE_MARKER,
  captureKeyHash,
  captureRequestHash,
  ensureErasedCaptureTombstone,
  entryHasErasureReceipt,
  legacyReceiptBackfillStatement,
  legacyReceiptBackfilled,
  legacyServiceEntryId,
  legacyServiceKeyHash,
  legacyServiceMutationId,
  legacyServiceRequestHash,
  loadCommittedCaptureView,
  loadLegacyCaptureProvenance,
  lookupCaptureReceipt,
} from "./capture-receipts";
import { withStatus } from "./tags";
import type { Env, ServiceActorContext } from "./types";
import { decideOperatorAction, requireAllowedDecision } from "./operator-policy";
import { verifyServiceActor } from "./service-actor";
import { withMandatoryAudit } from "./mandatory-audit";

export interface CaptureServicePrivateDraftInput {
  actor: ServiceActorContext;
  content: string;
  tags?: readonly string[];
  source?: string;
  sourceUrl?: string | null;
  contentType?: string;
  title?: string;
  idempotencyKey?: string;
  correlationId?: string | null;
  now?: number;
}

export class OperatorDraftIdempotencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OperatorDraftIdempotencyError";
  }
}

/**
 * A service capture whose retry key was permanently erased. Terminal: the
 * content is never recreated, and the caller must not retry with the same key.
 */
export class OperatorDraftErasedError extends Error {
  readonly code = "capture_erased";
  constructor() {
    super("This capture was permanently erased and will not be recreated.");
    this.name = "OperatorDraftErasedError";
  }
}

/**
 * Rebuild the committed result for a receipt. Delegates to the shared receipt
 * reconstruction so replay semantics stay identical across callers.
 */
async function replayServiceReceipt(
  env: Pick<Env, "DB">,
  receipt: { entryId: string; episodeId: string | null; mutationId: string | null; revision: number | null },
): Promise<CommitEntryVersionResult | null> {
  const view = await loadCommittedCaptureView(env, receipt);
  if (!view) return null;
  return {
    entryId: view.entryId,
    episodeId: view.episodeId ?? "",
    mutationId: view.mutationId ?? "",
    revision: view.revision,
    created: true,
    snapshotId: null,
    documentId: view.documentId,
    sectionIds: view.sectionIds,
    passageIds: view.passageIds,
    vectorIds: view.vectorIds,
    cleanupQueueId: null,
    cleanupPending: false,
  };
}

/**
 * Recognize a capture written before receipts existed. The legacy writer derived
 * a deterministic `opdraft:` entry id and embedded its own fingerprint in the
 * mutation id, so the check is: recompute that exact legacy fingerprint and
 * compare it with the fingerprint recorded on the ORIGINAL capture episode —
 * never with the current projection, which a later edit may have replaced.
 *
 * Returns:
 *  - `absent`    no legacy evidence at all: use the new capture path;
 *  - `replayed`  legacy capture matched and a new-format receipt was backfilled;
 *  - `erased`    the entry was erased: a tombstone now exists and is terminal;
 *  - `conflict`  the legacy key was used for a different request.
 */
async function resolveLegacyServiceCapture(
  env: Env,
  input: {
    serviceIdentityId: string;
    ownerUserId: string;
    key: string;
    content: string;
    tags: readonly string[];
    source?: string;
    sourceUrl?: string | null;
    contentType?: string;
    title?: string;
  },
  newKeyHash: string,
  newRequestHash: string,
): Promise<
  | { kind: "absent" }
  | { kind: "erased" }
  | { kind: "conflict" }
  | { kind: "replayed"; result: CommitEntryVersionResult }
> {
  const legacyKeyHash = await legacyServiceKeyHash(input.serviceIdentityId, input.key);
  const legacyEntryId = legacyServiceEntryId(legacyKeyHash);
  const provenance = await loadLegacyCaptureProvenance(env, legacyEntryId);

  if (!provenance) {
    if (await entryHasErasureReceipt(env, legacyEntryId)) {
      await ensureErasedCaptureTombstone(
        env,
        { kind: "service", actorId: input.serviceIdentityId },
        newKeyHash,
        legacyEntryId,
      );
      return { kind: "erased" };
    }
    return { kind: "absent" };
  }

  // Order-preserving tags exactly as the legacy writer persisted them, and the
  // source recorded on the original capture when the request omits it.
  const legacyRequestHash = await legacyServiceRequestHash({
    content: input.content,
    tags: input.tags,
    source: input.source ?? provenance.source,
    sourceUrl: input.sourceUrl ?? null,
    contentType: input.contentType ?? null,
    title: input.title?.trim() || null,
  });
  const expectedMutationId = legacyServiceMutationId(legacyKeyHash, legacyRequestHash);
  if (provenance.mutationId !== expectedMutationId) return { kind: "conflict" };

  const values = {
    entryId: provenance.entryId,
    episodeId: provenance.episodeId,
    mutationId: expectedMutationId,
    revision: provenance.revision,
  };
  const results = await env.DB.batch([
    legacyReceiptBackfillStatement(env, {
      actorKind: "service",
      actorId: input.serviceIdentityId,
      keyHash: newKeyHash,
      requestHash: newRequestHash,
      attemptId: "",
    }, values),
  ]);
  if (!legacyReceiptBackfilled(results)) {
    // A concurrent erase won the guard: the tombstone is authoritative.
    return { kind: "erased" };
  }

  const result = await replayServiceReceipt(env, values);
  if (!result) return { kind: "erased" };
  return { kind: "replayed", result };
}

/**
 * Capture directly without classifier, dedupe, merge, graph inference,
 * canonical promotion, deprecation, or any destructive capability.
 */
export async function captureServicePrivateDraft(
  env: Env,
  input: CaptureServicePrivateDraftInput,
): Promise<CommitEntryVersionResult> {
  if (!input.content) throw new TypeError("Service draft content is required.");
  const now = input.now ?? Date.now();
  const verified = await verifyServiceActor(env, input.actor, now);
  const decision = decideOperatorAction({
    actor: verified.actor,
    operation: "entry.create",
    directCapture: {
      visibility: "private",
      lifecycleStatus: "draft",
      epistemicStatus: "candidate",
      mayMerge: false,
      mayAutoDeprecate: false,
    },
    autonomyProfile: verified.autonomyProfile,
  });
  requireAllowedDecision(decision);

  const supplied = (input.tags ?? []).filter(
    (tag): tag is string => typeof tag === "string" && tag !== "private" && !tag.startsWith("status:"),
  );
  const tags = [...withStatus([...new Set(supplied)], "draft"), "private"];
  const idempotencyKey = input.idempotencyKey?.trim();
  if (input.idempotencyKey !== undefined && (!idempotencyKey || idempotencyKey.length > 240)) {
    throw new OperatorDraftIdempotencyError(
      "Idempotency key must contain 1 to 240 non-whitespace characters.",
    );
  }
  const effectiveSource = input.source ?? `operator:${verified.actor.serviceIdentityId}`;
  const keyed = idempotencyKey !== undefined;

  // Retry identity is decided before any write, and erased state is evaluated
  // before any payload comparison (Section 8.5).
  let keyHash: string | null = null;
  let requestHash: string | null = null;
  if (keyed) {
    keyHash = await captureKeyHash(idempotencyKey!);
    requestHash = await captureRequestHash({
      content: input.content,
      tags,
      sourceDeclaration: input.source ?? ACTOR_DEFAULT_SOURCE_MARKER,
      sourceUrl: input.sourceUrl ?? null,
      sourceTitle: input.title?.trim() || null,
      visibility: "private",
      contentType: input.contentType ?? "text",
    });
  }

  return withMandatoryAudit(
    env,
    {
      actor: verified.actor,
      subjectUserId: verified.ownerUserId,
      operation: "entry.create",
      decision,
      correlationId: input.correlationId,
      redactedRequest: {
        mode: "private-draft-candidate",
        contentLength: input.content.length,
        tagCount: tags.length,
      },
      now,
    },
    async () => {
      if (keyed && keyHash && requestHash) {
        const namespace = {
          kind: "service" as const,
          actorId: verified.actor.serviceIdentityId,
        };
        const lookup = await lookupCaptureReceipt(
          env,
          namespace,
          keyHash,
          requestHash,
          verified.ownerUserId,
        );

        if (lookup.status === "replayed") {
          const replayed = await replayServiceReceipt(env, lookup.descriptor);
          if (replayed) return replayed;
          throw new OperatorDraftIdempotencyError(
            "The committed capture for this key is temporarily unavailable.",
          );
        }
        if (lookup.status === "erased") throw new OperatorDraftErasedError();
        if (lookup.status === "conflict") {
          throw new OperatorDraftIdempotencyError(
            "Idempotency key is already bound to a different private draft request.",
          );
        }
        if (lookup.status === "unavailable") {
          throw new OperatorDraftIdempotencyError(
            "The committed capture for this key is temporarily unavailable.",
          );
        }

        const legacy = await resolveLegacyServiceCapture(
          env,
          {
            serviceIdentityId: verified.actor.serviceIdentityId,
            ownerUserId: verified.ownerUserId,
            key: idempotencyKey!,
            content: input.content,
            tags,
            source: input.source,
            sourceUrl: input.sourceUrl,
            contentType: input.contentType,
            title: input.title,
          },
          keyHash,
          requestHash,
        );
        if (legacy.kind === "erased") throw new OperatorDraftErasedError();
        if (legacy.kind === "replayed") return legacy.result;
        if (legacy.kind === "conflict") {
          throw new OperatorDraftIdempotencyError(
            "Idempotency key is already bound to a different private draft request.",
          );
        }
      }

      const attemptId = crypto.randomUUID();
      try {
        return await commitEntryVersion({
          kind: "capture",
          actorUserId: verified.ownerUserId,
          entryId: crypto.randomUUID(),
          rawContent: input.content,
          materializedContent: input.content,
          tags,
          source: effectiveSource,
          sourceUrl: input.sourceUrl,
          visibility: "private",
          contentType: input.contentType,
          title: input.title,
          epistemicStatus: "candidate",
          now,
          captureReceipt: keyed && keyHash && requestHash
            ? {
              actorKind: "service",
              actorId: verified.actor.serviceIdentityId,
              keyHash,
              requestHash,
              attemptId,
            }
            : undefined,
        }, env);
      } catch (error) {
        // A concurrent retry loses the receipt primary-key race and rolls its
        // whole batch back. Only that exact request is recovered.
        if (keyed && keyHash && requestHash && error instanceof EntryVersionCommitError) {
          const raced = await lookupCaptureReceipt(
            env,
            { kind: "service", actorId: verified.actor.serviceIdentityId },
            keyHash,
            requestHash,
            verified.ownerUserId,
          );
          if (raced.status === "replayed") {
            const replayed = await replayServiceReceipt(env, raced.descriptor);
            if (replayed) return replayed;
          }
        }
        throw error;
      }
    },
    (result) => ({ entryId: result.entryId, episodeId: result.episodeId, revision: result.revision }),
  );
}
