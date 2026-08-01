import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  listAwarenessEvents,
  markAwarenessEventRead,
  reconcileOverlapAwarenessIntent,
  reconcilePendingOverlapAwareness,
  stageOverlapAwarenessIntent,
} from "../../src/awareness-events";
import { AUTH_PEPPER, hmacKey } from "../../src/auth";
import { _resetDbReady, initializeDatabase } from "../../src/db";
import { defaultHandler } from "../../src/routes";
import type { Env } from "../../src/types";
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
    this.owner.beforeExecute(this.sql);
    const result = this.owner.sqlite.prepare(this.sql).run(...this.values as SQLInputValue[]);
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  }

  async all<T = Record<string, unknown>>(): Promise<any> {
    this.owner.beforeExecute(this.sql);
    const results = this.owner.sqlite.prepare(this.sql).all(...this.values as SQLInputValue[]) as T[];
    return { success: true, results, meta: { changes: 0 } };
  }

  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    this.owner.beforeExecute(this.sql);
    const row = this.owner.sqlite.prepare(this.sql).get(...this.values as SQLInputValue[]) as Record<string, unknown> | undefined;
    if (!row) return null;
    return (column ? row[column] : row) as T;
  }
}

class SqliteD1 {
  readonly sqlite = new DatabaseSync(":memory:");
  failOn: RegExp | null = null;

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

  beforeExecute(sql: string): void {
    if (this.failOn?.test(sql)) throw new Error(`Injected D1 failure for: ${sql}`);
  }
}

function embeddingStreamJson(value: unknown): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(JSON.stringify(value)));
      controller.close();
    },
  });
}

