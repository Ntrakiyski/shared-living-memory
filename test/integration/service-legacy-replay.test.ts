/**
 * service-legacy-replay.test.ts
 *
 * C4 / Section 8.6: a service retry key that predates capture receipts must be
 * recognized from the ORIGINAL capture episode's own fingerprint, backfilled
 * into the new receipt format once, and must never recreate erased content.
 *
 * Real SQLite, real migrations-time schema, real D1 transaction semantics.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteD1 } from "../helpers/sqlite-d1";
import { sha256Hex, stableJson } from "../../src/governance-utils";
import { withStatus } from "../../src/tags";
import {
  captureServicePrivateDraft,
  OperatorDraftErasedError,
  OperatorDraftIdempotencyError,
} from "../../src/operator-memory";
import { commitEntryVersion } from "../../src/entry-version-service";
import { legacyServiceEntryId, legacyServiceMutationId } from "../../src/capture-receipts";
import type { Env, ServiceActorContext, ServiceScope } from "../../src/types";

const SCOPES: ServiceScope[] = ["memory:read", "memory:draft", "audit:write", "run:write"];

interface Harness {
  db: SqliteD1;
  env: Env;
}

function serviceActor(): ServiceActorContext {
  return {
    kind: "service",
    actorId: "service-hermes",
    serviceIdentityId: "service-hermes",
    credentialId: "credential-hermes",
    ownerUserId: "user-owner",
    authMethod: "service_api_key",
    scopes: new Set(SCOPES),
  };
}

function makeHarness(): Harness {
  const db = new SqliteD1({ applySchema: true });
  db.exec(
    `INSERT INTO users (id, username, normalized_username, auth_key_hash, auth_key_prefix, status, created_at, role)
     VALUES ('user-owner', 'owner', 'owner', 'hash', 'prefix', 'active', 1, 'admin')`,
  );
  db.exec(
    `INSERT INTO service_identities (
       id, name, owner_user_id, status, default_autonomy_profile,
       created_by_user_id, created_at, updated_at
     ) VALUES ('service-hermes', 'Hermes', 'user-owner', 'active', 'execute-approved', 'user-owner', 1, 1)`,
  );
  db.exec(
    `INSERT INTO service_credentials (
       id, service_identity_id, credential_hash, credential_prefix, scopes,
       status, created_by_user_id, created_at
     ) VALUES ('credential-hermes', 'service-hermes', 'credential-hash', 'sbs_test',
               '${JSON.stringify(SCOPES)}', 'active', 'user-owner', 1)`,
  );
  const env = {
    DB: db as unknown as D1Database,
    AI: {
      run: vi.fn(async (_model: string, options: { text: string[] }) => ({
        data: options.text.map(() => new Array(384).fill(0.01)),
      })),
    } as unknown as Ai,
    VECTORIZE: {
      upsert: vi.fn(async () => ({ mutationId: "upsert" })),
      deleteByIds: vi.fn(async () => ({ mutationId: "delete" })),
      insert: vi.fn(),
      query: vi.fn(),
      getByIds: vi.fn(),
      describe: vi.fn(),
    } as unknown as VectorizeIndex,
    AUTH_TOKEN: "test-token",
    OAUTH_KV: {} as KVNamespace,
  } as Env;
  return { db, env };
}

/**
 * Reproduce exactly what the pre-receipt service writer persisted: the
 * deterministic `opdraft:` entry id and the self-describing mutation id that
 * embeds the old order-preserving request fingerprint.
 */
