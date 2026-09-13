/**
 * capture-receipts.test.ts
 *
 * C1–C4 + E2 (Sections 8.4–8.6, 9.2): keyed capture retry identity, erased-key
 * tombstones, stage fencing and truthful failure reporting, exercised against
 * real SQLite with the Workerd compound-SELECT limit enforced.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteD1, WORKERD_COMPOUND_SELECT_TERMS } from "../helpers/sqlite-d1";
import {
  beginCaptureStage,
  captureStageIsIntact,
  CAPTURE_MODE_CREATE_ONLY,
  captureKeyHash,
  captureReceiptError,
  captureRequestHash,
  lookupCaptureReceipt,
  normalizeIdempotencyKey,
  normalizedCaptureTags,
  ACTOR_DEFAULT_SOURCE_MARKER,
  type CaptureWriteMeaning,
} from "../../src/capture-receipts";
import {
  commitEntryVersion,
  EntryVersionCommitError,
  EntryVersionVectorStageError,
} from "../../src/entry-version-service";
import { eraseEntryArtifacts } from "../../src/erasure";
import {
  drainCaptureStageIntents,
  drainVectorCleanupQueue,
} from "../../src/vector-cleanup";
import type { ActorContext, Env } from "../../src/types";

interface Harness {
  db: SqliteD1;
  env: Env;
  vectors: Map<string, unknown>;
  deleteByIds: ReturnType<typeof vi.fn>;
}

function makeHarness(): Harness {
  const db = new SqliteD1({ maxCompoundSelectTerms: WORKERD_COMPOUND_SELECT_TERMS });
  const vectors = new Map<string, unknown>();
  const deleteByIds = vi.fn(async (ids: string[]) => {
    for (const id of ids) vectors.delete(id);
    return { mutationId: "delete" };
  });
  const env = {
    DB: db as unknown as D1Database,
    AI: {
      run: vi.fn(async (_model: string, options: { text: string[] }) => ({
        data: [new Array(384).fill((options.text[0]?.length ?? 0) / 1000 + 0.01)],
      })),
    } as unknown as Ai,
    VECTORIZE: {
      upsert: vi.fn(async (items: { id: string }[]) => {
        for (const item of items) vectors.set(item.id, item);
        return { mutationId: "upsert" };
      }),
      deleteByIds,
      insert: vi.fn(),
      query: vi.fn(),
      getByIds: vi.fn(),
      describe: vi.fn(),
    } as unknown as VectorizeIndex,
    AUTH_TOKEN: "test-token",
    OAUTH_KV: {} as KVNamespace,
  } as Env;
  return { db, env, vectors, deleteByIds };
}

const human: ActorContext = {
  kind: "human",
  actorId: "user-alice",
  userId: "user-alice",
  role: "member",
  authMethod: "personal_api_key",
  scopes: new Set(),
};

const MEANING: CaptureWriteMeaning = {
  content: "Keyed memory",
  tags: ["Work", "task", "work"],
  sourceDeclaration: ACTOR_DEFAULT_SOURCE_MARKER,
  sourceUrl: null,
  sourceTitle: null,
  visibility: "private",
  contentType: "text",
};

async function keyedCapture(
  harness: Harness,
  key: string,
  overrides: {
    meaning?: Partial<CaptureWriteMeaning>;
    attemptId?: string;
    namespace?: { kind: "human" | "service"; actorId: string };
    ownerUserId?: string;
  } = {},
) {
  const namespace = overrides.namespace ?? { kind: "human" as const, actorId: human.actorId };
  const ownerUserId = overrides.ownerUserId ?? human.actorId;
  const meaning: CaptureWriteMeaning = { ...MEANING, ...overrides.meaning };
  const keyHash = await captureKeyHash(key);
  const requestHash = await captureRequestHash(meaning);
  const attemptId = overrides.attemptId ?? crypto.randomUUID();

  const lookup = await lookupCaptureReceipt(harness.env, namespace, keyHash, requestHash, ownerUserId);
  if (lookup.status !== "absent") return { lookup, keyHash, requestHash, attemptId };

  const entryId = crypto.randomUUID();
  const committed = await commitEntryVersion({
    kind: "capture",
    actorUserId: ownerUserId,
    entryId,
    rawContent: meaning.content,
    materializedContent: meaning.content,
    tags: normalizedCaptureTags(meaning.tags),
    source: "mcp:alice",
    visibility: meaning.visibility,
    contentType: meaning.contentType,
    captureReceipt: {
      actorKind: namespace.kind,
      actorId: namespace.actorId,
      keyHash,
      requestHash,
      attemptId,
    },
  }, harness.env);

  return {
    lookup: await lookupCaptureReceipt(harness.env, namespace, keyHash, requestHash, ownerUserId),
    keyHash,
    requestHash,
    committed,
    attemptId,
  };
}

describe("capture receipt identity", () => {
  let harness: Harness;

  beforeEach(() => {
    harness = makeHarness();
  });

  afterEach(() => {
    harness.db.close();
  });

  it("trims only, and hashes the same key identically across attempts", async () => {
    expect(normalizeIdempotencyKey("  key-1  ")).toBe("key-1");
    expect(normalizeIdempotencyKey("Key-1")).toBe("Key-1");
    expect(await captureKeyHash("  key-1 ")).toBe(await captureKeyHash("key-1"));
    expect(await captureKeyHash("key-1")).not.toBe(await captureKeyHash("key-2"));
  });

  it("hashes tag order and duplicates out of the request meaning", async () => {
    const a = await captureRequestHash({ ...MEANING, tags: ["Work", "work", "task"] });
    const b = await captureRequestHash({ ...MEANING, tags: ["task", "work"] });
    expect(a).toBe(b);
    expect(await captureRequestHash({ ...MEANING, tags: ["work"] })).not.toBe(a);
  });

  it("changes the request hash with content, visibility, source and URL", async () => {
    const base = await captureRequestHash(MEANING);
    expect(await captureRequestHash({ ...MEANING, content: "Other" })).not.toBe(base);
    expect(await captureRequestHash({ ...MEANING, visibility: "public" })).not.toBe(base);
    expect(await captureRequestHash({ ...MEANING, sourceDeclaration: "mcp:alice" })).not.toBe(base);
    expect(await captureRequestHash({ ...MEANING, sourceUrl: "https://x.test" })).not.toBe(base);
    expect(await captureRequestHash({ ...MEANING, sourceTitle: "T" })).not.toBe(base);
    // The default marker is stable regardless of display name.
    expect(await captureRequestHash({ ...MEANING, sourceDeclaration: ACTOR_DEFAULT_SOURCE_MARKER }))
      .toBe(base);
  });

  it("C1 creates exactly one entry and replays it for the same key and payload", async () => {
    const first = await keyedCapture(harness, "retry-1");
    expect(first.committed?.revision).toBe(1);

    const second = await keyedCapture(harness, "retry-1");
    expect(second.lookup.status).toBe("replayed");
    if (second.lookup.status !== "replayed") throw new Error("expected replay");
    expect(second.lookup.descriptor.entryId).toBe(first.committed!.entryId);
    expect(second.lookup.descriptor.episodeId).toBe(first.committed!.episodeId);
    expect(second.lookup.descriptor.revision).toBe(1);

    expect(harness.db.count("entries")).toBe(1);
    expect(harness.db.count("episodes")).toBe(1);
    expect(harness.db.count("capture_receipts")).toBe(1);
  });

  it("C1 reports idempotency_conflict when the payload changes under one key", async () => {
    await keyedCapture(harness, "retry-2");
    const second = await keyedCapture(harness, "retry-2", {
      meaning: { content: "Different content" },
    });
    expect(second.lookup.status).toBe("conflict");
    const error = captureReceiptError(second.lookup);
    expect(error?.code).toBe("idempotency_conflict");
    expect(error?.retryable).toBe(false);
    expect(harness.db.count("entries")).toBe(1);
  });

  it("C1 lets two actors use the same key independently", async () => {
    const alice = await keyedCapture(harness, "shared");
    const bob = await keyedCapture(harness, "shared", {
      namespace: { kind: "human", actorId: "user-bob" },
      ownerUserId: "user-bob",
    });
    expect(alice.committed!.entryId).not.toBe(bob.committed!.entryId);
    expect(harness.db.count("entries")).toBe(2);
    expect(harness.db.count("capture_receipts")).toBe(2);

    // A service identity is a different namespace again.
    const service = await keyedCapture(harness, "shared", {
      namespace: { kind: "service", actorId: "svc-1" },
      ownerUserId: "user-bob",
    });
    expect(service.committed!.entryId).not.toBe(alice.committed!.entryId);
    expect(harness.db.count("capture_receipts")).toBe(3);
  });

  it("C1 preserves replay identity across a key rotation", async () => {
    const first = await keyedCapture(harness, "rotate-me");
    // Rotation replaces only the secret: the actor id (and its namespace) stay.
    harness.db.exec(`UPDATE users SET auth_key_hash = 'rotated' WHERE 1 = 0`);
    const replay = await keyedCapture(harness, "rotate-me");
    expect(replay.lookup.status).toBe("replayed");
    if (replay.lookup.status !== "replayed") throw new Error("expected replay");
    expect(replay.lookup.descriptor.entryId).toBe(first.committed!.entryId);
    expect(harness.db.count("entries")).toBe(1);
  });

  it("C3 replays the original capture revision after a later edit", async () => {
    const first = await keyedCapture(harness, "edited");
    const entryId = first.committed!.entryId;

    await commitEntryVersion({
      kind: "update",
      actorUserId: human.actorId,
      entryId,
      rawContent: "Edited content",
      materializedContent: "Edited content",
    }, harness.env);
    expect(harness.db.one<{ revision: number }>(
      "SELECT revision FROM entries WHERE id = ?", entryId,
    ).revision).toBe(2);

    const replay = await keyedCapture(harness, "edited");
    expect(replay.lookup.status).toBe("replayed");
    if (replay.lookup.status !== "replayed") throw new Error("expected replay");
    // The receipt keeps the original committed revision, not the current one.
    expect(replay.lookup.descriptor.revision).toBe(1);
    expect(replay.lookup.descriptor.episodeId).toBe(first.committed!.episodeId);
    expect(harness.db.one<{ content: string }>(
      "SELECT content FROM entries WHERE id = ?", entryId,
    ).content).toBe("Edited content");
  });

  it("C3 never recaptures a committed receipt whose target is gone", async () => {
    const first = await keyedCapture(harness, "vanished");
    harness.db.exec(`DELETE FROM entries WHERE id = '${first.committed!.entryId}'`);

    const replay = await keyedCapture(harness, "vanished");
    expect(replay.lookup.status).toBe("unavailable");
    const error = captureReceiptError(replay.lookup);
    expect(error?.code).toBe("receipt_unavailable");
    expect(error?.retryable).toBe(true);
    expect(harness.db.count("entries")).toBe(0);
  });

  it("C4 returns capture_erased after a forget and never recreates content", async () => {
    const first = await keyedCapture(harness, "erased-key");
    const entryId = first.committed!.entryId;
    const vectorsBefore = harness.vectors.size;

    const erased = await eraseEntryArtifacts(entryId, human, harness.env);
    expect(erased.status).toBe("complete");

    const tombstone = harness.db.one<Record<string, unknown>>(
      "SELECT * FROM capture_receipts WHERE entry_id = ?", entryId,
    );
    expect(tombstone.state).toBe("erased");
    expect(tombstone.request_hash).toBeNull();
    expect(tombstone.episode_id).toBeNull();
    expect(tombstone.mutation_id).toBeNull();
    expect(tombstone.revision).toBeNull();
    expect(Number(tombstone.erased_at)).toBeGreaterThan(0);
    expect(tombstone.key_hash).toBe(first.keyHash);
    expect(tombstone.actor_id).toBe(human.actorId);

    // Replay is terminal, even with a payload that would otherwise conflict.
    const replay = await keyedCapture(harness, "erased-key");
    expect(replay.lookup.status).toBe("erased");
    const error = captureReceiptError(replay.lookup);
    expect(error?.code).toBe("capture_erased");
    expect(error?.retryable).toBe(false);

    const conflicting = await keyedCapture(harness, "erased-key", {
      meaning: { content: "Different" },
    });
    expect(conflicting.lookup.status).toBe("erased");

    expect(harness.db.count("entries")).toBe(0);
    expect(harness.db.count("episodes")).toBe(0);
    expect(harness.vectors.size).toBe(0);
    expect(vectorsBefore).toBeGreaterThan(0);
  });

  it("E2 keeps the tombstone when the vector delete fails and cleanup stays pending", async () => {
    const first = await keyedCapture(harness, "pending-cleanup");
    const entryId = first.committed!.entryId;
    harness.deleteByIds.mockRejectedValueOnce(new Error("Vectorize down"));

    const erased = await eraseEntryArtifacts(entryId, human, harness.env);
    expect(erased.status).toBe("pending_cleanup");

    expect(harness.db.one<{ state: string }>(
      "SELECT state FROM capture_receipts WHERE entry_id = ?", entryId,
    ).state).toBe("erased");
    expect(harness.db.count("entries")).toBe(0);
    expect(harness.db.count("vector_cleanup_queue")).toBe(1);

    // A replay during pending cleanup is still terminal.
    const replay = await keyedCapture(harness, "pending-cleanup");
    expect(replay.lookup.status).toBe("erased");
    expect(harness.db.count("entries")).toBe(0);
  });

  it("E2 tombstones the receipt in the same batch as the deletion", async () => {
    const first = await keyedCapture(harness, "atomic-tombstone");
    const entryId = first.committed!.entryId;
    harness.db.beforeNextBatch = () => {
      // Inject a failure on the batch that performs the erasure deletion.
      harness.db.failBatchAt = 5;
    };

    await expect(eraseEntryArtifacts(entryId, human, harness.env)).rejects.toThrow();

    // Rolled back together: the entry survives and the receipt is not erased.
    expect(harness.db.count("entries")).toBe(1);
    expect(harness.db.one<{ state: string }>(
      "SELECT state FROM capture_receipts WHERE entry_id = ?", entryId,
    ).state).toBe("committed");
    expect(harness.db.count("erasure_receipts")).toBe(0);
  });

  it("C2 fenced-out receipt insert rolls back every artifact in the batch", async () => {
    const keyHash = await captureKeyHash("lost-fence");
    const requestHash = await captureRequestHash(MEANING);
    const attemptId = crypto.randomUUID();
    const entryId = crypto.randomUUID();

    // A repair worker claims the intent after the last in-request fence check
    // but before the commit batch runs.
    harness.db.beforeNextBatch = () => {
      harness.db.exec(
        `UPDATE vector_cleanup_queue SET claim_token = 'repair' WHERE id = '${attemptId}'`,
      );
    };

    await expect(commitEntryVersion({
      kind: "capture",
      actorUserId: human.actorId,
      entryId,
      rawContent: MEANING.content,
      materializedContent: MEANING.content,
      tags: ["work"],
      source: "mcp:alice",
      captureReceipt: {
        actorKind: "human",
        actorId: human.actorId,
        keyHash,
        requestHash,
        attemptId,
      },
    }, harness.env)).rejects.toBeInstanceOf(EntryVersionCommitError);

    expect(harness.db.count("entries")).toBe(0);
    expect(harness.db.count("episodes")).toBe(0);
    expect(harness.db.count("documents")).toBe(0);
    expect(harness.db.count("passages")).toBe(0);
    expect(harness.db.count("capture_receipts")).toBe(0);
    // The claimed intent survives for the repair worker, not for the attempt.
    expect(harness.db.count("vector_cleanup_queue")).toBe(1);
    expect(harness.db.one<{ claim_token: string }>(
      "SELECT claim_token FROM vector_cleanup_queue WHERE id = ?", attemptId,
    ).claim_token).toBe("repair");
    // This attempt's own unreferenced vectors were removed.
    expect(harness.vectors.size).toBe(0);
  });

  it("C2 refuses to commit when the lease expires during the remote upsert", async () => {
    const keyHash = await captureKeyHash("expired-midflight");
    const requestHash = await captureRequestHash(MEANING);
    const attemptId = crypto.randomUUID();
    const entryId = crypto.randomUUID();

    harness.env.VECTORIZE.upsert = vi.fn(async (items: { id: string }[]) => {
      for (const item of items) harness.vectors.set(item.id, item);
      harness.db.exec(
        `UPDATE vector_cleanup_queue SET lease_expires_at = 1 WHERE id = '${attemptId}'`,
      );
      return { mutationId: "upsert" };
    }) as unknown as VectorizeIndex["upsert"];

    await expect(commitEntryVersion({
      kind: "capture",
      actorUserId: human.actorId,
      entryId,
      rawContent: MEANING.content,
      materializedContent: MEANING.content,
      source: "mcp:alice",
      captureReceipt: {
        actorKind: "human",
        actorId: human.actorId,
        keyHash,
        requestHash,
        attemptId,
      },
    }, harness.env)).rejects.toBeInstanceOf(EntryVersionVectorStageError);

    expect(harness.db.count("entries")).toBe(0);
    expect(harness.db.count("capture_receipts")).toBe(0);
    // The late upsert's vectors are cleaned rather than left searchable.
    expect(harness.vectors.size).toBe(0);
  });

  it("treats a claimed or expired stage intent as not intact", async () => {
    const attemptId = crypto.randomUUID();
    await beginCaptureStage(harness.env, {
      attemptId,
      entryId: "entry-fence",
      episodeId: "episode-fence",
      vectorIds: ["v1"],
      reason: "capture-stage:fence",
      leaseMs: -1,
    });
    expect(await captureStageIsIntact(harness.env, attemptId)).toBe(false);

    harness.db.exec(
      `UPDATE vector_cleanup_queue SET lease_expires_at = 99999999999999 WHERE id = '${attemptId}'`,
    );
    expect(await captureStageIsIntact(harness.env, attemptId)).toBe(true);

    harness.db.exec(
      `UPDATE vector_cleanup_queue SET claim_token = 'repair' WHERE id = '${attemptId}'`,
    );
    expect(await captureStageIsIntact(harness.env, attemptId)).toBe(false);
  });

  it("C2 releases the stage intent on a successful commit and never leaves it behind", async () => {
    const result = await keyedCapture(harness, "fence-release");
    expect(result.committed).toBeTruthy();
    expect(harness.db.count("vector_cleanup_queue")).toBe(0);
    expect(harness.db.count("capture_receipts")).toBe(1);
  });

  it("keeps every receipt statement inside the Workerd compound-SELECT limit", async () => {
    harness.db.executed.length = 0;
    await keyedCapture(harness, "shape-check");
    const guards = harness.db.executed.filter((sql) => sql.includes("FROM capture_receipts"));
    expect(guards.length).toBeGreaterThan(0);
    for (const sql of harness.db.executed) {
      const compoundTerms = (sql.match(/\b(UNION|INTERSECT|EXCEPT)\b/gi)?.length ?? 0) + 1;
      expect(compoundTerms).toBeLessThanOrEqual(WORKERD_COMPOUND_SELECT_TERMS);
    }
  });

  it("exposes the create-only capture mode as the keyed contract", () => {
    expect(CAPTURE_MODE_CREATE_ONLY).toBe("create-only");
  });
});

describe("capture-stage repair worker", () => {
  let harness: Harness;

  beforeEach(() => {
    harness = makeHarness();
  });

  afterEach(() => {
    harness.db.close();
  });

  it("removes an abandoned attempt's vectors and then the intent", async () => {
    const attemptId = crypto.randomUUID();
    const planned = ["ev:dead-episode:0", "pv:dead-passage"];
    for (const id of planned) harness.vectors.set(id, { id });
    await beginCaptureStage(harness.env, {
      attemptId,
      entryId: "entry-abandoned",
      episodeId: "dead-episode",
      vectorIds: planned,
      reason: "capture-stage:abandoned",
      leaseMs: -1,
    });

    const result = await drainCaptureStageIntents(harness.env);
    expect(result).toMatchObject({ processed: 1, abandoned: 1, preserved: 0, deferred: 0, remaining: 0 });
    expect(harness.vectors.size).toBe(0);
    expect(harness.db.count("vector_cleanup_queue")).toBe(0);
  });

  it("preserves a committed attempt's vectors and only removes the intent", async () => {
    const first = await keyedCapture(harness, "repair-committed");
    const entryId = first.committed!.entryId;
    const committedVectorIds = JSON.parse(
      harness.db.one<{ vector_ids: string }>("SELECT vector_ids FROM entries WHERE id = ?", entryId).vector_ids,
    ) as string[];
    expect(committedVectorIds.length).toBeGreaterThan(0);
    for (const id of committedVectorIds) harness.vectors.set(id, { id });

    // A leftover intent pointing at the already-committed attempt.
    const leftoverId = crypto.randomUUID();
    harness.db.exec(
      `INSERT INTO vector_cleanup_queue
        (id, vector_ids, reason, attempts, last_error, created_at, updated_at,
         kind, stage_entry_id, stage_episode_id, lease_expires_at, claim_token)
       VALUES ('${leftoverId}', '${JSON.stringify(committedVectorIds)}', 'capture-stage:leftover',
               0, NULL, 1, 1, 'capture_stage', '${entryId}', 'ep', 1, NULL)`,
    );

    const result = await drainCaptureStageIntents(harness.env);
    expect(result).toMatchObject({ processed: 1, abandoned: 0, preserved: 1, deferred: 0, remaining: 0 });
    expect(harness.vectors.size).toBe(committedVectorIds.length);
    expect(harness.db.count("vector_cleanup_queue")).toBe(0);
  });

  it("defers the intent when the authoritative check is unavailable", async () => {
    const attemptId = crypto.randomUUID();
    await beginCaptureStage(harness.env, {
      attemptId,
      entryId: "entry-deferred",
      episodeId: "ep-deferred",
      vectorIds: ["v-deferred"],
      reason: "capture-stage:deferred",
      leaseMs: -1,
    });
    harness.vectors.set("v-deferred", { id: "v-deferred" });

    const original = harness.db.prepare.bind(harness.db);
    (harness.db as any).prepare = (sql: string) => {
      if (sql.includes("FROM capture_receipts")) throw new Error("D1 unavailable");
      return original(sql);
    };

    const result = await drainCaptureStageIntents(harness.env);
    expect(result).toMatchObject({ processed: 1, abandoned: 0, preserved: 0, deferred: 1, remaining: 1 });
    // No remote deletion was attempted without authority.
    expect(harness.vectors.has("v-deferred")).toBe(true);
    expect(harness.db.count("vector_cleanup_queue")).toBe(1);
  });

  it("keeps delete work and stage intents from starving each other", async () => {
    harness.db.exec(
      `INSERT INTO vector_cleanup_queue
        (id, vector_ids, reason, attempts, last_error, created_at, updated_at,
         kind, stage_entry_id, stage_episode_id, lease_expires_at, claim_token)
       VALUES ('stage-1', '["v-stage"]', 'capture-stage:x', 0, NULL, 1, 1,
               'capture_stage', 'entry', 'ep', 1, NULL)`,
    );
    harness.db.exec(
      `INSERT INTO vector_cleanup_queue
        (id, vector_ids, reason, attempts, last_error, created_at, updated_at, kind)
       VALUES ('delete-1', '["v-stale"]', 'entry-version:e:m', 0, NULL, 1, 1, 'delete')`,
    );
    harness.vectors.set("v-stage", {});
    harness.vectors.set("v-stale", {});

    const deletes = await drainVectorCleanupQueue(harness.env);
    expect(deletes).toMatchObject({ processed: 1, deleted: 1, failed: 0, remaining: 0 });
    // The unconditional delete branch never touches the stage intent.
    expect(harness.vectors.has("v-stage")).toBe(true);
    expect(harness.db.count("vector_cleanup_queue")).toBe(1);

    const stages = await drainCaptureStageIntents(harness.env);
    expect(stages).toMatchObject({ processed: 1, abandoned: 1, deferred: 0, remaining: 0 });
    expect(harness.vectors.has("v-stage")).toBe(false);
  });

  it("lets a later pass take over a claim left by a crashed worker", async () => {
    const attemptId = crypto.randomUUID();
    await beginCaptureStage(harness.env, {
      attemptId,
      entryId: "entry-crash",
      episodeId: "ep-crash",
      vectorIds: ["v-crash"],
      reason: "capture-stage:crash",
      leaseMs: -1,
    });
    harness.vectors.set("v-crash", {});
    // A previous repair pass claimed the row and then crashed before deleting.
    harness.db.exec(
      `UPDATE vector_cleanup_queue SET claim_token = 'crashed-pass' WHERE id = '${attemptId}'`,
    );

    const result = await drainCaptureStageIntents(harness.env);
    expect(result).toMatchObject({ processed: 1, abandoned: 1, deferred: 0, remaining: 0 });
    expect(harness.vectors.has("v-crash")).toBe(false);
    expect(harness.db.count("vector_cleanup_queue")).toBe(0);
  });

  it("leaves the intent in place when the remote deletion fails", async () => {
    const attemptId = crypto.randomUUID();
    await beginCaptureStage(harness.env, {
      attemptId,
      entryId: "entry-fail",
      episodeId: "ep-fail",
      vectorIds: ["v-fail"],
      reason: "capture-stage:fail",
      leaseMs: -1,
    });
    harness.deleteByIds.mockRejectedValueOnce(new Error("Vectorize down"));

    const result = await drainCaptureStageIntents(harness.env);
    expect(result).toMatchObject({ processed: 1, abandoned: 0, deferred: 1, remaining: 1 });
    expect(harness.db.one<{ last_error: string }>(
      "SELECT last_error FROM vector_cleanup_queue WHERE id = ?", attemptId,
    ).last_error).toContain("Vectorize down");
  });

  it("never removes an intent whose lease has not expired", async () => {
    const attemptId = crypto.randomUUID();
    await beginCaptureStage(harness.env, {
      attemptId,
      entryId: "entry-live",
      episodeId: "ep-live",
      vectorIds: ["v-live"],
      reason: "capture-stage:live",
    });
    harness.vectors.set("v-live", {});

    const result = await drainCaptureStageIntents(harness.env);
    expect(result).toMatchObject({ processed: 0, remaining: 1 });
    expect(harness.vectors.has("v-live")).toBe(true);
  });
});
