/**
 * tool-profiles-whoami.test.ts
 *
 * A4/A5 + Sections 5.1/5.2: exact profile inventories, profile transport
 * rejection, alias parity, and whoami reporting only verified storage facts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteD1 } from "../helpers/sqlite-d1";
import worker, { _resetDbReady, initializeDatabase } from "../../src/testing";
import { buildMcpServer } from "../../src/mcp";
import { apiHandler } from "../../src/api-handler";
import {
  PERSONAL_FULL_TOOLS,
  PERSONAL_PROFILE_TOOLS,
  SERVICE_TOOLS,
  EDGE_TOOL_ALIASES,
  profileAllowsTool,
} from "../../src/config";
import type { Env, HumanActorContext, ServiceActorContext } from "../../src/types";

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
    AI: { run: vi.fn(async (_m: string, o: { text: string[] }) => ({ data: o.text.map(() => new Array(384).fill(0.01)) })) } as unknown as Ai,
    VECTORIZE: {
      upsert: vi.fn(), deleteByIds: vi.fn(), insert: vi.fn(),
      query: vi.fn(async () => ({ matches: [] })), getByIds: vi.fn(async () => []), describe: vi.fn(),
    } as unknown as VectorizeIndex,
    AUTH_TOKEN: WORKSPACE_TOKEN,
    OAUTH_KV: {
      get: vi.fn(async () => null), put: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
      list: vi.fn(async () => ({ keys: [], list_complete: true, cacheStatus: null })),
    } as unknown as KVNamespace,
    MCP_OAUTH_ENABLED: "false",
    SLM_DEPLOYMENT_ID: "slm-test-deployment",
    SLM_ENVIRONMENT: "test",
    SLM_PUBLIC_BASE_URL: "https://memory.example.test",
    SLM_RELEASE_ID: "test-sha",
    SLM_WRITE_MODE: "enabled",
  } as Env;
  return { db, env };
}

function personalActor(role: "admin" | "member" = "member"): HumanActorContext {
  return {
    kind: "human",
    actorId: "user-alice",
    userId: "user-alice",
    role,
    authMethod: "personal_api_key",
    scopes: new Set(),
  };
}

function serviceActorCtx(): ServiceActorContext {
  return {
    kind: "service",
    actorId: "service-hermes",
    serviceIdentityId: "service-hermes",
    credentialId: "credential-hermes",
    ownerUserId: "user-owner",
    authMethod: "service_api_key",
    scopes: new Set(["memory:read"]),
  };
}

function registeredToolNames(server: ReturnType<typeof buildMcpServer>): string[] {
  return Object.keys((server as any)._registeredTools).sort();
}

function mcpRequest(profile?: string): Request {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${WORKSPACE_TOKEN}`,
    "X-Shared-Living-Memory-User": "alice",
    "X-Shared-Living-Memory-User-Key": "slm_user-alice.alice-secret",
  };
  if (profile !== undefined) headers["X-SLM-Tool-Profile"] = profile;
  return new Request("http://localhost/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
}

/** Seed a real active personal account whose stored key matches alice-secret. */
async function seedAlice(harness: Harness): Promise<void> {
  await initializeDatabase(harness.env);
  const { hmacKey, AUTH_PEPPER } = await import("../../src/auth");
  const hash = await hmacKey("alice-secret", AUTH_PEPPER);
  harness.db.exec(
    `INSERT INTO users (id, username, normalized_username, auth_key_hash, auth_key_prefix, status, created_at, role)
     VALUES ('user-alice', 'alice', 'alice', '${hash}', 'slm_user-alice.', 'active', 1, 'member')`,
  );
  harness.db.exec(
    `INSERT INTO service_identities (
       id, name, owner_user_id, status, default_autonomy_profile, created_by_user_id, created_at, updated_at
     ) VALUES ('service-hermes', 'Hermes Operator', 'user-alice', 'active', 'execute-approved', 'user-alice', 1, 1)`,
  );
  harness.db.exec(
    `INSERT INTO service_credentials (
       id, service_identity_id, credential_hash, credential_prefix, scopes, status, created_by_user_id, created_at
     ) VALUES ('credential-hermes', 'service-hermes', 'hash', 'sbs_test', '["memory:read"]', 'active', 'user-alice', 1)`,
  );
}

