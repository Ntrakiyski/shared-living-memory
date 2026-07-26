import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { createMcpHandler } from "agents/mcp";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { apiHandler } from "../../src/api-handler";
import { AUTH_PEPPER, hmacKey } from "../../src/auth";
import { _resetDbReady } from "../../src/db";
import { buildMcpServer } from "../../src/mcp";
import { defaultHandler } from "../../src/routes";
import {
  SERVICE_SCOPES,
  type Env,
  type HumanActorContext,
  type ServiceActorContext,
  type ServiceScope,
} from "../../src/types";
import { req } from "../helpers/make-request";

const schema = readFileSync(resolve(process.cwd(), "db/schema.sql"), "utf8");

class SqliteStatement {
  constructor(
    private readonly owner: SqliteD1,
    readonly sql: string,
    private readonly values: unknown[] = [],
  ) {}

  bind(...values: unknown[]): SqliteStatement {
    return new SqliteStatement(this.owner, this.sql, values);
  }

  async run(): Promise<any> {
    const result = this.owner.sqlite.prepare(this.sql).run(...this.values as SQLInputValue[]);
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  }

  async all<T = Record<string, unknown>>(): Promise<any> {
    const results = this.owner.sqlite.prepare(this.sql).all(...this.values as SQLInputValue[]) as T[];
    return { success: true, results, meta: { changes: 0 } };
  }

  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    const found = this.owner.sqlite.prepare(this.sql).get(...this.values as SQLInputValue[]) as Record<string, unknown> | undefined;
    if (!found) return null;
    return (column ? found[column] : found) as T;
  }
}

class SqliteD1 {
  readonly sqlite = new DatabaseSync(":memory:");

  constructor() {
    this.sqlite.exec(schema);
  }

  prepare(sql: string): SqliteStatement {
    return new SqliteStatement(this, sql);
  }

