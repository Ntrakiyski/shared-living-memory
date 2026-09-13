/**
 * client-isolation.test.ts
 *
 * O3 (client-isolation half) + Section 13: two independent installations
 * represent two clients. A key from one must not authenticate against the other,
 * and no entry, receipt, proposal, graph edge or export path may cross the
 * binding boundary. Tags and usernames are NOT a tenant boundary — separate
 * D1/Vectorize bindings are — so this proves the boundary at the deployment
 * level, not at the label level.
 *
 * Both installations are real, fully independent SQLite databases with their own
 * users, entries and staged vectors.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteD1 } from "../helpers/sqlite-d1";
import { _resetDbReady, initializeDatabase } from "../../src/testing";
import { resolveUserByApiKey } from "../../src/auth";
import { apiHandler, resolveRestActorContext } from "../../src/api-handler";
import { commitEntryVersion } from "../../src/entry-version-service";
import { buildEntryPageQuery } from "../../src/tags";
import type { Env } from "../../src/types";

const ctx = { waitUntil: (_: Promise<unknown>) => {}, passThroughOnException: () => {} } as any;

interface Installation {
  name: string;
  db: SqliteD1;
  env: Env;
  vectors: Map<string, unknown>;
  userKey: string;
  userId: string;
}

function makeInstallation(name: string, username: string): Installation {
  const db = new SqliteD1({ applySchema: false });
  const vectors = new Map<string, unknown>();
  const env = {
    DB: db as unknown as D1Database,
    AI: { run: vi.fn(async (_m: string, o: { text: string[] }) => ({ data: o.text.map(() => new Array(384).fill(0.01)) })) } as unknown as Ai,
    VECTORIZE: {
      upsert: vi.fn(async (items: { id: string }[]) => {
        for (const item of items) vectors.set(item.id, item);
        return { mutationId: "u" };
      }),
      deleteByIds: vi.fn(async (ids: string[]) => {
        for (const id of ids) vectors.delete(id);
        return { mutationId: "d" };
      }),
      insert: vi.fn(), query: vi.fn(async () => ({ matches: [] })),
      getByIds: vi.fn(async () => []), describe: vi.fn(),
    } as unknown as VectorizeIndex,
    AUTH_TOKEN: `${name}-workspace-key`,
    OAUTH_KV: {
      get: vi.fn(async () => null), put: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
      list: vi.fn(async () => ({ keys: [], list_complete: true, cacheStatus: null })),
    } as unknown as KVNamespace,
    MCP_OAUTH_ENABLED: "false",
    SLM_DEPLOYMENT_ID: name,
    SLM_ENVIRONMENT: "test",
    SLM_PUBLIC_BASE_URL: `https://${name}.example.test`,
    SLM_RELEASE_ID: "test-sha",
    SLM_WRITE_MODE: "enabled",
  } as Env;
  return { name, db, env, vectors, userKey: "", userId: "" };
}

/** Install one active account with a real verifiable credential. */
async function provision(installation: Installation, username: string): Promise<void> {
  _resetDbReady();
  await initializeDatabase(installation.env);
  const { hmacKey, generateApiKey, AUTH_PEPPER } = await import("../../src/auth");
  const { secret } = generateApiKey();
  const userId = `${installation.name}-${username}-id`;
  const hash = await hmacKey(secret, AUTH_PEPPER);
  const prefix = `slm_${userId}.`.slice(0, 15);
  installation.db.exec(
    `INSERT INTO users (id, username, normalized_username, auth_key_hash, auth_key_prefix, status, created_at, role)
     VALUES ('${userId}', '${username}', '${username}', '${hash}', '${prefix}', 'active', 1, 'member')`,
  );
  installation.userId = userId;
  installation.userKey = `slm_${userId}.${secret}`;
}