describe("exact tool profiles (A4)", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = makeHarness();
    await seedAlice(harness);
  });

  afterEach(() => {
    harness.db.close();
  });

  it("exposes exactly the capture, review and full personal inventories", () => {
    const capture = registeredToolNames(buildMcpServer(harness.env, ctx, personalActor(), "capture"));
    const review = registeredToolNames(buildMcpServer(harness.env, ctx, personalActor(), "review"));
    const full = registeredToolNames(buildMcpServer(harness.env, ctx, personalActor(), "full"));

    expect(capture).toEqual([
      "connections", "create_action_proposal", "history", "list_action_proposals",
      "list_recent", "passages", "recall", "remember", "remember_batch", "whoami",
    ]);
    expect(capture).toHaveLength(10);
    expect(review).toHaveLength(16);
    expect(full).toHaveLength(29);
    expect(full).toEqual([...PERSONAL_FULL_TOOLS].sort());
  });

  it("makes capture a subset of review and review a subset of full", () => {
    const capture = new Set(PERSONAL_PROFILE_TOOLS.capture);
    const review = new Set(PERSONAL_PROFILE_TOOLS.review);
    for (const tool of capture) expect(review.has(tool)).toBe(true);
    for (const tool of review) expect(PERSONAL_FULL_TOOLS as readonly string[]).toContain(tool);
  });

  it("registers the edge aliases only in full and shares the canonical handler", () => {
    const full = buildMcpServer(harness.env, ctx, personalActor(), "full") as any;
    const review = buildMcpServer(harness.env, ctx, personalActor(), "review") as any;
    const fullTools = full._registeredTools;
    const reviewTools = review._registeredTools;
    for (const [canonical, alias] of Object.entries(EDGE_TOOL_ALIASES)) {
      expect(Object.keys(fullTools)).toContain(alias);
      expect(Object.keys(reviewTools)).not.toContain(alias);
      // Same backend handler function, so no logic is duplicated.
      expect(typeof fullTools[alias].handler).toBe("function");
      // The alias and the canonical name share one handler function object, so
      // no backend logic is duplicated behind the second name.
      expect(fullTools[alias].handler).toBe(fullTools[canonical].handler);
      // Neither the canonical name nor the alias exists outside the full profile.
      expect(Object.keys(reviewTools)).not.toContain(canonical);
    }
  });

  it("never registers a profile-disallowed tool, so it cannot dispatch", () => {
    const capture = buildMcpServer(harness.env, ctx, personalActor(), "capture") as any;
    for (const hidden of ["forget", "update", "link", "restore", "propose_edge", "review_action_proposal"]) {
      expect(Object.keys(capture._registeredTools)).not.toContain(hidden);
      expect(profileAllowsTool("capture", hidden)).toBe(false);
    }
  });

  it("intersects service profiles with the implemented service tools", () => {
    const capture = registeredToolNames(buildMcpServer(harness.env, ctx, serviceActorCtx(), "capture"));
    const full = registeredToolNames(buildMcpServer(harness.env, ctx, serviceActorCtx(), "full"));
    for (const tool of capture) expect(SERVICE_TOOLS as readonly string[]).toContain(tool);
    expect(full).toEqual([...SERVICE_TOOLS].sort());
    // No personal-only capability leaks into a service connection.
    for (const personalOnly of ["remember_batch", "forget", "restore", "rate_recall", "list_edge_proposals"]) {
      expect(full).not.toContain(personalOnly);
    }
  });

  it("rejects an invalid or empty profile header with 400 instead of falling back", async () => {
    for (const value of ["", "FULL", "admin", "capture,review"]) {
      const response = await apiHandler.fetch(mcpRequest(value), harness.env, ctx);
      expect({ value, status: response.status }).toEqual({ value, status: 400 });
      const body = await response.json() as any;
      expect(body.error.data.code).toBe("invalid_profile");
    }
  });

  it("defaults a missing profile header to full", async () => {
    for (const profile of [undefined, "full", "capture", "review"]) {
      const response = await apiHandler.fetch(mcpRequest(profile), harness.env, ctx);
      expect({ profile, status: response.status }).toEqual({ profile, status: 200 });
    }
  });

  it("advertises the profile header in the CORS allowlist", async () => {
    const { CORS_HEADERS } = await import("../../src/config");
    expect(CORS_HEADERS["Access-Control-Allow-Headers"]).toContain("X-SLM-Tool-Profile");
  });
});

