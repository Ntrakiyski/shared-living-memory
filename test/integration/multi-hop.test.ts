import { describe, it, expect, vi, beforeEach } from "vitest";
import { recallEntries } from "../../src/testing";
import { makeTestEnv, makeTestDb, makeVectorizeMock } from "../helpers/make-env";
import type { Env } from "../../src/testing";
import { D1Mock } from "../helpers/d1-mock";
import { TEST_USER_ID } from "../helpers/test-principal";

function makeCtx() {
  const pending: Promise<any>[] = [];
  return {
    ctx: { waitUntil: (p: Promise<any>) => pending.push(p) } as any as ExecutionContext,
    drain: () => Promise.allSettled(pending),
  };
}

function seed(db: D1Mock, id: string, content: string, tags: string[] = []) {
  db.entries.push({ id, content, tags: JSON.stringify(tags), source: "api", created_at: 1000, vector_ids: "[]", recall_count: 0, importance_score: 0, owner_user_id: TEST_USER_ID, visibility: "public" });
}

function pushEdge(db: D1Mock, source_id: string, target_id: string, weight = 0.8) {
  db.edges.push({ id: `${source_id}-${target_id}`, source_id, target_id, type: "relates_to", weight, provenance: "inferred", metadata: "{}", created_at: 1, updated_at: 1 });
}

function denseEnv(db: D1Mock, matches: { id: string; score: number }[]) {
  return makeTestEnv(db, {
    VECTORIZE: makeVectorizeMock({
      query: vi.fn().mockResolvedValue({ matches: matches.map(m => ({ id: m.id, score: m.score, metadata: { parentId: m.id, isUpdate: false } })) }),
    }),
  });
}

describe("multi-hop recall (issue #16)", () => {
  let db: D1Mock;

  beforeEach(() => {
    db = makeTestDb();
  });

  it("hops:0 returns only direct matches even when a graph exists (no regression)", async () => {
    seed(db, "seed", "Direct match");
    seed(db, "neighbor", "Related context");
    pushEdge(db, "seed", "neighbor");
    const env = denseEnv(db, [{ id: "seed", score: 0.9 }]);
    const { ctx } = makeCtx();

    const res = await recallEntries({ query: "direct", topK: 5, hops: 0, userId: TEST_USER_ID }, env, ctx);
    expect(res.matches.map(m => m.id)).toEqual(["seed"]);
  });

  it("hops:1 surfaces a 1-hop neighbor that hops:0 misses, with direct matches still first", async () => {
    seed(db, "seed", "Direct match");
    seed(db, "neighbor", "Related context");
    pushEdge(db, "seed", "neighbor");
    const env = denseEnv(db, [{ id: "seed", score: 0.9 }]);
    const { ctx } = makeCtx();

    const res = await recallEntries({ query: "direct", topK: 5, hops: 1, userId: TEST_USER_ID }, env, ctx);
    expect(res.matches.map(m => m.id)).toEqual(["seed", "neighbor"]);
    expect(res.matches[0].hop).toBe(0);
    expect(res.matches[1].hop).toBe(1);
  });

  it("does not traverse into a status:deprecated neighbor", async () => {
    seed(db, "seed", "Direct match");
    seed(db, "neighbor", "Related context", ["status:deprecated"]);
    pushEdge(db, "seed", "neighbor");
    const env = denseEnv(db, [{ id: "seed", score: 0.9 }]);
    const { ctx } = makeCtx();

    const res = await recallEntries({ query: "direct", topK: 5, hops: 1, userId: TEST_USER_ID }, env, ctx);
    expect(res.matches.map(m => m.id)).toEqual(["seed"]);
  });

  it("does not mutate recall counters for direct or graph-expanded matches", async () => {
    seed(db, "seed", "Direct match");
    seed(db, "neighbor", "Related context");
    pushEdge(db, "seed", "neighbor");
    const env = denseEnv(db, [{ id: "seed", score: 0.9 }]);
    const { ctx, drain } = makeCtx();

    await recallEntries({ query: "direct", topK: 5, hops: 1, userId: TEST_USER_ID }, env, ctx);
    await drain();

    expect(db.entries.find((e: any) => e.id === "seed").recall_count).toBe(0);
    expect(db.entries.find((e: any) => e.id === "neighbor").recall_count).toBe(0);
  });

  it("reserves graph context within a full topK while keeping the strongest direct matches", async () => {
    for (let i = 0; i < 5; i++) seed(db, `d${i}`, "Direct match");
    seed(db, "neighbor", "Related context");
    pushEdge(db, "d0", "neighbor");
    const env = denseEnv(db, [0, 1, 2, 3, 4].map(i => ({ id: `d${i}`, score: 0.9 - i * 0.05 })));
    const { ctx } = makeCtx();

    const res = await recallEntries({ query: "direct", topK: 5, hops: 1, userId: TEST_USER_ID }, env, ctx);
    expect(res.matches).toHaveLength(5);
    expect(res.matches.map(m => m.id)).toEqual(["d0", "d1", "d2", "d3", "neighbor"]);
    expect(res.matches.at(-1)?.hop).toBe(1);
  });
});