async function seedLegacyCapture(
  harness: Harness,
  input: { key: string; content: string; tags: readonly string[]; source?: string },
): Promise<{ entryId: string; mutationId: string; episodeId: string; tags: string[] }> {
  const keyHash = await sha256Hex(`service-hermes:${input.key}`);
  const entryId = legacyServiceEntryId(keyHash);
  const tags = [...withStatus([...new Set(input.tags)], "draft"), "private"];
  const source = input.source ?? "operator:service-hermes";
  const requestHash = await sha256Hex(stableJson({
    content: input.content,
    tags,
    source,
    sourceUrl: null,
    contentType: null,
    title: null,
  }));
  const mutationId = legacyServiceMutationId(keyHash, requestHash);

  const committed = await commitEntryVersion({
    kind: "capture",
    actorUserId: "user-owner",
    entryId,
    rawContent: input.content,
    materializedContent: input.content,
    tags,
    source,
    visibility: "private",
    epistemicStatus: "candidate",
    mutationId,
  }, harness.env);

  return { entryId, mutationId, episodeId: committed.episodeId, tags };
}

function draftRequest(key: string, content: string, tags: string[] = ["team"]) {
  return {
    actor: serviceActor(),
    content,
    tags,
    idempotencyKey: key,
    now: 1_000,
  };
}