  async batch(statements: SqliteStatement[]): Promise<any[]> {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const results: any[] = [];
      for (const statement of statements) results.push(await statement.run());
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
}

function makeEnv(db: SqliteD1): Env {
  return {
    DB: db as unknown as D1Database,
    AI: {
      run: vi.fn(async (_model: string, options: { text: string[] }) => ({
        data: options.text.map(() => new Array(384).fill(0.01)),
      })),
    } as unknown as Ai,
    VECTORIZE: {
      upsert: vi.fn(async () => ({ mutationId: "upsert" })),
      insert: vi.fn(async () => ({ mutationId: "insert" })),
      deleteByIds: vi.fn(async () => ({ mutationId: "delete" })),
      query: vi.fn(async () => ({ matches: [] })),
      getByIds: vi.fn(async () => []),
      describe: vi.fn(async () => ({})),
    } as unknown as VectorizeIndex,
    AUTH_TOKEN: "test-token",
    OAUTH_KV: {
      get: vi.fn(async () => null),
      put: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
      list: vi.fn(async () => ({ keys: [], list_complete: true, cacheStatus: null })),
    } as unknown as KVNamespace,
  };
}

function makeCtx(props?: unknown): ExecutionContext {
  return {
    props,
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
}

async function seedHuman(
  db: SqliteD1,
  id: string,
  username: string,
  role: "admin" | "member",
): Promise<string> {
  const secret = `${username}-secret`;
  const key = `slm_${id}.${secret}`;
  db.sqlite.prepare(
    `INSERT INTO users (
       id, username, normalized_username, auth_key_hash, auth_key_prefix,
       status, created_at, role
     ) VALUES (?, ?, ?, ?, ?, 'active', 1, ?)`,
  ).run(id, username, username.toLowerCase(), await hmacKey(secret, AUTH_PEPPER), key.slice(0, 15), role);
  return key;
}

function seedService(db: SqliteD1, scopes: readonly ServiceScope[] = SERVICE_SCOPES): ServiceActorContext {
  db.sqlite.prepare(
    `INSERT INTO service_identities (
       id, name, owner_user_id, status, default_autonomy_profile,
       created_by_user_id, created_at, updated_at
     ) VALUES ('service-hermes', 'Hermes', 'user-owner', 'active', 'execute-approved', 'user-owner', 1, 1)`,
  ).run();
  db.sqlite.prepare(
    `INSERT INTO service_credentials (
       id, service_identity_id, credential_hash, credential_prefix, scopes,
       status, created_by_user_id, created_at
     ) VALUES ('credential-hermes', 'service-hermes', 'credential-hash', 'sbs_hermes', ?, 'active', 'user-owner', 1)`,
  ).run(JSON.stringify(scopes));
  return {
    kind: "service",
    actorId: "service-hermes",
    serviceIdentityId: "service-hermes",
    credentialId: "credential-hermes",
    ownerUserId: "user-owner",
    authMethod: "sbs-key",
    scopes: new Set(scopes),
  };
}

function registeredToolNames(server: ReturnType<typeof buildMcpServer>): string[] {
  return Object.keys((server as any)._registeredTools).sort();
}

function callTool(
  server: ReturnType<typeof buildMcpServer>,
  name: string,
  input: Record<string, unknown>,
): Promise<any> {
  return (server as any)._registeredTools[name].handler(input, {});
}

describe("operator MCP surfaces", () => {
  let db: SqliteD1;
  let env: Env;

  beforeEach(() => {
    vi.clearAllMocks();
    _resetDbReady();
    db = new SqliteD1();
    env = makeEnv(db);
  });

  it("resolves a service ActorContext to only the safe governed tool allowlist", async () => {
    await seedHuman(db, "user-owner", "owner", "member");
    const actor = seedService(db);

    const response = await apiHandler.fetch(
      req("POST", "/mcp", { body: { jsonrpc: "2.0", id: 1, method: "initialize" }, token: null }),
      env,
      makeCtx({
        actorKind: "service",
        serviceIdentityId: actor.serviceIdentityId,
        credentialId: actor.credentialId,
        ownerUserId: actor.ownerUserId,
        authMethod: actor.authMethod,
        scopes: [...actor.scopes],
      }),
    );

    expect(response.status).toBe(200);
    const handlerCall = vi.mocked(createMcpHandler).mock.calls[0];
    const server = handlerCall?.[0] as ReturnType<typeof buildMcpServer>;
    expect(handlerCall?.[1]).toEqual({
      authContext: {
        props: {
          actorKind: "service",
          actorId: "service-hermes",
          ownerUserId: "user-owner",
          actorSource: "service_api_key",
        },
      },
    });
    expect(registeredToolNames(server)).toEqual([
      "connections",
      "create_action_proposal",
      "execute_approved_action",
      "history",
      "list_action_proposals",
      "list_recent",
      "recall",
      "remember",
    ]);
    expect(registeredToolNames(server)).not.toEqual(expect.arrayContaining([
      "forget",
      "unlink",
      "approve-proposal",
      "reject-proposal",
      "review_action_proposal",
    ]));

    const stored = await callTool(server, "remember", {
      content: "Hermes observed a durable team decision.",
      tags: ["decision", "status:canonical"],
      source: "hermes-test",
      idempotency_key: "surface-private-draft",
    });
    expect(stored.isError).not.toBe(true);
    const entry = db.sqlite.prepare(
      `SELECT owner_user_id, visibility, epistemic_status, tags, revision
       FROM entries WHERE content = ?`,
    ).get("Hermes observed a durable team decision.") as Record<string, unknown>;
    expect(entry).toMatchObject({
      owner_user_id: "user-owner",
      visibility: "private",
      epistemic_status: "candidate",
      revision: 1,
    });
    expect(JSON.parse(String(entry.tags))).toEqual(expect.arrayContaining(["decision", "status:draft", "private"]));
  });

  it("registers generic create, list, review, and approved-execute tools for humans", () => {
    const actor: HumanActorContext = {
      kind: "human",
      actorId: "human-reviewer",
      userId: "human-reviewer",
      role: "member",
      authMethod: "test",
      scopes: new Set(),
    };
    const tools = registeredToolNames(buildMcpServer(env, makeCtx(), actor));

    expect(tools).toEqual(expect.arrayContaining([
      "create_action_proposal",
      "list_action_proposals",
      "review_action_proposal",
      "execute_approved_action",
    ]));
  });
});

describe("governed action proposal REST surface", () => {
  let db: SqliteD1;
  let env: Env;
  let ownerKey: string;
  let reviewerKey: string;
  let otherKey: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    _resetDbReady();
    db = new SqliteD1();
    env = makeEnv(db);
    ownerKey = await seedHuman(db, "user-owner", "owner", "member");
    reviewerKey = await seedHuman(db, "user-reviewer", "reviewer", "admin");
    otherKey = await seedHuman(db, "user-other", "other", "member");
    seedService(db);
  });

  it("rejects anonymous and service credentials at every human proposal endpoint", async () => {
    const requests = [
      req("GET", "/action-proposals", { token: null }),
      req("POST", "/action-proposals", { body: {}, token: "sbs_service.opaque" }),
      req("POST", "/action-proposals/missing/review", {
        body: { decision: "approve", reason: "no" },
        token: "sbs_service.opaque",
      }),
      req("POST", "/action-proposals/missing/execute", { token: "sbs_service.opaque" }),
    ];

    for (const request of requests) {
      const response = await defaultHandler.fetch(request, env, makeCtx());
      expect(response.status).toBe(401);
    }
  });

  it("keeps private proposals scoped, requires human approval, then executes exactly once", async () => {
    const create = await defaultHandler.fetch(
      req("POST", "/action-proposals", {
        token: ownerKey,
        body: {
          action_type: "entry.create",
          payload: {
            content: "Approved operating memory",
            tags: ["operations"],
            visibility: "private",
            lifecycleStatus: "draft",
            epistemicStatus: "candidate",
          },
          visibility_scope: "private",
          risk_level: "medium",
          reason: "Capture after explicit review",
          idempotency_key: "rest-proposal-create-1",
        },
      }),
      env,
      makeCtx(),
    );
    expect(create.status).toBe(201);
    const created = await create.json() as any;
    const proposalId = created.proposal.id as string;
    expect(created.proposal).toMatchObject({
      proposerKind: "human",
      proposerId: "user-owner",
      visibilityScope: "private",
      status: "pending",
    });

    const ownerList = await defaultHandler.fetch(
      req("GET", "/action-proposals?status=pending", { token: ownerKey }),
      env,
      makeCtx(),
    );
    expect((await ownerList.json() as any).proposals.map((proposal: any) => proposal.id)).toContain(proposalId);

    const otherList = await defaultHandler.fetch(
      req("GET", "/action-proposals?status=pending", { token: otherKey }),
      env,
      makeCtx(),
    );
    expect((await otherList.json() as any).proposals).toEqual([]);

    const otherReview = await defaultHandler.fetch(
      req("POST", `/action-proposals/${proposalId}/review`, {
        token: otherKey,
        body: { decision: "approve", reason: "Not this member's proposal" },
      }),
      env,
      makeCtx(),
    );
    expect(otherReview.status).toBe(403);

    const prematureExecute = await defaultHandler.fetch(
      req("POST", `/action-proposals/${proposalId}/execute`, { token: ownerKey }),
      env,
      makeCtx(),
    );
    expect(prematureExecute.status).toBe(403);
    expect(await prematureExecute.json()).toMatchObject({ code: "human_review_required" });

    const review = await defaultHandler.fetch(
      req("POST", `/action-proposals/${proposalId}/review`, {
        token: reviewerKey,
        body: { decision: "approve", reason: "Human verified the proposed memory" },
      }),
      env,
      makeCtx(),
    );
    expect(review.status).toBe(200);
    expect(await review.json()).toMatchObject({
      ok: true,
      proposal: {
        id: proposalId,
        status: "pending",
        reviewerKind: "human",
        reviewerId: "user-reviewer",
      },
    });

    const execute = await defaultHandler.fetch(
      req("POST", `/action-proposals/${proposalId}/execute`, { token: ownerKey }),
      env,
      makeCtx(),
    );
    expect(execute.status).toBe(200);
    const executed = await execute.json() as any;
    expect(executed.result).toMatchObject({ proposalId, actionType: "entry.create", revision: 1 });

    const retry = await defaultHandler.fetch(
      req("POST", `/action-proposals/${proposalId}/execute`, { token: ownerKey }),
      env,
      makeCtx(),
    );
    expect(retry.status).toBe(200);
    expect((await retry.json() as any).result).toEqual(executed.result);

    const entry = db.sqlite.prepare(
      `SELECT owner_user_id, visibility, epistemic_status, revision
       FROM entries WHERE id = ?`,
    ).get(executed.result.entryId) as Record<string, unknown>;
    expect(entry).toEqual({
      owner_user_id: "user-owner",
      visibility: "private",
      epistemic_status: "candidate",
      revision: 1,
    });
    expect((db.sqlite.prepare(
      `SELECT COUNT(*) AS count FROM episodes WHERE mutation_id = ?`,
    ).get(`proposal:${proposalId}`) as { count: number }).count).toBe(1);
  });
});
