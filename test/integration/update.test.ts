import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/testing";
import { makeTestDb, makeTestEnv, makeVectorizeMock } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import type { Env } from "../../src/testing";
import { D1Mock } from "../helpers/d1-mock";
import { TEST_USER_ID } from "../helpers/test-principal";

const ctx = { waitUntil: (_: Promise<any>) => {} } as any;

function seedEntry(db: D1Mock, overrides: Record<string, unknown> = {}) {
  const createdAt = Date.now() - 1_000;
  const entry = {
    id: "entry-abc",
    content: "Original content",
    tags: '["work"]',
    source: "api",
    created_at: createdAt,
    vector_ids: '["legacy-vector"]',
    recall_count: 0,
    importance_score: 3,
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

describe("POST /update", () => {
  let db: D1Mock;
  let env: Env;

  beforeEach(() => {
    db = makeTestDb();
    env = makeTestEnv(db);
  });

  it("returns 401 without auth", async () => {
    const res = await worker.fetch(
      req("POST", "/update", { body: { id: "x", content: "new" }, token: null }),
      env,
      ctx,
    );
    expect(res.status).toBe(401);
  });

  it("returns 400 when id is missing", async () => {
    const res = await worker.fetch(
      req("POST", "/update", { body: { content: "new content" } }),
      env,
      ctx,
    );
    expect(res.status).toBe(400);
    expect((await res.json() as any).error).toMatch(/id/);
  });

  it("returns 400 when content is missing or blank", async () => {
    for (const body of [{ id: "entry-abc" }, { id: "entry-abc", content: "   " }]) {
      const res = await worker.fetch(req("POST", "/update", { body }), env, ctx);
      expect(res.status).toBe(400);
      expect((await res.json() as any).error).toMatch(/content/);
    }
  });

  it("returns 404 when the entry does not exist", async () => {
    const res = await worker.fetch(
      req("POST", "/update", { body: { id: "nonexistent", content: "new content" } }),
      env,
      ctx,
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ ok: false });
  });

  it("atomically snapshots, versions, and projects an update", async () => {
    seedEntry(db, { tags: '["work","important"]', source: "claude" });

    const res = await worker.fetch(
      req("POST", "/update", { body: { id: "entry-abc", content: "Updated content" } }),
      env,
      ctx,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, id: "entry-abc", revision: 1 });

    const entry = db.entries[0] as any;
    expect(entry).toMatchObject({
      content: "Updated content",
      source: "claude",
      revision: 1,
    });
    expect(JSON.parse(entry.tags)).toEqual(["work", "important"]);
    expect(entry.current_episode_id).toEqual(expect.any(String));

    expect(db.entry_snapshots).toHaveLength(1);
    expect(db.entry_snapshots[0]).toMatchObject({
      entry_id: "entry-abc",
      content: "Original content",
      tags: '["work","important"]',
      source: "claude",
      revision: 0,
      mutation_kind: "update",
    });
    expect(db.episodes).toHaveLength(2);
    const currentEpisode = db.episodes.find((episode: any) => episode.id === entry.current_episode_id);
    expect(currentEpisode).toMatchObject({
      entry_id: "entry-abc",
      content: "Updated content",
      materialized_content: "Updated content",
      mutation_kind: "update",
    });
    expect(currentEpisode.parent_episode_id).toEqual(expect.any(String));
  });

  it("keeps exact raw input in the episode while materializing hashtag changes", async () => {
    seedEntry(db, { tags: '["work"]' });
    const raw = "  Updated content #newtag  ";

    const res = await worker.fetch(
      req("POST", "/update", { body: { id: "entry-abc", content: raw } }),
      env,
      ctx,
    );

    expect(res.status).toBe(200);
    const entry = db.entries[0] as any;
    expect(entry.content).toBe("Updated content");
    expect(JSON.parse(entry.tags)).toEqual(["work", "newtag"]);
    const episode = db.episodes.find((candidate: any) => candidate.id === entry.current_episode_id);
    expect(episode.content).toBe(raw);
    expect(episode.materialized_content).toBe("Updated content");
  });

  it("accepts a validated explicit replacement source envelope", async () => {
    const captured = await worker.fetch(req("POST", "/capture", {
      body: {
        content: "Original sourced content",
        source_title: "Original explicit title",
        source_url: "https://example.test/original",
        visibility: "public",
      },
    }), env, ctx);
    const capturedBody = await captured.json() as any;

    const updated = await worker.fetch(req("POST", "/update", {
      body: {
        id: capturedBody.id,
        content: "Deliberately replaced sourced content",
        source_title: "Replacement explicit title",
        source_url: "doi:10.1000/replacement",
      },
    }), env, ctx);
    const entry = db.entries.find((candidate: any) => candidate.id === capturedBody.id) as any;
    const episode = db.episodes.find((candidate: any) => candidate.id === entry.current_episode_id);
    const document = db.documents.find((candidate: any) => candidate.episode_id === entry.current_episode_id);

    expect(updated.status).toBe(200);
    expect(episode.source_url).toBe("doi:10.1000/replacement");
    expect(document).toMatchObject({
      title: "Replacement explicit title",
      source_url: "doi:10.1000/replacement",
    });
  });

  it("rejects an unsafe explicit replacement title before versioning", async () => {
    seedEntry(db);
    const secret = `ghp_${"a".repeat(36)}`;

    const res = await worker.fetch(req("POST", "/update", {
      body: { id: "entry-abc", content: "Updated", source_title: secret },
    }), env, ctx);

    expect(res.status).toBe(422);
    expect(JSON.stringify(await res.json())).not.toContain(secret);
    expect(db.entries[0]).toMatchObject({ content: "Original content", revision: 0 });
    expect(db.episodes).toHaveLength(0);
  });

  it("deduplicates an existing hashtag", async () => {
    seedEntry(db, { tags: '["work"]' });

    await worker.fetch(
      req("POST", "/update", { body: { id: "entry-abc", content: "Updated content #work" } }),
      env,
      ctx,
    );

    const tags: string[] = JSON.parse((db.entries[0] as any).tags);
    expect(tags.filter((tag) => tag === "work")).toHaveLength(1);
  });

  it("stages only version-scoped ev: vectors through upsert", async () => {
    const upsertMock = vi.fn().mockResolvedValue({ mutationId: "m" });
    const insertMock = vi.fn().mockResolvedValue({ mutationId: "m" });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({ upsert: upsertMock, insert: insertMock }),
    });
    seedEntry(db);

    const res = await worker.fetch(
      req("POST", "/update", { body: { id: "entry-abc", content: "Brand new content" } }),
      env,
      ctx,
    );

    expect(res.status).toBe(200);
    expect(upsertMock).toHaveBeenCalledOnce();
    expect(insertMock).not.toHaveBeenCalled();
    const vectors = upsertMock.mock.calls[0][0] as any[];
    expect(vectors.every((vector: any) => /^ev:[0-9a-f-]{36}:\d+$/.test(vector.id))).toBe(true);
    expect(vectors[0].metadata.content).toBe("Brand new content");
    expect(JSON.parse((db.entries[0] as any).vector_ids)).toEqual(vectors.map((vector: any) => vector.id));
  });

  it("deletes the complete prior projection after committing unique version ids", async () => {
    const deleteByIdsMock = vi.fn().mockResolvedValue({ mutationId: "m" });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({ deleteByIds: deleteByIdsMock }),
    });
    seedEntry(db, { vector_ids: '["old-a","old-b"]' });

    await worker.fetch(
      req("POST", "/update", { body: { id: "entry-abc", content: "Updated" } }),
      env,
      ctx,
    );

    expect(deleteByIdsMock).toHaveBeenCalledOnce();
    expect(deleteByIdsMock).toHaveBeenCalledWith(["old-a", "old-b"]);
    expect(JSON.parse((db.entries[0] as any).vector_ids)).not.toContain("old-a");
  });

  it("does not request cleanup when the prior projection is empty", async () => {
    const deleteByIdsMock = vi.fn().mockResolvedValue({ mutationId: "m" });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({ deleteByIds: deleteByIdsMock }),
    });
    seedEntry(db, { vector_ids: "[]" });

    await worker.fetch(
      req("POST", "/update", { body: { id: "entry-abc", content: "Updated" } }),
      env,
      ctx,
    );

    expect(deleteByIdsMock).not.toHaveBeenCalled();
  });

  it("fails closed without provenance or projection changes when vector staging fails", async () => {
    const deleteByIdsMock = vi.fn().mockResolvedValue({ mutationId: "cleanup" });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        upsert: vi.fn().mockRejectedValue(new Error("Vectorize down")),
        deleteByIds: deleteByIdsMock,
      }),
    });
    seedEntry(db, { vector_ids: '["old-a","old-b"]' });

    const res = await worker.fetch(
      req("POST", "/update", { body: { id: "entry-abc", content: "Updated content" } }),
      env,
      ctx,
    );

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ ok: false });
    expect(db.entries[0]).toMatchObject({
      content: "Original content",
      tags: '["work"]',
      vector_ids: '["old-a","old-b"]',
      revision: 0,
      current_episode_id: null,
    });
    expect(db.entry_snapshots).toHaveLength(0);
    expect(db.episodes).toHaveLength(0);
    expect(deleteByIdsMock).toHaveBeenCalledOnce();
    expect(deleteByIdsMock.mock.calls[0][0]).not.toContain("old-a");
  });

  it("returns success and preserves a durable cleanup record when deletion fails", async () => {
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        deleteByIds: vi.fn().mockRejectedValue(new Error("Delete failed")),
      }),
    });
    seedEntry(db, { vector_ids: '["old-a","old-b"]' });

    const res = await worker.fetch(
      req("POST", "/update", { body: { id: "entry-abc", content: "Updated content" } }),
      env,
      ctx,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, revision: 1 });
    expect(db.vector_cleanup_queue).toHaveLength(1);
    expect(JSON.parse(db.vector_cleanup_queue[0].vector_ids)).toEqual(["old-a", "old-b"]);
    expect(db.vector_cleanup_queue[0]).toMatchObject({ attempts: 1 });
  });

  it("upserts the new version before deleting the prior projection", async () => {
    const callOrder: string[] = [];
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        upsert: vi.fn().mockImplementation(async () => {
          callOrder.push("upsert");
          return { mutationId: "m" };
        }),
        deleteByIds: vi.fn().mockImplementation(async (ids: string[]) => {
          callOrder.push(`delete:${ids.join(",")}`);
          return { mutationId: "m" };
        }),
      }),
    });
    seedEntry(db, { vector_ids: '["old-vec-1","old-vec-2"]' });

    await worker.fetch(
      req("POST", "/update", { body: { id: "entry-abc", content: "Replaced content" } }),
      env,
      ctx,
    );

    expect(callOrder).toEqual(["upsert", "delete:old-vec-1,old-vec-2"]);
  });
});
