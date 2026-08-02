/** The only direct memory write exposed to a service operator. */

import {
  commitEntryVersion,
  EntryVersionCommitError,
  type CommitEntryVersionResult,
} from "./entry-version-service";
import { parseStringArray, sha256Hex, stableJson } from "./governance-utils";
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

interface ExistingDraftRow {
  id: string;
  owner_user_id: string;
  current_episode_id: string | null;
  revision: number;
  vector_ids: string;
  mutation_id: string | null;
}

async function loadIdempotentDraft(
  env: Pick<Env, "DB">,
  entryId: string,
  ownerUserId: string,
  mutationId: string,
): Promise<CommitEntryVersionResult | null> {
  const row = await env.DB.prepare(
    `SELECT e.id, e.owner_user_id, e.current_episode_id, e.revision,
       e.vector_ids, ep.mutation_id
     FROM entries e
     LEFT JOIN episodes ep ON ep.id = e.current_episode_id
     WHERE e.id = ?`,
  ).bind(entryId).first<ExistingDraftRow>();
  if (!row) return null;
  if (row.owner_user_id !== ownerUserId || row.mutation_id !== mutationId || !row.current_episode_id) {
    throw new OperatorDraftIdempotencyError(
      "Idempotency key is already bound to a different private draft request.",
    );
  }

  const documents = await env.DB.prepare(
    `SELECT id FROM documents WHERE episode_id = ? ORDER BY created_at ASC, id ASC`,
  ).bind(row.current_episode_id).all<{ id: string }>();
  const documentId = documents.results[0]?.id ?? null;
  const sections = documentId
    ? await env.DB.prepare(
      `SELECT id FROM document_sections WHERE document_id = ? ORDER BY order_index ASC, id ASC`,
    ).bind(documentId).all<{ id: string }>()
    : { results: [] as { id: string }[] };
  const passages = await env.DB.prepare(
    `SELECT id FROM passages WHERE episode_id = ? ORDER BY start_offset ASC, id ASC`,
  ).bind(row.current_episode_id).all<{ id: string }>();

  return {
    entryId: row.id,
    episodeId: row.current_episode_id,
    mutationId,
    revision: Number(row.revision),
    created: true,
    snapshotId: null,
    documentId,
    sectionIds: sections.results.map(({ id }) => id),
    passageIds: passages.results.map(({ id }) => id),
    vectorIds: parseStringArray(row.vector_ids),
    cleanupQueueId: null,
    cleanupPending: false,
  };
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
  let deterministicEntryId: string | undefined;
  let mutationId: string | undefined;
  if (idempotencyKey) {
    const keyHash = await sha256Hex(`${verified.actor.serviceIdentityId}:${idempotencyKey}`);
    const requestHash = await sha256Hex(stableJson({
      content: input.content,
      tags,
      source: effectiveSource,
      sourceUrl: input.sourceUrl ?? null,
      contentType: input.contentType ?? null,
      title: input.title?.trim() || null,
    }));
    deterministicEntryId = `opdraft:${keyHash.slice(0, 40)}`;
    mutationId = `operator:${keyHash.slice(0, 24)}:${requestHash}`;
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
      if (deterministicEntryId && mutationId) {
        const existing = await loadIdempotentDraft(
          env,
          deterministicEntryId,
          verified.ownerUserId,
          mutationId,
        );
        if (existing) return existing;
      }

      try {
        return await commitEntryVersion({
          kind: "capture",
          actorUserId: verified.ownerUserId,
          entryId: deterministicEntryId,
          rawContent: input.content,
          materializedContent: input.content,
          tags,
          source: effectiveSource,
          sourceUrl: input.sourceUrl,
          visibility: "private",
          contentType: input.contentType,
          title: input.title,
          epistemicStatus: "candidate",
          mutationId,
          now,
        }, env);
      } catch (error) {
        // A concurrent retry can win the deterministic entry-ID insert race.
        // Only recover that exact request; unrelated database failures remain failures.
        if (deterministicEntryId && mutationId && error instanceof EntryVersionCommitError) {
          const raced = await loadIdempotentDraft(
            env,
            deterministicEntryId,
            verified.ownerUserId,
            mutationId,
          );
          if (raced) return raced;
        }
        throw error;
      }
    },
    (result) => ({ entryId: result.entryId, episodeId: result.episodeId, revision: result.revision }),
  );
}
