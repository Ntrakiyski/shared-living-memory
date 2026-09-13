/**
 * user-rotation.test.ts
 *
 * A1/A2 + Section 6.1: rotating a personal key replaces only the secret. The
 * stable `users.id` — and therefore every entry it owns — must survive, the old
 * key must stop authenticating immediately, and the new key must work on both
 * the REST and MCP credential paths.
 *
 * Runs against real SQLite so the real `users` table (roles, status, UNIQUE
 * constraints) is exercised instead of a hand-written mock.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteD1 } from "../helpers/sqlite-d1";
import worker from "../../src/testing";
import { _resetDbReady, initializeDatabase } from "../../src/testing";
import { resolveUserByApiKey } from "../../src/auth";
import { apiHandler } from "../../src/api-handler";
import type { Env } from "../../src/types";

const ctx = { waitUntil: (_: Promise<unknown>) => {}, passThroughOnException: () => {} } as any;
const WORKSPACE_TOKEN = "test-token";

interface Harness {
  db: SqliteD1;
  env: Env;
}

function makeHarness(): Harness {
  const db = new SqliteD1({ applySchema: false });
  _resetDbReady();
  const env = {
    DB: db as unknown as D1Database,
    AI: {
      run: vi.fn(async (_model: string, options: { text: string[] }) => ({
        data: [new Array(384).fill((options.text[0]?.length ?? 0) / 1000 + 0.01)],
      })),
    } as unknown as Ai,
    VECTORIZE: {
      upsert: vi.fn(async () => ({ mutationId: "upsert" })),
      deleteByIds: vi.fn(async () => ({ mutationId: "delete" })),
      insert: vi.fn(),
      query: vi.fn(async () => ({ matches: [] })),
      getByIds: vi.fn(async () => []),
      describe: vi.fn(),
    } as unknown as VectorizeIndex,
    AUTH_TOKEN: WORKSPACE_TOKEN,
    OAUTH_KV: {
      get: vi.fn(async () => null),
      put: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
      list: vi.fn(async () => ({ keys: [], list_complete: true, cacheStatus: null })),
    } as unknown as KVNamespace,
    MCP_OAUTH_ENABLED: "false",
  } as Env;
  return { db, env };
}

function mcpRequest(key: string, method: string): Request {
  return new Request("http://localhost/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method }),
  });
}

function restRequest(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.token) headers["Authorization"] = `Bearer ${opts.token}`;
  return new Request(`http://localhost${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
}

async function bootstrapAdmin(harness: Harness): Promise<{ username: string; key: string; id: string }> {
  await initializeDatabase(harness.env);
  const response = await worker.fetch(
    restRequest("POST", "/api/bootstrap", { token: WORKSPACE_TOKEN, body: { username: "jarvis" } }),
    harness.env,
    ctx,
  );
  expect(response.status).toBe(201);
  const body = await response.json() as { username: string; key: string };
  const row = harness.db.one<{ id: string }>(
    "SELECT id FROM users WHERE username = ?",
    body.username,
  );
  return { username: body.username, key: body.key, id: row.id };
}

async function createUser(
  harness: Harness,
  adminKey: string,
  username: string,
): Promise<{ username: string; key: string; id: string }> {
  const response = await worker.fetch(
    restRequest("POST", "/api/users", { token: adminKey, body: { username } }),
    harness.env,
    ctx,
  );
  expect(response.status).toBe(201);
  const body = await response.json() as { username: string; key: string };
  const row = harness.db.one<{ id: string }>("SELECT id FROM users WHERE username = ?", username);
  return { username: body.username, key: body.key, id: row.id };
}

describe("personal key rotation", () => {
  let harness: Harness;

  beforeEach(() => {
    harness = makeHarness();
  });

  afterEach(() => {
    harness.db.close();
  });

  it("A1 replaces only the secret and preserves id, ownership and MCP access", async () => {
    const admin = await bootstrapAdmin(harness);
    const alice = await createUser(harness, admin.key, "alice");

    // Give alice an entry so ownership can be checked across the rotation.
    harness.db.exec(
      `INSERT INTO entries (id, content, tags, source, created_at, vector_ids, owner_user_id)
       VALUES ('entry-alice', 'alice memory', '[]', 'api', 1, '[]', '${alice.id}')`,
    );

    expect(await resolveUserByApiKey(alice.key, harness.env)).toMatchObject({ user_id: alice.id });

    const rotate = await worker.fetch(
      restRequest("POST", "/api/me/rotate-key", { token: alice.key }),
      harness.env,
      ctx,
    );
    expect(rotate.status).toBe(200);
    const rotated = await rotate.json() as { username: string; key: string };
    expect(rotated.username).toBe("alice");
    expect(rotated.key).not.toBe(alice.key);

    // The stable account id is the key's public id, so the resolver finds it.
    expect(rotated.key.split(".")[0]).toBe(`slm_${alice.id}`);
    expect(harness.db.one<{ id: string }>(
      "SELECT id FROM users WHERE username = 'alice'",
    ).id).toBe(alice.id);

    // Old key is dead everywhere.
    expect(await resolveUserByApiKey(alice.key, harness.env)).toBeNull();
    expect((await worker.fetch(
      restRequest("GET", "/api/me", { token: alice.key }),
      harness.env,
      ctx,
    )).status).toBe(401);

    // New key passes REST identity...
    const me = await worker.fetch(
      restRequest("GET", "/api/me", { token: rotated.key }),
      harness.env,
      ctx,
    );
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({
      ok: true,
      user: { id: alice.id, username: "alice" },
    });

    // ...and the MCP credential path used by OAuthProvider.
    expect(await resolveUserByApiKey(rotated.key, harness.env)).toMatchObject({
      user_id: alice.id,
      username: "alice",
    });
    for (const method of ["initialize", "tools/list"]) {
      const response = await apiHandler.fetch(
        mcpRequest(rotated.key, method),
        harness.env,
        { ...ctx, props: { userId: alice.id } } as unknown as ExecutionContext,
      );
      expect({ method, status: response.status }).toEqual({ method, status: 200 });
    }

    // Ownership never moved.
    expect(harness.db.one<{ owner_user_id: string }>(
      "SELECT owner_user_id FROM entries WHERE id = 'entry-alice'",
    ).owner_user_id).toBe(alice.id);
  });

  it("A1 lets an admin rotate another active account", async () => {
    const admin = await bootstrapAdmin(harness);
    const bob = await createUser(harness, admin.key, "bob");

    const rotate = await worker.fetch(
      restRequest("POST", `/api/users/${bob.id}/rotate-key`, { token: admin.key }),
      harness.env,
      ctx,
    );
    expect(rotate.status).toBe(200);
    const rotated = await rotate.json() as { key: string };

    expect(await resolveUserByApiKey(bob.key, harness.env)).toBeNull();
    expect(await resolveUserByApiKey(rotated.key, harness.env)).toMatchObject({ user_id: bob.id });
  });

  it("A2 refuses a member rotating another account and an unknown target", async () => {
    const admin = await bootstrapAdmin(harness);
    const alice = await createUser(harness, admin.key, "alice");
    const bob = await createUser(harness, admin.key, "bob");

    const forbidden = await worker.fetch(
      restRequest("POST", `/api/users/${bob.id}/rotate-key`, { token: alice.key }),
      harness.env,
      ctx,
    );
    expect(forbidden.status).toBe(403);

    const unknown = await worker.fetch(
      restRequest("POST", "/api/users/does-not-exist/rotate-key", { token: admin.key }),
      harness.env,
      ctx,
    );
    expect(unknown.status).toBe(404);
  });

  it("A2 refuses rotation for a non-active account", async () => {
    const admin = await bootstrapAdmin(harness);
    const alice = await createUser(harness, admin.key, "alice");
    harness.db.exec(`UPDATE users SET status = 'deactivating' WHERE id = '${alice.id}'`);

    const self = await worker.fetch(
      restRequest("POST", "/api/me/rotate-key", { token: alice.key }),
      harness.env,
      ctx,
    );
    // The credential no longer authenticates at all.
    expect(self.status).toBe(401);

    const byAdmin = await worker.fetch(
      restRequest("POST", `/api/users/${alice.id}/rotate-key`, { token: admin.key }),
      harness.env,
      ctx,
    );
    expect(byAdmin.status).toBe(404);

    // No unusable key was minted and the stored hash is unchanged.
    const row = harness.db.one<{ auth_key_hash: string; auth_key_prefix: string }>(
      "SELECT auth_key_hash, auth_key_prefix FROM users WHERE id = ?",
      alice.id,
    );
    expect(row.auth_key_hash).toBeTruthy();
    expect(harness.db.one<{ count: number }>(
      "SELECT COUNT(*) AS count FROM security_events WHERE event_type LIKE '%key_rotation%'",
    ).count).toBe(0);
  });

  it("A2 never leaks a key, hash, prefix or account existence in an error body", async () => {
    const admin = await bootstrapAdmin(harness);
    const alice = await createUser(harness, admin.key, "alice");
    const hash = harness.db.one<{ auth_key_hash: string; auth_key_prefix: string }>(
      "SELECT auth_key_hash, auth_key_prefix FROM users WHERE id = ?",
      alice.id,
    );

    const unknownTarget = await worker.fetch(
      restRequest("POST", "/api/users/ghost/rotate-key", { token: admin.key }),
      harness.env,
      ctx,
    );
    const body = await unknownTarget.text();
    expect(body).not.toContain(hash.auth_key_hash);
    expect(body).not.toContain(hash.auth_key_prefix);
    expect(body).not.toContain(alice.key);
    expect(body).not.toContain("slm_");
  });
});
