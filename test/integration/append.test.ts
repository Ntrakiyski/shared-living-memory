import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/testing";
import { makeTestDb, makeTestEnv, makeVectorizeMock } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import type { Env } from "../../src/testing";
import { D1Mock } from "../helpers/d1-mock";
import { TEST_USER_ID } from "../helpers/test-principal";

const ctx = { waitUntil: (_: Promise<any>) => {} } as any;
const LONG_CONTENT = "a".repeat(1601);

function seedEntry(db: D1Mock, overrides: Record<string, unknown> = {}) {
  const createdAt = Date.now() - 1_000;
  const entry = {
    id: "entry-1",
    content: "Original content",
    tags: "[]",
    source: "api",
    created_at: createdAt,
    vector_ids: '["old-vector"]',
    owner_user_id: TEST_USER_ID,
    revision: 0,
    current_episode_id: null,
    recorded_at: createdAt,
    valid_from: createdAt,
    valid_to: null,
    epistemic_status: "canonical",
    visibility: "public",
    ...overrides,
  };
  db.entries.push(entry);
  return entry;
}

describe("POST /append", () => {
  let env: Env;
  let db: D1Mock;

  beforeEach(() => {
    db = makeTestDb();
    env = makeTestEnv(db);
  });

  it("returns 400 when id is missing", async () => {
    const res = await worker.fetch(req("POST", "/append", { body: { addition: "update" } }), env, ctx);
    expect(res.status).toBe(400);
  });

  it("returns 400 when addition is missing", async () => {
    const res = await worker.fetch(req("POST", "/append", { body: { id: "abc" } }), env, ctx);
    expect(res.status).toBe(400);
  });

  it("returns 404 for a non-existent id", async () => {
    const res = await worker.fetch(
      req("POST", "/append", { body: { id: "no-such-id", addition: "update" } }),
      env,
      ctx,
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ ok: false });
  });

  it("appends through one atomic version with exact raw provenance", async () => {
    seedEntry(db);

    const res = await worker.fetch(
      req("POST", "/append", { body: { id: "entry-1", addition: "New info" } }),
      env,
      ctx,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, id: "entry-1" });

    const entry = db.entries[0] as any;
    expect(entry.content).toContain("Original content");
    expect(entry.content).toContain("New info");
    expect(entry.revision).toBe(1);
    expect(entry.current_episode_id).toEqual(expect.any(String));
    expect(db.entry_snapshots).toHaveLength(1);
    expect(db.entry_snapshots[0]).toMatchObject({
      entry_id: "entry-1",
      content: "Original content",
      revision: 0,
      mutation_kind: "append",
    });

    // A legacy row receives a baseline episode and the append becomes the
    // current immutable episode. The episode keeps the exact addition while
    // materialized_content holds the full projected state.
    expect(db.episodes).toHaveLength(2);
    const currentEpisode = db.episodes.find((episode: any) => episode.id === entry.current_episode_id);
    expect(currentEpisode).toMatchObject({
      entry_id: "entry-1",
      content: "New info",
      mutation_kind: "append",
    });
    expect(currentEpisode.materialized_content).toBe(entry.content);
    expect(currentEpisode.parent_episode_id).toEqual(expect.any(String));
  });

  it.each([
    ["short", "Short original", "Small addition"],
    ["oversized", LONG_CONTENT, "More info"],
  ])("%s append replaces the projection with version-scoped ev: vectors", async (_label, content, addition) => {
    const upsertMock = vi.fn().mockResolvedValue({ mutationId: "m" });
    const insertMock = vi.fn().mockResolvedValue({ mutationId: "m" });
    const deleteByIdsMock = vi.fn().mockResolvedValue({ mutationId: "m" });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({ upsert: upsertMock, insert: insertMock, deleteByIds: deleteByIdsMock }),
    });
    seedEntry(db, { content, vector_ids: '["legacy-a","legacy-b"]' });

    const res = await worker.fetch(
      req("POST", "/append", { body: { id: "entry-1", addition } }),
      env,
      ctx,
    );

    expect(res.status).toBe(200);
    expect(upsertMock).toHaveBeenCalledOnce();
    expect(insertMock).not.toHaveBeenCalled();
    const vectors = upsertMock.mock.calls[0][0] as any[];
    expect(vectors.length).toBeGreaterThan(0);
    expect(vectors.every((vector: any) => /^ev:[0-9a-f-]{36}:\d+$/.test(vector.id))).toBe(true);
    expect(JSON.parse((db.entries[0] as any).vector_ids)).toEqual(vectors.map((vector: any) => vector.id));
    expect(vectors.every((vector: any) => !vector.id.includes("-update-"))).toBe(true);
    expect(deleteByIdsMock).toHaveBeenCalledWith(["legacy-a", "legacy-b"]);
  });

  it("stages version vectors before deleting the prior projection", async () => {
    const callOrder: string[] = [];
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        upsert: vi.fn().mockImplementation(async () => {
          callOrder.push("upsert");
          return { mutationId: "m" };
        }),
        deleteByIds: vi.fn().mockImplementation(async () => {
          callOrder.push("delete");
          return { mutationId: "m" };
        }),
      }),
    });
    seedEntry(db);

    await worker.fetch(
      req("POST", "/append", { body: { id: "entry-1", addition: "More info" } }),
      env,
      ctx,
    );

    expect(callOrder).toEqual(["upsert", "delete"]);
  });

  it("fails closed when vector staging fails", async () => {
    const deleteByIdsMock = vi.fn().mockResolvedValue({ mutationId: "cleanup" });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        upsert: vi.fn().mockRejectedValue(new Error("Vectorize down")),
        deleteByIds: deleteByIdsMock,
      }),
    });
    seedEntry(db, { content: LONG_CONTENT, vector_ids: '["last-known-good"]' });

    const res = await worker.fetch(
      req("POST", "/append", { body: { id: "entry-1", addition: "More info" } }),
      env,
      ctx,
    );

    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ ok: false });
    expect((db.entries[0] as any).content).toBe(LONG_CONTENT);
    expect((db.entries[0] as any).vector_ids).toBe('["last-known-good"]');
    expect((db.entries[0] as any).revision).toBe(0);
    expect(db.entry_snapshots).toHaveLength(0);
    expect(db.episodes).toHaveLength(0);
    expect(deleteByIdsMock).toHaveBeenCalledOnce();
    expect(deleteByIdsMock.mock.calls[0][0]).not.toContain("last-known-good");
  });

  it("succeeds when stale-vector cleanup fails and leaves a durable queue row", async () => {
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        deleteByIds: vi.fn().mockRejectedValue(new Error("delete failed")),
      }),
    });
    seedEntry(db, { vector_ids: '["old-a","old-b"]' });

    const res = await worker.fetch(
      req("POST", "/append", { body: { id: "entry-1", addition: "More info" } }),
      env,
      ctx,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
    expect((db.entries[0] as any).revision).toBe(1);
    expect(db.vector_cleanup_queue).toHaveLength(1);
    expect(JSON.parse(db.vector_cleanup_queue[0].vector_ids)).toEqual(["old-a", "old-b"]);
    expect(db.vector_cleanup_queue[0]).toMatchObject({ attempts: 1 });
  });

  it("preserves per-tag metadata on version-scoped vectors", async () => {
    const upsertMock = vi.fn().mockResolvedValue({ mutationId: "m" });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({ upsert: upsertMock }),
    });
    seedEntry(db, { tags: '["work","idea"]', vector_ids: "[]" });

    const res = await worker.fetch(
      req("POST", "/append", { body: { id: "entry-1", addition: "Short update" } }),
      env,
      ctx,
    );

    expect(res.status).toBe(200);
    const vectors = upsertMock.mock.calls[0][0] as any[];
    expect(vectors[0].id).toMatch(/^ev:/);
    expect(vectors[0].metadata).toMatchObject({ tag_work: true, tag_idea: true });
  });

  it("auto-links a similar neighbor after the version commit", async () => {
    seedEntry(db, { id: "target", content: "Original note", vector_ids: "[]" });
    seedEntry(db, {
      id: "neighbor",
      content: "Related memory",
      vector_ids: "[]",
      current_episode_id: "episode-neighbor",
    });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [{
            id: "neighbor",
            score: 0.85,
            metadata: { parentId: "neighbor", episodeId: "episode-neighbor" },
          }],
        }),
      }),
    });

    const res = await worker.fetch(
      req("POST", "/append", { body: { id: "target", addition: "New related detail" } }),
      env,
      ctx,
    );

    expect(res.status).toBe(200);
    const edge = db.edges.find((candidate: any) => candidate.type === "relates_to");
    expect(edge).toBeTruthy();
    expect([edge.source_id, edge.target_id].sort()).toEqual(["neighbor", "target"]);
    expect(edge.provenance).toBe("inferred");
  });

  it("does not link a neighbor below the inference threshold", async () => {
    seedEntry(db, { id: "target", content: "Original note", vector_ids: "[]" });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [{ id: "loose", score: 0.6, metadata: { parentId: "loose" } }],
        }),
      }),
    });

    const res = await worker.fetch(
      req("POST", "/append", { body: { id: "target", addition: "New detail" } }),
      env,
      ctx,
    );

    expect(res.status).toBe(200);
    expect(db.edges).toHaveLength(0);
  });
});