describe("legacy service capture replay", () => {
  let harness: Harness;

  beforeEach(() => {
    harness = makeHarness();
  });

  afterEach(() => {
    harness.db.close();
  });

  it("recognizes a pre-receipt capture and backfills one committed receipt", async () => {
    const legacy = await seedLegacyCapture(harness, {
      key: "legacy-1",
      content: "Legacy private plan",
      tags: ["team"],
    });
    expect(harness.db.one<{ count: number }>(
      "SELECT COUNT(*) AS count FROM capture_receipts",
    ).count).toBe(0);

    const replayed = await captureServicePrivateDraft(
      harness.env,
      draftRequest("legacy-1", "Legacy private plan"),
    );

    // The original entry is reused; nothing new was written.
    expect(replayed.entryId).toBe(legacy.entryId);
    expect(replayed.episodeId).toBe(legacy.episodeId);
    expect(replayed.mutationId).toBe(legacy.mutationId);
    expect(harness.db.count("entries")).toBe(1);
    expect(harness.db.count("episodes")).toBe(1);

    const receipt = harness.db.one<Record<string, unknown>>(
      "SELECT * FROM capture_receipts WHERE entry_id = ?", legacy.entryId,
    );
    expect(receipt.state).toBe("committed");
    expect(receipt.actor_kind).toBe("service");
    expect(receipt.actor_id).toBe("service-hermes");
    // A NEW-format request hash is stored, not the legacy fingerprint.
    expect(typeof receipt.request_hash).toBe("string");
    expect(String(receipt.request_hash)).not.toBe("");
    expect(receipt.request_hash).not.toBe(
      legacy.mutationId.split(":")[2],
    );
  });

  it("serves the backfilled receipt on the next retry without touching legacy again", async () => {
    const legacy = await seedLegacyCapture(harness, {
      key: "legacy-2",
      content: "Legacy plan two",
      tags: ["team"],
    });

    const first = await captureServicePrivateDraft(
      harness.env,
      draftRequest("legacy-2", "Legacy plan two"),
    );
    harness.db.exec(`DELETE FROM episodes WHERE mutation_kind = 'capture'`);

    const second = await captureServicePrivateDraft(
      harness.env,
      draftRequest("legacy-2", "Legacy plan two"),
    );
    expect(second.entryId).toBe(legacy.entryId);
    expect(second.episodeId).toBe(first.episodeId);
    expect(harness.db.count("entries")).toBe(1);
  });

  it("still recognizes the legacy capture after the entry was edited", async () => {
    const legacy = await seedLegacyCapture(harness, {
      key: "legacy-3",
      content: "Original legacy text",
      tags: ["team"],
    });

    await commitEntryVersion({
      kind: "update",
      actorUserId: "user-owner",
      entryId: legacy.entryId,
      rawContent: "Owner-edited text",
      materializedContent: "Owner-edited text",
    }, harness.env);

    const replayed = await captureServicePrivateDraft(
      harness.env,
      draftRequest("legacy-3", "Original legacy text"),
    );
    expect(replayed.entryId).toBe(legacy.entryId);
    // The receipt points at the ORIGINAL capture episode, not the edit.
    expect(replayed.episodeId).toBe(legacy.episodeId);
    expect(replayed).toMatchObject({ outcome: "replayed", revision: 1, committedRevision: 1, currentRevision: 2 });
    expect(harness.db.one<{ revision: number }>(
      "SELECT revision FROM capture_receipts WHERE entry_id = ?", legacy.entryId,
    ).revision).toBe(1);
    expect(harness.db.count("entries")).toBe(1);
    expect(harness.db.count("episodes")).toBe(2);
  });

  it("rejects a legacy key reused for different content", async () => {
    await seedLegacyCapture(harness, {
      key: "legacy-4",
      content: "Original legacy text",
      tags: ["team"],
    });

    await expect(captureServicePrivateDraft(
      harness.env,
      draftRequest("legacy-4", "Different content"),
    )).rejects.toBeInstanceOf(OperatorDraftIdempotencyError);

    expect(harness.db.count("entries")).toBe(1);
    expect(harness.db.count("capture_receipts")).toBe(0);
  });

  it("turns an erased legacy key into a terminal tombstone", async () => {
    const legacy = await seedLegacyCapture(harness, {
      key: "legacy-5",
      content: "Erased legacy text",
      tags: ["team"],
    });
    // The entry was erased before receipts existed: only the erasure receipt
    // records what happened.
    harness.db.exec(`DELETE FROM episodes WHERE entry_id = '${legacy.entryId}'`);
    harness.db.exec(`DELETE FROM entries WHERE id = '${legacy.entryId}'`);
    harness.db.exec(
      `INSERT INTO erasure_receipts (
         operation_id, entry_id, owner_user_id, actor_user_id, vector_count,
         status, created_at, updated_at, completed_at
       ) VALUES ('op-legacy', '${legacy.entryId}', 'user-owner', 'user-owner', 0,
                 'complete', 1, 1, 1)`,
    );

    await expect(captureServicePrivateDraft(
      harness.env,
      draftRequest("legacy-5", "Erased legacy text"),
    )).rejects.toBeInstanceOf(OperatorDraftErasedError);

    expect(harness.db.count("entries")).toBe(0);
    const tombstone = harness.db.one<Record<string, unknown>>(
      "SELECT * FROM capture_receipts WHERE entry_id = ?", legacy.entryId,
    );
    expect(tombstone.state).toBe("erased");
    expect(tombstone.request_hash).toBeNull();
    expect(tombstone.episode_id).toBeNull();
    expect(tombstone.mutation_id).toBeNull();
    expect(tombstone.revision).toBeNull();

    // And it stays terminal.
    await expect(captureServicePrivateDraft(
      harness.env,
      draftRequest("legacy-5", "Erased legacy text"),
    )).rejects.toBeInstanceOf(OperatorDraftErasedError);
    expect(harness.db.count("entries")).toBe(0);
    expect(harness.db.count("episodes")).toBe(0);
  });

  it("uses the new capture path when no legacy evidence exists", async () => {
    const created = await captureServicePrivateDraft(
      harness.env,
      draftRequest("fresh-key", "Fresh private plan"),
    );

    expect(created.entryId.startsWith("opdraft:")).toBe(false);
    expect(created).toMatchObject({ outcome: "created", currentRevision: 1, committedRevision: 1 });
    expect(harness.db.count("entries")).toBe(1);
    expect(harness.db.one<{ state: string }>(
      "SELECT state FROM capture_receipts WHERE entry_id = ?", created.entryId,
    ).state).toBe("committed");

    await commitEntryVersion({
      kind: "update", actorUserId: "user-owner", entryId: created.entryId,
      rawContent: "Owner-edited fresh plan", materializedContent: "Owner-edited fresh plan",
    }, harness.env);
    const retried = await captureServicePrivateDraft(
      harness.env,
      draftRequest("fresh-key", "Fresh private plan"),
    );
    expect(retried.entryId).toBe(created.entryId);
    expect(retried).toMatchObject({
      outcome: "replayed", currentRevision: 2, committedRevision: 1,
      episodeId: created.episodeId, revision: 1,
    });
    expect(harness.db.count("entries")).toBe(1);
    expect(harness.db.count("capture_receipts")).toBe(1);
  });

  it("never creates a second entry when a same-key retry races the first", async () => {
    const request = draftRequest("race-key", "Racy private plan");
    const [first, second] = await Promise.all([
      captureServicePrivateDraft(harness.env, request),
      captureServicePrivateDraft(harness.env, request),
    ]);
    expect(first.entryId).toBe(second.entryId);
    expect([first.outcome, second.outcome].sort()).toEqual(["created", "replayed"]);
    expect(harness.db.count("entries")).toBe(1);
    expect(harness.db.count("episodes")).toBe(1);
    expect(harness.db.count("capture_receipts")).toBe(1);
    expect(harness.db.count("vector_cleanup_queue")).toBe(0);
  });
});

