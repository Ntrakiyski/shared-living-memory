import { beforeEach, describe, expect, it, vi } from "vitest";
import worker, { _resetDbReady, captureEntry } from "../../src/testing";
import { makeTestDb, makeTestEnv, makeVectorizeMock } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import type { Env } from "../../src/testing";
import { D1Mock } from "../helpers/d1-mock";
import { TEST_USER_ID } from "../helpers/test-principal";

const ctx = { waitUntil: (_: Promise<any>) => {} } as any;

function makeCtx() {
  const pending: Promise<any>[] = [];
  return {
    ctx: { waitUntil: (promise: Promise<any>) => pending.push(promise) } as any,
    drain: () => Promise.allSettled(pending),
  };
}

function makeSseStream(response: string) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: {"response":${JSON.stringify(response)}}\n\n`));
      controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
}

function makePromptAwareAI(mergeResponse: string, classifyResponse: string): Ai {
  return {
    run: vi.fn().mockImplementation(async (model: string, options: any) => {
      if (model === "@cf/baai/bge-small-en-v1.5") {
        return { data: [new Array(384).fill(0.1)] };
      }
      const prompt: string = (options?.messages ?? []).map((message: any) => message.content).join("\n");
      if (prompt.includes("Choose exactly one action")) return makeSseStream(mergeResponse);
      if (prompt.includes("Classify this memory")) return makeSseStream(classifyResponse);
      throw new Error(`Unexpected AI prompt: ${prompt.slice(0, 120)}`);
    }),
  } as unknown as Ai;
}

function makeMergeAI(response: string): Ai {
  return {
    run: vi.fn().mockImplementation(async (model: string) => {
      if (model === "@cf/baai/bge-small-en-v1.5") {
        return { data: [new Array(384).fill(0.1)] };
      }
      return makeSseStream(response);
    }),
  } as unknown as Ai;
}

function seedEntry(
  db: D1Mock,
  id = "existing-id",
  content = "I use VSCode",
  vectorIds = '["existing-id"]',
  overrides: Record<string, unknown> = {},
) {
  const createdAt = Date.now() - 1_000;
  const entry = {
    id,
    content,
    tags: '["work"]',
    source: "api",
    created_at: createdAt,
    vector_ids: vectorIds,
    recall_count: 0,
    importance_score: 3,
    owner_user_id: TEST_USER_ID,
    revision: 0,
    current_episode_id: `episode-${id}`,
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

function currentMatch(id: string, score: number) {
  return { id, score, metadata: { parentId: id, episodeId: `episode-${id}` } };
}

describe("POST /capture — governed smart merge", () => {
  let db: D1Mock;
  let env: Env;

  beforeEach(() => {
    _resetDbReady();
    db = makeTestDb();
  });

  it("replace updates one entry through snapshot + episode + revision", async () => {
    seedEntry(db);
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [currentMatch("existing-id", 0.88)],
        }),
      }),
      AI: makeMergeAI('{"action":"replace","target_id":"existing-id"}'),
    });

    const res = await worker.fetch(
      req("POST", "/capture", { body: { content: "I switched to Cursor IDE", visibility: "public" } }),
      env,
      ctx,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, action: "replaced", id: "existing-id" });
    expect(db.entries).toHaveLength(1);
    const entry = db.entries[0] as any;
    expect(entry).toMatchObject({ content: "I switched to Cursor IDE", revision: 1 });
    expect(entry.current_episode_id).toEqual(expect.any(String));
    expect(db.entry_snapshots).toHaveLength(1);
    expect(db.entry_snapshots[0]).toMatchObject({
      content: "I use VSCode",
      revision: 0,
      mutation_kind: "replace",
    });
    expect(db.episodes).toHaveLength(1);
    const episode = db.episodes.find((candidate: any) => candidate.id === entry.current_episode_id);
    expect(episode).toMatchObject({
      content: "I switched to Cursor IDE",
      materialized_content: "I switched to Cursor IDE",
      mutation_kind: "replace",
    });
    expect(episode.parent_episode_id).toEqual(expect.any(String));
  });

  it("merge preserves the exact new statement and the merged materialized state", async () => {
    seedEntry(db, "existing-id", "I prefer dark mode");
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [currentMatch("existing-id", 0.88)],
        }),
      }),
      AI: makeMergeAI(
        '{"action":"merge","target_id":"existing-id","merged_content":"I prefer dark mode in all apps, especially at night"}',
      ),
    });

    const raw = "I like dark mode especially at night";
    const res = await worker.fetch(req("POST", "/capture", { body: { content: raw, visibility: "public" } }), env, ctx);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, action: "merged", id: "existing-id" });
    expect(db.entries).toHaveLength(1);
    const entry = db.entries[0] as any;
    expect(entry.content).toBe("I prefer dark mode in all apps, especially at night");
    expect(entry.revision).toBe(1);
    const episode = db.episodes.find((candidate: any) => candidate.id === entry.current_episode_id);
    expect(episode).toMatchObject({
      content: raw,
      materialized_content: "I prefer dark mode in all apps, especially at night",
      mutation_kind: "merge",
    });
  });

  it.each([
    ["replace", '{"action":"replace","target_id":"existing-id"}', "Incoming replacement"],
    ["merge", '{"action":"merge","target_id":"existing-id","merged_content":"Merged current state"}', "Incoming merge detail"],
  ])("%s keeps the valid incoming source title on the current document envelope", async (_kind, aiResponse, content) => {
    seedEntry(db, "existing-id", "Previous current state", "[]", { importance_score: 2 });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [currentMatch("existing-id", 0.88)],
        }),
      }),
      AI: makeMergeAI(aiResponse),
    });

    const res = await worker.fetch(req("POST", "/capture", {
      body: {
        content,
        visibility: "public",
        source_title: "Incoming safe source title",
      },
    }), env, ctx);
    const data = await res.json() as any;
    const entry = db.entries.find((candidate: any) => candidate.id === "existing-id") as any;
    const currentDocument = db.documents.find((document: any) => document.episode_id === entry.current_episode_id);

    expect(res.status).toBe(200);
    expect(data.action).toBe(_kind === "merge" ? "merged" : "replaced");
    expect(currentDocument).toMatchObject({ title: "Incoming safe source title" });
  });

  it("stores explicit public input separately from a same-owner private target without changing either scope", async () => {
    seedEntry(db, "private-target", "Private existing preference", "[]", {
      visibility: "private",
      tags: '["private"]',
      importance_score: 2,
    });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [currentMatch("private-target", 0.88)],
        }),
      }),
      AI: makeMergeAI('{"action":"replace","target_id":"private-target"}'),
    });

    const res = await worker.fetch(
      req("POST", "/capture", { body: { content: "Explicit public statement", visibility: "public" } }),
      env,
      ctx,
    );
    const data = await res.json() as any;

    expect(res.status).toBe(200);
    expect(data).toMatchObject({
      ok: true,
      action: "stored_separately",
      visibility: "public",
      warnings: expect.arrayContaining(["Merge skipped: visibility_mismatch"]),
    });
    expect(data.id).not.toBe("private-target");
    expect(db.entries.find((entry: any) => entry.id === "private-target")).toMatchObject({
      content: "Private existing preference",
      visibility: "private",
      revision: 0,
    });
    expect(db.entries.find((entry: any) => entry.id === data.id)).toMatchObject({
      content: "Explicit public statement",
      visibility: "public",
      revision: 1,
    });
  });

  it.each([
    ["replace", '{"action":"replace","target_id":"existing-id"}', "I switched to Cursor"],
    ["merge", '{"action":"merge","target_id":"existing-id","merged_content":"Combined"}', "New detail"],
  ])("%s stages ev: vectors with upsert and deletes the whole prior projection", async (_kind, response, content) => {
    seedEntry(db, "existing-id", "Previous", '["old-a","old-b"]');
    const upsertMock = vi.fn().mockResolvedValue({ mutationId: "m" });
    const insertMock = vi.fn().mockResolvedValue({ mutationId: "m" });
    const deleteByIdsMock = vi.fn().mockResolvedValue({ mutationId: "m" });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [currentMatch("existing-id", 0.88)],
        }),
        upsert: upsertMock,
        insert: insertMock,
        deleteByIds: deleteByIdsMock,
      }),
      AI: makeMergeAI(response),
    });

    const res = await worker.fetch(req("POST", "/capture", { body: { content, visibility: "public" } }), env, ctx);

    expect(res.status).toBe(200);
    expect(upsertMock).toHaveBeenCalledOnce();
    expect(insertMock).not.toHaveBeenCalled();
    const vectors = upsertMock.mock.calls[0][0] as any[];
    expect(vectors.every((vector: any) => /^ev:[0-9a-f-]{36}:\d+$/.test(vector.id))).toBe(true);
    expect(deleteByIdsMock).toHaveBeenCalledWith(["old-a", "old-b"]);
    expect(JSON.parse((db.entries[0] as any).vector_ids)).toEqual(vectors.map((vector: any) => vector.id));
  });

  it("merge embeds merged_content, not the raw incoming statement", async () => {
    seedEntry(db, "existing-id", "I prefer dark mode");
    const upsertMock = vi.fn().mockResolvedValue({ mutationId: "m" });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [currentMatch("existing-id", 0.88)],
        }),
        upsert: upsertMock,
      }),
      AI: makeMergeAI(
        '{"action":"merge","target_id":"existing-id","merged_content":"THE MERGED RESULT"}',
      ),
    });

    await worker.fetch(
      req("POST", "/capture", { body: { content: "I like dark mode at night", visibility: "public" } }),
      env,
      ctx,
    );

    const vectors = upsertMock.mock.calls[0][0] as any[];
    expect(vectors[0].metadata.content).toBe("THE MERGED RESULT");
  });

  it("upserts the version before deleting the prior projection", async () => {
    seedEntry(db, "existing-id", "I use VSCode", '["old-vec"]');
    const callOrder: string[] = [];
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [currentMatch("existing-id", 0.88)],
        }),
        upsert: vi.fn().mockImplementation(async () => {
          callOrder.push("upsert");
          return { mutationId: "m" };
        }),
        deleteByIds: vi.fn().mockImplementation(async () => {
          callOrder.push("delete");
          return { mutationId: "m" };
        }),
      }),
      AI: makeMergeAI('{"action":"replace","target_id":"existing-id"}'),
    });

    await worker.fetch(req("POST", "/capture", { body: { content: "Cursor IDE", visibility: "public" } }), env, ctx);

    expect(callOrder).toEqual(["upsert", "delete"]);
  });

  it("fails closed when merge vector staging fails", async () => {
    seedEntry(db, "existing-id", "I prefer dark mode", '["last-known-good"]');
    const deleteByIdsMock = vi.fn().mockResolvedValue({ mutationId: "cleanup" });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [currentMatch("existing-id", 0.88)],
        }),
        upsert: vi.fn().mockRejectedValue(new Error("Vectorize down")),
        deleteByIds: deleteByIdsMock,
      }),
      AI: makeMergeAI(
        '{"action":"merge","target_id":"existing-id","merged_content":"Combined"}',
      ),
    });

    await expect(
      captureEntry("I like dark mode at night", [], "api", env, ctx, TEST_USER_ID, { visibility: "public" }),
    ).rejects.toMatchObject({ code: "vector_stage_failed" });
    expect(db.entries[0]).toMatchObject({
      content: "I prefer dark mode",
      vector_ids: '["last-known-good"]',
      revision: 0,
      current_episode_id: "episode-existing-id",
    });
    expect(db.entry_snapshots).toHaveLength(0);
    expect(db.episodes).toHaveLength(0);
    expect(deleteByIdsMock.mock.calls[0][0]).not.toContain("last-known-good");
  });

  it("succeeds after cleanup failure and leaves a durable queue row", async () => {
    seedEntry(db, "existing-id", "I prefer dark mode", '["old-vec"]');
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [currentMatch("existing-id", 0.88)],
        }),
        deleteByIds: vi.fn().mockRejectedValue(new Error("delete failed")),
      }),
      AI: makeMergeAI(
        '{"action":"merge","target_id":"existing-id","merged_content":"Combined"}',
      ),
    });

    const res = await worker.fetch(
      req("POST", "/capture", { body: { content: "I like dark mode at night", visibility: "public" } }),
      env,
      ctx,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, action: "merged" });
    expect((db.entries[0] as any).revision).toBe(1);
    expect(db.vector_cleanup_queue).toHaveLength(1);
    expect(JSON.parse(db.vector_cleanup_queue[0].vector_ids)).toEqual(["old-vec"]);
  });

  it("keep_both stores a separately versioned duplicate candidate", async () => {
    seedEntry(db, "near-id", "I prefer dark mode", "[]");
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [currentMatch("near-id", 0.88)],
        }),
      }),
      AI: makeMergeAI('{"action":"keep_both"}'),
    });

    const res = await worker.fetch(
      req("POST", "/capture", { body: { content: "I like dark themes generally", visibility: "public" } }),
      env,
      ctx,
    );

    expect(await res.json()).toMatchObject({
      ok: true,
      action: "stored_separately",
      visibility: "public",
      warnings: ["Similar entry exists: near-id"],
    });
    expect(db.entries).toHaveLength(2);
    const stored = db.entries.find((entry: any) => entry.id !== "near-id") as any;
    expect(JSON.parse(stored.tags)).toContain("duplicate-candidate");
    expect(stored).toMatchObject({ revision: 1 });
    expect(stored.current_episode_id).toEqual(expect.any(String));
  });

  it("records contradiction candidates while both statements remain live", async () => {
    seedEntry(db, "old-id", "I live in NYC", '["incumbent-vector"]', {
      tags: "[]",
      valid_to: null,
    });
    const deleteByIdsMock = vi.fn().mockResolvedValue({ mutationId: "m" });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [currentMatch("old-id", 0.88)],
        }),
        deleteByIds: deleteByIdsMock,
      }),
      AI: makeMergeAI(
        '{"action":"contradiction","conflicting_id":"old-id","reason":"different city"}',
      ),
    });

    const res = await worker.fetch(
      req("POST", "/capture", { body: { content: "I moved to LA", visibility: "public" } }),
      env,
      ctx,
    );

    const data = await res.json() as any;
    expect(data).toMatchObject({
      ok: true,
      action: "stored_separately",
      visibility: "public",
      warnings: ["Conflicts with entry old-id: different city"],
    });
    expect(db.entries).toHaveLength(2);

    const incumbent = db.entries.find((entry: any) => entry.id === "old-id") as any;
    expect(incumbent).toMatchObject({
      content: "I live in NYC",
      tags: "[]",
      vector_ids: '["incumbent-vector"]',
      valid_to: null,
    });
    expect(JSON.parse(incumbent.tags)).not.toContain("status:deprecated");
    expect(deleteByIdsMock).not.toHaveBeenCalled();

    const candidate = db.entries.find((entry: any) => entry.id === data.id) as any;
    const candidateTags: string[] = JSON.parse(candidate.tags);
    expect(candidateTags).toEqual(expect.arrayContaining(["status:draft", "contradiction-candidate"]));
    expect(candidateTags).not.toContain("contradiction-resolved");
    expect(candidate.valid_to).toBeNull();

    const edge = db.edges.find((candidateEdge: any) => candidateEdge.type === "contradicts");
    expect(edge).toBeDefined();
    expect(new Set([edge.source_id, edge.target_id])).toEqual(new Set([data.id, "old-id"]));
  });

  it("research content bypasses a destructive smart-merge recommendation", async () => {
    seedEntry(db, "research-id", "Earlier research summary", "[]");
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [currentMatch("research-id", 0.88)],
        }),
      }),
      AI: makeMergeAI('{"action":"replace","target_id":"research-id"}'),
    });

    const res = await worker.fetch(
      req("POST", "/capture", {
        body: { content: "# New paper\n\nIndependent findings", source: "research", visibility: "public" },
      }),
      env,
      ctx,
    );

    expect(await res.json()).toMatchObject({
      ok: true,
      action: "stored_separately",
      visibility: "public",
      warnings: ["Similar entry exists: research-id"],
    });
    expect(db.entries).toHaveLength(2);
    expect(db.entries.find((entry: any) => entry.id === "research-id")?.content).toBe("Earlier research summary");
    const research = db.entries.find((entry: any) => entry.id !== "research-id") as any;
    expect(research.current_episode_id).toEqual(expect.any(String));
    expect(db.documents.some((document: any) => document.episode_id === research.current_episode_id)).toBe(true);
  });

  it("protects an explicitly canonical target from silent replacement", async () => {
    seedEntry(db, "canonical-id", "Canonical source of truth", '["canonical-id"]', {
      tags: '["work","status:canonical"]',
      importance_score: 2,
    });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [currentMatch("canonical-id", 0.88)],
        }),
      }),
      AI: makeMergeAI('{"action":"replace","target_id":"canonical-id"}'),
    });

    const res = await worker.fetch(
      req("POST", "/capture", { body: { content: "Replacement attempt", visibility: "public" } }),
      env,
      ctx,
    );

    const data = await res.json() as any;
    expect(data).toMatchObject({
      ok: true,
      action: "stored_separately",
      visibility: "public",
      warnings: [
        "Similar entry exists: canonical-id",
        "Merge skipped: target_protected",
      ],
    });
    expect(data.id).not.toBe("canonical-id");
    expect(db.entries.find((entry: any) => entry.id === "canonical-id")?.content).toBe("Canonical source of truth");
    expect(db.entries).toHaveLength(2);

    const stored = db.entries.find((entry: any) => entry.id === data.id) as any;
    expect(stored).toMatchObject({
      id: data.id,
      content: "Replacement attempt",
      owner_user_id: TEST_USER_ID,
      visibility: "public",
      revision: 1,
    });
    expect(JSON.parse(stored.tags)).toContain("duplicate-candidate");
    expect(stored.current_episode_id).toEqual(expect.any(String));
    expect(db.episodes.find((episode: any) => episode.id === stored.current_episode_id)).toMatchObject({
      entry_id: data.id,
      content: "Replacement attempt",
      materialized_content: "Replacement attempt",
      mutation_kind: "capture",
      owner_user_id: TEST_USER_ID,
    });
  });

  it.each([
    ["merge", '{"action":"merge","target_id":"existing-id","merged_content":"I prefer dark mode in all apps"}', "semantic", 4],
    ["replace", '{"action":"replace","target_id":"existing-id"}', "episodic", 2],
  ])("%s classification sets importance and versions a kind tag without canonical promotion", async (
    _action,
    mergeResponse,
    kind,
    importance,
  ) => {
    seedEntry(db, "existing-id", "Previous content", '["existing-id"]');
    const { ctx: testCtx, drain } = makeCtx();
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [currentMatch("existing-id", 0.88)],
        }),
      }),
      AI: makePromptAwareAI(
        mergeResponse,
        `{"importance":${importance},"canonical":true,"kind":"${kind}"}`,
      ),
    });

    const res = await worker.fetch(
      req("POST", "/capture", { body: { content: "New incoming statement", visibility: "public" } }),
      env,
      testCtx,
    );
    expect(res.status).toBe(200);
    await drain();

    const entry = db.entries.find((candidate: any) => candidate.id === "existing-id") as any;
    expect(entry.importance_score).toBe(importance);
    const tags: string[] = JSON.parse(entry.tags);
    expect(tags).toContain(`kind:${kind}`);
    expect(tags).not.toContain("status:canonical");
    expect(entry.revision).toBe(2);
    expect(db.entry_snapshots).toHaveLength(2);
    const episode = db.episodes.find((candidate: any) => candidate.id === entry.current_episode_id);
    expect(episode.mutation_kind).toBe("status");
  });

  it("still blocks a near-exact duplicate without calling the merge LLM", async () => {
    seedEntry(db, "dup", "Duplicate");
    const aiRunMock = vi.fn().mockImplementation(async (model: string) => {
      if (model === "@cf/baai/bge-small-en-v1.5") return { data: [new Array(384).fill(0.1)] };
      throw new Error("LLM should not be called for blocked entries");
    });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [currentMatch("dup", 0.97)],
        }),
      }),
      AI: { run: aiRunMock } as unknown as Ai,
    });

    const res = await worker.fetch(
      req("POST", "/capture", { body: { content: "Duplicate" } }),
      env,
      ctx,
    );

    expect(await res.json()).toMatchObject({
      ok: false,
      error: "duplicate",
      action: "blocked_duplicate",
      match_id: "dup",
    });
    expect(aiRunMock).toHaveBeenCalledOnce();
  });
});
