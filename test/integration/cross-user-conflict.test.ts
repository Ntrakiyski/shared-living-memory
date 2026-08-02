import { describe, it, expect, beforeEach, vi } from "vitest";
import worker from "../../src/testing";
import { makeTestEnv, makeTestDb, makeVectorizeMock } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import type { Env } from "../../src/testing";
import { D1Mock } from "../helpers/d1-mock";
import { TEST_USER_ID } from "../helpers/test-principal";

function makeCtx() {
  const pending: Promise<any>[] = [];
  return {
    ctx: { waitUntil: (p: Promise<any>) => pending.push(p) } as any,
    drain: () => Promise.allSettled(pending),
  };
}

function makeVectorizeQueryFn(matches: any[]) {
  return vi.fn().mockResolvedValue({ matches });
}

describe("Cross-user conflict detection", () => {
  let env: Env;
  let db: D1Mock;

  beforeEach(() => {
    db = makeTestDb();
    env = makeTestEnv(db);
  });

  // ── Capture: cross-user note ──────────────────────────────────────────────

  describe("POST /capture — cross-user note", () => {
    it("includes crossUserNote when similar public content exists from another user", async () => {
      // Seed: another user's public entry
      db.entries.push({
        id: "other-public",
        content: "I love hiking in the mountains",
        tags: "[]",
        source: "api",
        created_at: 1000,
        vector_ids: "[]",
        owner_user_id: "other-user",
        current_episode_id: "episode-other-public",
      });
      db.users.push({
        id: "other-user",
        username: "alice",
        api_key_hash: "hash-other",
        created_at: 1000,
        public_id: "other-pub",
      });

      // Vectorize returns a match from the other user
      const vectorize = makeVectorizeMock({
        query: makeVectorizeQueryFn([
          { id: "other-public", score: 0.90, metadata: { parentId: "other-public", episodeId: "episode-other-public", owner_user_id: "other-user", is_private: false } },
        ]),
      });
      env = makeTestEnv(db, { VECTORIZE: vectorize });

      const { ctx } = makeCtx();
      const res = await worker.fetch(
        req("POST", "/capture", { body: { content: "I enjoy hiking in the mountains too", visibility: "public" } }),
        env, ctx,
      );
      const data = await res.json() as any;
      expect(data.ok).toBe(true);
      expect(data.warnings).toContain("Similar content exists in alice's public memories");
    });

    it("does not block capture when cross-user similarity found", async () => {
      db.entries.push({
        id: "other-public",
        content: "Similar content from another user",
        tags: "[]",
        source: "api",
        created_at: 1000,
        vector_ids: "[]",
        owner_user_id: "other-user",
      });
      db.users.push({
        id: "other-user",
        username: "bob",
        api_key_hash: "hash-other",
        created_at: 1000,
        public_id: "other-pub",
      });

      const vectorize = makeVectorizeMock({
        query: makeVectorizeQueryFn([
          { id: "other-public", score: 0.88, metadata: { parentId: "other-public", owner_user_id: "other-user", is_private: false } },
        ]),
      });
      env = makeTestEnv(db, { VECTORIZE: vectorize });

      const { ctx } = makeCtx();
      const res = await worker.fetch(
        req("POST", "/capture", { body: { content: "Similar content from another user" } }),
        env, ctx,
      );
      const data = await res.json() as any;
      expect(data.ok).toBe(true);
      // Entry should be stored (not blocked)
      expect(data.id).toBeDefined();
      expect(db.entries.length).toBeGreaterThanOrEqual(1);
    });

    it("does not include crossUserNote when match is private", async () => {
      db.entries.push({
        id: "other-private",
        content: "Private entry from another user",
        tags: '["private"]',
        source: "api",
        created_at: 1000,
        vector_ids: "[]",
        owner_user_id: "other-user",
      });

      const vectorize = makeVectorizeMock({
        query: makeVectorizeQueryFn([
          { id: "other-private", score: 0.92, metadata: { parentId: "other-private", owner_user_id: "other-user", is_private: true } },
        ]),
      });
      env = makeTestEnv(db, { VECTORIZE: vectorize });

      const { ctx } = makeCtx();
      const res = await worker.fetch(
        req("POST", "/capture", { body: { content: "Private entry from another user" } }),
        env, ctx,
      );
      const data = await res.json() as any;
      expect(data.ok).toBe(true);
      expect(data.crossUserNote).toBeUndefined();
    });

    it("does not create contradiction edge for cross-user similarity", async () => {
      db.entries.push({
        id: "other-public",
        content: "Cross-user similar content",
        tags: "[]",
        source: "api",
        created_at: 1000,
        vector_ids: "[]",
        owner_user_id: "other-user",
      });
      db.users.push({
        id: "other-user",
        username: "carol",
        api_key_hash: "hash-other",
        created_at: 1000,
        public_id: "other-pub",
      });

      const vectorize = makeVectorizeMock({
        query: makeVectorizeQueryFn([
          { id: "other-public", score: 0.87, metadata: { parentId: "other-public", owner_user_id: "other-user", is_private: false } },
        ]),
      });
      env = makeTestEnv(db, { VECTORIZE: vectorize });

      const { ctx, drain } = makeCtx();
      const res = await worker.fetch(
        req("POST", "/capture", { body: { content: "Cross-user similar content" } }),
        env, ctx,
      );
      await drain();
      const data = await res.json() as any;
      expect(data.ok).toBe(true);
      // No contradiction or supersedes edge should be created
      const relevantEdges = db.edges.filter(e =>
        (e.source_id === "other-public" || e.target_id === "other-public") &&
        (e.edge_type === "contradiction" || e.edge_type === "supersedes")
      );
      expect(relevantEdges).toHaveLength(0);
    });
  });

  // ── Recall: cross-user mention ────────────────────────────────────────────

  describe("GET /recall — cross-user mention", () => {
    it("includes crossUserMention when similar public content exists from another user", async () => {
      // Seed: user's own entry
      db.entries.push({
        id: "my-entry",
        content: "I like coffee",
        tags: "[]",
        source: "api",
        created_at: 1000,
        vector_ids: "[]",
        owner_user_id: TEST_USER_ID,
        recall_count: 0,
        importance_score: 0,
        current_episode_id: "episode-my-entry",
      });
      // Seed: another user's public entry
      db.entries.push({
        id: "other-public",
        content: "I also enjoy coffee very much",
        tags: "[]",
        source: "api",
        created_at: 1000,
        vector_ids: "[]",
        owner_user_id: "other-user",
        recall_count: 0,
        importance_score: 0,
        current_episode_id: "episode-other-public",
      });
      db.users.push({
        id: "other-user",
        username: "dave",
        api_key_hash: "hash-other",
        created_at: 1000,
        public_id: "other-pub",
      });

      // Vectorize returns both entries as matches
      const vectorize = makeVectorizeMock({
        query: makeVectorizeQueryFn([
          { id: "my-entry", score: 0.95, metadata: { parentId: "my-entry", episodeId: "episode-my-entry", owner_user_id: TEST_USER_ID, is_private: false } },
          { id: "other-public", score: 0.90, metadata: { parentId: "other-public", episodeId: "episode-other-public", owner_user_id: "other-user", is_private: false } },
        ]),
      });
      env = makeTestEnv(db, { VECTORIZE: vectorize });

      const ctx = { waitUntil: (_: Promise<any>) => {} } as any;
      const res = await worker.fetch(req("GET", "/recall?query=coffee"), env, ctx);
      const data = await res.json() as any;
      expect(data.ok).toBe(true);
      expect(data.results.length).toBeGreaterThanOrEqual(1);

      // The other user's result should have a crossUserMention
      const otherResult = data.results.find((r: any) => r.id === "other-public");
      expect(otherResult).toBeDefined();
      expect(otherResult.crossUserMention).toBeDefined();
      expect(otherResult.crossUserMention.owner_username).toBe("dave");
      expect(otherResult.crossUserMention.similarity).toBeGreaterThan(85);
    });

    it("does not include crossUserMention for own entries", async () => {
      db.entries.push({
        id: "my-entry",
        content: "My own memory about coffee",
        tags: "[]",
        source: "api",
        created_at: 1000,
        vector_ids: "[]",
        owner_user_id: TEST_USER_ID,
        recall_count: 0,
        importance_score: 0,
      });

      const vectorize = makeVectorizeMock({
        query: makeVectorizeQueryFn([
          { id: "my-entry", score: 0.95, metadata: { parentId: "my-entry", owner_user_id: TEST_USER_ID, is_private: false } },
        ]),
      });
      env = makeTestEnv(db, { VECTORIZE: vectorize });

      const ctx = { waitUntil: (_: Promise<any>) => {} } as any;
      const res = await worker.fetch(req("GET", "/recall?query=coffee"), env, ctx);
      const data = await res.json() as any;
      expect(data.ok).toBe(true);
      expect(data.results.length).toBe(1);
      expect(data.results[0].crossUserMention).toBeUndefined();
    });

    it("does not include crossUserMention for private entries from other users", async () => {
      db.entries.push({
        id: "other-private",
        content: "Private entry from another user",
        tags: '["private"]',
        source: "api",
        created_at: 1000,
        vector_ids: "[]",
        owner_user_id: "other-user",
        recall_count: 0,
        importance_score: 0,
      });

      const vectorize = makeVectorizeMock({
        query: makeVectorizeQueryFn([
          { id: "other-private", score: 0.95, metadata: { parentId: "other-private", owner_user_id: "other-user", is_private: true } },
        ]),
      });
      env = makeTestEnv(db, { VECTORIZE: vectorize });

      const ctx = { waitUntil: (_: Promise<any>) => {} } as any;
      const res = await worker.fetch(req("GET", "/recall?query=private"), env, ctx);
      const data = await res.json() as any;
      expect(data.ok).toBe(true);
      // Should be filtered out entirely (private from another user)
      const otherResult = data.results.find((r: any) => r.id === "other-private");
      expect(otherResult).toBeUndefined();
    });
  });
});
