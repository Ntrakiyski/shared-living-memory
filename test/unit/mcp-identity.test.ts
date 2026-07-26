import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMcpHandler } from "agents/mcp";

import {
  AUTH_PEPPER,
  hmacKey,
  isValidMcpActorId,
  resolveUserByApiKey,
  resolveMcpActor,
} from "../../src/auth";
import { apiHandler } from "../../src/api-handler";
import { buildMcpServer } from "../../src/mcp";
import { makeTestDb, makeTestEnv } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import type { HumanActorContext } from "../../src/types";

const MCP_BODY = { jsonrpc: "2.0", id: 1, method: "initialize" };

function makeCtx(props?: unknown): ExecutionContext {
  return {
    props,
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
}

const humanActor = (userId: string): HumanActorContext => ({
  kind: "human" as const,
  actorId: userId,
  userId,
  role: "member" as const,
  authMethod: "test",
  scopes: new Set(),
});

async function addUser(
  db: ReturnType<typeof makeTestDb>,
  id: string,
  username: string,
  secret: string,
) {
  db.users.push({
    id,
    username,
    normalized_username: username.toLowerCase(),
    auth_key_hash: await hmacKey(secret, AUTH_PEPPER),
    auth_key_prefix: `slm_${id}`.slice(0, 15),
    status: "active",
    created_at: Date.now(),
  });
  return { username, key: `slm_${id}.${secret}` };
}

async function seedUser() {
  const db = makeTestDb();
  const credentials = await addUser(db, "user-alice", "Alice", "alice-secret");
  return {
    db,
    env: makeTestEnv(db),
    credentials,
  };
}

describe("MCP actor resolution", () => {
  it("uses the OAuthProvider principal when no legacy user headers are present", async () => {
    const db = makeTestDb();
    await addUser(db, "oauth-alice", "OAuthAlice", "oauth-secret");
    const env = makeTestEnv(db);
    const result = await resolveMcpActor(
      req("POST", "/mcp", { body: MCP_BODY }),
      env,
      { userId: "oauth-alice" },
    );

    expect(result).toEqual({
      ok: true,
      actor: {
        user_id: "oauth-alice",
        username: "OAuthAlice",
        source: "oauth_props",
      },
    });
  });

  it("resolves a personal API key to its active users.id", async () => {
    const { env, credentials } = await seedUser();
    await expect(resolveUserByApiKey(credentials.key, env)).resolves.toEqual({
      user_id: "user-alice",
      username: "Alice",
    });
    await expect(resolveUserByApiKey("test-token", env)).resolves.toBeNull();
  });

  it("preserves a complete, verified per-user legacy actor", async () => {
    const { db, env, credentials } = await seedUser();
    await addUser(db, "oauth-alice", "OAuthAlice", "oauth-secret");
    const result = await resolveMcpActor(
      req("POST", "/mcp", { body: MCP_BODY, userCredentials: credentials }),
      env,
      { userId: "oauth-alice" },
    );

    expect(result).toEqual({
      ok: true,
      actor: {
        user_id: "user-alice",
        username: "Alice",
        source: "user_credentials",
      },
    });
  });

  it("allows verified legacy credentials without props only with the workspace key", async () => {
    const { env, credentials } = await seedUser();
    const authorized = await resolveMcpActor(
      req("POST", "/mcp", { body: MCP_BODY, userCredentials: credentials }),
      env,
      undefined,
    );
    const unauthenticated = await resolveMcpActor(
      req("POST", "/mcp", { body: MCP_BODY, token: null, userCredentials: credentials }),
      env,
      undefined,
    );

    expect(authorized.ok && authorized.actor.user_id).toBe("user-alice");
    expect(unauthenticated).toEqual({ ok: false, reason: "legacy_transport_unauthorized" });
  });

  it("fails closed when no actor exists", async () => {
    const result = await resolveMcpActor(
      req("POST", "/mcp", { body: MCP_BODY }),
      makeTestEnv(),
      undefined,
    );

    expect(result).toEqual({ ok: false, reason: "missing_actor" });
  });

  it("rejects malformed OAuth actor IDs", async () => {
    const env = makeTestEnv();
    for (const userId of ["", "anonymous", "_system", "owner", "user with spaces", "service:hermes"]) {
      const result = await resolveMcpActor(
        req("POST", "/mcp", { body: MCP_BODY }),
        env,
        { userId },
      );
      expect(result).toEqual({ ok: false, reason: "invalid_oauth_actor" });
    }
  });

  it("rejects partial or invalid user headers instead of falling back to OAuth", async () => {
    const { db, env, credentials } = await seedUser();
    await addUser(db, "oauth-alice", "OAuthAlice", "oauth-secret");
    const partialRequest = req("POST", "/mcp", { body: MCP_BODY });
    partialRequest.headers.set("X-Shared-Living-Memory-User", credentials.username);
    const invalidRequest = req("POST", "/mcp", {
      body: MCP_BODY,
      userCredentials: { username: credentials.username, key: "wrong-key" },
    });

    await expect(resolveMcpActor(partialRequest, env, { userId: "oauth-alice" }))
      .resolves.toEqual({ ok: false, reason: "incomplete_user_credentials" });
    await expect(resolveMcpActor(invalidRequest, env, { userId: "oauth-alice" }))
      .resolves.toEqual({ ok: false, reason: "invalid_user_credentials" });
  });

  it("rejects syntactically valid OAuth props that do not name an active user", async () => {
    const db = makeTestDb();
    await addUser(db, "inactive-user", "Inactive", "secret");
    db.users[0].status = "inactive";

    await expect(resolveMcpActor(
      req("POST", "/mcp", { body: MCP_BODY }),
      makeTestEnv(db),
      { userId: "inactive-user" },
    )).resolves.toEqual({ ok: false, reason: "invalid_oauth_actor" });
  });
});

describe("MCP API identity guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 before constructing/handling MCP when actor props are absent", async () => {
    const response = await apiHandler.fetch(
      req("POST", "/mcp", { body: MCP_BODY }),
      makeTestEnv(),
      makeCtx(),
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toBe("Bearer");
    expect(createMcpHandler).not.toHaveBeenCalled();
  });

  it("builds a scoped server and passes only the effective actor to MCP auth context", async () => {
    const db = makeTestDb();
    await addUser(db, "oauth-alice", "OAuthAlice", "oauth-secret");
    const response = await apiHandler.fetch(
      req("POST", "/mcp", { body: MCP_BODY }),
      makeTestEnv(db),
      makeCtx({ userId: "oauth-alice", ignoredClaim: "do-not-forward" }),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("mcp");
    expect(vi.mocked(createMcpHandler).mock.calls[0]?.[1]).toEqual({
      authContext: {
        props: {
          actorKind: "human",
          actorId: "oauth-alice",
          ownerUserId: "oauth-alice",
          actorSource: "oauth_props",
        },
      },
    });
  });

  it("propagates a verified legacy user as the effective scoped MCP actor", async () => {
    const { db, env, credentials } = await seedUser();
    await addUser(db, "oauth-alice", "OAuthAlice", "oauth-secret");
    const response = await apiHandler.fetch(
      req("POST", "/mcp", { body: MCP_BODY, userCredentials: credentials }),
      env,
      makeCtx({ userId: "oauth-alice" }),
    );

    expect(response.status).toBe(200);
    expect(vi.mocked(createMcpHandler).mock.calls[0]?.[1]).toEqual({
      authContext: {
        props: {
          actorKind: "human",
          actorId: "user-alice",
          ownerUserId: "user-alice",
          actorSource: "user_credentials",
        },
      },
    });
  });

  it("does not fall back to OAuth when supplied user credentials are invalid", async () => {
    const { db, env } = await seedUser();
    await addUser(db, "oauth-alice", "OAuthAlice", "oauth-secret");
    const response = await apiHandler.fetch(
      req("POST", "/mcp", {
        body: MCP_BODY,
        userCredentials: { username: "Alice", key: "wrong-key" },
      }),
      env,
      makeCtx({ userId: "oauth-alice" }),
    );

    expect(response.status).toBe(401);
    expect(createMcpHandler).not.toHaveBeenCalled();
  });

  it("refuses direct construction with an invalid actor", () => {
    expect(isValidMcpActorId("scoped-agent")).toBe(true);
    expect(() => buildMcpServer(makeTestEnv(), makeCtx(), humanActor(""))).toThrow(
      "A verified, scoped MCP actor is required",
    );
    expect(() => buildMcpServer(makeTestEnv(), makeCtx(), humanActor("anonymous"))).toThrow(
      "A verified, scoped MCP actor is required",
    );
  });
});
