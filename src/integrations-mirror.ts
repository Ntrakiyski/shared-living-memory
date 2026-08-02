/** Tenant-scoped, versioned writes for external-source mirrors. */

import type { Env } from "./types";
import { commitEntryVersion } from "./entry-version-service";
import { forgetEntry } from "./lifecycle";
import { initializeDatabase } from "./db";
import { CRON_SYNC_MAX_BATCHES } from "./config";
import { withStatus } from "./tags";
import {
  type IntegrationRecord,
  type IntegrationVisibility,
  type MirrorEntryVersion,
  type MirrorStore,
  type SyncOutcome,
  INTEGRATION_PROVIDERS,
  deleteIntegration,
  getProvider,
  loadIntegration,
  redactIntegrationError,
  saveIntegration,
} from "./integrations/index";

function requireScopedRecord(userId: string, record: IntegrationRecord): void {
  if (!userId) throw new Error("userId is required");
  if (record.ownerUserId !== userId) {
    throw new Error("Integration record does not belong to this user");
  }
  if (!getProvider(record.provider)) throw new Error("Unknown integration provider");
}

function projectedTags(tags: string[], visibility: IntegrationVisibility): string[] {
  const result = [...new Set(tags.filter((tag) => typeof tag === "string" && tag && tag !== "private"))];
  if (visibility === "private") result.push("private");
  return result;
}

function mutationId(record: IntegrationRecord, input: MirrorEntryVersion): string {
  return `integration:${record.provider}:${input.externalItemId}:${input.version}`;
}

function requireMappedEntry(
  record: IntegrationRecord,
  externalItemId: string,
  entryId: string,
): void {
  if (record.itemMap[externalItemId]?.entryId !== entryId) {
    throw new Error("Entry is not managed by this user's integration item map");
  }
}

/**
 * Build a mirror writer scoped to one user and one connected record.
 *
 * Creates and updates use the canonical version service, so every upstream
 * revision has an immutable episode, citations, a guarded entry projection,
 * and version-scoped vectors. Deletes require both item-map membership and D1
 * ownership before entering either non-destructive archive or the explicit
 * human-requested permanent-forget path.
 */
function makeMirrorStore(
  env: Env,
  userId: string,
  record: IntegrationRecord,
): MirrorStore {
  requireScopedRecord(userId, record);

  return {
    async createEntry(input) {
      const mirrorMutationId = mutationId(record, input);
      const alreadyCommitted = await env.DB.prepare(
        `SELECT ep.entry_id AS entryId
         FROM episodes ep
         JOIN entries e ON e.id = ep.entry_id
         WHERE ep.owner_user_id = ? AND ep.source = ? AND ep.mutation_id = ?
           AND e.owner_user_id = ? AND e.source = ?
         ORDER BY ep.created_at DESC LIMIT 1`,
      ).bind(
        userId,
        record.provider,
        mirrorMutationId,
        userId,
        record.provider,
      ).first<{ entryId: string }>();
      if (alreadyCommitted) return alreadyCommitted.entryId;

      const visibility = record.config.defaultVisibility;
      const result = await commitEntryVersion({
        kind: "capture",
        actorUserId: userId,
        rawContent: input.content,
        materializedContent: input.content,
        tags: projectedTags(input.tags, visibility),
        source: record.provider,
        sourceUrl: input.sourceUrl ?? null,
        visibility,
        contentType: "research",
        title: input.title,
        mutationId: mirrorMutationId,
      }, env);
      return result.entryId;
    },

    async updateEntry(entryId, input) {
      requireMappedEntry(record, input.externalItemId, entryId);
      const row = await env.DB.prepare(
        `SELECT owner_user_id, source, revision, visibility
         FROM entries WHERE id = ?`,
      ).bind(entryId).first<{
        owner_user_id: string;
        source: string;
        revision: number;
        visibility: string;
      }>();
      if (!row) return false;
      if (row.owner_user_id !== userId) throw new Error("Mirror entry owner mismatch");
      if (row.source !== record.provider) throw new Error("Mirror entry provider mismatch");

      const mirrorMutationId = mutationId(record, input);
      const alreadyCommitted = await env.DB.prepare(
        `SELECT id FROM episodes
         WHERE entry_id = ? AND owner_user_id = ? AND mutation_id = ?
         LIMIT 1`,
      ).bind(entryId, userId, mirrorMutationId).first<{ id: string }>();
      if (alreadyCommitted) return true;

      const visibility: IntegrationVisibility = row.visibility === "public" ? "public" : "private";
      await commitEntryVersion({
        kind: "update",
        actorUserId: userId,
        entryId,
        expectedRevision: Number(row.revision),
        rawContent: input.content,
        materializedContent: input.content,
        tags: projectedTags(input.tags, visibility),
        source: record.provider,
        sourceUrl: input.sourceUrl ?? null,
        contentType: "research",
        title: input.title,
        mutationId: mirrorMutationId,
      }, env);
      return true;
    },

    async archiveEntry(externalItemId, entryId) {
      requireMappedEntry(record, externalItemId, entryId);
      const row = await env.DB.prepare(
        `SELECT owner_user_id, source, revision, content, tags,
                valid_from, valid_to, epistemic_status
         FROM entries WHERE id = ?`,
      ).bind(entryId).first<{
        owner_user_id: string;
        source: string;
        revision: number;
        content: string;
        tags: string;
        valid_from: number | null;
        valid_to: number | null;
        epistemic_status: "candidate" | "reviewed" | "canonical" | "qualified" | "stale" | "superseded" | "retracted";
      }>();
      if (!row) return false;
      if (row.owner_user_id !== userId) throw new Error("Mirror entry owner mismatch");
      if (row.source !== record.provider) throw new Error("Mirror entry provider mismatch");
      let tags: string[] = [];
      try {
        const parsed: unknown = JSON.parse(row.tags);
        if (Array.isArray(parsed)) tags = parsed.filter((tag): tag is string => typeof tag === "string");
      } catch { /* preserve a safe empty tag set for malformed legacy rows */ }
      await commitEntryVersion({
        kind: "status",
        actorUserId: userId,
        entryId,
        expectedRevision: Number(row.revision),
        rawContent: `integration-source-removed:${record.provider}:${externalItemId}`,
        materializedContent: row.content,
        tags: withStatus([...new Set([...tags, "source-archived"])], "deprecated"),
        source: row.source,
        validFrom: row.valid_from,
        validTo: row.valid_to,
        epistemicStatus: row.epistemic_status,
        mutationId: `integration:${record.provider}:${externalItemId}:archive:${row.revision}`,
      }, env);
      return true;
    },

    async deleteEntry(externalItemId, entryId) {
      requireMappedEntry(record, externalItemId, entryId);
      const row = await env.DB.prepare(
        `SELECT owner_user_id, source FROM entries WHERE id = ?`,
      ).bind(entryId).first<{ owner_user_id: string; source: string }>();
      if (!row) return false;
      if (row.owner_user_id !== userId) throw new Error("Mirror entry owner mismatch");
      if (row.source !== record.provider) throw new Error("Mirror entry provider mismatch");
      // Compliance purge: the D1 projection is authoritative. A queued vector
      // cleanup still counts as erased (the repair schedule drains it).
      const result = await forgetEntry(entryId, env);
      return result.status === "deleted" || result.status === "pending_cleanup";
    },
  };
}