describe("concurrent legacy replay and erase (C4, Section 8.6)", () => {
  let harness: Harness;

  beforeEach(() => {
    harness = makeHarness();
  });

  afterEach(() => {
    harness.db.close();
    restorePrepare();
  });

  let restorePrepare: () => void = () => {};

  /**
   * Arm an erase at the exact race window the guard protects: the moment the
   * legacy backfill statement is prepared, which is after the provenance read
   * and before the guarded insert runs.
   */
  function eraseOnBackfillArm(entryId: string, opts: { withErasureReceipt: boolean }): void {
    const original = harness.db.prepare.bind(harness.db);
    restorePrepare = () => { (harness.db as any).prepare = original; };
    (harness.db as any).prepare = (sql: string) => {
      if (sql.includes("INSERT INTO capture_receipts") && sql.includes("NOT EXISTS")) {
        // Disarm immediately: the race happens once.
        (harness.db as any).prepare = original;
        if (opts.withErasureReceipt) {
          harness.db.exec(
            `INSERT INTO erasure_receipts (
               operation_id, entry_id, owner_user_id, actor_user_id, vector_count,
               status, created_at, updated_at, completed_at
             ) VALUES ('race-op', '${entryId}', 'user-owner', 'user-owner', 0,
                       'complete', 1, 1, 1)`,
          );
        }
        harness.db.exec(`DELETE FROM episodes WHERE entry_id = '${entryId}'`);
        harness.db.exec(`DELETE FROM entries WHERE id = '${entryId}'`);
      }
      return original(sql);
    };
  }

  it("loses the backfill race to a concurrent erase and never recreates the entry", async () => {
    const legacy = await seedLegacyCapture(harness, {
      key: "race-legacy",
      content: "Legacy text about to be erased",
      tags: ["team"],
    });
    eraseOnBackfillArm(legacy.entryId, { withErasureReceipt: true });

    await expect(captureServicePrivateDraft(
      harness.env,
      draftRequest("race-legacy", "Legacy text about to be erased"),
    )).rejects.toBeInstanceOf(OperatorDraftErasedError);

    // The guard lost, so nothing was backfilled and nothing was created.
    expect(harness.db.count("entries")).toBe(0);
    expect(harness.db.count("episodes")).toBe(0);
    expect(harness.db.count("capture_receipts")).toBe(0);
  });

  it("does not backfill a receipt for an entry that vanished before the insert", async () => {
    const legacy = await seedLegacyCapture(harness, {
      key: "vanish-legacy",
      content: "Legacy text that vanishes",
      tags: ["team"],
    });
    eraseOnBackfillArm(legacy.entryId, { withErasureReceipt: false });

    // The entry-existence guard loses; the caller is told the capture cannot be
    // replayed, and crucially no NEW entry is created in its place.
    await expect(captureServicePrivateDraft(
      harness.env,
      draftRequest("vanish-legacy", "Legacy text that vanishes"),
    )).rejects.toBeInstanceOf(OperatorDraftErasedError);

    expect(harness.db.count("entries")).toBe(0);
    expect(harness.db.count("capture_receipts")).toBe(0);
  });
});
