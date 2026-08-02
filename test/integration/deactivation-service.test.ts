import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  requestUserDeactivation,
  resumePendingDeactivations,
  resumeUserDeactivation,
} from "../../src/deactivation";
import { integrationKey } from "../../src/integrations";
import type { Env } from "../../src/types";

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
    const result = this.owner.sqlite.prepare(this.sql)
      .run(...this.values as SQLInputValue[]);
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  }

  async all<T = Record<string, unknown>>(): Promise<any> {
    const results = this.owner.sqlite.prepare(this.sql)
      .all(...this.values as SQLInputValue[]) as T[];
    return { success: true, results, meta: { changes: 0 } };
  }

  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    const result = this.owner.sqlite.prepare(this.sql)
      .get(...this.values as SQLInputValue[]) as Record<string, unknown> | undefined;
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
      const results = [];
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

class MemoryKv {
  readonly values = new Map<string, string>();
  readonly deletes: string[] = [];

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.deletes.push(key);
    this.values.delete(key);
  }
}

function insertUser(
  db: SqliteD1,
  id: string,
  role: "admin" | "member",
  status = "active",
  createdAt = 1,
): void {
  db.sqlite.prepare(
    `INSERT INTO users (
       id, username, normalized_username, auth_key_hash, auth_key_prefix,
       status, created_at, role
     ) VALUES (?, ?, ?, 'hash', 'prefix', ?, ?, ?)`,
  ).run(id, id, id, status, createdAt, role);
}

