import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AUTH_PEPPER, hmacKey } from "../../src/auth";
import { _resetDbReady } from "../../src/db";
import { buildMcpServer } from "../../src/mcp";
import { reinforceOwnedEntry } from "../../src/reinforcement";
import { defaultHandler } from "../../src/routes";
import type {
  Env,
  HumanActorContext,
  ServiceActorContext,
} from "../../src/types";
import { makeAIMock, makeKVMock, makeVectorizeMock } from "../helpers/make-env";

const schema = readFileSync(resolve(process.cwd(), "db/schema.sql"), "utf8");

class SqliteStatement {
  constructor(
    private readonly owner: SqliteD1,
    private readonly sql: string,
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
    const result = this.owner.sqlite.prepare(this.sql).get(...this.values as SQLInputValue[]) as Record<string, unknown> | undefined;
    if (!result) return null;
    return (column ? result[column] : result) as T;
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

  close(): void {
    this.sqlite.close();
  }
}

function makeCtx(): ExecutionContext {
  return {
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
}

function makeEnv(db: SqliteD1): Env {
  return {
    DB: db as unknown as D1Database,
    AI: makeAIMock(),
    VECTORIZE: makeVectorizeMock(),
    AUTH_TOKEN: "test-token",
    OAUTH_KV: makeKVMock(),
  } as Env;
}

async function seedUser(db: SqliteD1, id: string): Promise<string> {
  const secret = `${id}-secret`;
  const key = `slm_${id}.${secret}`;
  db.sqlite.prepare(
    `INSERT INTO users (
       id, username, normalized_username, auth_key_hash, auth_key_prefix,
       status, created_at, role
     ) VALUES (?, ?, ?, ?, ?, 'active', 1, 'member')`,
  ).run(id, id, id, await hmacKey(secret, AUTH_PEPPER), key.slice(0, 15));
  return key;
}

function seedEntry(db: SqliteD1): void {
  db.sqlite.prepare(
    `INSERT INTO entries (
       id, content, tags, source, created_at, vector_ids, owner_user_id,
       retention_score, recall_count, last_recalled_at, visibility,
       recorded_at, valid_from, epistemic_status, updated_at
     ) VALUES (
       'owned-memory', 'Durable launch decision', '[]', 'api', 100, '[]',
       'owner-user', 0.2, 3, 50, 'public', 100, 100, 'canonical', 100
     )`,
  ).run();
}

interface StoredReinforcementState {
  recall_count: number;
  last_recalled_at: number | null;
  retention_score: number;
}

function entryState(db: SqliteD1): StoredReinforcementState {
  return db.sqlite.prepare(
    `SELECT recall_count, last_recalled_at, retention_score
     FROM entries WHERE id = 'owned-memory'`,
  ).get() as unknown as StoredReinforcementState;
}

function snapshotCount(db: SqliteD1): number {
  return (db.sqlite.prepare(
    `SELECT COUNT(*) AS count FROM entry_snapshots WHERE entry_id = 'owned-memory'`,
  ).get() as { count: number }).count;
}

function registeredTools(server: ReturnType<typeof buildMcpServer>): Record<string, any> {
  return (server as any)._registeredTools;
}

describe("explicit retention reinforcement", () => {
  let db: SqliteD1;
  let env: Env;
  let ownerKey: string;
  let otherKey: string;

  beforeEach(async () => {
    _resetDbReady();
    db = new SqliteD1();
    env = makeEnv(db);
    ownerKey = await seedUser(db, "owner-user");
    otherKey = await seedUser(db, "other-user");
    seedEntry(db);
  });

  afterEach(() => {
    db.close();
  });

  it("atomically records one reinforcement per invocation without creating a snapshot", async () => {
    const first = await reinforceOwnedEntry("owned-memory", "owner-user", env, 500);
    expect(first).toEqual({
      entryId: "owned-memory",
      recallCount: 4,
      lastRecalledAt: 500,
      retentionScore: 1,
    });
    expect(snapshotCount(db)).toBe(0);

    const second = await reinforceOwnedEntry("owned-memory", "owner-user", env, 501);
    expect(second?.recallCount).toBe(5);
    expect(entryState(db)).toEqual({
      recall_count: 5,
      last_recalled_at: 501,
      retention_score: 1,
    });
    expect(snapshotCount(db)).toBe(0);

    await expect(reinforceOwnedEntry("owned-memory", "other-user", env, 502)).resolves.toBeNull();
    expect(entryState(db).recall_count).toBe(5);
  });

  it("keeps recall read-only and exposes an owner-only REST command with explicit retry semantics", async () => {
    const before = entryState(db);
    const recall = await defaultHandler.fetch(
      new Request("http://localhost/recall?query=durable", {
        headers: { Authorization: `Bearer ${ownerKey}` },
      }),
      env,
      makeCtx(),
    );
    expect(recall.status).toBe(200);
    expect(entryState(db)).toEqual(before);
    expect(snapshotCount(db)).toBe(0);

    const forbidden = await defaultHandler.fetch(
      new Request("http://localhost/entries/owned-memory/reinforce", {
        method: "POST",
        headers: { Authorization: `Bearer ${otherKey}` },
      }),
      env,
      makeCtx(),
    );
    expect(forbidden.status).toBe(404);
    expect(entryState(db)).toEqual(before);

    const serviceCredential = await defaultHandler.fetch(
      new Request("http://localhost/entries/owned-memory/reinforce", {
        method: "POST",
        headers: { Authorization: "Bearer sbs_service.opaque" },
      }),
      env,
      makeCtx(),
    );
    expect(serviceCredential.status).toBe(401);
    expect(entryState(db)).toEqual(before);

    const click = () => defaultHandler.fetch(
      new Request("http://localhost/entries/owned-memory/reinforce", {
        method: "POST",
        headers: { Authorization: `Bearer ${ownerKey}` },
      }),
      env,
      makeCtx(),
    );
    const first = await click();
    const firstBody = await first.json() as Record<string, unknown>;
    expect(firstBody).toMatchObject({
      ok: true,
      id: "owned-memory",
      recall_count: 4,
      retention_score: 1,
      semantics: "one_request_one_reinforcement",
    });

    const second = await click();
    const secondBody = await second.json() as Record<string, unknown>;
    expect(secondBody.recall_count).toBe(5);
    expect(entryState(db).recall_count).toBe(5);
    expect(snapshotCount(db)).toBe(0);
  });

  it("registers reinforce only for human MCP actors and still enforces ownership", async () => {
    const owner: HumanActorContext = {
      kind: "human",
      actorId: "owner-user",
      userId: "owner-user",
      role: "member",
      authMethod: "test",
      scopes: new Set(),
    };
    const other: HumanActorContext = {
      ...owner,
      actorId: "other-user",
      userId: "other-user",
    };
    const service: ServiceActorContext = {
      kind: "service",
      actorId: "service-hermes",
      serviceIdentityId: "service-hermes",
      credentialId: "credential-hermes",
      ownerUserId: "owner-user",
      authMethod: "test",
      scopes: new Set(),
    };

    const ownerTools = registeredTools(buildMcpServer(env, makeCtx(), owner));
    const otherTools = registeredTools(buildMcpServer(env, makeCtx(), other));
    const serviceTools = registeredTools(buildMcpServer(env, makeCtx(), service));
    expect(ownerTools.reinforce).toBeDefined();
    expect(serviceTools.reinforce).toBeUndefined();

    const denied = await otherTools.reinforce.handler({ id: "owned-memory" }, {});
    expect(denied.content[0].text).toContain("No entry found");
    expect(entryState(db).recall_count).toBe(3);

    const reinforced = await ownerTools.reinforce.handler({ id: "owned-memory" }, {});
    expect(reinforced.content[0].text).toContain("Reinforced entry owned-memory once");
    expect(entryState(db).recall_count).toBe(4);
    expect(snapshotCount(db)).toBe(0);
  });
});
