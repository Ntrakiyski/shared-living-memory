/**
 * auth-guidance.test.ts
 *
 * Section 4.2/6.2: authentication failures stay deliberately generic while still
 * naming the deployment, and OAuth-disabled routes explain that personal keys are
 * the supported path. Completes the A2 "no key/hash/user-existence leak" case at
 * the transport boundary.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteD1 } from "../helpers/sqlite-d1";
import worker, { _resetDbReady, initializeDatabase } from "../../src/testing";
import { apiHandler } from "../../src/api-handler";
import type { Env } from "../../src/types";

const ctx = { waitUntil: (_: Promise<unknown>) => {}, passThroughOnException: () => {} } as any;
const CANONICAL = "https://memory.example.test";

interface Harness {
  db: SqliteD1;
  env: Env;
}

function makeHarness(overrides: Record<string, unknown> = {}): Harness {
  const db = new SqliteD1({ applySchema: false });
  _resetDbReady();
  const env = {
    DB: db as unknown as D1Database,
    AI: { run: vi.fn(async () => ({ data: [new Array(384).fill(0.01)] })) } as unknown as Ai,
    VECTORIZE: {
      upsert: vi.fn(), deleteByIds: vi.fn(), insert: vi.fn(),
      query: vi.fn(async () => ({ matches: [] })), getByIds: vi.fn(async () => []), describe: vi.fn(),
    } as unknown as VectorizeIndex,
    AUTH_TOKEN: "workspace-token-value",
    OAUTH_KV: {
      get: vi.fn(async () => null), put: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
      list: vi.fn(async () => ({ keys: [], list_complete: true, cacheStatus: null })),
    } as unknown as KVNamespace,
    MCP_OAUTH_ENABLED: "false",
    SLM_DEPLOYMENT_ID: "slm-test-deployment",
    SLM_ENVIRONMENT: "test",
    SLM_PUBLIC_BASE_URL: CANONICAL,
    SLM_RELEASE_ID: "test-sha",
    SLM_WRITE_MODE: "enabled",
    ...overrides,
  } as Env;
  return { db, env };
}

function mcpRequest(token: string): Request {
  return new Request("http://localhost/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
  });
}

describe("MCP authentication guidance", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = makeHarness();
    await initializeDatabase(harness.env);
  });

  afterEach(() => {
    harness.db.close();
  });

  it("challenges with Bearer and names the deployment without guessing a reason", async () => {
    const response = await apiHandler.fetch(mcpRequest("slm_unknown.wrong-secret"), harness.env, ctx);
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toBe("Bearer");
    expect(response.headers.get("Cache-Control")).toBe("no-store");

    const body = await response.text();
    expect(body).toContain(CANONICAL);
    // A plain Bearer challenge names the deployment but never the key, a hash,
    // a prefix, or whether an account exists.
    expect(body).not.toContain("wrong-secret");
    expect(body).not.toContain("workspace-token-value");
    expect(body).not.toMatch(/auth_key|hash|prefix/i);
    expect(body).not.toMatch(/no such user|user not found|unknown account|does not exist/i);
  });

  it("still names the deployment when metadata is absent, without inventing one", async () => {
    const bare = makeHarness({ SLM_PUBLIC_BASE_URL: "" });
    try {
      await initializeDatabase(bare.env);
      const response = await apiHandler.fetch(mcpRequest("slm_unknown.wrong-secret"), bare.env, ctx);
      expect(response.status).toBe(401);
      const body = await response.text();
      expect(body).toContain("personal API key");
      expect(body).not.toContain(CANONICAL);
    } finally {
      bare.db.close();
    }
  });

  it("treats the workspace bootstrap key alone as insufficient", async () => {
    const response = await apiHandler.fetch(mcpRequest("workspace-token-value"), harness.env, ctx);
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain("workspace-token-value");
  });
});

describe("OAuth-disabled guidance", () => {
  let harness: Harness;

  beforeEach(() => {
    harness = makeHarness();
  });

  afterEach(() => {
    harness.db.close();
  });

  it("explains that OAuth is off, that personal keys work, and how to get one", async () => {
    for (const path of [
      "/.well-known/oauth-authorization-server",
      "/oauth/authorize",
      "/oauth/token",
      "/oauth/register",
    ]) {
      const response = await worker.fetch(new Request(`http://localhost${path}`), harness.env, ctx);
      expect({ path, status: response.status }).toEqual({ path, status: 404 });
      const body = await response.text();
      expect(body).toContain("OAuth issuance is disabled");
      expect(body).toContain("personal API keys are accepted");
      expect(body).toContain(`${CANONICAL}/`);
      expect(body).toContain("Authorization: Bearer");
      expect(body).not.toContain("workspace-token-value");
    }
  });

  it("falls back to a dashboard instruction when no canonical URL is configured", async () => {
    const bare = makeHarness({ SLM_PUBLIC_BASE_URL: "" });
    try {
      const response = await worker.fetch(new Request("http://localhost/oauth/token"), bare.env, ctx);
      expect(response.status).toBe(404);
      const body = await response.text();
      expect(body).toContain("dashboard");
      expect(body).not.toContain(CANONICAL);
    } finally {
      bare.db.close();
    }
  });

  it("does not intercept OAuth routes when OAuth is explicitly enabled", async () => {
    const oauth = makeHarness({ MCP_OAUTH_ENABLED: "true" });
    try {
      // The gate must not fire: the request reaches the OAuthProvider instead of
      // being answered with the OAuth-disabled copy. (The provider itself is
      // mocked in this environment, so only the gate is asserted here.)
      for (const path of ["/.well-known/oauth-authorization-server", "/oauth/token", "/oauth/register"]) {
        const response = await worker.fetch(
          new Request(`http://localhost${path}`, { method: "POST" }),
          oauth.env,
          ctx,
        );
        const body = await response.text();
        expect({ path, intercepted: body.includes("OAuth issuance is disabled") })
          .toEqual({ path, intercepted: false });
      }
    } finally {
      oauth.db.close();
    }
  });
});
