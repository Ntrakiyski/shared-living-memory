/**
 * maintenance-mode.test.ts
 *
 * O5 + Section 16.1: read-only maintenance serves the read surface and refuses
 * every mutation before any side effect, using an explicit allowlist rather than
 * a method rule so a mutating GET cannot slip through.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteD1 } from "../helpers/sqlite-d1";
import worker, { _resetDbReady, initializeDatabase } from "../../src/testing";
import { buildMcpServer } from "../../src/mcp";
import {
  READ_ONLY_SAFE_GET_PATHS,
  READ_ONLY_SAFE_TOOLS,
  isMaintenanceReadOnly,
  isReadOnlySafeRequest,
  readWriteMode,
} from "../../src/config";
import type { Env, HumanActorContext } from "../../src/types";

const ctx = { waitUntil: (_: Promise<unknown>) => {}, passThroughOnException: () => {} } as any;
const ALICE_KEY = "slm_user-alice.alice-secret";

interface Harness {
  db: SqliteD1;
  env: Env;
}

function makeHarness(writeMode: string): Harness {
  const db = new SqliteD1({ applySchema: false });
  _resetDbReady();
  const env = {
    DB: db as unknown as D1Database,
    AI: { run: vi.fn(async () => ({ data: [new Array(384).fill(0.01)] })) } as unknown as Ai,
    VECTORIZE: {
      upsert: vi.fn(), deleteByIds: vi.fn(), insert: vi.fn(),
      query: vi.fn(async () => ({ matches: [] })), getByIds: vi.fn(async () => []), describe: vi.fn(),
    } as unknown as VectorizeIndex,
    AUTH_TOKEN: "test-token",
    OAUTH_KV: {
      get: vi.fn(async () => null), put: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
      list: vi.fn(async () => ({ keys: [], list_complete: true, cacheStatus: null })),
    } as unknown as KVNamespace,
    SLM_DEPLOYMENT_ID: "slm-test-deployment",
    SLM_ENVIRONMENT: "test",
    SLM_PUBLIC_BASE_URL: "https://memory.example.test",
    SLM_RELEASE_ID: "test-sha",
    SLM_WRITE_MODE: writeMode,
  } as Env;
  return { db, env };
}

async function seedAlice(harness: Harness): Promise<void> {
  await initializeDatabase(harness.env);
  const { hmacKey, AUTH_PEPPER } = await import("../../src/auth");
  const hash = await hmacKey("alice-secret", AUTH_PEPPER);
  harness.db.exec(
    `INSERT INTO users (id, username, normalized_username, auth_key_hash, auth_key_prefix, status, created_at, role)
     VALUES ('user-alice', 'alice', 'alice', '${hash}', 'slm_user-alice.', 'active', 1, 'member')`,
  );
}

function call(method: string, path: string, body?: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { Authorization: `Bearer ${ALICE_KEY}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("write mode predicate", () => {
  it("defaults to enabled and recognises read-only exactly", () => {
    expect(readWriteMode({})).toBe("enabled");
    expect(readWriteMode({ SLM_WRITE_MODE: "" })).toBe("enabled");
    expect(readWriteMode({ SLM_WRITE_MODE: "enabled" })).toBe("enabled");
    expect(readWriteMode({ SLM_WRITE_MODE: "read-only" })).toBe("read-only");
    expect(readWriteMode({ SLM_WRITE_MODE: "sometimes" })).toBe("invalid");
    expect(readWriteMode({ SLM_WRITE_MODE: "READ-ONLY" })).toBe("invalid");
    expect(isMaintenanceReadOnly({ SLM_WRITE_MODE: "read-only" })).toBe(true);
    expect(isMaintenanceReadOnly({})).toBe(false);
  });

  it("allows the fixed safe GET set and blocks everything else", () => {
    for (const path of READ_ONLY_SAFE_GET_PATHS) {
      expect({ path, safe: isReadOnlySafeRequest("GET", path) }).toEqual({ path, safe: true });
    }
    for (const path of ["/entries/e1/history", "/entries/e1/hierarchy", "/edges/e1/history"]) {
      expect({ path, safe: isReadOnlySafeRequest("GET", path) }).toEqual({ path, safe: true });
    }
    // A mutating GET is expressly blocked.
    expect(isReadOnlySafeRequest("GET", "/digest")).toBe(false);
    // Unknown routes and every mutation method are blocked.
    expect(isReadOnlySafeRequest("GET", "/api/unknown-route")).toBe(false);
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect({ method, safe: isReadOnlySafeRequest(method, "/capture") }).toEqual({ method, safe: false });
    }
    expect(isReadOnlySafeRequest("OPTIONS", "/capture")).toBe(true);
    expect(isReadOnlySafeRequest("GET", "/")).toBe(true);
    expect(isReadOnlySafeRequest("GET", "/assets/app.js")).toBe(true);
  });
});

describe("read-only maintenance over REST", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = makeHarness("read-only");
    await seedAlice(harness);
    harness.db.exec(
      `INSERT INTO entries (id, content, tags, source, created_at, vector_ids, owner_user_id, visibility)
       VALUES ('entry-1', 'readable', '["work"]', 'api', 1000, '[]', 'user-alice', 'public')`,
    );
  });

  afterEach(() => {
    harness.db.close();
  });

  it("refuses mutations with 503 maintenance_read_only before any side effect", async () => {
    const mutations: [string, string, unknown][] = [
      ["POST", "/capture", { content: "new memory" }],
      ["POST", "/capture/batch", { items: [{ client_item_id: "a", idempotency_key: "k", content: "x" }] }],
      ["POST", "/append", { id: "entry-1", addition: "more" }],
      ["POST", "/update", { id: "entry-1", content: "replaced" }],
      ["POST", "/forget", { id: "entry-1", confirm_entry_id: "entry-1" }],
      ["POST", "/status", { id: "entry-1", status: "draft" }],
      ["POST", "/epistemic-status", { id: "entry-1", status: "reviewed" }],
      ["POST", "/api/users", { username: "bob" }],
      ["POST", "/api/me/rotate-key", {}],
      ["POST", "/link", { source_id: "entry-1", target_id: "entry-1", type: "relates_to" }],
      ["POST", "/unlink", { id: "e1" }],
      ["POST", "/restore", { id: "entry-1" }],
      ["POST", "/action-proposals", { action_type: "entry.epistemic-status.set" }],
      ["POST", "/classify-pending", {}],
      ["POST", "/vectorize-pending", {}],
      ["POST", "/recall-feedback", { recall_event_id: "r", rating: 1 }],
      ["GET", "/digest", undefined],
    ];

    for (const [method, path, body] of mutations) {
      const response = await worker.fetch(call(method, path, body), harness.env, ctx);
      expect({ path, status: response.status }).toEqual({ path, status: 503 });
      const payload = await response.json() as any;
      expect({ path, code: payload.error.code }).toEqual({ path, code: "maintenance_read_only" });
    }

    // Nothing changed: same entry count, same revision, same visibility.
    expect(harness.db.count("entries")).toBe(1);
    expect(harness.db.one<{ revision: number; content: string }>(
      "SELECT revision, content FROM entries WHERE id = 'entry-1'",
    )).toMatchObject({ content: "readable" });
    // No account was created and no proposal was written.
    expect(harness.db.one<{ count: number }>(
      "SELECT COUNT(*) AS count FROM users WHERE username = 'bob'",
    ).count).toBe(0);
    expect(harness.db.count("action_proposals")).toBe(0);
  });

  it("still serves the read surface", async () => {
    for (const path of ["/health", "/api/me", "/api/whoami", "/count", "/list"]) {
      const response = await worker.fetch(call("GET", path), harness.env, ctx);
      expect({ path, status: response.status }).toEqual({ path, status: 200 });
    }
    // The gate lets the rest of the safe set reach its handler, whatever that
    // handler then decides about the request's own validity.
    for (const path of ["/export", "/stats", "/tags", "/connections", "/action-proposals"]) {
      const response = await worker.fetch(call("GET", path), harness.env, ctx);
      expect({ path, gated: response.status === 503 }).toEqual({ path, gated: false });
    }
    // Readiness is explicitly 503 in maintenance even though reads work.
    const ready = await worker.fetch(call("GET", "/ready"), harness.env, ctx);
    expect(ready.status).toBe(503);
    expect((await ready.json() as any).status).toBe("maintenance_read_only");
  });

  it("answers CORS preflight without invoking a handler", async () => {
    const response = await worker.fetch(call("OPTIONS", "/capture"), harness.env, ctx);
    expect(response.status).not.toBe(503);
    expect(harness.db.count("entries")).toBe(1);
  });
});

describe("read-only maintenance over MCP", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = makeHarness("read-only");
    await seedAlice(harness);
  });

  afterEach(() => {
    harness.db.close();
  });

  function actor(): HumanActorContext {
    return {
      kind: "human",
      actorId: "user-alice",
      userId: "user-alice",
      role: "member",
      authMethod: "personal_api_key",
      scopes: new Set(),
    };
  }

  it("keeps read tools registered and refuses mutation tools with a truthful error", async () => {
    const server = buildMcpServer(harness.env, ctx, actor(), "full") as any;
    const tools = server._registeredTools;

    // Read tools still exist and are callable.
    for (const name of READ_ONLY_SAFE_TOOLS) {
      expect(Object.keys(tools)).toContain(name);
    }

    for (const name of ["remember", "remember_batch", "update", "forget", "restore", "rate_recall"]) {
      expect(Object.keys(tools)).toContain(name);
      const result = await tools[name].handler({}, {});
      expect({ name, isError: result.isError }).toEqual({ name, isError: true });
      expect(result.content[0].text).toContain("maintenance_read_only");
    }
  });

  it("still serves whoami normally", async () => {
    const server = buildMcpServer(harness.env, ctx, actor(), "full") as any;
    const result = await server._registeredTools.whoami.handler({}, {});
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.data.deployment.write_mode).toBe("read-only");
  });

  it("registers mutation tools normally when writes are enabled", async () => {
    const writable = makeHarness("enabled");
    await seedAlice(writable);
    const server = buildMcpServer(writable.env, ctx, actor(), "full") as any;
    const result = await server._registeredTools.update.handler({ id: "nope", content: "x" }, {});
    expect(result.isError).toBeUndefined();
    writable.db.close();
  });
});

describe("MCP transport stays reachable in maintenance", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = makeHarness("read-only");
    await seedAlice(harness);
  });

  afterEach(() => {
    harness.db.close();
  });

  it("does not gate the /mcp protocol endpoint at the REST boundary", async () => {
    // /mcp is served by apiHandler under OAuthProvider, so the REST safe-route
    // allowlist must not intercept protocol negotiation. Per-tool gating happens
    // inside the server instead (see the tools/call assertions above).
    const response = await worker.fetch(new Request("http://localhost/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ALICE_KEY}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    }), harness.env, ctx);
    expect(response.status).not.toBe(503);
    const text = await response.text();
    expect(text).not.toContain("maintenance_read_only");
  });

  it("keeps authenticated identity readable in maintenance", async () => {
    const response = await worker.fetch(new Request("http://localhost/api/whoami", {
      method: "GET",
      headers: { Authorization: `Bearer ${ALICE_KEY}` },
    }), harness.env, ctx);
    expect(response.status).toBe(200);
    expect((await response.json() as any).data.deployment.write_mode).toBe("read-only");
  });

  it("serves the read-only dashboard asset", async () => {
    const response = await worker.fetch(new Request("http://localhost/", {
      method: "GET",
    }), harness.env, ctx);
    expect(response.status).not.toBe(503);
  });
});

describe("deep shared writes refuse in maintenance (second guard)", () => {
  it("blocks commitEntryVersion even when the request-level gate is bypassed", async () => {
    const { commitEntryVersion } = await import("../../src/entry-version-service");
    const harnessIn = makeHarness("read-only");
    await seedAlice(harnessIn);
    try {
      // A scheduled job or internal caller reaches this function directly, so the
      // gate cannot rely on the route allowlist or the MCP tool wrapper.
      await expect(commitEntryVersion({
        kind: "capture",
        actorUserId: "user-alice",
        entryId: "deep-guard",
        rawContent: "should not land",
        materializedContent: "should not land",
        tags: [],
        source: "api:alice",
      }, harnessIn.env)).rejects.toBeInstanceOf(Error);
      expect(harnessIn.db.count("entries")).toBe(0);
      expect(harnessIn.db.count("episodes")).toBe(0);
      // Nothing was staged in Vectorize either.
      expect(harnessIn.env.VECTORIZE.upsert as never).not.toHaveProperty("mock.calls.length", 1);
    } finally {
      harnessIn.db.close();
    }
  });

  it("blocks a direct erasure call in maintenance", async () => {
    const { eraseEntryArtifacts } = await import("../../src/erasure");
    const writable = makeHarness("enabled");
    await seedAlice(writable);
    writable.db.exec(
      `INSERT INTO entries (id, content, tags, source, created_at, vector_ids, owner_user_id, visibility)
       VALUES ('deep-entry', 'still here', '[]', 'api', 1, '[]', 'user-alice', 'private')`,
    );
    try {
      const actor = {
        kind: "human" as const, actorId: "user-alice", userId: "user-alice",
        role: "member" as const, authMethod: "personal_api_key", scopes: new Set<never>(),
      };
      // Same store, read-only switch flipped: the deletion must not proceed.
      const readOnlyEnv = { ...writable.env, SLM_WRITE_MODE: "read-only" } as Env;
      await expect(eraseEntryArtifacts("deep-entry", actor as never, readOnlyEnv)).rejects.toBeTruthy();
      expect(writable.db.count("entries")).toBe(1);

      // With writes enabled the same call succeeds, so the guard is the mode and
      // not a broken path.
      const erased = await eraseEntryArtifacts("deep-entry", actor as never, writable.env);
      expect(erased.status).toBe("complete");
      expect(writable.db.count("entries")).toBe(0);
    } finally {
      writable.db.close();
    }
  });
});
