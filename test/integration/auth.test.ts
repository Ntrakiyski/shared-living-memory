import { describe, it, expect, beforeEach, vi } from "vitest";
import worker, { _resetDbReady } from "../../src/testing";
import { makeTestDb, makeTestEnv } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import type { Env } from "../../src/testing";

const ctx = { waitUntil: (_: Promise<any>) => { } } as any;

const PROTECTED_ROUTES: Array<[string, string, unknown?]> = [
  ["POST", "/capture", { content: "hello" }],
  ["POST", "/append", { id: "abc", addition: "update" }],
  ["GET", "/list", undefined],
  ["GET", "/tags", undefined],
  ["GET", "/recall?query=test", undefined],
  ["POST", "/forget", { id: "abc" }],
  ["POST", "/chat", { query: "what?" }],
  ["POST", "/mcp", undefined],
];

describe("Auth", () => {
  let env: Env;
  let db: ReturnType<typeof makeTestDb>;
  beforeEach(() => {
    _resetDbReady();
    db = makeTestDb();
    env = makeTestEnv(db);
  });

  for (const [method, path, body] of PROTECTED_ROUTES) {
    it(`${method} ${path} — no token → 401`, async () => {
      const res = await worker.fetch(req(method, path, { body, token: null }), env, ctx);
      expect(res.status).toBe(401);
      const data = await res.json() as any;
      expect(data.error).toBe("Unauthorized");
    });

    it(`${method} ${path} — wrong token → 401`, async () => {
      const res = await worker.fetch(req(method, path, { body, token: "wrong-token" }), env, ctx);
      expect(res.status).toBe(401);
    });
  }

  for (const [method, path, body] of PROTECTED_ROUTES) {
    it(`${method} ${path} — workspace key bearer alone has no user principal`, async () => {
      const res = await worker.fetch(req(method, path, { body, token: "test-token" }), env, ctx);
      expect(res.status).toBe(401);
    });
  }

  it("accepts a personal API key directly as the REST bearer principal", async () => {
    const createRes = await worker.fetch(
      req("POST", "/api/users", { body: { username: "alice" } }),
      env,
      ctx,
    );
    const { key } = await createRes.json() as { key: string };

    const res = await worker.fetch(
      req("POST", "/capture", { body: { content: "personal bearer memory" }, token: key }),
      env,
      ctx,
    );

    expect(res.status).toBe(200);
    expect(db.entries[0]?.owner_user_id).toBe(db.users.find(user => user.username === "alice")?.id);
  });

  it("accepts a personal API key directly as the MCP bearer principal", async () => {
    const createRes = await worker.fetch(
      req("POST", "/api/users", { body: { username: "alice" } }),
      env,
      ctx,
    );
    const { key } = await createRes.json() as { key: string };

    const res = await worker.fetch(req("POST", "/mcp", { body: {}, token: key }), env, ctx);
    expect(res.status).toBe(200);
  });

  it("issues browser OAuth grants for the personal key's real users.id", async () => {
    const createRes = await worker.fetch(
      req("POST", "/api/users", { body: { username: "alice" } }), env, ctx,
    );
    const { key } = await createRes.json() as { key: string };
    const alice = db.users.find(user => user.username === "alice");
    const completeAuthorization = vi.fn().mockResolvedValue({
      redirectTo: "https://client.example.test/callback?code=issued",
    });
    (env as any).OAUTH_PROVIDER = {
      parseAuthRequest: vi.fn().mockResolvedValue({ scope: ["memory"] }),
      completeAuthorization,
    };

    const request = new Request(
      "http://localhost/oauth/authorize?client_id=test-client&response_type=code",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ password: key }),
      },
    );
    const res = await worker.fetch(request, env, ctx);

    expect(res.status).toBe(302);
    expect(completeAuthorization).toHaveBeenCalledWith({
      request: { scope: ["memory"] },
      userId: alice?.id,
      scope: ["memory"],
      props: { userId: alice?.id },
    });
  });

  it("does not turn the workspace key into a browser OAuth principal", async () => {
    const completeAuthorization = vi.fn();
    (env as any).OAUTH_PROVIDER = {
      parseAuthRequest: vi.fn().mockResolvedValue({ scope: ["memory"] }),
      completeAuthorization,
    };
    const request = new Request(
      "http://localhost/oauth/authorize?client_id=test-client&response_type=code",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ password: "test-token" }),
      },
    );

    const res = await worker.fetch(request, env, ctx);
    expect(res.status).toBe(401);
    expect(completeAuthorization).not.toHaveBeenCalled();
  });

  it("keeps private writes in distinct real-user namespaces", async () => {
    const aliceRes = await worker.fetch(
      req("POST", "/api/users", { body: { username: "alice" } }), env, ctx,
    );
    const bobRes = await worker.fetch(
      req("POST", "/api/users", { body: { username: "bob" } }), env, ctx,
    );
    const alice = await aliceRes.json() as { key: string };
    const bob = await bobRes.json() as { key: string };

    await worker.fetch(req("POST", "/capture", {
      token: alice.key,
      body: { content: "Alice private namespace", tags: ["private"] },
    }), env, ctx);
    await worker.fetch(req("POST", "/capture", {
      token: bob.key,
      body: { content: "Bob private namespace", tags: ["private"] },
    }), env, ctx);

    const ownerIds = db.entries.map(entry => entry.owner_user_id);
    expect(new Set(ownerIds).size).toBe(2);
    expect(ownerIds).not.toContain(db.users.find(user => user.username === "_system")?.id);
  });

  it("does not let the workspace key bearer mutate system-owned entries", async () => {
    await worker.fetch(req("GET", "/list"), env, ctx); // initializes the system owner
    const systemUser = db.users.find(user => user.username === "_system");
    expect(systemUser).toBeDefined();
    db.entries.push({
      id: "system-entry",
      content: "system-owned content",
      tags: "[]",
      source: "migration",
      created_at: 1,
      vector_ids: "[]",
      owner_user_id: systemUser!.id,
    });

    const res = await worker.fetch(req("POST", "/update", {
      token: "test-token",
      body: { id: "system-entry", content: "workspace key overwrite" },
    }), env, ctx);

    expect(res.status).toBe(401);
    expect(db.entries[0].content).toBe("system-owned content");
  });

  it("POST /capture — bearer + valid user headers → 200", async () => {
    // First create a user
    const createRes = await worker.fetch(req("POST", "/api/users", { body: { username: "alice" } }), env, ctx);
    const { key } = await createRes.json() as any;

    const res = await worker.fetch(
      req("POST", "/capture", { body: { content: "test entry" }, userCredentials: { username: "alice", key } }),
      env, ctx
    );
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
  });

  it("POST /capture — bearer + invalid key → 401", async () => {
    await worker.fetch(req("POST", "/api/users", { body: { username: "alice" } }), env, ctx);
    const res = await worker.fetch(
      req("POST", "/capture", { body: { content: "test" }, userCredentials: { username: "alice", key: "wrong-key" } }),
      env, ctx
    );
    expect(res.status).toBe(401);
  });

  it("POST /capture — bearer + unknown username → 401", async () => {
    const res = await worker.fetch(
      req("POST", "/capture", { body: { content: "test" }, userCredentials: { username: "unknown", key: "anything" } }),
      env, ctx
    );
    expect(res.status).toBe(401);
  });

  it("POST /capture — partial user headers do not fall back to the system actor", async () => {
    for (const header of ["X-Shared-Living-Memory-User", "X-Shared-Living-Memory-User-Key"]) {
      const request = req("POST", "/capture", { body: { content: "test" } });
      request.headers.set(header, "partial-credential");
      const res = await worker.fetch(request, env, ctx);
      expect(res.status).toBe(401);
    }
  });

  it("POST /capture — workspace credentials in the URL are rejected", async () => {
    const request = new Request("http://localhost/capture?token=test-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "test" }),
    });
    const res = await worker.fetch(request, env, ctx);
    expect(res.status).toBe(401);
  });

  it("POST /capture — user headers without bearer → 401", async () => {
    await worker.fetch(req("POST", "/api/users", { body: { username: "alice" } }), env, ctx);
    const createRes = await worker.fetch(req("POST", "/api/users", { body: { username: "alice" } }), env, ctx);
    // Even with valid user headers, no bearer token means 401
    const res = await worker.fetch(
      req("POST", "/capture", { body: { content: "test" }, token: null, userCredentials: { username: "alice", key: "whatever" } }),
      env, ctx
    );
    expect(res.status).toBe(401);
  });
});
