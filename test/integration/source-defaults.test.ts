/**
 * source-defaults.test.ts
 *
 * O2 + Section 5.3: an omitted source resolves to the verified principal of the
 * transport that received the capture. An explicit label is preserved as
 * declared provenance, and a keyed retry hashes the actor-default MARKER rather
 * than the resolved display name, so renaming cannot change a retry's meaning.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteD1 } from "../helpers/sqlite-d1";
import worker, { _resetDbReady, initializeDatabase } from "../../src/testing";
import { buildMcpServer } from "../../src/mcp";
import { captureServicePrivateDraft } from "../../src/operator-memory";
import { commitEntryVersion } from "../../src/entry-version-service";
import { captureRequestHash, ACTOR_DEFAULT_SOURCE_MARKER } from "../../src/capture-receipts";
import type { Env, HumanActorContext, ServiceActorContext, ServiceScope } from "../../src/types";

const ctx = { waitUntil: (_: Promise<unknown>) => {}, passThroughOnException: () => {} } as any;

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
  } as Env;
  return { db, env };
}

async function seed(harness: Harness): Promise<void> {
  await initializeDatabase(harness.env);
  const { hmacKey, AUTH_PEPPER } = await import("../../src/auth");
  const hash = await hmacKey("alice-secret", AUTH_PEPPER);
  harness.db.exec(
    `INSERT INTO users (id, username, normalized_username, auth_key_hash, auth_key_prefix, status, created_at, role)
     VALUES ('user-alice', 'alice', 'alice', '${hash}', 'slm_user-alice.', 'active', 1, 'admin')`,
  );
  harness.db.exec(
    `INSERT INTO service_identities (id, name, owner_user_id, status, default_autonomy_profile, created_by_user_id, created_at, updated_at)
     VALUES ('svc-1', 'Hermes Operator', 'user-alice', 'active', 'execute-approved', 'user-alice', 1, 1)`,
  );
  harness.db.exec(
    `INSERT INTO service_credentials (id, service_identity_id, credential_hash, credential_prefix, scopes, status, created_by_user_id, created_at)
     VALUES ('cred-1', 'svc-1', 'hash', 'sbs_x', '["memory:draft","audit:write","run:write"]', 'active', 'user-alice', 1)`,
  );
}

const ALICE_KEY = "slm_user-alice.alice-secret";

function sourceOf(harness: Harness, entryId: string): string {
  return harness.db.one<{ source: string }>("SELECT source FROM entries WHERE id = ?", entryId).source;
}

describe("actor-based source defaults (O2)", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = makeHarness();
    await seed(harness);
  });

  afterEach(() => {
    harness.db.close();
  });

  it("defaults personal REST capture to api:<verified username>", async () => {
    const response = await worker.fetch(new Request("http://localhost/capture", {
      method: "POST",
      headers: { Authorization: `Bearer ${ALICE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ content: "REST default source" }),
    }), harness.env, ctx);
    expect(response.status).toBe(200);
    const { id } = await response.json() as { id: string };
    expect(sourceOf(harness, id)).toBe("api:alice");
  });

  it("preserves an explicit REST source as declared provenance", async () => {
    const response = await worker.fetch(new Request("http://localhost/capture", {
      method: "POST",
      headers: { Authorization: `Bearer ${ALICE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Declared source", source: "notion" }),
    }), harness.env, ctx);
    const { id } = await response.json() as { id: string };
    expect(sourceOf(harness, id)).toBe("notion");
  });

  it("defaults personal MCP capture to mcp:<verified username>", async () => {
    const actor: HumanActorContext = {
      kind: "human", actorId: "user-alice", userId: "user-alice",
      role: "admin", authMethod: "personal_api_key", scopes: new Set(),
    };
    const server = buildMcpServer(harness.env, ctx, actor, "full") as any;
    const result = await server._registeredTools.remember.handler({ content: "MCP default source" }, {});
    expect(result.isError).toBeUndefined();
    const entry = harness.db.one<{ id: string; source: string }>(
      "SELECT id, source FROM entries ORDER BY created_at DESC LIMIT 1",
    );
    expect(entry.source).toBe("mcp:alice");
  });

  it("defaults service capture to operator:<verified service name>", async () => {
    const actor: ServiceActorContext = {
      kind: "service",
      actorId: "svc-1",
      serviceIdentityId: "svc-1",
      credentialId: "cred-1",
      ownerUserId: "user-alice",
      authMethod: "service_api_key",
      scopes: new Set<ServiceScope>(["memory:draft", "audit:write", "run:write"]),
    };
    const committed = await captureServicePrivateDraft(harness.env, {
      actor,
      content: "Service default source",
    });
    // The service NAME, not its identity id and not its owner's username.
    expect(sourceOf(harness, committed.entryId)).toBe("operator:Hermes Operator");
  });

  it("hashes the actor-default marker so a rename cannot change a retry's meaning", async () => {
    const before = await captureRequestHash({
      content: "Renamable",
      tags: [],
      sourceDeclaration: ACTOR_DEFAULT_SOURCE_MARKER,
      sourceUrl: null,
      sourceTitle: null,
      visibility: "private",
      contentType: "text",
    });
    // Renaming the account does not touch the marker, so the hash is stable.
    harness.db.exec(`UPDATE users SET username = 'alice-renamed' WHERE id = 'user-alice'`);
    const after = await captureRequestHash({
      content: "Renamable",
      tags: [],
      sourceDeclaration: ACTOR_DEFAULT_SOURCE_MARKER,
      sourceUrl: null,
      sourceTitle: null,
      visibility: "private",
      contentType: "text",
    });
    expect(after).toBe(before);
  });

  it("never relabels an existing record when the principal is renamed", async () => {
    const committed = await commitEntryVersion({
      kind: "capture",
      actorUserId: "user-alice",
      entryId: "entry-old",
      rawContent: "Old record",
      materializedContent: "Old record",
      source: "api:alice",
    }, harness.env);
    harness.db.exec(`UPDATE users SET username = 'alice-renamed' WHERE id = 'user-alice'`);
    expect(sourceOf(harness, committed.entryId)).toBe("api:alice");
  });
});