describe("whoami (A5)", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = makeHarness();
    await seedAlice(harness);
  });

  afterEach(() => {
    harness.db.close();
  });

  async function whoamiRest(token: string): Promise<{ status: number; body: any }> {
    const response = await worker.fetch(new Request("http://localhost/api/whoami", {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    }), harness.env, ctx);
    return { status: response.status, body: await response.json() };
  }

  it("reports verified personal identity without any secret field", async () => {
    const personalKey = "slm_user-alice.alice-secret";
    const { status, body } = await whoamiRest(personalKey);
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    const data = body.data;
    expect(data.principal).toEqual({ id: "user-alice", name: "alice", kind: "human" });
    expect(data.credential_type).toBe("personal_api_key");
    expect(data.auth_method).toBe("personal_api_key");
    expect(data.owner).toBeNull();
    expect(data.role).toBe("member");
    expect(data.scopes).toEqual([]);
    expect(data.human_presence_verified).toBe(false);
    expect(data.default_visibility).toBe("private");
    expect(data.deployment).toMatchObject({
      id: "slm-test-deployment",
      environment: "test",
      canonical_url: "https://memory.example.test",
      release_id: "test-sha",
      write_mode: "enabled",
    });
    expect(data.effective_tools).toHaveLength(29);
    expect(data.effective_tools).toEqual([...data.effective_tools].sort());
    // The key itself, its hash and its prefix never appear.
    expect(JSON.stringify(body)).not.toContain("alice-secret");
    expect(JSON.stringify(body)).not.toMatch(/auth_key|auth_key_hash|slm_user-alice/i);
  });

  it("reports the service principal name and owner, with no review capability", async () => {
    const { createServiceIdentity, resolveServiceCredential } = await import("../../src/service-identities");
    // Replace the fixture identity with one created through the real API so the
    // credential resolver can verify its secret. Provisioning requires an admin.
    harness.db.exec(`DELETE FROM service_credentials; DELETE FROM service_identities;`);
    harness.db.exec(`UPDATE users SET role = 'admin' WHERE id = 'user-alice'`);
    const created = await createServiceIdentity({
      requesterUserId: "user-alice",
      ownerUserId: "user-alice",
      name: "Hermes Operator",
      scopes: ["memory:read"],
    }, harness.env);
    const secret = created.credential.key;
    expect(await resolveServiceCredential(secret, harness.env)).toBeTruthy();

    const { status, body } = await whoamiRest(secret);
    expect(status).toBe(200);
    expect(body.data.credential_type).toBe("service_api_key");
    expect(body.data.role).toBeNull();
    expect(body.data.owner).toEqual({ id: "user-alice", username: "alice" });
    expect(body.data.principal.name).toBe("Hermes Operator");
    expect(body.data.capabilities.proposal_review).toBe("none");
    expect(body.data.human_presence_verified).toBe(false);
    expect(JSON.stringify(body)).not.toContain(secret);
  });

  it("reports the requested profile and its actual subset", async () => {
    const response = await worker.fetch(new Request("http://localhost/api/whoami", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${WORKSPACE_TOKEN}`,
        "X-Shared-Living-Memory-User": "alice",
        "X-Shared-Living-Memory-User-Key": "slm_user-alice.alice-secret",
        "X-SLM-Tool-Profile": "capture",
      },
    }), harness.env, ctx);
    const body = await response.json() as any;
    expect(body.data.tool_profile).toBe("capture");
    expect(body.data.effective_tools).toHaveLength(10);
    // Account capabilities are computed independently from the request profile.
    expect(body.data.capabilities.direct_mutation_scope).toBe("owned_entries");
  });

  it("rejects an invalid profile header on REST whoami instead of reporting full", async () => {
    const response = await worker.fetch(new Request("http://localhost/api/whoami", {
      method: "GET",
      headers: { Authorization: `Bearer ${WORKSPACE_TOKEN}`, "X-SLM-Tool-Profile": "admin" },
    }), harness.env, ctx);
    expect(response.status).toBe(400);
    expect((await response.json() as any).error.code).toBe("invalid_profile");
  });

  it("returns 401 with the common boundary when unauthenticated", async () => {
    const response = await worker.fetch(new Request("http://localhost/api/whoami", {
      method: "GET",
    }), harness.env, ctx);
    expect(response.status).toBe(401);
    const body = await response.json() as any;
    expect(body.error.code).toBe("invalid_credentials");
    expect(response.headers.get("WWW-Authenticate")).toBe("Bearer");
  });

  it("flags incomplete deployment metadata as a warning, never a secret", async () => {
    (harness.env as any).SLM_RELEASE_ID = "";
    const { body } = await whoamiRest("slm_user-alice.alice-secret");
    expect(body.warnings.join(" ")).toContain("SLM_RELEASE_ID");
    expect(JSON.stringify(body)).not.toMatch(/auth_key|secret/i);
  });
});
