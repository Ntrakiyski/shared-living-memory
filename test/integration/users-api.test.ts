import { describe, it, expect, beforeEach } from "vitest";
import worker from "../../src/testing";
import { makeTestEnv, makeTestDb } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import type { Env } from "../../src/testing";
import { D1Mock } from "../helpers/d1-mock";

const ctx = { waitUntil: (_: Promise<any>) => { } } as any;

describe("POST /api/users", () => {
  let env: Env;
  beforeEach(() => { env = makeTestEnv(); });

  it("creates a user and returns username + key", async () => {
    const res = await worker.fetch(req("POST", "/api/users", { body: { username: "alice" } }), env, ctx);
    expect(res.status).toBe(201);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(data.username).toBe("alice");
    expect(data.key).toMatch(/^slm_[a-f0-9]+\.[a-zA-Z0-9]+$/);
  });

  it("rejects duplicate username", async () => {
    await worker.fetch(req("POST", "/api/users", { body: { username: "alice" } }), env, ctx);
    const res = await worker.fetch(req("POST", "/api/users", { body: { username: "alice" } }), env, ctx);
    expect(res.status).toBe(409);
    const data = await res.json() as any;
    expect(data.error).toMatch(/already exists/i);
  });

  it("rejects invalid username (special characters)", async () => {
    const res = await worker.fetch(req("POST", "/api/users", { body: { username: "alice bob" } }), env, ctx);
    expect(res.status).toBe(400);
    const data = await res.json() as any;
    expect(data.error).toMatch(/alphanumeric/i);
  });

  it("rejects username that is too long", async () => {
    const res = await worker.fetch(req("POST", "/api/users", { body: { username: "a".repeat(33) } }), env, ctx);
    expect(res.status).toBe(400);
    const data = await res.json() as any;
    expect(data.error).toMatch(/32 characters/i);
  });

  it("requires auth", async () => {
    const res = await worker.fetch(req("POST", "/api/users", { body: { username: "alice" }, token: null }), env, ctx);
    expect(res.status).toBe(401);
  });

  it("can authenticate with created user's key", async () => {
    const createRes = await worker.fetch(req("POST", "/api/users", { body: { username: "alice" } }), env, ctx);
    const { key } = await createRes.json() as any;

    const listRes = await worker.fetch(
      req("GET", "/list", { userCredentials: { username: "alice", key } }),
      env, ctx
    );
    expect(listRes.status).toBe(200);
  });
});

describe("GET /api/users", () => {
  let env: Env;
  beforeEach(() => { env = makeTestEnv(); });

  it("returns empty array initially", async () => {
    const res = await worker.fetch(req("GET", "/api/users"), env, ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.users).toEqual([]);
  });

  it("returns active users after creation", async () => {
    await worker.fetch(req("POST", "/api/users", { body: { username: "alice" } }), env, ctx);
    await worker.fetch(req("POST", "/api/users", { body: { username: "bob" } }), env, ctx);
    const res = await worker.fetch(req("GET", "/api/users"), env, ctx);
    const data = await res.json() as any;
    expect(data.users).toHaveLength(2);
    expect(data.users.map((u: any) => u.username).sort()).toEqual(["alice", "bob"]);
    for (const u of data.users) {
      expect(u.id).toBeDefined();
      expect(u.status).toBe("active");
      expect(["admin", "member"]).toContain(u.role);
    }
  });

  it("requires auth", async () => {
    const res = await worker.fetch(req("GET", "/api/users", { token: null }), env, ctx);
    expect(res.status).toBe(401);
  });
});

// ── Deactivation ─────────────────────────────────────────────────────────────

describe("POST /api/users/:id/deactivate", () => {
  let env: Env;
  let db: D1Mock;

  beforeEach(() => {
    db = makeTestDb();
    env = makeTestEnv(db);
  });

  async function createUser(username: string): Promise<{ id: string; key: string }> {
    const res = await worker.fetch(req("POST", "/api/users", { body: { username } }), env, ctx);
    const data = await res.json() as any;
    // Look up the actual user ID from the database
    const userRow = await env.DB.prepare("SELECT id FROM users WHERE username = ?").bind(username).first() as any;
    return { id: userRow?.id ?? data.username, key: data.key };
  }

  it("requires an administrator even when a member targets themselves", async () => {
    const alice = await createUser("alice");

    const deactivateRes = await worker.fetch(
      req("POST", `/api/users/${alice.id}/deactivate`, { userCredentials: { username: "alice", key: alice.key } }),
      env, ctx,
    );
    const data = await deactivateRes.json() as any;
    expect(deactivateRes.status).toBe(403);
    expect(data.ok).toBe(false);
    expect(data.error).toMatch(/administrator/i);

    const userRow = await env.DB.prepare("SELECT status FROM users WHERE username = ?").bind("alice").first() as any;
    expect(userRow?.status).toBe("active");
  });

  it("non-owner cannot deactivate other users", async () => {
    const alice = await createUser("alice");
    const bob = await createUser("bob");

    const deactivateRes = await worker.fetch(
      req("POST", `/api/users/${alice.id}/deactivate`, { userCredentials: { username: "bob", key: bob.key } }),
      env, ctx,
    );
    expect(deactivateRes.status).toBe(403);
  });

  it("requires authentication", async () => {
    const alice = await createUser("alice");
    const res = await worker.fetch(
      req("POST", `/api/users/${alice.id}/deactivate`, { token: null }),
      env,
      ctx,
    );
    expect(res.status).toBe(401);
  });
});
