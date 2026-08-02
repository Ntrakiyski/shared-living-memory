import { beforeEach, describe, expect, it, vi } from "vitest";
import { captureEntry } from "../../src/testing";
import { makeTestDb, makeTestEnv, makeVectorizeMock } from "../helpers/make-env";
import type { CaptureResult, Env } from "../../src/testing";
import { D1Mock } from "../helpers/d1-mock";
import { TEST_USER_ID } from "../helpers/test-principal";

function makeCtx() {
  const pending: Promise<any>[] = [];
  return {
    ctx: { waitUntil: (promise: Promise<any>) => pending.push(promise) } as any as ExecutionContext,
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

function makeResponseAI(response: string): Ai {
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
  overrides: Record<string, unknown> = {},
) {
  const createdAt = Date.now() - 1_000;
  const id = String(overrides.id ?? "existing");
  const entry = {
    id,
    content: "Existing memory",
    tags: "[]",
    source: "api",
    created_at: createdAt,
    vector_ids: '["existing-vector"]',
    recall_count: 0,
    importance_score: 0,
    contradiction_wins: 0,
    contradiction_losses: 0,
    owner_user_id: TEST_USER_ID,
    revision: 0,
    current_episode_id: `episode-${id}`,
    recorded_at: createdAt,
    valid_from: createdAt,
    valid_to: null,
    epistemic_status: "candidate",
    visibility: "public",
    ...overrides,
  };
  db.entries.push(entry);
  return entry;
}

function currentMatch(id: string, score: number) {
  return { id, score, metadata: { parentId: id, episodeId: `episode-${id}` } };
}

describe("captureEntry()", () => {
  let db: D1Mock;
  let env: Env;

  beforeEach(() => {
    db = makeTestDb();
    env = makeTestEnv(db);
  });

  it("stores a plain entry as revision 1 with an immutable current episode", async () => {
    const upsertMock = vi.fn().mockResolvedValue({ mutationId: "m" });
    const insertMock = vi.fn().mockResolvedValue({ mutationId: "m" });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({ upsert: upsertMock, insert: insertMock }),
    });
    const before = Date.now();
    const { ctx } = makeCtx();

    const result: CaptureResult = await captureEntry("My first memory", [], "api", env, ctx);

    expect(result.status).toBe("stored");
    if (result.status !== "stored") return;
    expect(result.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(db.entries).toHaveLength(1);
    const entry = db.entries[0] as any;
    expect(entry).toMatchObject({
      id: result.id,
      content: "My first memory",
      source: "api",
      revision: 1,
      epistemic_status: "candidate",
      visibility: "private",
    });
    expect(entry.current_episode_id).toEqual(expect.any(String));
    expect(entry.created_at).toBeGreaterThanOrEqual(before);
    expect(entry.recorded_at).toBe(entry.created_at);
    expect(entry.valid_from).toBe(entry.created_at);
    expect(entry.valid_to).toBeNull();

    expect(db.episodes).toHaveLength(1);
    expect(db.episodes[0]).toMatchObject({
      id: entry.current_episode_id,
      entry_id: result.id,
      content: "My first memory",
      materialized_content: "My first memory",
      mutation_kind: "capture",
      owner_user_id: entry.owner_user_id,
    });
    expect(upsertMock).toHaveBeenCalledOnce();
    expect(insertMock).not.toHaveBeenCalled();
    const vectors = upsertMock.mock.calls[0][0] as any[];
    expect(vectors.every((vector: any) => /^ev:[0-9a-f-]{36}:\d+$/.test(vector.id))).toBe(true);
  });

  it("honors explicit public visibility without requiring a metadata tag", async () => {
    const { ctx } = makeCtx();
    const result = await captureEntry(
      "Team decision",
      [],
      "api",
      env,
      ctx,
      TEST_USER_ID,
      { visibility: "public" },
    );

    expect(result).toMatchObject({ status: "stored", visibility: "public" });
    expect(db.entries[0].visibility).toBe("public");
    expect(JSON.parse(db.entries[0].tags)).not.toContain("private");
  });

  it.each([
    ["content_too_large", { content: "x".repeat(32 * 1024 + 1), tags: [] }],
    ["content_too_large", { content: "🌿".repeat(8_190), tags: [], source: "123456789" }],
    ["too_many_tags", { content: "note", tags: Array.from({ length: 26 }, (_, index) => `tag-${index}`) }],
    ["too_many_tags", { content: Array.from({ length: 26 }, (_, index) => `#derived${index}`).join(" "), tags: [] }],
    ["tag_too_long", { content: "note", tags: ["x".repeat(65)] }],
    ["tag_too_long", { content: `note #${"x".repeat(65)}`, tags: [] }],
    ["source_url_too_long", { content: "note", tags: [], sourceUrl: `https://example.test/${"x".repeat(2049)}` }],
    ["source_url_too_long", { content: "note", tags: [], source: `https://example.test/${"x".repeat(2049)}` }],
    ["source_title_too_long", { content: "note", tags: [], sourceTitle: "🌿".repeat(513) }],
  ])("rejects %s before model or vector work", async (error, value) => {
    const aiRun = vi.fn();
    const vectorQuery = vi.fn();
    env = makeTestEnv(db, {
      AI: { run: aiRun } as unknown as Ai,
      VECTORIZE: makeVectorizeMock({ query: vectorQuery }),
    });
    const { ctx } = makeCtx();

    await expect(captureEntry(
      value.content,
      value.tags,
      "source" in value ? value.source : "api",
      env,
      ctx,
      TEST_USER_ID,
      {
        sourceUrl: "sourceUrl" in value ? value.sourceUrl : undefined,
        sourceTitle: "sourceTitle" in value ? value.sourceTitle : undefined,
      },
    )).rejects.toMatchObject({ code: error });
    expect(aiRun).not.toHaveBeenCalled();
    expect(vectorQuery).not.toHaveBeenCalled();
  });

  it.each([
    ["pem_private_key", "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n-----END PRIVATE KEY-----"],
    ["github_token", `ghp_${"a".repeat(36)}`],
    ["slack_token", `xoxb-123456789012-123456789012-${"a".repeat(24)}`],
    ["stripe_live_secret", `sk_live_${"a".repeat(24)}`],
    ["openai_project_key", `sk-proj-${"a".repeat(32)}`],
    ["openai_project_key", `sk-proj-${"a".repeat(19)}-`],
    ["openai_project_key", `sk-svcacct-${"a".repeat(19)}-`],
    ["openai_project_key", `(sk-proj-${"a".repeat(19)}-)`],
    ["openai_project_key", `prefix: sk-svcacct-${"a".repeat(19)}-.`],
  ])("rejects a structurally valid %s before model or vector work", async (detector, content) => {
    const aiRun = vi.fn();
    const vectorQuery = vi.fn();
    env = makeTestEnv(db, {
      AI: { run: aiRun } as unknown as Ai,
      VECTORIZE: makeVectorizeMock({ query: vectorQuery }),
    });
    const { ctx } = makeCtx();

    await expect(captureEntry(content, [], "api", env, ctx, TEST_USER_ID)).rejects.toMatchObject({
      code: "secret_detected",
      detector,
    });
    expect(aiRun).not.toHaveBeenCalled();
    expect(vectorQuery).not.toHaveBeenCalled();
  });

  it.each([
    ["tag", { tags: [`sk_live_${"a".repeat(24)}`] }],
    ["source", { source: `ghp_${"a".repeat(36)}` }],
    ["source URL", { sourceUrl: `https://example.test/sk-proj-${"a".repeat(32)}` }],
    ["source title", { sourceTitle: `xoxb-123456789012-123456789012-${"a".repeat(24)}` }],
  ])("rejects a secret in capture %s metadata before model or vector work", async (_field, metadata) => {
    const aiRun = vi.fn();
    const vectorQuery = vi.fn();
    env = makeTestEnv(db, {
      AI: { run: aiRun } as unknown as Ai,
      VECTORIZE: makeVectorizeMock({ query: vectorQuery }),
    });
    const { ctx } = makeCtx();

    await expect(captureEntry(
      "Safe note",
      "tags" in metadata ? metadata.tags : [],
      "source" in metadata ? metadata.source : "api",
      env,
      ctx,
      TEST_USER_ID,
      {
        sourceUrl: "sourceUrl" in metadata ? metadata.sourceUrl : undefined,
        sourceTitle: "sourceTitle" in metadata ? metadata.sourceTitle : undefined,
      },
    )).rejects.toMatchObject({ code: "secret_detected" });
    expect(aiRun).not.toHaveBeenCalled();
    expect(vectorQuery).not.toHaveBeenCalled();
    expect(db.entries).toHaveLength(0);
  });

  it.each(["xoxa", "xoxr", "xoxs"])("rejects a structurally valid %s Slack token", async (prefix) => {
    const { ctx } = makeCtx();
    await expect(captureEntry(
      `${prefix}-2-${"a".repeat(40)}`,
      [],
      "api",
      env,
      ctx,
      TEST_USER_ID,
    )).rejects.toMatchObject({ code: "secret_detected", detector: "slack_token" });
  });

  it("measures tag limits in characters rather than UTF-8 bytes", async () => {
    const { ctx } = makeCtx();
    await expect(captureEntry(
      "Unicode tag",
      ["🌿".repeat(64)],
      "api",
      env,
      ctx,
      TEST_USER_ID,
    )).resolves.toMatchObject({ status: "stored" });
  });

  it("does not reject generic bearer text", async () => {
    const { ctx } = makeCtx();
    await expect(captureEntry(
      "Use Authorization: Bearer example in the docs",
      [],
      "api",
      env,
      ctx,
      TEST_USER_ID,
    )).resolves.toMatchObject({ status: "stored" });
  });

  it.each([
    `mask-proj-${"a".repeat(19)}-`,
    `mask-svcacct-${"a".repeat(19)}-`,
    `sk-proj-${"a".repeat(18)}-`,
    `sk-svcacct-${"a".repeat(18)}-`,
  ])("does not treat adjacent or sub-minimum OpenAI-like text as a token: %s", async (content) => {
    const { ctx } = makeCtx();
    await expect(captureEntry(
      content,
      [],
      "api",
      env,
      ctx,
      TEST_USER_ID,
    )).resolves.toMatchObject({ status: "stored" });
  });

  it("allows a private-key header mention without a matching encoded block", async () => {
    const { ctx } = makeCtx();
    await expect(captureEntry(
      "The docs mention -----BEGIN PRIVATE KEY----- as a header.",
      [],
      "api",
      env,
      ctx,
      TEST_USER_ID,
    )).resolves.toMatchObject({ status: "stored" });
  });

  it("resolves an ownerless internal capture to the _system user", async () => {
    const { ctx } = makeCtx();
    const result = await captureEntry("System-owned memory", [], "internal", env, ctx);
    expect(result.status).toBe("stored");

    const entry = db.entries[0] as any;
    expect(entry.owner_user_id).toBe("_system");
    expect(entry.created_by_user_id).toBe("_system");
    expect(db.episodes[0].owner_user_id).toBe("_system");
  });

  it("uses the provided source value", async () => {
    const { ctx } = makeCtx();
    await captureEntry("Memory from claude", [], "claude", env, ctx, TEST_USER_ID);
    expect(db.entries[0].source).toBe("claude");
    expect(db.episodes[0].source).toBe("claude");
  });

  it("preserves exact raw input in the episode while materializing hashtags", async () => {
    const raw = "  went for a run #health #fitness  ";
    const { ctx } = makeCtx();
    await captureEntry(raw, ["Health"], "api", env, ctx, TEST_USER_ID);

    const entry = db.entries[0] as any;
    expect(entry.content).toBe("went for a run");
    const tags: string[] = JSON.parse(entry.tags);
    expect(tags.filter((tag) => tag === "health")).toHaveLength(1);
    expect(tags).toContain("fitness");
    expect(db.episodes[0].content).toBe(raw);
    expect(db.episodes[0].materialized_content).toBe("went for a run");
  });

  it("falls back to trimmed raw content when input is only hashtags", async () => {
    const { ctx } = makeCtx();
    await captureEntry("  #task  ", [], "api", env, ctx, TEST_USER_ID);
    expect(db.entries[0].content).toBe("#task");
    expect(JSON.parse(db.entries[0].tags)).toContain("task");
    expect(db.episodes[0].content).toBe("  #task  ");
  });

  it("blocks a near-exact duplicate without writing provenance or scheduling classification", async () => {
    seedEntry(db, { content: "Duplicate content" });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [currentMatch("existing", 0.97)],
        }),
      }),
    });
    const pending: Promise<any>[] = [];
    const ctx = { waitUntil: (promise: Promise<any>) => pending.push(promise) } as any as ExecutionContext;

    const result = await captureEntry("Duplicate content", [], "api", env, ctx, TEST_USER_ID);

    expect(result).toMatchObject({ status: "blocked", matchId: "existing", score: 0.97 });
    expect(db.entries).toHaveLength(1);
    expect(db.episodes).toHaveLength(0);
    expect(db.entry_snapshots).toHaveLength(0);
    expect(pending).toHaveLength(0);
  });

  it("keep_both stores a separately versioned duplicate candidate", async () => {
    seedEntry(db, { content: "Similar existing note" });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [currentMatch("existing", 0.88)],
        }),
      }),
      AI: makeResponseAI('{"action":"keep_both"}'),
    });
    const { ctx } = makeCtx();

    const result = await captureEntry("Similar note", [], "api", env, ctx, TEST_USER_ID);

    expect(result.status).toBe("flagged");
    if (result.status !== "flagged") return;
    expect(result.matchId).toBe("existing");
    expect(db.entries).toHaveLength(2);
    const stored = db.entries.find((entry: any) => entry.id === result.id) as any;
    expect(JSON.parse(stored.tags)).toContain("duplicate-candidate");
    expect(stored.revision).toBe(1);
    expect(stored.current_episode_id).toEqual(expect.any(String));
  });

  it("records a contradiction candidate without deprecating either statement", async () => {
    seedEntry(db, {
      id: "old-entry",
      content: "I live in NYC",
      vector_ids: '["old-vec-1","old-vec-2"]',
      valid_to: null,
    });
    const deleteByIdsMock = vi.fn().mockResolvedValue({ mutationId: "m" });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [currentMatch("old-entry", 0.72)],
        }),
        deleteByIds: deleteByIdsMock,
      }),
      AI: makeResponseAI(
        '{"contradicts":true,"conflicting_id":"old-entry","reason":"different city"}',
      ),
    });
    const { ctx } = makeCtx();

    const result = await captureEntry("I moved to LA", [], "api", env, ctx, TEST_USER_ID, { visibility: "public" });

    expect(result).toMatchObject({
      status: "contradiction",
      resolvedConflict: "old-entry",
      reason: "different city",
    });
    if (result.status !== "contradiction") return;

    const incumbent = db.entries.find((entry: any) => entry.id === "old-entry") as any;
    expect(incumbent).toMatchObject({
      content: "I live in NYC",
      vector_ids: '["old-vec-1","old-vec-2"]',
      valid_to: null,
      contradiction_wins: 0,
      contradiction_losses: 0,
    });
    expect(JSON.parse(incumbent.tags)).not.toContain("status:deprecated");
    expect(deleteByIdsMock).not.toHaveBeenCalled();

    const candidate = db.entries.find((entry: any) => entry.id === result.id) as any;
    const candidateTags: string[] = JSON.parse(candidate.tags);
    expect(candidateTags).toEqual(expect.arrayContaining(["status:draft", "contradiction-candidate"]));
    expect(candidateTags).not.toContain("contradiction-resolved");
    expect(candidate.valid_to).toBeNull();
    expect(candidate.contradiction_wins).toBe(0);
    expect(candidate.contradiction_losses).toBe(0);

    expect(db.edges).toContainEqual(expect.objectContaining({
      source_id: result.id,
      target_id: "old-entry",
      type: "contradicts",
    }));
  });

  it("keeps a canonical incumbent unchanged while storing the same governed candidate", async () => {
    seedEntry(db, {
      id: "canonical-entry",
      content: "I live in NYC",
      tags: '["status:canonical"]',
      vector_ids: '["canonical-vec"]',
      importance_score: 5,
    });
    const deleteByIdsMock = vi.fn().mockResolvedValue({ mutationId: "m" });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [currentMatch("canonical-entry", 0.72)],
        }),
        deleteByIds: deleteByIdsMock,
      }),
      AI: makeResponseAI(
        '{"contradicts":true,"conflicting_id":"canonical-entry","reason":"different city"}',
      ),
    });
    const { ctx } = makeCtx();

    const result = await captureEntry("I moved to LA", [], "api", env, ctx, TEST_USER_ID, { visibility: "public" });

    expect(result).toMatchObject({
      status: "contradiction_protected",
      canonicalId: "canonical-entry",
    });
    if (result.status !== "contradiction_protected") return;
    const canonical = db.entries.find((entry: any) => entry.id === "canonical-entry") as any;
    expect(canonical).toMatchObject({
      content: "I live in NYC",
      tags: '["status:canonical"]',
      vector_ids: '["canonical-vec"]',
      valid_to: null,
    });
    expect(deleteByIdsMock).not.toHaveBeenCalled();
    const candidate = db.entries.find((entry: any) => entry.id === result.id) as any;
    expect(JSON.parse(candidate.tags)).toEqual(
      expect.arrayContaining(["status:draft", "contradiction-candidate"]),
    );
    expect(JSON.parse(candidate.tags)).not.toContain("status:canonical");
  });

  it("replace snapshots the prior state and makes a replace episode current", async () => {
    seedEntry(db, {
      content: "I use VSCode",
      tags: '["work"]',
      importance_score: 3,
    });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [currentMatch("existing", 0.88)],
        }),
      }),
      AI: makeResponseAI('{"action":"replace","target_id":"existing"}'),
    });
    const { ctx } = makeCtx();

    const result = await captureEntry("I switched to Cursor", [], "api", env, ctx, TEST_USER_ID, { visibility: "public" });

    expect(result).toEqual({ status: "replaced", id: "existing", visibility: "public" });
    expect(db.entries).toHaveLength(1);
    const entry = db.entries[0] as any;
    expect(entry).toMatchObject({ content: "I switched to Cursor", revision: 1 });
    expect(db.entry_snapshots).toHaveLength(1);
    expect(db.entry_snapshots[0]).toMatchObject({ content: "I use VSCode", mutation_kind: "replace" });
    const episode = db.episodes.find((candidate: any) => candidate.id === entry.current_episode_id);
    expect(episode).toMatchObject({
      content: "I switched to Cursor",
      materialized_content: "I switched to Cursor",
      mutation_kind: "replace",
    });
  });

  it("merge keeps incoming raw content distinct from merged materialized content", async () => {
    seedEntry(db, { content: "I prefer dark mode", tags: '["personal"]', importance_score: 2 });
    const upsertMock = vi.fn().mockResolvedValue({ mutationId: "m" });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [currentMatch("existing", 0.88)],
        }),
        upsert: upsertMock,
      }),
      AI: makeResponseAI(
        '{"action":"merge","target_id":"existing","merged_content":"Combined merged memory"}',
      ),
    });
    const { ctx } = makeCtx();
    const raw = "I like dark mode at night";

    const result = await captureEntry(raw, [], "api", env, ctx, TEST_USER_ID, { visibility: "public" });

    expect(result).toEqual({ status: "merged", id: "existing", visibility: "public" });
    const entry = db.entries[0] as any;
    expect(entry).toMatchObject({ content: "Combined merged memory", revision: 1 });
    const episode = db.episodes.find((candidate: any) => candidate.id === entry.current_episode_id);
    expect(episode).toMatchObject({
      content: raw,
      materialized_content: "Combined merged memory",
      mutation_kind: "merge",
    });
    const vectors = upsertMock.mock.calls[0][0] as any[];
    expect(vectors.every((vector: any) => vector.id.startsWith(`ev:${entry.current_episode_id}:`))).toBe(true);
    expect(vectors[0].metadata.content).toBe("Combined merged memory");
  });

  it("stores a private capture separately instead of replacing a same-owner public target", async () => {
    seedEntry(db, {
      content: "Public preference",
      visibility: "public",
      importance_score: 2,
    });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [currentMatch("existing", 0.88)],
        }),
      }),
      AI: makeResponseAI('{"action":"replace","target_id":"existing"}'),
    });
    const { ctx } = makeCtx();

    const result = await captureEntry(
      "Private replacement proposal",
      [],
      "api",
      env,
      ctx,
      TEST_USER_ID,
      { visibility: "private" },
    );

    expect(result).toMatchObject({
      status: "flagged",
      visibility: "private",
      mergeSkipped: "visibility_mismatch",
      matchId: "existing",
    });
    if (result.status !== "flagged") return;
    expect(result.id).not.toBe("existing");
    expect(db.entries).toHaveLength(2);
    expect(db.entries.find((entry: any) => entry.id === "existing")).toMatchObject({
      content: "Public preference",
      visibility: "public",
      revision: 0,
    });
    expect(db.entries.find((entry: any) => entry.id === result.id)).toMatchObject({
      content: "Private replacement proposal",
      visibility: "private",
      revision: 1,
    });
  });

  it("falls through to a new capture when a merge target is missing", async () => {
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [currentMatch("ghost-id", 0.88)],
        }),
      }),
      AI: makeResponseAI('{"action":"replace","target_id":"ghost-id"}'),
    });
    const { ctx } = makeCtx();

    const result = await captureEntry("I switched to Cursor", [], "api", env, ctx, TEST_USER_ID);

    expect(result.status).toBe("stored");
    expect(db.entries).toHaveLength(1);
    expect((db.entries[0] as any).revision).toBe(1);
  });

  it("stores a private versioned capture instead of fabricating an id for a foreign merge target", async () => {
    seedEntry(db, {
      id: "foreign",
      content: "Foreign public memory",
      owner_user_id: TEST_USER_ID,
      visibility: "public",
      vector_ids: '["foreign"]',
    });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [currentMatch("foreign", 0.88)],
        }),
      }),
      AI: makeResponseAI('{"action":"replace","target_id":"foreign"}'),
    });
    const { ctx } = makeCtx();

    const result = await captureEntry(
      "Private incoming memory",
      ["private"],
      "internal",
      env,
      ctx,
    );

    expect(result).toMatchObject({
      status: "flagged",
      matchId: "foreign",
      mergeSkipped: "target_not_owned",
    });
    if (result.status !== "flagged") return;
    expect(result.id).not.toBe("foreign");
    expect(db.entries).toHaveLength(2);
    expect(db.entries.find((entry: any) => entry.id === "foreign")).toMatchObject({
      content: "Foreign public memory",
      owner_user_id: TEST_USER_ID,
      visibility: "public",
      revision: 0,
    });

    const stored = db.entries.find((entry: any) => entry.id === result.id) as any;
    expect(stored).toMatchObject({
      content: "Private incoming memory",
      owner_user_id: "_system",
      visibility: "private",
      revision: 1,
    });
    expect(JSON.parse(stored.tags)).toEqual(
      expect.arrayContaining(["private", "duplicate-candidate"]),
    );
    expect(stored.current_episode_id).toEqual(expect.any(String));
    expect(db.episodes.find((episode: any) => episode.id === stored.current_episode_id)).toMatchObject({
      entry_id: result.id,
      content: "Private incoming memory",
      materialized_content: "Private incoming memory",
      mutation_kind: "capture",
      owner_user_id: "_system",
    });
  });

  it("research content bypasses destructive smart merge", async () => {
    seedEntry(db, { id: "research", content: "Old research summary", vector_ids: "[]" });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [currentMatch("research", 0.88)],
        }),
      }),
      AI: makeResponseAI('{"action":"replace","target_id":"research"}'),
    });
    const { ctx } = makeCtx();

    const result = await captureEntry(
      "# New paper\n\nIndependent findings",
      [],
      "research",
      env,
      ctx,
      TEST_USER_ID,
    );

    expect(result.status).toBe("flagged");
    expect(db.entries).toHaveLength(2);
    expect(db.entries.find((entry: any) => entry.id === "research")?.content).toBe("Old research summary");
    expect(db.documents).toHaveLength(1);
    expect(db.passages.length).toBeGreaterThan(0);
  });

  it("classifier may set importance but never auto-promotes canonical", async () => {
    env = makeTestEnv(db, {
      AI: makeResponseAI('{"importance":5,"canonical":true}'),
    });
    const { ctx, drain } = makeCtx();

    const result = await captureEntry(
      "I will always prefer TypeScript over JavaScript",
      [],
      "api",
      env,
      ctx,
      TEST_USER_ID,
    );
    expect(result.status).toBe("stored");
    await drain();

    const entry = db.entries[0] as any;
    expect(entry.importance_score).toBe(5);
    expect(JSON.parse(entry.tags)).not.toContain("status:canonical");
    expect(entry.revision).toBe(1);
  });

  it("classifier versions a kind tag without changing governance status", async () => {
    env = makeTestEnv(db, {
      AI: makeResponseAI('{"importance":2,"canonical":true,"kind":"episodic"}'),
    });
    const { ctx, drain } = makeCtx();

    const result = await captureEntry(
      "Went for a run this morning",
      [],
      "api",
      env,
      ctx,
      TEST_USER_ID,
    );
    expect(result.status).toBe("stored");
    await drain();

    const entry = db.entries[0] as any;
    const tags: string[] = JSON.parse(entry.tags);
    expect(tags).toContain("kind:episodic");
    expect(tags).not.toContain("status:canonical");
    expect(entry.importance_score).toBe(2);
    expect(entry.revision).toBe(2);
    expect(db.entry_snapshots).toHaveLength(1);
    expect(db.entry_snapshots[0].mutation_kind).toBe("status");
    const episode = db.episodes.find((candidate: any) => candidate.id === entry.current_episode_id);
    expect(episode).toMatchObject({
      content: "classification:episodic",
      materialized_content: "Went for a run this morning",
      mutation_kind: "status",
    });
  });

  it("does not add a kind tag when classification returns no kind", async () => {
    env = makeTestEnv(db, {
      AI: makeResponseAI('{"importance":3,"canonical":false}'),
    });
    const { ctx, drain } = makeCtx();
    await captureEntry("Some generic note", [], "api", env, ctx, TEST_USER_ID);
    await drain();

    const tags: string[] = JSON.parse(db.entries[0].tags);
    expect(tags.some((tag) => tag.startsWith("kind:"))).toBe(false);
    expect((db.entries[0] as any).revision).toBe(1);
  });

  it("fails closed when vector staging fails", async () => {
    const deleteByIdsMock = vi.fn().mockResolvedValue({ mutationId: "cleanup" });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        upsert: vi.fn().mockRejectedValue(new Error("Vectorize unavailable")),
        deleteByIds: deleteByIdsMock,
      }),
    });
    const { ctx } = makeCtx();

    await expect(
      captureEntry("Note with broken vectorize", [], "api", env, ctx, TEST_USER_ID),
    ).rejects.toMatchObject({ code: "vector_stage_failed" });
    expect(db.entries).toHaveLength(0);
    expect(db.episodes).toHaveLength(0);
    expect(db.entry_snapshots).toHaveLength(0);
    expect(deleteByIdsMock).toHaveBeenCalledOnce();
    expect((deleteByIdsMock.mock.calls[0][0] as string[]).every((id) => id.startsWith("ev:"))).toBe(true);
  });
});