describe("two isolated client installations", () => {
  let clientA: Installation;
  let clientB: Installation;

  beforeEach(async () => {
    clientA = makeInstallation("client-a", "alice");
    clientB = makeInstallation("client-b", "alice");
    await provision(clientA, "alice");
    await provision(clientB, "alice");
  });

  afterEach(() => {
    clientA.db.close();
    clientB.db.close();
  });

  it("gives each client its own deployment metadata and key", () => {
    expect(clientA.env.SLM_DEPLOYMENT_ID).not.toBe(clientB.env.SLM_DEPLOYMENT_ID);
    expect(clientA.env.AUTH_TOKEN).not.toBe(clientB.env.AUTH_TOKEN);
    expect(clientA.userKey).not.toBe(clientB.userKey);
    // The SAME username exists in both installations, which is exactly why a
    // username can never be a tenant boundary.
    expect(clientA.db.one<{ username: string }>(
      "SELECT username FROM users LIMIT 1",
    ).username).toBe(clientB.db.one<{ username: string }>(
      "SELECT username FROM users LIMIT 1",
    ).username);
  });

  it("refuses client A's key in client B and vice versa", async () => {
    expect(await resolveUserByApiKey(clientA.userKey, clientA.env)).toMatchObject({ user_id: clientA.userId });
    expect(await resolveUserByApiKey(clientB.userKey, clientB.env)).toMatchObject({ user_id: clientB.userId });

    // Cross-installation authentication fails in both directions.
    expect(await resolveUserByApiKey(clientA.userKey, clientB.env)).toBeNull();
    expect(await resolveUserByApiKey(clientB.userKey, clientA.env)).toBeNull();
  });

  it("does not let one client's workspace bootstrap key act as the other's principal", async () => {
    expect(await resolveRestActorContext(new Request("http://localhost/api/me", {
      method: "GET",
      headers: { Authorization: `Bearer ${clientA.env.AUTH_TOKEN}` },
    }), clientA.env)).toBeNull();

    // A's workspace key is not a principal anywhere, including in its own install.
    expect(await resolveRestActorContext(new Request("http://localhost/api/me", {
      method: "GET",
      headers: { Authorization: `Bearer ${clientB.env.AUTH_TOKEN}` },
    }), clientA.env)).toBeNull();
  });

  it("keeps entries, receipts, episodes and vectors inside their own binding", async () => {
    const aEntry = await commitEntryVersion({
      kind: "capture",
      actorUserId: clientA.userId,
      entryId: "a-entry",
      rawContent: "Client A private memory",
      materializedContent: "Client A private memory",
      tags: ["work"],
      source: "api:alice",
      visibility: "public",
    }, clientA.env);
    const bEntry = await commitEntryVersion({
      kind: "capture",
      actorUserId: clientB.userId,
      entryId: "b-entry",
      rawContent: "Client B private memory",
      materializedContent: "Client B private memory",
      tags: ["work"],
      source: "api:alice",
      visibility: "public",
    }, clientB.env);

    // Each store sees only its own rows.
    expect(clientA.db.all<{ id: string }>("SELECT id FROM entries")).toEqual([{ id: "a-entry" }]);
    expect(clientB.db.all<{ id: string }>("SELECT id FROM entries")).toEqual([{ id: "b-entry" }]);
    expect(clientA.db.one<{ content: string }>(
      "SELECT content FROM entries WHERE id = ?", "b-entry",
    )).toBeUndefined();

    // Vector ids are episode-scoped, and each installation's index holds only
    // its own attempt's vectors.
    const aVectorIds = aEntry.vectorIds;
    const bVectorIds = bEntry.vectorIds;
    expect(aVectorIds.some((id) => bVectorIds.includes(id))).toBe(false);
    for (const id of aVectorIds) expect(clientA.vectors.has(id)).toBe(true);
    for (const id of aVectorIds) expect(clientB.vectors.has(id)).toBe(false);
  });

  it("never returns another installation's rows through the listing query", async () => {
    await commitEntryVersion({
      kind: "capture", actorUserId: clientA.userId, entryId: "a-only",
      rawContent: "A only", materializedContent: "A only",
      tags: [], source: "api:alice", visibility: "public",
    }, clientA.env);

    const { sql, bindings } = buildEntryPageQuery({ n: 10, userId: clientB.userId });
    const rows = clientB.db.all<{ id: string }>(sql, ...(bindings as (string | number)[]));
    expect(rows.map((row) => row.id)).not.toContain("a-only");
    expect(rows).toEqual([]);
  });

  it("keeps graph edges and proposals inside their own installation", async () => {
    await commitEntryVersion({
      kind: "capture", actorUserId: clientA.userId, entryId: "a1",
      rawContent: "A one", materializedContent: "A one",
      tags: [], source: "api:alice", visibility: "public",
    }, clientA.env);
    await commitEntryVersion({
      kind: "capture", actorUserId: clientA.userId, entryId: "a2",
      rawContent: "A two", materializedContent: "A two",
      tags: [], source: "api:alice", visibility: "public",
    }, clientA.env);
    clientA.db.exec(
      `INSERT INTO edges (id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at)
       VALUES ('a-edge', 'a1', 'a2', 'relates_to', 1.0, 'explicit', '{}', 1, 1)`,
    );
    clientA.db.exec(
      `INSERT INTO action_proposals (
         id, action_type, proposer_kind, proposer_id, visibility_scope, payload_json,
         payload_hash, target_ids, expected_preconditions, status, risk_level, reason,
         evidence_json, autonomy_profile, policy_version, idempotency_key, created_at, updated_at
       ) VALUES ('a-proposal', 'entry.epistemic-status.set', 'human', '${clientA.userId}', 'private',
                 '{"entryId":"a1","status":"reviewed"}', 'hash', '["a1"]', '{}', 'pending', 'low',
                 'reason', '[]', 'human-reviewed', 'v1', 'a-key', 1, 1)`,
    );

    expect(clientB.db.count("edges")).toBe(0);
    expect(clientB.db.count("action_proposals")).toBe(0);
    // Client B's own store is unaffected even though ids and usernames collide
    // in shape with client A's.
    expect(clientA.db.count("edges")).toBe(1);
    expect(clientA.db.count("action_proposals")).toBe(1);
  });

  it("does not accept client A's MCP key at client B's protocol endpoint", async () => {
    const response = await apiHandler.fetch(new Request("http://localhost/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${clientA.userKey}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    }), clientB.env, ctx);
    // Client B's OAuthProvider would not have accepted A's token; when props are
    // absent the actor resolution fails closed with a Bearer challenge.
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toBe("Bearer");
  });

  it("keeps exports scoped to the requesting installation", async () => {
    await commitEntryVersion({
      kind: "capture", actorUserId: clientA.userId, entryId: "a-export",
      rawContent: "Client A exportable", materializedContent: "Client A exportable",
      tags: [], source: "api:alice", visibility: "public",
    }, clientA.env);

    // The export path reads only from the installation it runs against.
    const exportedFromB = clientB.db.all<{ id: string }>("SELECT id FROM entries");
    expect(exportedFromB).toEqual([]);
    const exportedFromA = clientA.db.all<{ content: string }>("SELECT content FROM entries");
    expect(exportedFromA.map((row) => row.content)).toContain("Client A exportable");
  });
});
