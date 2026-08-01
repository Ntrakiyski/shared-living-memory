import { describe, it, expect, beforeEach, vi } from "vitest";
import worker, { _resetDbReady } from "../../src/testing";
import { makeTestEnv, makeTestDb, makeVectorizeMock } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import type { Env } from "../../src/testing";
import { D1Mock } from "../helpers/d1-mock";
import { TEST_USER_ID } from "../helpers/test-principal";
import { buildMcpServer } from "../../src/mcp";
import type { CaptureResponse, HumanActorContext } from "../../src/types";

function makeCtx() {
  const pending: Promise<any>[] = [];
  return {
    ctx: { waitUntil: (p: Promise<any>) => pending.push(p) } as any,
    drain: () => Promise.allSettled(pending),
  };
}

describe("POST /capture", () => {
  let env: Env;
  let db: D1Mock;

  beforeEach(() => {
    _resetDbReady();
    db = makeTestDb();
    env = makeTestEnv(db);
  });

  it("represents authentication rejection in the exported capture response contract", () => {
    const response: CaptureResponse = { ok: false, error: "Unauthorized" };
    expect(response).toEqual({ ok: false, error: "Unauthorized" });
  });

  it("returns the typed authentication rejection from the real capture route", async () => {
    const { ctx } = makeCtx();
    const res = await worker.fetch(req("POST", "/capture", { token: null, body: { content: "note" } }), env, ctx);

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, error: "Unauthorized" });
  });

  it("stores importance_score after async AI scoring completes", async () => {
    const { ctx, drain } = makeCtx();
    const res = await worker.fetch(req("POST", "/capture", { body: { content: "Decided to switch to TypeScript for all new projects" } }), env, ctx);
    expect(res.status).toBe(200);
    await drain();
    expect(db.entries).toHaveLength(1);
    expect(db.entries[0].importance_score).toBeGreaterThanOrEqual(1);
    expect(db.entries[0].importance_score).toBeLessThanOrEqual(5);
  });

  it("returns 400 when content is missing", async () => {
    const { ctx } = makeCtx();
    const res = await worker.fetch(req("POST", "/capture", { body: {} }), env, ctx);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: "content is required" });
  });

  it("returns a typed 400 when the JSON body is null", async () => {
    const { ctx } = makeCtx();
    const res = await worker.fetch(req("POST", "/capture", { body: null }), env, ctx);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: "invalid_request" });
  });

  it("returns 400 when content is whitespace-only", async () => {
    const { ctx } = makeCtx();
    const res = await worker.fetch(req("POST", "/capture", { body: { content: "   " } }), env, ctx);
    expect(res.status).toBe(400);
  });

  it("stores valid entry and returns id", async () => {
    const { ctx } = makeCtx();
    const res = await worker.fetch(req("POST", "/capture", { body: { content: "Test note" } }), env, ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(typeof data.id).toBe("string");
    expect(data.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(db.entries).toHaveLength(1);
    expect(db.entries[0].content).toBe("Test note");
    expect(data).toMatchObject({
      action: "stored",
      visibility: "private",
      warnings: [],
    });
    expect(db.entries[0].visibility).toBe("private");
  });

  it("stores explicit public capture with source metadata in the existing envelope", async () => {
    const { ctx } = makeCtx();
    const res = await worker.fetch(req("POST", "/capture", {
      body: {
        content: "Published research note",
        visibility: "public",
        source_url: "https://example.test/source",
        source_title: "Source title",
      },
    }), env, ctx);
    const data = await res.json() as any;

    expect(res.status).toBe(200);
    expect(data).toMatchObject({ ok: true, action: "stored", visibility: "public", warnings: [] });
    expect(db.entries[0].visibility).toBe("public");
    expect(db.episodes[0].source_url).toBe("https://example.test/source");
    expect(db.documents[0].title).toBe("Source title");
  });

  it("blocks a near-exact duplicate (score ≥ 0.95)", async () => {
    db.entries.push({ id: "existing", content: "Duplicate note", tags: "[]", source: "api", created_at: 1, vector_ids: '["existing"]', owner_user_id: TEST_USER_ID, current_episode_id: "episode-existing" });
    const vectorize = makeVectorizeMock({
      query: vi.fn().mockResolvedValue({
        matches: [{ id: "existing", score: 0.97, metadata: { parentId: "existing", episodeId: "episode-existing" } }],
      }),
    });
    env = makeTestEnv(db, { VECTORIZE: vectorize });

    const { ctx } = makeCtx();
    const res = await worker.fetch(req("POST", "/capture", { body: { content: "Duplicate note" } }), env, ctx);
    const data = await res.json() as any;
    expect(data.ok).toBe(false);
    expect(res.status).toBe(409);
    expect(data).toEqual({
      ok: false,
      error: "duplicate",
      action: "blocked_duplicate",
      match_id: "existing",
      match_score: 0.97,
      warnings: [],
    });
    expect(db.entries).toHaveLength(1);
  });

  it("returns 422 for rejected secrets and logs only detector plus actor", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const secret = `sk_live_${"a".repeat(24)}`;
    const { ctx } = makeCtx();

    const res = await worker.fetch(req("POST", "/capture", { body: { content: secret } }), env, ctx);
    const data = await res.json() as any;

    expect(res.status).toBe(422);
    const expected: CaptureResponse = { ok: false, error: "secret_detected" };
    expect(data).toEqual(expected);
    expect(JSON.stringify(consoleWarn.mock.calls)).not.toContain(secret);
    expect(consoleWarn).toHaveBeenCalledWith("capture rejected", {
      detector: "stripe_live_secret",
      actor_id: TEST_USER_ID,
    });
    expect(db.entries).toHaveLength(0);
    consoleWarn.mockRestore();
  });

  it.each([
    ["oversize source title", { content: "Safe note", source_title: "🌿".repeat(513) }, "source_title_too_long"],
    ["combined UTF-8 payload", { content: "🌿".repeat(8_190), source: "123456789" }, "content_too_large"],
  ])("rejects an %s before database or vector work", async (_case, body, error) => {
    const query = vi.fn();
    const upsert = vi.fn();
    env = makeTestEnv(db, { VECTORIZE: makeVectorizeMock({ query, upsert }) });
    const { ctx } = makeCtx();

    const res = await worker.fetch(req("POST", "/capture", { body }), env, ctx);
    const data = await res.json();

    expect(res.status).toBe(422);
    expect(data).toEqual({ ok: false, error });
    expect(db.entries).toHaveLength(0);
    expect(query).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it.each([
    ["tag", { content: "Safe note", tags: [`sk_live_${"a".repeat(24)}`] }, `sk_live_${"a".repeat(24)}`],
    ["source", { content: "Safe note", source: `ghp_${"a".repeat(36)}` }, `ghp_${"a".repeat(36)}`],
    ["source URL", { content: "Safe note", source_url: `https://example.test/sk-proj-${"a".repeat(32)}` }, `sk-proj-${"a".repeat(32)}`],
    ["source title", { content: "Safe note", source_title: `xoxb-123456789012-123456789012-${"a".repeat(24)}` }, `xoxb-123456789012-123456789012-${"a".repeat(24)}`],
  ])("rejects a secret in REST %s metadata without echo or side effects", async (_field, body, secret) => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const query = vi.fn();
    const upsert = vi.fn();
    env = makeTestEnv(db, { VECTORIZE: makeVectorizeMock({ query, upsert }) });
    const { ctx } = makeCtx();

    const res = await worker.fetch(req("POST", "/capture", { body }), env, ctx);
    const data = await res.json();
    const warningCalls = [...consoleWarn.mock.calls];
    consoleWarn.mockRestore();

    expect(res.status).toBe(422);
    expect(data).toEqual({ ok: false, error: "secret_detected" });
    expect(JSON.stringify(data)).not.toContain(secret);
    expect(JSON.stringify(warningCalls)).not.toContain(secret);
    expect(warningCalls).toContainEqual(["capture rejected", {
      detector: expect.any(String), actor_id: TEST_USER_ID,
    }]);
    expect(db.entries).toHaveLength(0);
    expect(query).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it("exposes MCP visibility/source fields, defaults private, and does not audit captured content", async () => {
    const pending: Promise<any>[] = [];
    const actor: HumanActorContext = {
      kind: "human",
      actorId: TEST_USER_ID,
      userId: TEST_USER_ID,
      role: "member",
      authMethod: "test",
      scopes: new Set(),
    };
    const server = buildMcpServer(env, { waitUntil: (promise: Promise<any>) => pending.push(promise) } as any, actor);
    const remember = (server as any)._registeredTools.remember;
    expect(Object.keys(remember.inputSchema.shape)).toEqual(expect.arrayContaining([
      "content", "tags", "source", "source_url", "source_title", "visibility",
    ]));
    expect(remember.inputSchema.parse({ content: "private MCP note" }).visibility).toBe("private");

    const result = await remember.handler({ content: "private MCP note" }, {});
    await Promise.allSettled(pending);

    expect(result.content[0].text).toContain("visibility: private");
    expect(db.entries[0].visibility).toBe("private");
    expect(JSON.stringify(db.agentEvents)).not.toContain("private MCP note");

    const publicResult = await remember.handler({
      content: "public MCP research note",
      visibility: "public",
      source_url: "https://example.test/mcp-source",
      source_title: "MCP source title",
    }, {});
    await Promise.allSettled(pending);

    expect(publicResult.content[0].text).toContain("visibility: public");
    expect(db.entries[1].visibility).toBe("public");
    expect(db.episodes[1].source_url).toBe("https://example.test/mcp-source");
    expect(db.documents[1].title).toBe("MCP source title");
  });

  it("rejects a secret in human MCP remember metadata without echo, audit content, or side effects", async () => {
    const pending: Promise<any>[] = [];
    const secret = `sk_live_${"z".repeat(24)}`;
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const query = vi.fn();
    const upsert = vi.fn();
    env = makeTestEnv(db, { VECTORIZE: makeVectorizeMock({ query, upsert }) });
    const actor: HumanActorContext = {
      kind: "human",
      actorId: TEST_USER_ID,
      userId: TEST_USER_ID,
      role: "member",
      authMethod: "test",
      scopes: new Set(),
    };
    const server = buildMcpServer(env, { waitUntil: (promise: Promise<any>) => pending.push(promise) } as any, actor);
    const remember = (server as any)._registeredTools.remember;

    const result = await remember.handler({ content: "Safe note", source_title: secret }, {});
    await Promise.allSettled(pending);
    const warningCalls = [...consoleWarn.mock.calls];
    consoleWarn.mockRestore();

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("Not stored: secret_detected.");
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(db.agentEvents)).not.toContain(secret);
    expect(JSON.stringify(warningCalls)).not.toContain(secret);
    expect(warningCalls).toEqual([["capture rejected", {
      detector: "stripe_live_secret", actor_id: TEST_USER_ID,
    }]]);
    expect(db.entries).toHaveLength(0);
    expect(query).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it("extracts hashtags from content and stores clean content with tags", async () => {
    const { ctx, drain } = makeCtx();
    const res = await worker.fetch(req("POST", "/capture", { body: { content: "went for a run #health #fitness" } }), env, ctx);
    await drain();
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(db.entries).toHaveLength(1);
    expect(db.entries[0].content).toBe("went for a run");
    const tags = JSON.parse(db.entries[0].tags);
    expect(tags).toContain("health");
    expect(tags).toContain("fitness");
  });

  it("merges hashtag tags with explicit tags and deduplicates case-insensitively", async () => {
    const { ctx, drain } = makeCtx();
    const res = await worker.fetch(req("POST", "/capture", { body: { content: "note #health", tags: ["Health", "fitness"] } }), env, ctx);
    await drain();
    expect(res.status).toBe(200);
    const tags: string[] = JSON.parse(db.entries[0].tags);
    const healthCount = tags.filter(t => t === "health").length;
    expect(healthCount).toBe(1);
    expect(tags).toContain("fitness");
  });

  it("behaves identically when no hashtags are present (regression)", async () => {
    const { ctx, drain } = makeCtx();
    const res = await worker.fetch(req("POST", "/capture", { body: { content: "plain note", tags: ["work"] } }), env, ctx);
    await drain();
    expect(res.status).toBe(200);
    expect(db.entries[0].content).toBe("plain note");
    const tags = JSON.parse(db.entries[0].tags);
    expect(tags).toEqual(["work"]);
  });

  it("falls back to original content when input is only hashtags", async () => {
    const { ctx, drain } = makeCtx();
    const res = await worker.fetch(req("POST", "/capture", { body: { content: "#task" } }), env, ctx);
    await drain();
    expect(res.status).toBe(200);
    expect(db.entries[0].content).toBe("#task");
    const tags = JSON.parse(db.entries[0].tags);
    expect(tags).toContain("task");
  });

  it("stores flagged duplicate (score 0.85–0.94) with duplicate-candidate tag", async () => {
    db.entries.push({ id: "near", content: "Similar existing note", tags: "[]", source: "api", created_at: 1, vector_ids: '["near"]', owner_user_id: TEST_USER_ID, current_episode_id: "episode-near" });
    const vectorize = makeVectorizeMock({
      query: vi.fn().mockResolvedValue({
        matches: [{ id: "near", score: 0.88, metadata: { parentId: "near", episodeId: "episode-near" } }],
      }),
    });
    env = makeTestEnv(db, { VECTORIZE: vectorize });

    const { ctx } = makeCtx();
    const res = await worker.fetch(req("POST", "/capture", { body: { content: "Similar note" } }), env, ctx);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(data.action).toBe("stored_separately");
    expect(data.warnings).toContain("Similar entry exists: near");
    expect(db.entries).toHaveLength(2);
    const tags = JSON.parse(db.entries[1].tags);
    expect(tags).toContain("duplicate-candidate");
  });
});
