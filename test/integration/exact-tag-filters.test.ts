import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import worker, { _resetDbReady, initializeDatabase } from "../../src/testing";
import { compressTag } from "../../src/lifecycle";
import { buildMcpServer } from "../../src/mcp";
import { AUTH_PEPPER, hmacKey } from "../../src/auth";
import type { Env, HumanActorContext } from "../../src/types";
import { SqliteD1 } from "../helpers/sqlite-d1";

const tags = ["long-" + "t".repeat(45), "literal%_tag", 'quoted"tag\\path'];
const actor: HumanActorContext = { kind: "human", actorId: "alice", userId: "alice", role: "member", authMethod: "personal_api_key", scopes: new Set() };
const ctx = { waitUntil: (promise: Promise<unknown>) => { void promise.catch(() => {}); } } as ExecutionContext;
let db: SqliteD1;
let likeDb: DatabaseSync;
let env: Env;

beforeEach(async () => {
  db = new SqliteD1({ applySchema: false });
  likeDb = new DatabaseSync(":memory:");
  _resetDbReady();
  env = {
    DB: db as unknown as D1Database,
    AI: { run: vi.fn(async () => new ReadableStream({ start(controller) { controller.close(); } })) },
    VECTORIZE: { query: vi.fn(async () => ({ matches: [] })), upsert: vi.fn(), deleteByIds: vi.fn() },
    OAUTH_KV: { get: vi.fn(async () => null), put: vi.fn(), delete: vi.fn() },
    AUTH_TOKEN: "test-token",
  } as unknown as Env;
  await initializeDatabase(env);
  for (const user of ["alice", "bob"]) {
    db.sqlite.prepare(`INSERT INTO users (id,username,normalized_username,auth_key_hash,auth_key_prefix,status,created_at,role) VALUES (?,?,?,?,?,'active',1,'member')`)
      .run(user, user, user, await hmacKey(`${user}-secret`, AUTH_PEPPER), `slm_${user}.`);
  }
  // D1 limits LIKE patterns to 50 bytes; delegate allowed patterns to SQLite.
  const like = likeDb.prepare("SELECT ? LIKE ? AS matched");
  db.sqlite.function("like", (pattern, value) => {
    if (typeof pattern === "string" && new TextEncoder().encode(pattern).byteLength > 50) {
      throw new Error("LIKE or GLOB pattern too complex");
    }
    return (like.get(value, pattern) as { matched: number }).matched;
  });
});

afterEach(() => { db.close(); likeDb.close(); });

function seed(id: string, tag: string, owner = "alice", visibility = "public", extraTags: string[] = []) {
  db.sqlite.prepare(`INSERT INTO entries (id,content,tags,source,created_at,vector_ids,owner_user_id,visibility,revision,recall_count,importance_score,epistemic_status) VALUES (?,?,?,'api',?,'[]',?,?,1,0,0,'candidate')`)
    .run(id, `content-${id}`, JSON.stringify([tag, ...extraTags]), Date.now(), owner, visibility);
}

async function get(path: string) {
  const response = await worker.fetch(new Request(`http://localhost${path}`, { headers: { Authorization: "Bearer slm_alice.alice-secret" } }), env, ctx);
  expect(response.status).toBe(200);
  return await response.json() as any;
}

it.each(tags)("browses the exact tag %s without wildcard matches or private leakage", async (tag) => {
  seed("owned", tag, "alice", "private");
  seed("public", tag, "bob");
  seed("hidden", tag, "bob", "private");
  seed("nearby", tag.replace("%_", "expanded") + "-other");
  const query = new URLSearchParams({ tag });
  const legacy = await get(`/list?${query}`);
  expect(legacy.map((entry: any) => entry.id).sort()).toEqual(["owned", "public"]);
  const page = await get(`/list?page=true&${query}`);
  expect(page.data.entries.map((entry: any) => entry.entry_id).sort()).toEqual(["owned", "public"]);
  const server = buildMcpServer(env, ctx, actor) as any;
  const result = await server._registeredTools.list_recent.handler({ tag, n: 10 }, {});
  expect(result.structuredContent.ok).toBe(true);
  expect(result.structuredContent.data.entries.map((entry: any) => entry.entry_id).sort()).toEqual(["owned", "public"]);
  expect(JSON.stringify([legacy, page, result])).not.toContain("content-hidden");
  expect((await get("/count")).count).toBe(3);
});

it.each(tags)("counts exact digest candidates for %s and respects cooldown", async (tag) => {
  for (let index = 0; index < 11; index++) {
    seed(`owned-${index}`, tag);
    seed(`hidden-${index}`, "hidden-only", "bob", "private");
  }
  seed("other-synthesis", tag + "-other", "alice", "public", ["synthesized"]);
  const stats = await get("/stats");
  expect(stats.digest_candidates).toEqual([{ tag, count: 11 }]);
  expect(JSON.stringify(stats)).not.toContain("hidden-only");
  seed("exact-synthesis", tag, "alice", "public", ["synthesized"]);
  expect((await get("/stats")).digest_candidates).toEqual([]);
});

it.each(tags)("selects only owned exact-tag sources for compression of %s", async (tag) => {
  for (let index = 0; index < 10; index++) {
    seed(`owned-${index}`, tag, "alice", "private");
    seed(`hidden-${index}`, tag, "bob", "private");
    seed(`foreign-public-${index}`, tag, "bob");
    seed(`nearby-${index}`, tag + "-other");
  }
  seed("other-synthesis", tag + "-other", "alice", "public", ["synthesized"]);
  await compressTag(tag, env, ctx, "alice");
  expect(env.AI.run).toHaveBeenCalledTimes(1);
  const prompt = JSON.stringify(vi.mocked(env.AI.run).mock.calls[0]);
  for (let index = 0; index < 10; index++) expect(prompt).toContain(`content-owned-${index}`);
  expect(prompt).not.toContain("content-hidden");
  expect(prompt).not.toContain("content-foreign-public");
  expect(prompt).not.toContain("content-nearby");
  seed("exact-synthesis", tag, "alice", "private", ["synthesized"]);
  vi.mocked(env.AI.run).mockClear();
  await compressTag(tag, env, ctx, "alice");
  expect(env.AI.run).not.toHaveBeenCalled();
});