function makeEnv(db: SqliteD1): Env {
  return {
    DB: db as unknown as D1Database,
    AI: {
      run: vi.fn(async (_model: string, options: Record<string, unknown>) => {
        if (Array.isArray(options.text)) {
          return { data: options.text.map(() => new Array(384).fill(0.01)) };
        }
        return embeddingStreamJson({ importance: 1, kind: "episodic" });
      }),
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
    OAUTH_KV: {} as KVNamespace,
  };
}

async function seedUser(
  db: SqliteD1,
  id: string,
  username: string,
  status: "active" | "inactive" = "active",
): Promise<string> {
  const secret = `${username}-secret`;
  const key = `slm_${id}.${secret}`;
  db.sqlite.prepare(
    `INSERT INTO users (
       id, username, normalized_username, auth_key_hash, auth_key_prefix,
       status, created_at, role
     ) VALUES (?, ?, ?, ?, ?, ?, 100, 'member')`,
  ).run(
    id,
    username,
    username.toLowerCase(),
    await hmacKey(secret, AUTH_PEPPER),
    key.slice(0, 15),
    status,
  );
  return key;
}

function seedEntry(
  db: SqliteD1,
  id: string,
  ownerUserId: string,
  visibility: "public" | "private" = "public",
): void {
  db.sqlite.prepare(
    `INSERT INTO entries (
       id, content, tags, source, created_at, owner_user_id,
       created_by_user_id, visibility, updated_at, current_episode_id
     ) VALUES (?, ?, '[]', 'api', 200, ?, ?, ?, 200, ?)`,
  ).run(id, `${id} content`, ownerUserId, ownerUserId, visibility, `episode-${id}`);
}

async function createPair(
  env: Env,
  db: SqliteD1,
): Promise<{ reconciliationId: string; aliceEventId: string; bobEventId: string }> {
  seedEntry(db, "entry-alice", "user-alice");
  seedEntry(db, "entry-bob", "user-bob");
  const reconciliationId = await stageOverlapAwarenessIntent(env, {
    newEntryId: "entry-alice",
    newOwnerUserId: "user-alice",
    matchedEntryId: "entry-bob",
    matchedOwnerUserId: "user-bob",
    similarity: 0.91,
    newEntryIsPublic: true,
  });
  expect(reconciliationId).toBeTruthy();
  expect(await reconcileOverlapAwarenessIntent(env, reconciliationId!)).toMatchObject({
    status: "ready",
    eventCount: 2,
  });
  const rows = db.sqlite.prepare(
    `SELECT id, recipient_user_id FROM awareness_events ORDER BY recipient_user_id`,
  ).all() as { id: string; recipient_user_id: string }[];
  return {
    reconciliationId: reconciliationId!,
    aliceEventId: rows.find((row) => row.recipient_user_id === "user-alice")!.id,
    bobEventId: rows.find((row) => row.recipient_user_id === "user-bob")!.id,
  };
}

describe("cross-user overlap awareness", () => {
  let db: SqliteD1;
  let env: Env;
  let aliceKey: string;
  let bobKey: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    _resetDbReady();
    db = new SqliteD1();
    env = makeEnv(db);
    await initializeDatabase(env);
    aliceKey = await seedUser(db, "user-alice", "alice");
    bobKey = await seedUser(db, "user-bob", "bob");
  });

  it("persists exactly one idempotent event for each active owner", async () => {
    const pair = await createPair(env, db);

    expect(await reconcileOverlapAwarenessIntent(env, pair.reconciliationId)).toMatchObject({
      status: "ready",
      eventCount: 2,
    });
    expect(db.sqlite.prepare(`SELECT COUNT(*) AS count FROM awareness_events`).get()).toMatchObject({ count: 2 });

    const alice = await listAwarenessEvents(env, "user-alice");
    const bob = await listAwarenessEvents(env, "user-bob");
    expect(alice).toHaveLength(1);
    expect(bob).toHaveLength(1);
    expect(alice[0].endpoints.map((entry) => entry.entryId).sort()).toEqual(["entry-alice", "entry-bob"]);
    expect(bob[0].similarity).toBe(0.91);
  });

  it("does not stage or expose events with a private endpoint", async () => {
    seedEntry(db, "entry-alice", "user-alice");
    seedEntry(db, "entry-private", "user-bob", "private");

    await expect(stageOverlapAwarenessIntent(env, {
      newEntryId: "entry-alice",
      newOwnerUserId: "user-alice",
      matchedEntryId: "entry-private",
      matchedOwnerUserId: "user-bob",
      similarity: 0.95,
      newEntryIsPublic: true,
    })).resolves.toBeNull();
    await expect(stageOverlapAwarenessIntent(env, {
      newEntryId: "entry-alice",
      newOwnerUserId: "user-alice",
      matchedEntryId: "entry-private",
      matchedOwnerUserId: "user-bob",
      similarity: 0.95,
      newEntryIsPublic: false,
    })).resolves.toBeNull();
    expect(db.sqlite.prepare(`SELECT COUNT(*) AS count FROM awareness_events`).get()).toMatchObject({ count: 0 });
  });

  it("rechecks D1 visibility and hides an existing event after either endpoint becomes private", async () => {
    await createPair(env, db);
    expect(await listAwarenessEvents(env, "user-alice")).toHaveLength(1);

    db.sqlite.prepare(`UPDATE entries SET visibility = 'private' WHERE id = 'entry-bob'`).run();

    expect(await listAwarenessEvents(env, "user-alice")).toEqual([]);
    expect(await listAwarenessEvents(env, "user-bob")).toEqual([]);
    expect(db.sqlite.prepare(`SELECT COUNT(*) AS count FROM awareness_events`).get()).toMatchObject({ count: 2 });
  });

  it("requires active owners at creation and hides events after owner deactivation", async () => {
    db.sqlite.prepare(`UPDATE users SET status = 'inactive' WHERE id = 'user-bob'`).run();
    seedEntry(db, "entry-alice", "user-alice");
    seedEntry(db, "entry-bob", "user-bob");

    await expect(stageOverlapAwarenessIntent(env, {
      newEntryId: "entry-alice",
      newOwnerUserId: "user-alice",
      matchedEntryId: "entry-bob",
      matchedOwnerUserId: "user-bob",
      similarity: 0.9,
      newEntryIsPublic: true,
    })).resolves.toBeNull();

    db.sqlite.prepare(`UPDATE users SET status = 'active' WHERE id = 'user-bob'`).run();
    const id = await stageOverlapAwarenessIntent(env, {
      newEntryId: "entry-alice",
      newOwnerUserId: "user-alice",
      matchedEntryId: "entry-bob",
      matchedOwnerUserId: "user-bob",
      similarity: 0.9,
      newEntryIsPublic: true,
    });
    await reconcileOverlapAwarenessIntent(env, id!);
    expect(await listAwarenessEvents(env, "user-alice")).toHaveLength(1);

    db.sqlite.prepare(`UPDATE users SET status = 'inactive' WHERE id = 'user-bob'`).run();
    expect(await listAwarenessEvents(env, "user-alice")).toEqual([]);
  });

  it("allows only the recipient to mark an event read through authenticated REST", async () => {
    const pair = await createPair(env, db);

    const forbidden = await defaultHandler.fetch(
      req("POST", `/awareness-events/${pair.aliceEventId}/read`, { token: bobKey }),
      env,
      { waitUntil: () => {} } as unknown as ExecutionContext,
    );
    expect(forbidden.status).toBe(404);

    const marked = await defaultHandler.fetch(
      req("POST", `/awareness-events/${pair.aliceEventId}/read`, { token: aliceKey }),
      env,
      { waitUntil: () => {} } as unknown as ExecutionContext,
    );
    expect(marked.status).toBe(200);
    expect((await marked.json() as any).event.readAt).toBeTypeOf("number");

    expect((await markAwarenessEventRead(env, "user-bob", pair.aliceEventId))).toBeNull();
    expect((await listAwarenessEvents(env, "user-bob", { unreadOnly: true }))).toHaveLength(1);

    const listed = await defaultHandler.fetch(
      req("GET", "/awareness-events?unread=true", { token: aliceKey }),
      env,
      { waitUntil: () => {} } as unknown as ExecutionContext,
    );
    expect(listed.status).toBe(200);
    expect((await listed.json() as any).events).toEqual([]);
  });

  it("captures durably, reports deferred awareness truthfully, and reconciles later", async () => {
    seedEntry(db, "matched-public", "user-bob");
    (env.VECTORIZE.query as ReturnType<typeof vi.fn>).mockImplementation(
      async (_values: number[], options: any) => {
        const ownFilter = options?.filter?.owner_user_id?.$eq;
        return ownFilter
          ? { matches: [] }
          : {
              matches: [{
                id: "matched-vector",
                score: 0.92,
                metadata: {
                  parentId: "matched-public",
                  episodeId: "episode-matched-public",
                  owner_user_id: "user-bob",
                  is_private: false,
                },
              }],
            };
      },
    );
    db.failOn = /INSERT OR IGNORE INTO awareness_events/;

    const response = await defaultHandler.fetch(
      req("POST", "/capture", {
        token: aliceKey,
        body: { content: "A strongly overlapping public memory", visibility: "public" },
      }),
      env,
      { waitUntil: () => {} } as unknown as ExecutionContext,
    );
    const body = await response.json() as any;
    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    const awarenessWarning = body.warnings.find((warning: string) => warning.startsWith("Awareness pending_reconciliation:"));
    expect(awarenessWarning).toBeDefined();
    const reconciliationId = awarenessWarning.split(": ")[1];
    expect(db.sqlite.prepare(`SELECT id FROM entries WHERE id = ?`).get(body.id)).toBeTruthy();
    expect(db.sqlite.prepare(
      `SELECT status FROM overlap_awareness_reconciliation WHERE id = ?`,
    ).get(reconciliationId)).toMatchObject({ status: "failed" });

    db.failOn = null;
    await expect(reconcilePendingOverlapAwareness(env)).resolves.toMatchObject({ ready: 1, pending: 0 });
    expect(db.sqlite.prepare(`SELECT COUNT(*) AS count FROM awareness_events`).get()).toMatchObject({ count: 2 });
  });
});
