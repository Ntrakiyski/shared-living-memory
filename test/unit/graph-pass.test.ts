import { describe, it, expect, vi, beforeEach } from "vitest";
import worker, { runGraphPass } from "../../src/testing";
import { makeTestDb, makeTestEnv, makeVectorizeMock } from "../helpers/make-env";
import { D1Mock } from "../helpers/d1-mock";

function makeCtx() {
  const pending: Promise<any>[] = [];
  return {
    ctx: { waitUntil: (p: Promise<any>) => pending.push(p) } as any as ExecutionContext,
    drain: () => Promise.allSettled(pending),
  };
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function currentEntry<T extends { id: string }>(entry: T): T & { current_episode_id: string } {
  return { ...entry, current_episode_id: `episode-${entry.id}` };
}

function currentMatch(id: string, score: number, metadata: Record<string, unknown> = {}) {
  return { id, score, metadata: { parentId: id, episodeId: `episode-${id}`, ...metadata } };
}

describe("runGraphPass", () => {
  let db: D1Mock;

  beforeEach(() => {
    db = makeTestDb();
  });

  it("backfills a relates_to edge for an unlinked entry to its nearest neighbor", async () => {
    db.entries.push(
      currentEntry({ id: "lonely", content: "Unlinked memory", tags: "[]", source: "api", created_at: 2, vector_ids: "[]", owner_user_id: "u1", visibility: "public" }),
      currentEntry({ id: "neighbor", content: "Similar memory", tags: "[]", source: "api", created_at: 1, vector_ids: "[]", owner_user_id: "u1", visibility: "public" }),
    );
    const query = vi.fn().mockResolvedValue({ matches: [
      currentMatch("lonely", 1.0),
      currentMatch("neighbor", 0.8),
    ] });
    const env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query,
      }),
    });
    const { ctx } = makeCtx();

    await runGraphPass(env, ctx);

    const e = db.edges.find((x: any) => x.type === "relates_to");
    expect(e).toBeTruthy();
    expect([e.source_id, e.target_id].sort()).toEqual(["lonely", "neighbor"]);
    expect(e.provenance).toBe("inferred");
    expect(query).toHaveBeenCalled();
    for (const [, options] of query.mock.calls) {
      expect(options).toMatchObject({ filter: { is_private: { $eq: false } } });
      expect(options).not.toHaveProperty("metadataFilter");
    }
  });

  it("does not re-link entries that already have an edge", async () => {
    db.entries.push({ id: "linked", content: "x", tags: "[]", source: "api", created_at: 1, vector_ids: "[]", owner_user_id: "u1", visibility: "public" });
    db.edges.push({ id: "e", source_id: "linked", target_id: "other", type: "relates_to", weight: 0.9, provenance: "explicit", metadata: "{}", created_at: 1, updated_at: 1 });
    const env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({ query: vi.fn().mockResolvedValue({ matches: [{ id: "z", score: 0.9, metadata: { parentId: "z" } }] }) }),
    });
    const { ctx } = makeCtx();

    await runGraphPass(env, ctx);

    expect(db.edges).toHaveLength(1); // unchanged — "linked" already had an edge
  });

  it("prunes weak old inferred edges but keeps explicit and recent ones", async () => {
    const old = 1;
    const recent = Date.now();
    db.edges.push(
      { id: "weak-old", source_id: "a", target_id: "b", type: "relates_to", weight: 0.2, provenance: "inferred", metadata: "{}", created_at: old, updated_at: old },
      { id: "weak-explicit", source_id: "a", target_id: "c", type: "relates_to", weight: 0.2, provenance: "explicit", metadata: "{}", created_at: old, updated_at: old },
      { id: "weak-recent", source_id: "a", target_id: "d", type: "relates_to", weight: 0.2, provenance: "inferred", metadata: "{}", created_at: recent, updated_at: recent },
      { id: "strong-old", source_id: "a", target_id: "e", type: "relates_to", weight: 0.9, provenance: "inferred", metadata: "{}", created_at: old, updated_at: old },
    );
    const env = makeTestEnv(db, { VECTORIZE: makeVectorizeMock() });
    const { ctx } = makeCtx();

    await runGraphPass(env, ctx);

    expect(db.edges.map((x: any) => x.id).sort()).toEqual(["strong-old", "weak-explicit", "weak-recent"]);
  });

  it("is a safe no-op on an empty database", async () => {
    const env = makeTestEnv(db, { VECTORIZE: makeVectorizeMock() });
    const { ctx } = makeCtx();
    await expect(runGraphPass(env, ctx)).resolves.toBeUndefined();
    expect(db.edges).toHaveLength(0);
  });

  it("creates cross-user edges only between public entries", async () => {
    db.entries.push(
      currentEntry({ id: "pub-a", content: "User1 public", tags: "[]", source: "api", created_at: 2, vector_ids: "[]", owner_user_id: "u1", visibility: "public" }),
      currentEntry({ id: "pub-b", content: "User2 public", tags: "[]", source: "api", created_at: 1, vector_ids: "[]", owner_user_id: "u2", visibility: "public" }),
    );
    const env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({ matches: [
          currentMatch("pub-a", 1.0),
          currentMatch("pub-b", 0.85),
        ] }),
      }),
    });
    const { ctx } = makeCtx();
    await runGraphPass(env, ctx);

    const e = db.edges.find((x: any) => x.type === "relates_to");
    expect(e).toBeTruthy();
    expect([e.source_id, e.target_id].sort()).toEqual(["pub-a", "pub-b"]);
  });

  it("does not create edges involving other users' private entries", async () => {
    db.entries.push(
      { id: "priv-other", content: "Other private", tags: '["private"]', source: "api", created_at: 2, vector_ids: "[]", owner_user_id: "u2", visibility: "private" },
      { id: "pub-a", content: "My public", tags: "[]", source: "api", created_at: 1, vector_ids: "[]", owner_user_id: "u1", visibility: "public" },
    );
    const env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({ matches: [
          { id: "priv-other", score: 1.0, metadata: { parentId: "priv-other" } },
          { id: "pub-a", score: 0.9, metadata: { parentId: "pub-a" } },
        ] }),
      }),
    });
    const { ctx } = makeCtx();
    await runGraphPass(env, ctx);

    // No edge should be created because the only neighbor is another user's private entry
    expect(db.edges).toHaveLength(0);
  });

  it("links a private source only to same-owner private entries", async () => {
    db.entries.push(
      currentEntry({ id: "source-private", content: "Private source", tags: '["private"]', source: "api", created_at: 10, vector_ids: "[]", owner_user_id: "u1", visibility: "private" }),
      currentEntry({ id: "own-private", content: "Own private", tags: '["private"]', source: "api", created_at: 9, vector_ids: "[]", owner_user_id: "u1", visibility: "private" }),
      currentEntry({ id: "own-public", content: "Own public", tags: "[]", source: "api", created_at: 8, vector_ids: "[]", owner_user_id: "u1", visibility: "public" }),
      currentEntry({ id: "other-private", content: "Other private", tags: '["private"]', source: "api", created_at: 7, vector_ids: "[]", owner_user_id: "u2", visibility: "private" }),
      currentEntry({ id: "other-public", content: "Other public", tags: "[]", source: "api", created_at: 6, vector_ids: "[]", owner_user_id: "u2", visibility: "public" }),
    );
    // Keep every candidate out of the source backfill batch so this assertion
    // isolates the partition applied to source-private.
    for (const id of ["own-private", "own-public", "other-private", "other-public"]) {
      db.edges.push({ id: `existing-${id}`, source_id: id, target_id: `sentinel-${id}`, type: "relates_to", weight: 1, provenance: "explicit", metadata: "{}", created_at: 1, updated_at: 1 });
    }
    const query = vi.fn().mockResolvedValue({ matches: [
      currentMatch("source-private", 1, { is_private: false }),
      currentMatch("own-private", 0.95, { owner_user_id: "attacker" }),
      currentMatch("own-public", 0.94, { is_private: true }),
      currentMatch("other-private", 0.93, { is_private: false }),
      currentMatch("other-public", 0.92, { owner_user_id: "u1" }),
    ] });
    const env = makeTestEnv(db, { VECTORIZE: makeVectorizeMock({ query }) });

    await runGraphPass(env, makeCtx().ctx);

    const sourceEdges = db.edges.filter(edge =>
      edge.source_id === "source-private" || edge.target_id === "source-private"
    );
    expect(sourceEdges).toHaveLength(1);
    expect([sourceEdges[0].source_id, sourceEdges[0].target_id].sort())
      .toEqual(["own-private", "source-private"]);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0][1]).toMatchObject({
      filter: { owner_user_id: { $eq: "u1" } },
    });
    expect(query.mock.calls[1][1]).toMatchObject({
      filter: { is_private: { $eq: false } },
    });
  });

  it("fails closed without embedding a source whose tags are not an array", async () => {
    db.entries.push({
      id: "malformed", content: "Do not inspect", tags: JSON.stringify("private"),
      source: "api", created_at: 1, vector_ids: "[]", owner_user_id: "u1", visibility: "private",
    });
    const query = vi.fn().mockResolvedValue({ matches: [] });
    const env = makeTestEnv(db, { VECTORIZE: makeVectorizeMock({ query }) });

    await runGraphPass(env, makeCtx().ctx);

    expect(query).not.toHaveBeenCalled();
    expect(db.edges).toHaveLength(0);
  });
});

describe("scheduled handler", () => {
  it("runs the graph pass alongside nightly compression (wired, same cron)", async () => {
    const db = makeTestDb();
    db.entries.push(
      currentEntry({ id: "lonely", content: "x", tags: "[]", source: "api", created_at: 2, vector_ids: "[]", owner_user_id: "u1", visibility: "public" }),
      currentEntry({ id: "neighbor", content: "y", tags: "[]", source: "api", created_at: 1, vector_ids: "[]", owner_user_id: "u1", visibility: "public" }),
    );
    const env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({ matches: [
          currentMatch("lonely", 1.0),
          currentMatch("neighbor", 0.8),
        ] }),
      }),
    });
    const pending: Promise<any>[] = [];
    const ctx = { waitUntil: (p: Promise<any>) => pending.push(p) } as any;

    await (worker as any).scheduled({} as any, env, ctx);
    await Promise.allSettled(pending);

    expect(db.edges.some((e: any) => e.type === "relates_to")).toBe(true);
  });
});
