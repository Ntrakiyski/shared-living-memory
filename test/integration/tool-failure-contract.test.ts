/**
 * tool-failure-contract.test.ts
 *
 * M4 + Sections 4.1/9.3: a failed tool sets isError explicitly and returns a safe
 * domain code, never a raw SQL or internal exception message. A committed
 * deletion whose cleanup or audit finalization did not finish is reported as
 * success with a truthful pending state, never as a retryable failure.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteD1 } from "../helpers/sqlite-d1";
import worker, { _resetDbReady, initializeDatabase } from "../../src/testing";
import { buildMcpServer } from "../../src/mcp";
import { mapDomainError } from "../../src/mcp-results";
import type { Env, HumanActorContext } from "../../src/types";

const ctx = { waitUntil: (_: Promise<unknown>) => {}, passThroughOnException: () => {} } as any;
const ALICE_KEY = "slm_user-alice.alice-secret";

interface Harness {
  db: SqliteD1;
  env: Env;
}

function makeHarness(): Harness {
  const db = new SqliteD1({ applySchema: false });
  _resetDbReady();
  const env = {
    DB: db as unknown as D1Database,
    AI: { run: vi.fn(async (_m: string, o: { text: string[] }) => ({ data: o.text.map(() => new Array(384).fill(0.01)) })) } as unknown as Ai,
    VECTORIZE: {
      upsert: vi.fn(async () => ({ mutationId: "u" })),
      deleteByIds: vi.fn(async () => ({ mutationId: "d" })),
      insert: vi.fn(), query: vi.fn(async () => ({ matches: [] })), getByIds: vi.fn(async () => []), describe: vi.fn(),
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
    SLM_WRITE_MODE: "enabled",
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

const ACTOR: HumanActorContext = {
  kind: "human", actorId: "user-alice", userId: "user-alice",
  role: "member", authMethod: "personal_api_key", scopes: new Set(),
};

describe("failed tool contract", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = makeHarness();
    await seedAlice(harness);
  });

  afterEach(() => {
    harness.db.close();
  });

  function tool(harnessIn: Harness, name: string, input: Record<string, unknown> = {}) {
    const server = buildMcpServer(harnessIn.env, ctx, ACTOR, "full") as any;
    return server._registeredTools[name].handler(input, {});
  }

  it("sets isError and hides the raw SQL message when the database fails", async () => {
    const original = harness.db.prepare.bind(harness.db);
    (harness.db as any).prepare = (sql: string) => {
      if (sql.includes("FROM entries")) {
        throw new Error("D1_ERROR: no such table: entries — raw internal detail");
      }
      return original(sql);
    };

    const result = await tool(harness, "list_recent", { n: 5 })
      .finally(() => { (harness.db as any).prepare = original; });

    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).not.toContain("D1_ERROR");
    expect(text).not.toContain("no such table");
    expect(text).not.toContain("raw internal detail");
    // A safe code is reported instead.
    expect(text).toMatch(/Error [a-z_]+:/);
  });

  it("maps an unknown failure to a retryable storage_unavailable rather than leaking it", () => {
    const mapped = mapDomainError(new Error("SQLITE_BUSY: database is locked at src/db.ts:1"));
    expect(mapped.code).toBe("storage_unavailable");
    expect(mapped.retryable).toBe(true);
    expect(mapped.message).not.toContain("SQLITE_BUSY");
    expect(mapped.message).not.toContain("src/db.ts");
  });

  it("keeps a successful empty search a success, distinct from a failure", async () => {
    const result = await tool(harness, "recall", { query: "nothing-matches-this", topK: 5, hops: 0 });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.ok).toBe(true);
    expect(result.structuredContent.data.matches).toEqual([]);
  });
});

describe("committed deletion with unfinished cleanup or audit (Section 9.3)", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = makeHarness();
    await seedAlice(harness);
    harness.db.exec(
      `INSERT INTO entries (id, content, tags, source, created_at, vector_ids, owner_user_id, visibility)
       VALUES ('entry-1', 'gone soon', '["work"]', 'api', 1000, '["v1"]', 'user-alice', 'private')`,
    );
  });

  afterEach(() => {
    harness.db.close();
  });

  async function forget(): Promise<Response> {
    return await worker.fetch(new Request("http://localhost/forget", {
      method: "POST",
      headers: { Authorization: `Bearer ${ALICE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ id: "entry-1", confirm_entry_id: "entry-1" }),
    }), harness.env, ctx);
  }

  it("reports committed with pending cleanup when the vector delete fails, and never asks for a retry", async () => {
    harness.env.VECTORIZE.deleteByIds = vi.fn(async () => { throw new Error("Vectorize down"); });

    const response = await forget();
    const body = await response.json() as any;
    // Truthful either way: the content deletion committed, and the caller is
    // never told to retry the deletion itself.
    expect(body.ok).toBe(true);
    expect(body.retry).toBe(false);
    expect([200, 202]).toContain(response.status);
    expect(body.erasure_status).toBe("pending_cleanup");
    // The authoritative D1 deletion happened; the queue holds the repair work.
    expect(harness.db.one<{ count: number }>(
      "SELECT COUNT(*) AS count FROM entries WHERE id = 'entry-1'",
    ).count).toBe(0);
    expect(harness.db.count("vector_cleanup_queue")).toBeGreaterThan(0);
  });

  it("reports a completed erasure when vectors are removed", async () => {
    const response = await forget();
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body).toMatchObject({ ok: true, erasure_status: "complete" });
    expect(harness.db.count("vector_cleanup_queue")).toBe(0);
  });
});