/** Manual edits are guarded only when this exact entry is in the caller's map. */
async function isManagedMirror(
  entryId: string,
  source: string,
  userId: string,
  env: Env,
): Promise<boolean> {
  if (!entryId || !userId || getProvider(source) === null) return false;
  const record = await loadIntegration(env, userId, source);
  return record !== null && Object.values(record.itemMap)
    .some((mapped) => mapped.entryId === entryId);
}

function mirrorEditError(source: string): string {
  const name = getProvider(source)?.name ?? source;
  return `This memory is synced from ${name}. Edit it in ${name} (the change syncs automatically), or disconnect the ${name} integration to make it editable.`;
}

export type DisconnectIntegrationResult =
  | { ok: true; purged: number; kept: number }
  | { ok: false; purged: number; remaining: number; error: string };

/** Disconnect or human-requested purge only the caller's record and mirrors. */
async function disconnectIntegration(
  env: Env,
  userId: string,
  providerId: string,
  purge = false,
): Promise<DisconnectIntegrationResult | null> {
  const record = await loadIntegration(env, userId, providerId);
  if (!record) return null;
  const itemCount = Object.keys(record.itemMap).length;

  if (!purge) {
    await deleteIntegration(env, userId, providerId);
    return { ok: true, purged: 0, kept: itemCount };
  }

  const store = makeMirrorStore(env, userId, record);
  let purged = 0;
  const errors: string[] = [];
  for (const [externalItemId, mapped] of Object.entries(record.itemMap)) {
    try {
      if (await store.deleteEntry(externalItemId, mapped.entryId)) purged++;
      delete record.itemMap[externalItemId];
    } catch (error) {
      errors.push(redactIntegrationError(error));
    }
  }

  const remaining = Object.keys(record.itemMap).length;
  if (remaining > 0) {
    record.status = "error";
    record.lastSyncError = `Could not purge ${remaining} mirror(s): ${errors[0] ?? "unknown error"}`.slice(0, 500);
    record.updatedAt = Date.now();
    await saveIntegration(env, userId, record);
    return { ok: false, purged, remaining, error: record.lastSyncError };
  }

  await deleteIntegration(env, userId, providerId);
  return { ok: true, purged, kept: 0 };
}

/**
 * Bounded nightly scheduler over active, non-deactivating users and providers.
 * The batch budget is global to the invocation so adding users cannot multiply
 * the Worker's external subrequest ceiling.
 */
async function runScheduledIntegrationSync(env: Env): Promise<void> {
  await initializeDatabase(env);
  const { results: users } = await env.DB.prepare(
    `SELECT u.id
     FROM users u
     WHERE u.status = 'active'
       AND u.normalized_username <> '_system'
       AND NOT EXISTS (
         SELECT 1 FROM user_deactivations d
         WHERE d.user_id = u.id AND d.status IN ('pending', 'running')
       )
     ORDER BY u.created_at ASC, u.id ASC`,
  ).all<{ id: string }>();

  let remainingBudget = CRON_SYNC_MAX_BATCHES;
  for (const user of users) {
    for (const provider of Object.values(INTEGRATION_PROVIDERS)) {
      if (remainingBudget <= 0) return;
      const record = await loadIntegration(env, user.id, provider.id);
      if (!record) continue;
      const store = makeMirrorStore(env, user.id, record);
      while (remainingBudget > 0) {
        remainingBudget--;
        let result: SyncOutcome;
        try {
          result = await provider.sync(env, user.id, store);
        } catch (error) {
          record.status = "error";
          record.lastSyncError = redactIntegrationError(error, [record.credentials.token]);
          record.updatedAt = Date.now();
          await saveIntegration(env, user.id, record);
          break;
        }
        if (!result.ok || result.remaining === 0) break;
      }
    }
  }
}

export {
  disconnectIntegration,
  isManagedMirror,
  makeMirrorStore,
  mirrorEditError,
  runScheduledIntegrationSync,
};