function count(db: SqliteD1, table: string): number {
  return Number((db.sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count);
}

describe("user deactivation service", () => {
  let db: SqliteD1;
  let kv: MemoryKv;
  let vectors: Map<string, unknown>;
  let deleteByIds: ReturnType<typeof vi.fn>;
  let env: Env;

  beforeEach(() => {
    db = new SqliteD1();
    kv = new MemoryKv();
    vectors = new Map();
    deleteByIds = vi.fn(async (ids: string[]) => {
      for (const id of ids) vectors.delete(id);
      return { mutationId: "delete" };
    });
    env = {
      DB: db as unknown as D1Database,
      VECTORIZE: {
        deleteByIds,
        upsert: vi.fn(),
        insert: vi.fn(),
        query: vi.fn(),
        getByIds: vi.fn(),
        describe: vi.fn(),
      } as unknown as VectorizeIndex,
      OAUTH_KV: kv as unknown as KVNamespace,
      AI: {} as Ai,
      AUTH_TOKEN: "test",
      MCP_OAUTH_ENABLED: "false",
    };
  });

  afterEach(() => db.close());

  it("uses stored roles and refuses to strand the team without an active admin", async () => {
    insertUser(db, "member-requester", "member");
    insertUser(db, "only-admin", "admin");

    await expect(requestUserDeactivation({
      requesterUserId: "member-requester",
      targetUserId: "only-admin",
      transferToUserId: "only-admin",
      privateExportAcknowledgement: "waived",
      deactivationId: "unauthorized",
      now: 10,
    }, env)).rejects.toMatchObject({ code: "ADMIN_REQUIRED" });

    await expect(requestUserDeactivation({
      requesterUserId: "only-admin",
      targetUserId: "only-admin",
      transferToUserId: "only-admin",
      privateExportAcknowledgement: "waived",
      deactivationId: "last-admin",
      now: 10,
    }, env)).rejects.toMatchObject({ code: "LAST_ACTIVE_ADMIN" });

    expect(count(db, "user_deactivations")).toBe(0);
    expect((db.sqlite.prepare(`SELECT status FROM users WHERE id = 'only-admin'`).get() as any).status)
      .toBe("active");
  });

  it("retries vector-first private purge, transfers public custody, and finalizes only after cleanup", async () => {
    insertUser(db, "admin", "admin");
    insertUser(db, "member", "member");

    db.sqlite.prepare(
      `INSERT INTO entries (
         id, content, tags, source, created_at, vector_ids, owner_user_id,
         created_by_user_id, visibility, updated_at
       ) VALUES
         ('a-private', 'private', '["private"]', 'api', 1, '["entry-vector"]', 'member', 'member', 'private', 1),
         ('b-public', 'public', '[]', 'api', 2, '["public-vector"]', 'member', 'member', 'public', 2)`,
    ).run();
    db.sqlite.prepare(
      `INSERT INTO episodes (
         id, entry_id, content, source, created_at, materialized_content, owner_user_id
       ) VALUES
         ('private-episode', 'a-private', 'private', 'api', 1, 'private', 'member'),
         ('public-episode', 'b-public', 'public', 'api', 2, 'public', 'member')`,
    ).run();
    db.sqlite.prepare(
      `INSERT INTO entry_snapshots (id, entry_id, content, source, created_at)
       VALUES ('private-snapshot', 'a-private', 'private', 'api', 1)`,
    ).run();
    db.sqlite.prepare(
      `INSERT INTO documents (
         id, title, content_type, created_at, episode_id, owner_user_id
       ) VALUES
         ('private-document', 'private', 'research', 1, 'private-episode', 'member'),
         ('public-document', 'public', 'research', 2, 'public-episode', 'member')`,
    ).run();
    db.sqlite.prepare(
      `INSERT INTO document_sections (id, document_id, title, created_at)
       VALUES ('private-section', 'private-document', 'private', 1)`,
    ).run();
    db.sqlite.prepare(
      `INSERT INTO passages (
         id, entry_id, episode_id, document_id, section_id, content,
         vector_ids, created_at
       ) VALUES (
         'private-passage', 'a-private', 'private-episode', 'private-document',
         'private-section', 'private', '["passage-vector"]', 1
       )`,
    ).run();
    db.sqlite.prepare(
      `INSERT INTO vector_cleanup_queue (
         id, vector_ids, reason, created_at, updated_at
       ) VALUES (
         'private-cleanup', '["historical-vector"]',
         'entry-version:a-private:mutation', 1, 1
       )`,
    ).run();
    db.sqlite.prepare(
      `INSERT INTO edges (
         id, source_id, target_id, created_at, updated_at
       ) VALUES ('private-edge', 'a-private', 'b-public', 1, 1)`,
    ).run();
    db.sqlite.prepare(
      `INSERT INTO edge_proposals (
         id, source_id, target_id, proposed_by, created_at
       ) VALUES ('private-edge-proposal', 'a-private', 'b-public', 'member', 1)`,
    ).run();
    db.sqlite.prepare(
      `INSERT INTO action_proposals (
         id, action_type, proposer_kind, proposer_id, payload_json, target_ids,
         risk_level, reason, evidence_json, autonomy_profile, policy_version,
         idempotency_key, created_at, updated_at
       ) VALUES (
         'private-action', 'entry.update', 'human', 'member',
         '{"entryId":"a-private"}', '["a-private"]', 'medium', 'private',
         '[]', 'observe', 'v1', 'private-action', 1, 1
       )`,
    ).run();
    db.sqlite.prepare(
      `INSERT INTO proposal_events (
         id, proposal_id, sequence, event_type, actor_kind, actor_id, created_at
       ) VALUES ('private-event', 'private-action', 1, 'created', 'human', 'member', 1)`,
    ).run();
    db.sqlite.prepare(
      `INSERT INTO service_identities (
         id, name, owner_user_id, created_by_user_id, created_at, updated_at
       ) VALUES ('member-service', 'member service', 'member', 'admin', 1, 1)`,
    ).run();
    db.sqlite.prepare(
      `INSERT INTO service_credentials (
         id, service_identity_id, credential_hash, credential_prefix,
         created_by_user_id, created_at
       ) VALUES ('member-credential', 'member-service', 'credential-hash', 'sbs_', 'admin', 1)`,
    ).run();

    for (const id of ["entry-vector", "passage-vector", "historical-vector", "public-vector"]) {
      vectors.set(id, { id });
    }
    const integrationSecretKey = integrationKey("member", "notion");
    kv.values.set(integrationSecretKey, JSON.stringify({ credentials: { token: "secret" } }));

    const requested = await requestUserDeactivation({
      requesterUserId: "admin",
      targetUserId: "member",
      transferToUserId: "admin",
      privateExportAcknowledgement: "waived",
      deactivationId: "deactivation-1",
      now: 10,
    }, env);
    expect(requested).toMatchObject({
      status: "pending",
      transferToUserId: "admin",
      transferCursor: null,
    });
    expect((db.sqlite.prepare(`SELECT status FROM users WHERE id = 'member'`).get() as any).status)
      .toBe("deactivating");
    expect((db.sqlite.prepare(`SELECT status FROM service_identities WHERE id = 'member-service'`).get() as any).status)
      .toBe("revoked");
    expect((db.sqlite.prepare(`SELECT status FROM service_credentials WHERE id = 'member-credential'`).get() as any).status)
      .toBe("revoked");

    // Step 1 — Vectorize fails. The erasure commits anyway (D1 mutates, vectors
    // are queued for the repair schedule), the cursor advances, and the
    // deactivation never blocks on remote vector cleanup.
    deleteByIds.mockRejectedValueOnce(new Error("vector service unavailable"));
    const afterError = await resumeUserDeactivation({
      deactivationId: requested.id,
      actorUserId: "admin",
      batchSize: 1,
      now: 20,
    }, env);
    expect(afterError).toMatchObject({ phase: "entries", processedThisRun: 1, remainingEntries: 1 });
    expect(afterError.deactivation).toMatchObject({ transferCursor: "a-private", processedEntries: 1 });
    expect(count(db, "entries")).toBe(1);               // b-public remains
    expect(count(db, "episodes")).toBe(1);               // public-episode remains
    expect(count(db, "proposal_events")).toBe(0);        // private-event purged
    expect((db.sqlite.prepare(`SELECT status FROM users WHERE id = 'member'`).get() as any).status)
      .toBe("deactivating");
    // Vectors were NOT deleted (deleteByIds failed); they are queued.
    expect(vectors.has("entry-vector")).toBe(true);
    expect(vectors.has("passage-vector")).toBe(true);
    expect(vectors.has("historical-vector")).toBe(true);
    expect(vectors.has("public-vector")).toBe(true);
    // An erasure queue row is persisted so the repair schedule can retry.
    expect(count(db, "vector_cleanup_queue")).toBeGreaterThanOrEqual(1);
    expect(count(db, "erasure_receipts")).toBe(1);
    const receipt = db.sqlite.prepare(
      `SELECT status, vector_count FROM erasure_receipts WHERE entry_id = 'a-private'`,
    ).get() as { status: string; vector_count: number };
    expect(receipt).toBeTruthy();
    expect(receipt.status).toBe("pending_cleanup");
    expect(receipt.vector_count).toBe(3);

    // Step 2 — resume again: the public entry is transferred to the admin,
    // all remaining owned entries are cleared, and the deactivation finalizes.
    deleteByIds.mockClear();
    const secondBatch = await resumeUserDeactivation({
      deactivationId: requested.id,
      actorUserId: "admin",
      batchSize: 1,
      now: 30,
    }, env);
    expect(secondBatch).toMatchObject({ phase: "completed", processedThisRun: 1, remainingEntries: 0 });
    expect(secondBatch.deactivation).toMatchObject({ status: "completed", processedEntries: 2 });
    // Only the public entry (transferred, not purged) and its children survive.
    expect(count(db, "entries")).toBe(1);
    expect(count(db, "episodes")).toBe(1);
    expect(count(db, "documents")).toBe(1);
    expect(count(db, "document_sections")).toBe(0);      // private-section was purged in step 1
    expect(count(db, "entry_snapshots")).toBe(0);         // private-snapshot purged in step 1
    expect(count(db, "passages")).toBe(0);                // private-passage purged in step 1
    expect(count(db, "edge_proposals")).toBe(0);          // purged in step 1
    expect(count(db, "edges")).toBe(0);                   // purged in step 1
    expect(count(db, "action_proposals")).toBe(0);        // purged in step 1
    expect(count(db, "proposal_events")).toBe(0);         // purged in step 1
    // proposal_events triggers are restored after purge.
    expect((db.sqlite.prepare(
      `SELECT COUNT(*) AS count FROM sqlite_master
       WHERE type = 'trigger' AND name IN ('proposal_events_no_update', 'proposal_events_no_delete')`,
    ).get() as { count: number }).count).toBe(2);
    // Public vector untouched (transfer, not erasure). Queued vectors still
    // pending (repair schedule will drain them separately).
    expect(vectors.has("public-vector")).toBe(true);
    expect(kv.values.has(integrationSecretKey)).toBe(false);

    const retained = db.sqlite.prepare(
      `SELECT owner_user_id, created_by_user_id, visibility
       FROM entries WHERE id = 'b-public'`,
    ).get() as any;
    expect(retained).toEqual({
      owner_user_id: "admin",
      created_by_user_id: "member",
      visibility: "public",
    });
    expect((db.sqlite.prepare(`SELECT owner_user_id FROM episodes WHERE id = 'public-episode'`).get() as any).owner_user_id)
      .toBe("admin");
    expect((db.sqlite.prepare(`SELECT owner_user_id FROM documents WHERE id = 'public-document'`).get() as any).owner_user_id)
      .toBe("admin");
    expect((db.sqlite.prepare(`SELECT status FROM users WHERE id = 'member'`).get() as any).status)
      .toBe("inactive");
    expect(kv.deletes).toContain(integrationSecretKey);
  });

  it("schedules bounded jobs with requester preference and deterministic admin fallback", async () => {
    insertUser(db, "admin-requester", "admin", "active", 1);
    insertUser(db, "admin-fallback", "admin", "active", 2);
    insertUser(db, "admin-preferred", "admin", "active", 3);
    insertUser(db, "member-fallback", "member", "active", 4);
    insertUser(db, "member-preferred", "member", "active", 5);

    await requestUserDeactivation({
      requesterUserId: "admin-requester",
      targetUserId: "member-fallback",
      transferToUserId: "admin-requester",
      privateExportAcknowledgement: "waived",
      deactivationId: "job-fallback",
      now: 10,
    }, env);
    await requestUserDeactivation({
      requesterUserId: "admin-preferred",
      targetUserId: "member-preferred",
      transferToUserId: "admin-preferred",
      privateExportAcknowledgement: "waived",
      deactivationId: "job-preferred",
      now: 11,
    }, env);

    // The first job must fall back to the earliest remaining administrator.
    db.sqlite.prepare(`UPDATE users SET status = 'inactive' WHERE id = 'admin-requester'`).run();

    // Add credentials after initiation so finalization records the scheduler's
    // chosen administrator in revoked_by_user_id.
    db.sqlite.prepare(
      `INSERT INTO service_identities (
         id, name, owner_user_id, created_by_user_id, created_at, updated_at
       ) VALUES
         ('fallback-service', 'fallback service', 'member-fallback', 'admin-fallback', 12, 12),
         ('preferred-service', 'preferred service', 'member-preferred', 'admin-preferred', 12, 12)`,
    ).run();
    db.sqlite.prepare(
      `INSERT INTO service_credentials (
         id, service_identity_id, credential_hash, credential_prefix,
         created_by_user_id, created_at
       ) VALUES
         ('fallback-credential', 'fallback-service', 'fallback-hash', 'sbs_f', 'admin-fallback', 12),
         ('preferred-credential', 'preferred-service', 'preferred-hash', 'sbs_p', 'admin-preferred', 12)`,
    ).run();

    const result = await resumePendingDeactivations(env, 1, 2);
    expect(result).toEqual({
      selected: 2,
      attempted: 2,
      completed: 2,
      stillRunning: 0,
      blocked: 0,
      skippedNoAdmin: 0,
      processedEntries: 0,
      remainingJobs: 0,
    });

    const fallbackCredential = db.sqlite.prepare(
      `SELECT status, revoked_by_user_id FROM service_credentials
       WHERE id = 'fallback-credential'`,
    ).get();
    expect(fallbackCredential).toEqual({
      status: "revoked",
      revoked_by_user_id: "admin-fallback",
    });
    const preferredCredential = db.sqlite.prepare(
      `SELECT status, revoked_by_user_id FROM service_credentials
       WHERE id = 'preferred-credential'`,
    ).get();
    expect(preferredCredential).toEqual({
      status: "revoked",
      revoked_by_user_id: "admin-preferred",
    });
  });

  it("leaves a job pending when no active administrator remains", async () => {
    insertUser(db, "admin", "admin");
    insertUser(db, "member", "member");
    await requestUserDeactivation({
      requesterUserId: "admin",
      targetUserId: "member",
      transferToUserId: "admin",
      privateExportAcknowledgement: "waived",
      deactivationId: "job-without-admin",
      now: 10,
    }, env);
    db.sqlite.prepare(`UPDATE users SET status = 'inactive' WHERE id = 'admin'`).run();

    const result = await resumePendingDeactivations(env, 5, 1);
    expect(result).toMatchObject({
      selected: 1,
      attempted: 0,
      completed: 0,
      skippedNoAdmin: 1,
      remainingJobs: 1,
    });
    expect((db.sqlite.prepare(`SELECT status FROM users WHERE id = 'member'`).get() as any).status)
      .toBe("deactivating");
    const job = db.sqlite.prepare(
      `SELECT status, last_error FROM user_deactivations WHERE id = 'job-without-admin'`,
    ).get() as any;
    expect(job.status).toBe("pending");
    expect(job.last_error).toContain("No active administrator");
  });
});
