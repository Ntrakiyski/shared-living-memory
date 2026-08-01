import { describe, it, expect, beforeEach, vi } from "vitest";
import worker, { _resetDbReady, reindexAllVectors } from "../../src/testing";
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

  it("Reindex adds ownership metadata to existing vectors", async () => {
    // Seed entries with vectors but no ownership metadata
    db.entries.push(
      { id: "old-1", content: "Old entry", tags: '["private"]', source: "api", created_at: 1000, vector_ids: '["old-v1"]', owner_user_id: "alice-id", recall_count: 0, importance_score: 0, contradiction_wins: 0, contradiction_losses: 0 },
    );

    const result = await reindexAllVectors(env);
    expect(result.processed).toBe(1);
    expect(result.failed).toBe(0);

    // Verify new vectors have ownership metadata
    expect(insertedVectors.length).toBeGreaterThan(0);
    const newVector = insertedVectors.find((v: any) => v.id === "old-1");
    expect(newVector).toBeDefined();
    expect(newVector.metadata.owner_user_id).toBe("alice-id");
    expect(newVector.metadata.is_private).toBe(true);
  });

  it("POST /vectorize-pending?reindex=true triggers re-index", async () => {
    db.entries.push(
      { id: "re-1", content: "Re-index me", tags: '[]', source: "api", created_at: 1000, vector_ids: '["old-v1"]', owner_user_id: TEST_USER_ID, visibility: "public", recall_count: 0, importance_score: 0, contradiction_wins: 0, contradiction_losses: 0 },
    );

    const { ctx } = makeCtx();
    const res = await worker.fetch(
      req("POST", "/vectorize-pending?reindex=true"),
      env, ctx
    );
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(data.reindex).toBe(true);
    expect(data.processed).toBe(1);
  });
});
