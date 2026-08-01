import { describe, it, expect, beforeEach, vi } from "vitest";
import worker, {
  _resetDbReady,
  drainVectorCleanupQueue,
  forgetEntry,
  reindexAllVectors,
} from "../../src/testing";
import { makeTestEnv, makeTestDb, makeVectorizeMock } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import type { Env } from "../../src/testing";
import { D1Mock } from "../helpers/d1-mock";
import { TEST_USER_ID } from "../helpers/test-principal";

function makeCtx() {
  const promises: Promise<any>[] = [];
  return {
    ctx: {
      waitUntil: (p: Promise<any>) => { promises.push(p); },
    } as any,
    flush: () => Promise.all(promises),
  };
}

describe("Vector Metadata & Filtering", () => {
  let env: Env;
  let db: D1Mock;
  let aliceKey: string;
  let bobKey: string;
  let insertedVectors: any[];

  beforeEach(async () => {
    db = makeTestDb();
    insertedVectors = [];
    const vectorize = makeVectorizeMock({
      insert: vi.fn().mockImplementation(async (vectors: any[]) => {
        insertedVectors.push(...vectors);
        return { mutationId: "m" };
      }),
      upsert: vi.fn().mockImplementation(async (vectors: any[]) => {
        insertedVectors.push(...vectors);
        return { mutationId: "m" };
      }),
      query: vi.fn().mockResolvedValue({ matches: [] }),
      getByIds: vi.fn().mockResolvedValue([]),
      deleteByIds: vi.fn().mockResolvedValue({ mutationId: "m" }),
    });
    env = makeTestEnv(db, { VECTORIZE: vectorize });
    _resetDbReady();

    // Initialize database (creates system user)
    const { ctx, flush } = makeCtx();
    await worker.fetch(req("GET", "/list"), env, ctx);
    await flush();

    // Create two users
    const createAlice = await worker.fetch(req("POST", "/api/users", { body: { username: "alice" } }), env, makeCtx().ctx);
    const aliceData = await createAlice.json() as any;
    aliceKey = aliceData.key;

    const createBob = await worker.fetch(req("POST", "/api/users", { body: { username: "bob" } }), env, makeCtx().ctx);
    const bobData = await createBob.json() as any;
    bobKey = bobData.key;
  });

  it("New vectors include owner_user_id in metadata", async () => {
    const { ctx, flush } = makeCtx();
    await worker.fetch(
      req("POST", "/capture", { body: { content: "Alice note" }, userCredentials: { username: "alice", key: aliceKey } }),
      env, ctx
    );
    await flush();

    expect(insertedVectors.length).toBeGreaterThan(0);
    for (const v of insertedVectors) {
      expect(v.metadata.owner_user_id).toBeDefined();
      expect(typeof v.metadata.owner_user_id).toBe("string");
    }
  });

  it("New vectors include is_private in metadata", async () => {
    const { ctx, flush } = makeCtx();
    await worker.fetch(
      req("POST", "/capture", { body: { content: "Private note", tags: ["private"] }, userCredentials: { username: "alice", key: aliceKey } }),
      env, ctx
    );
    await flush();

    expect(insertedVectors.length).toBeGreaterThan(0);
    for (const v of insertedVectors) {
      expect(v.metadata.is_private).toBe(true);
    }
  });

  it("Public entry vectors have is_private=false", async () => {
    const { ctx, flush } = makeCtx();
    await worker.fetch(
      req("POST", "/capture", { body: { content: "Public note", visibility: "public" }, userCredentials: { username: "alice", key: aliceKey } }),
      env, ctx
    );
    await flush();

    expect(insertedVectors.length).toBeGreaterThan(0);
    for (const v of insertedVectors) {
      expect(v.metadata.is_private).toBe(false);
    }
  });

  it("recall issues separate supported owner and public Vectorize filters", async () => {
    const queryFn = vi.fn().mockResolvedValue({ matches: [] });
    const vectorize = makeVectorizeMock({ query: queryFn });
    env = makeTestEnv(db, { VECTORIZE: vectorize });

    // Seed entries directly
    db.entries.push(
      { id: "alice-pub", content: "Alice public", tags: '[]', source: "api", created_at: 1000, vector_ids: '["v1"]', owner_user_id: "alice-id", recall_count: 0, importance_score: 0, contradiction_wins: 0, contradiction_losses: 0 },
      { id: "alice-priv", content: "Alice private", tags: '["private"]', source: "api", created_at: 2000, vector_ids: '["v2"]', owner_user_id: "alice-id", recall_count: 0, importance_score: 0, contradiction_wins: 0, contradiction_losses: 0 },
      { id: "bob-priv", content: "Bob private", tags: '["private"]', source: "api", created_at: 3000, vector_ids: '["v3"]', owner_user_id: "bob-id", recall_count: 0, importance_score: 0, contradiction_wins: 0, contradiction_losses: 0 },
    );

    const { ctx, flush } = makeCtx();
    await worker.fetch(
      req("GET", "/recall?query=test&topK=10", { userCredentials: { username: "alice", key: aliceKey } }),
      env, ctx
    );
    await flush();

    expect(queryFn).toHaveBeenCalledTimes(2);
    const ownerOpts = queryFn.mock.calls[0][1];
    const publicOpts = queryFn.mock.calls[1][1];
    expect(ownerOpts.filter).toEqual({ owner_user_id: { $eq: expect.any(String) } });
    expect(publicOpts.filter).toEqual({ is_private: { $eq: false } });
    expect(ownerOpts).not.toHaveProperty("metadataFilter");
    expect(publicOpts).not.toHaveProperty("metadataFilter");
  });

  it("Duplicate detection issues separate supported owner and public filters", async () => {
    const queryFn = vi.fn().mockResolvedValue({ matches: [] });
    const vectorize = makeVectorizeMock({ query: queryFn });
    env = makeTestEnv(db, { VECTORIZE: vectorize });

    const { ctx, flush } = makeCtx();
    await worker.fetch(
      req("POST", "/capture", { body: { content: "Test note" }, userCredentials: { username: "alice", key: aliceKey } }),
      env, ctx
    );
    await flush();

    expect(queryFn).toHaveBeenCalledTimes(2);
    const ownerOpts = queryFn.mock.calls[0][1];
    const publicOpts = queryFn.mock.calls[1][1];
    expect(ownerOpts.filter).toEqual({ owner_user_id: { $eq: expect.any(String) } });
    expect(publicOpts.filter).toEqual({ is_private: { $eq: false } });
    expect(ownerOpts).not.toHaveProperty("metadataFilter");
    expect(publicOpts).not.toHaveProperty("metadataFilter");
  });

  it("rebuilds a current entry projection and its current-episode passages with canonical metadata", async () => {
    const deleteByIds = vi.fn().mockResolvedValue({ mutationId: "deleted" });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        upsert: vi.fn().mockImplementation(async (vectors: any[]) => {
          insertedVectors.push(...vectors);
          return { mutationId: "upserted" };
        }),
        deleteByIds,
      }),
    });
    db.entries.push({
      id: "entry-1", content: "Current projection", tags: '["private","work"]',
      source: "api", created_at: 1000, vector_ids: '["legacy-entry-vector"]',
      owner_user_id: "alice-id", visibility: "private", current_episode_id: "episode-1",
      recall_count: 0, importance_score: 0,
    });
    db.episodes.push({
      id: "episode-1", entry_id: "entry-1", mutation_id: "mutation-1",
      materialized_content: "Current projection",
    });
    db.passages.push(
      { id: "passage-1", entry_id: "entry-1", episode_id: "episode-1", content: "First passage", section: "One", vector_ids: '["legacy-passage-1"]' },
      { id: "passage-2", entry_id: "entry-1", episode_id: "episode-1", content: "Second passage", section: "Two", vector_ids: '["legacy-passage-2"]' },
      { id: "historical", entry_id: "entry-1", episode_id: "episode-old", content: "Old passage", section: "Old", vector_ids: '["keep-history"]' },
    );

    const result = await reindexAllVectors(env);

    expect(result).toEqual({
      entries_processed: 1,
      passages_processed: 2,
      failed: 0,
      stale_deleted: 3,
      failures: [],
    });
    expect(insertedVectors.map((vector: any) => vector.id)).toEqual([
      "ev:episode-1:0",
      "pv:passage-1",
      "pv:passage-2",
    ]);
    for (const vector of insertedVectors) {
      expect(vector.metadata).toMatchObject({
        parentId: "entry-1",
        episodeId: "episode-1",
        mutationId: "mutation-1",
        owner_user_id: "alice-id",
        is_private: true,
      });
    }
    expect(insertedVectors[1].metadata.passageId).toBe("passage-1");
    expect(insertedVectors[2].metadata.passageId).toBe("passage-2");
    expect(db.entries[0].vector_ids).toBe('["ev:episode-1:0"]');
    expect(db.passages.find((row: any) => row.id === "passage-1")?.vector_ids).toBe('["pv:passage-1"]');
    expect(db.passages.find((row: any) => row.id === "passage-2")?.vector_ids).toBe('["pv:passage-2"]');
    expect(db.passages.find((row: any) => row.id === "historical")?.vector_ids).toBe('["keep-history"]');
    expect(deleteByIds).toHaveBeenCalledWith([
      "legacy-entry-vector",
      "legacy-passage-1",
      "legacy-passage-2",
    ]);
  });

  it("fails a legacy entry closed without fabricating lineage or deleting its old vectors", async () => {
    const upsert = vi.fn();
    const deleteByIds = vi.fn();
    env = makeTestEnv(db, { VECTORIZE: makeVectorizeMock({ upsert, deleteByIds }) });
    db.entries.push({
      id: "legacy-entry", content: "Needs operator review", tags: "[]", source: "api",
      created_at: 1000, vector_ids: '["legacy-vector"]', owner_user_id: "alice-id",
      visibility: "private", current_episode_id: null,
    });
    db.passages.push({
      id: "legacy-passage", entry_id: "legacy-entry", episode_id: null,
      content: "Legacy evidence", vector_ids: '["legacy-passage-vector"]',
    });

    const result = await reindexAllVectors(env);

    expect(result).toEqual({
      entries_processed: 0,
      passages_processed: 0,
      failed: 1,
      stale_deleted: 0,
      failures: [{
        entry_id: "legacy-entry",
        code: "current_episode_missing",
        entry_vector_count: 1,
        passage_count: 1,
        passage_vector_count: 1,
      }],
    });
    expect(db.episodes).toEqual([]);
    expect(upsert).not.toHaveBeenCalled();
    expect(deleteByIds).not.toHaveBeenCalled();
  });

  it("continues after an upsert failure and never deletes the failed entry's old IDs", async () => {
    const upsert = vi.fn()
      .mockRejectedValueOnce(new Error("Vectorize unavailable"))
      .mockResolvedValueOnce({ mutationId: "ok" });
    const deleteByIds = vi.fn().mockResolvedValue({ mutationId: "deleted" });
    env = makeTestEnv(db, { VECTORIZE: makeVectorizeMock({ upsert, deleteByIds }) });
    for (const suffix of ["bad", "good"]) {
      db.entries.push({
        id: suffix, content: suffix, tags: "[]", source: "api", created_at: 1000,
        vector_ids: JSON.stringify([`old-${suffix}`]), owner_user_id: "alice-id",
        visibility: "public", current_episode_id: `episode-${suffix}`,
      });
      db.episodes.push({
        id: `episode-${suffix}`, entry_id: suffix, mutation_id: `mutation-${suffix}`,
        materialized_content: suffix,
      });
    }

    const result = await reindexAllVectors(env);

    expect(result.entries_processed).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.stale_deleted).toBe(1);
    expect(result.failures).toEqual([{
      entry_id: "bad",
      code: "vector_upsert_failed",
      entry_vector_count: 1,
      passage_count: 0,
      passage_vector_count: 0,
    }]);
    expect(deleteByIds).toHaveBeenCalledTimes(1);
    expect(deleteByIds).toHaveBeenCalledWith(["old-good"]);
    expect(db.entries.find((row: any) => row.id === "bad")?.vector_ids).toBe('["old-bad"]');
  });

  it("is idempotent when canonical tracked IDs already match", async () => {
    const deleteByIds = vi.fn();
    env = makeTestEnv(db, { VECTORIZE: makeVectorizeMock({ deleteByIds }) });
    db.entries.push({
      id: "repeat", content: "repeat", tags: "[]", source: "api", created_at: 1000,
      vector_ids: '["ev:episode-repeat:0"]', owner_user_id: "alice-id", revision: 2,
      visibility: "public", current_episode_id: "episode-repeat",
    });
    db.episodes.push({ id: "episode-repeat", entry_id: "repeat", mutation_id: "mutation-repeat", materialized_content: "repeat" });
    db.passages.push({
      id: "passage-repeat", entry_id: "repeat", episode_id: "episode-repeat",
      content: "repeat passage", vector_ids: '["pv:passage-repeat"]',
    });

    const result = await reindexAllVectors(env);

    expect(result).toMatchObject({
      entries_processed: 1,
      passages_processed: 1,
      failed: 0,
      stale_deleted: 0,
    });
    expect(deleteByIds).not.toHaveBeenCalled();
    expect(db.vector_cleanup_queue).toEqual([]);
  });

  it("durably queues stale IDs when deletion fails and allows the cleanup worker to retry", async () => {
    const deleteByIds = vi.fn()
      .mockRejectedValueOnce(new Error("delete outage"))
      .mockResolvedValue({ mutationId: "retry-ok" });
    env = makeTestEnv(db, { VECTORIZE: makeVectorizeMock({ deleteByIds }) });
    db.entries.push({
      id: "cleanup", content: "cleanup", tags: "[]", source: "api", created_at: 1000,
      vector_ids: '["legacy-cleanup"]', owner_user_id: "alice-id", revision: 3,
      visibility: "private", current_episode_id: "episode-cleanup",
    });
    db.episodes.push({ id: "episode-cleanup", entry_id: "cleanup", mutation_id: "mutation-cleanup", materialized_content: "cleanup" });

    const reindex = await reindexAllVectors(env);

    expect(reindex).toMatchObject({ entries_processed: 1, failed: 1, stale_deleted: 0 });
    expect(reindex.failures).toEqual([{
      entry_id: "cleanup",
      code: "stale_delete_failed",
      entry_vector_count: 1,
      passage_count: 0,
      passage_vector_count: 0,
    }]);
    expect(db.entries[0].vector_ids).toBe('["ev:episode-cleanup:0"]');
    expect(db.vector_cleanup_queue).toHaveLength(1);
    expect(JSON.parse(db.vector_cleanup_queue[0].vector_ids)).toEqual(["legacy-cleanup"]);

    const retried = await drainVectorCleanupQueue(env);
    expect(retried).toEqual({ processed: 1, deleted: 1, failed: 0, remaining: 0 });
    expect(db.vector_cleanup_queue).toEqual([]);
  });

  it("returns exact failure counts when cleanup deletion and its diagnostic update both fail", async () => {
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        deleteByIds: vi.fn().mockRejectedValue(new Error("delete outage")),
      }),
    });
    db.entries.push({
      id: "cleanup-diagnostic", content: "cleanup", tags: "[]", source: "api", created_at: 1000,
      vector_ids: '["legacy-cleanup"]', owner_user_id: "alice-id", revision: 3,
      visibility: "private", current_episode_id: "episode-cleanup-diagnostic",
    });
    db.episodes.push({
      id: "episode-cleanup-diagnostic", entry_id: "cleanup-diagnostic",
      mutation_id: "mutation-cleanup-diagnostic", materialized_content: "cleanup",
    });
    const originalPrepare = env.DB.prepare.bind(env.DB);
    vi.spyOn(env.DB, "prepare").mockImplementation((sql: string) => {
      if (sql.replace(/\s+/g, " ").trim().startsWith("UPDATE vector_cleanup_queue SET attempts")) {
        return {
          bind: () => ({ run: vi.fn().mockRejectedValue(new Error("D1 diagnostic outage")) }),
        } as unknown as D1PreparedStatement;
      }
      return originalPrepare(sql);
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await reindexAllVectors(env);

    expect(result).toMatchObject({ entries_processed: 1, failed: 1, stale_deleted: 0 });
    expect(result.failures).toEqual([{
      entry_id: "cleanup-diagnostic",
      code: "stale_delete_failed",
      entry_vector_count: 1,
      passage_count: 0,
      passage_vector_count: 0,
    }]);
    expect(db.vector_cleanup_queue).toHaveLength(1);
    expect(consoleError).toHaveBeenCalledWith(
      "Re-index cleanup queue diagnostic update failed",
      expect.objectContaining({ entry_id: "cleanup-diagnostic" }),
    );
  });

  it("cleans only newly staged IDs when guarded projection persistence loses a race", async () => {
    const deleteByIds = vi.fn().mockResolvedValue({ mutationId: "cleanup-ok" });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        upsert: vi.fn().mockImplementation(async () => {
          Object.assign(db.entries[0], {
            revision: 2,
            current_episode_id: "episode-race-winner",
            vector_ids: '["ev:episode-race-winner:0"]',
          });
          return { mutationId: "staged" };
        }),
        deleteByIds,
      }),
    });
    db.entries.push({
      id: "race", content: "losing projection", tags: "[]", source: "api", created_at: 1000,
      vector_ids: '["ev:episode-race-loser:0"]', owner_user_id: "alice-id", revision: 1,
      visibility: "private", current_episode_id: "episode-race-loser",
    });
    db.episodes.push({
      id: "episode-race-loser", entry_id: "race", mutation_id: "mutation-race-loser",
      materialized_content: "losing projection",
    });
    db.passages.push({
      id: "race-passage", entry_id: "race", episode_id: "episode-race-loser",
      content: "newly staged passage", vector_ids: '["legacy-race-passage"]',
    });

    const result = await reindexAllVectors(env);

    expect(result).toMatchObject({ entries_processed: 0, failed: 1, stale_deleted: 0 });
    expect(result.failures).toEqual([expect.objectContaining({
      entry_id: "race",
      code: "projection_persist_failed",
    })]);
    expect(deleteByIds).toHaveBeenCalledOnce();
    expect(deleteByIds).toHaveBeenCalledWith(["pv:race-passage"]);
    expect(deleteByIds.mock.calls[0][0]).not.toContain("ev:episode-race-loser:0");
    expect(db.entries[0]).toMatchObject({
      revision: 2,
      current_episode_id: "episode-race-winner",
      vector_ids: '["ev:episode-race-winner:0"]',
    });
    expect(db.passages[0].vector_ids).toBe('["legacy-race-passage"]');
    expect(db.vector_cleanup_queue).toEqual([]);
  });

  it("directly deletes new-only vectors when the aborted-cleanup queue insert fails", async () => {
    const deleteByIds = vi.fn().mockResolvedValue({ mutationId: "cleanup-ok" });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        upsert: vi.fn().mockImplementation(async () => {
          Object.assign(db.entries[0], {
            revision: 2,
            current_episode_id: "episode-queue-race-winner",
            vector_ids: '["ev:episode-queue-race-winner:0"]',
          });
          return { mutationId: "staged" };
        }),
        deleteByIds,
      }),
    });
    db.entries.push({
      id: "queue-race", content: "losing projection", tags: "[]", source: "api", created_at: 1000,
      vector_ids: '["ev:episode-queue-race-loser:0"]', owner_user_id: "alice-id", revision: 1,
      visibility: "private", current_episode_id: "episode-queue-race-loser",
    });
    db.episodes.push({
      id: "episode-queue-race-loser", entry_id: "queue-race", mutation_id: "mutation-queue-race-loser",
      materialized_content: "losing projection",
    });
    db.passages.push({
      id: "queue-race-passage", entry_id: "queue-race", episode_id: "episode-queue-race-loser",
      content: "newly staged passage", vector_ids: '["legacy-queue-race-passage"]',
    });
    const originalPrepare = env.DB.prepare.bind(env.DB);
    vi.spyOn(env.DB, "prepare").mockImplementation((sql: string) => {
      const normalized = sql.replace(/\s+/g, " ").trim();
      if (normalized.startsWith("INSERT INTO vector_cleanup_queue")
          && normalized.includes("VALUES")) {
        return {
          bind: () => ({ run: vi.fn().mockRejectedValue(new Error("D1 queue outage")) }),
        } as unknown as D1PreparedStatement;
      }
      return originalPrepare(sql);
    });

    const result = await reindexAllVectors(env);

    expect(result.failures).toEqual([expect.objectContaining({ code: "projection_persist_failed" })]);
    expect(deleteByIds).toHaveBeenCalledOnce();
    expect(deleteByIds).toHaveBeenCalledWith(["pv:queue-race-passage"]);
    expect(db.vector_cleanup_queue).toEqual([]);
  });

  it("reports a safe unreconciled error when queueing and direct new-only cleanup both fail", async () => {
    const deleteByIds = vi.fn().mockRejectedValue(new Error("Vectorize cleanup outage"));
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        upsert: vi.fn().mockImplementation(async () => {
          Object.assign(db.entries[0], {
            revision: 2,
            current_episode_id: "episode-double-failure-winner",
            vector_ids: '["ev:episode-double-failure-winner:0"]',
          });
          return { mutationId: "staged" };
        }),
        deleteByIds,
      }),
    });
    db.entries.push({
      id: "double-failure", content: "sensitive losing content", tags: "[]", source: "api",
      created_at: 1000, vector_ids: '["ev:episode-double-failure-loser:0"]',
      owner_user_id: "alice-id", revision: 1, visibility: "private",
      current_episode_id: "episode-double-failure-loser",
    });
    db.episodes.push({
      id: "episode-double-failure-loser", entry_id: "double-failure",
      mutation_id: "mutation-double-failure-loser", materialized_content: "sensitive losing content",
    });
    db.passages.push({
      id: "double-failure-passage", entry_id: "double-failure",
      episode_id: "episode-double-failure-loser", content: "sensitive passage",
      vector_ids: '["legacy-double-failure-passage"]',
    });
    const originalPrepare = env.DB.prepare.bind(env.DB);
    vi.spyOn(env.DB, "prepare").mockImplementation((sql: string) => {
      const normalized = sql.replace(/\s+/g, " ").trim();
      if (normalized.startsWith("INSERT INTO vector_cleanup_queue")
          && normalized.includes("VALUES")) {
        return {
          bind: () => ({ run: vi.fn().mockRejectedValue(new Error("D1 queue outage")) }),
        } as unknown as D1PreparedStatement;
      }
      return originalPrepare(sql);
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await reindexAllVectors(env);

    expect(result.failures).toEqual([expect.objectContaining({ code: "projection_persist_failed" })]);
    expect(deleteByIds).toHaveBeenCalledOnce();
    expect(deleteByIds).toHaveBeenCalledWith(["pv:double-failure-passage"]);
    expect(consoleError).toHaveBeenCalledWith(
      "Re-index aborted cleanup unreconciled",
      { entry_id: "double-failure", error: "Vectorize cleanup outage" },
    );
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain("sensitive");
    expect(db.vector_cleanup_queue).toEqual([]);
  });

  it("keeps raced new-only IDs durably queued so a later forget cannot miss them", async () => {
    const deleteByIds = vi.fn()
      .mockRejectedValueOnce(new Error("orphan cleanup outage"))
      .mockResolvedValue({ mutationId: "later-ok" });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        upsert: vi.fn().mockImplementation(async () => {
          Object.assign(db.entries[0], {
            revision: 2,
            current_episode_id: "episode-race-winner",
            vector_ids: '["ev:episode-race-winner:0"]',
          });
          return { mutationId: "staged" };
        }),
        deleteByIds,
      }),
    });
    db.entries.push({
      id: "race-forget", content: "losing projection", tags: "[]", source: "api", created_at: 1000,
      vector_ids: '["ev:episode-race-loser:0"]', owner_user_id: "alice-id", revision: 1,
      visibility: "private", current_episode_id: "episode-race-loser",
    });
    db.episodes.push({
      id: "episode-race-loser", entry_id: "race-forget", mutation_id: "mutation-race-loser",
      materialized_content: "losing projection",
    });
    db.passages.push({
      id: "race-forget-passage", entry_id: "race-forget", episode_id: "episode-race-loser",
      content: "newly staged passage", vector_ids: '["legacy-race-passage"]',
    });

    const result = await reindexAllVectors(env);
    expect(result.failures).toEqual([expect.objectContaining({ code: "projection_persist_failed" })]);
    expect(db.vector_cleanup_queue).toHaveLength(1);
    expect(JSON.parse(db.vector_cleanup_queue[0].vector_ids)).toEqual(["pv:race-forget-passage"]);

    await expect(forgetEntry("race-forget", env)).resolves.toMatchObject({ status: "deleted" });
    expect(db.vector_cleanup_queue).toEqual([]);
    expect(deleteByIds.mock.calls.map(([ids]) => ids)).toEqual([
      ["pv:race-forget-passage"],
      ["ev:episode-race-winner:0", "legacy-race-passage", "pv:race-forget-passage"],
    ]);
  });

  it("POST /vectorize-pending?reindex=true triggers re-index", async () => {
    db.entries.push(
      { id: "re-1", content: "Re-index me", tags: '[]', source: "api", created_at: 1000, vector_ids: '["old-v1"]', owner_user_id: TEST_USER_ID, visibility: "public", current_episode_id: "episode-re-1", recall_count: 0, importance_score: 0, contradiction_wins: 0, contradiction_losses: 0 },
    );
    db.episodes.push({ id: "episode-re-1", entry_id: "re-1", mutation_id: "mutation-re-1", materialized_content: "Re-index me" });

    const { ctx } = makeCtx();
    const res = await worker.fetch(
      req("POST", "/vectorize-pending?reindex=true"),
      env, ctx
    );
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(data.reindex).toBe(true);
    expect(data).toMatchObject({
      entries_processed: 1,
      passages_processed: 0,
      failed: 0,
      stale_deleted: 1,
    });
  });

  it("returns non-2xx and metadata-only failure details when any reindex item fails", async () => {
    db.entries.push({
      id: "legacy-route", content: "sensitive body must not be reported", tags: "[]",
      source: "api", created_at: 1000, vector_ids: '["old-v1"]', owner_user_id: TEST_USER_ID,
      visibility: "private", current_episode_id: null,
    });

    const res = await worker.fetch(req("POST", "/vectorize-pending?reindex=true"), env, makeCtx().ctx);
    const data = await res.json() as any;

    expect(res.status).toBe(503);
    expect(data).toMatchObject({ ok: false, reindex: true, failed: 1 });
    expect(data.failures).toEqual([{
      entry_id: "legacy-route",
      code: "current_episode_missing",
      entry_vector_count: 1,
      passage_count: 0,
      passage_vector_count: 0,
    }]);
    expect(JSON.stringify(data)).not.toContain("sensitive body");
  });
});
