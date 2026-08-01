import { describe, it, expect, beforeEach } from "vitest";
import worker, { _resetDbReady } from "../../src/testing";
import { makeTestEnv } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import type { Env } from "../../src/testing";
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

describe("Migration & Ownership", () => {
  let env: Env;
  beforeEach(() => {
    env = makeTestEnv();
    _resetDbReady();
  });

  it("system user is created with status 'inactive'", async () => {
    const { ctx, flush } = makeCtx();
    await worker.fetch(req("GET", "/list"), env, ctx);
    await flush();
    const row = await (env.DB as any).prepare(
      "SELECT id, username, status FROM users WHERE username = ?"
    ).bind("_system").first();
    expect(row).not.toBeNull();
    expect(row.status).toBe("inactive");
  });

  it("system user gets a UUID id", async () => {
    const { ctx, flush } = makeCtx();
    await worker.fetch(req("GET", "/list"), env, ctx);
    await flush();
    const row = await (env.DB as any).prepare(
      "SELECT id FROM users WHERE username = ?"
    ).bind("_system").first();
    expect(row.id).toMatch(/^[a-f0-9]{32}$/);
  });

  it("entries table has owner_user_id column with empty default", async () => {
    await (env.DB as any).prepare(
      "INSERT INTO entries (id, content, tags, source, created_at, vector_ids) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind("test-1", "test", "[]", "api", Date.now(), "[]").run();
    const row = await (env.DB as any).prepare(
      "SELECT owner_user_id FROM entries WHERE id = 'test-1'"
    ).first();
    expect(row).not.toBeNull();
    expect(row.owner_user_id).toBe("");
  });

  it("migration assigns existing unowned entries to system user", async () => {
    const { ctx, flush } = makeCtx();
    // Manually insert entry without owner_user_id (simulates pre-migration data)
    await (env.DB as any).prepare(
      "INSERT INTO entries (id, content, tags, source, created_at, vector_ids) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind("old-entry", "old content", "[]", "api", 1000, "[]").run();
    // Trigger initialization + migration
    await worker.fetch(req("GET", "/list"), env, ctx);
    await flush();
    const systemRow = await (env.DB as any).prepare(
      "SELECT id FROM users WHERE username = ?"
    ).bind("_system").first();
    const entry = await (env.DB as any).prepare(
      "SELECT owner_user_id FROM entries WHERE id = ?"
    ).bind("old-entry").first();
    expect(entry.owner_user_id).toBe(systemRow.id);
  });

  it("idempotent — running migration twice does not duplicate system user", async () => {
    const { ctx, flush } = makeCtx();
    await worker.fetch(req("GET", "/list"), env, ctx);
    await flush();
    await worker.fetch(req("GET", "/list"), env, ctx);
    await flush();
    const { results } = await (env.DB as any).prepare(
      "SELECT id FROM users WHERE username = ?"
    ).bind("_system").all();
    expect(results).toHaveLength(1);
  });

  it("the canonical personal bearer never resolves to the system user ID", async () => {
    const { ctx, flush } = makeCtx();
    await worker.fetch(req("GET", "/list"), env, ctx);
    await flush();
    // Capture entry with the test fixture's personal API-key bearer.
    await worker.fetch(req("POST", "/capture", { body: { content: "legacy entry" } }), env, ctx);
    const systemRow = await (env.DB as any).prepare(
      "SELECT id FROM users WHERE username = ?"
    ).bind("_system").first();
    const entry = await (env.DB as any).prepare(
      "SELECT owner_user_id FROM entries WHERE content = ?"
    ).bind("legacy entry").first();
    expect(entry.owner_user_id).toBe(TEST_USER_ID);
    expect(entry.owner_user_id).not.toBe(systemRow.id);
  });

  it("export works after migration", async () => {
    const { ctx, flush } = makeCtx();
    await worker.fetch(req("GET", "/list"), env, ctx);
    await flush();
    const res = await worker.fetch(req("GET", "/export?mode=team_public"), env, ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(Array.isArray(data.entries)).toBe(true);
  });
});
