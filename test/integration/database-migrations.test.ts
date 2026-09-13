import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  _resetDbReady,
  getDbReady,
  initializeDatabase,
} from "../../src/db";
import type { Env } from "../../src/types";

const schemaSnapshot = readFileSync(
  resolve(process.cwd(), "db/schema.sql"),
  "utf8",
);

class SqliteD1Statement {
  constructor(
    private readonly owner: SqliteD1,
    readonly sql: string,
    private readonly values: unknown[] = [],
  ) {}

  bind(...values: unknown[]): SqliteD1Statement {
    return new SqliteD1Statement(this.owner, this.sql, values);
  }

  async run(): Promise<any> {
    this.owner.beforeExecute(this.sql);
    const result = this.owner.sqlite
      .prepare(this.sql)
      .run(...this.values as SQLInputValue[]);
    return {
      success: true,
      results: [],
      meta: { changes: Number(result.changes) },
    };
  }

  async all<T = Record<string, unknown>>(): Promise<any> {
    this.owner.beforeExecute(this.sql);
    const results = this.owner.sqlite
      .prepare(this.sql)
      .all(...this.values as SQLInputValue[]) as T[];
    return { success: true, results, meta: { changes: 0 } };
  }

  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    this.owner.beforeExecute(this.sql);
    const row = this.owner.sqlite
      .prepare(this.sql)
      .get(...this.values as SQLInputValue[]) as Record<string, unknown> | undefined;
    if (!row) return null;
    return (column ? row[column] : row) as T;
  }
}

class SqliteD1 {
  readonly sqlite = new DatabaseSync(":memory:");
  readonly executedSql: string[] = [];
  failOn: RegExp | null = null;

  prepare(sql: string): SqliteD1Statement {
    return new SqliteD1Statement(this, sql);
  }

  async exec(sql: string): Promise<any> {
    this.beforeExecute(sql);
    this.sqlite.exec(sql);
    return { count: 1, duration: 0 };
  }

  async batch(statements: SqliteD1Statement[]): Promise<any[]> {
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
    this.executedSql.push(sql.replace(/\s+/g, " ").trim());
    if (this.failOn?.test(sql)) throw new Error(`Injected D1 failure for: ${sql}`);
  }

  columns(table: string): string[] {
    return (this.sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[])
      .map((row) => row.name);
  }

  versions(): number[] {
    return (this.sqlite.prepare(
      `SELECT version FROM schema_migrations ORDER BY version`,
    ).all() as { version: number }[]).map((row) => Number(row.version));
  }

  schemaSignature(): unknown {
    const tables = (this.sqlite.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
       ORDER BY name`,
    ).all() as { name: string }[]).map((row) => row.name);
    const columns = Object.fromEntries(tables.map((table) => [
      table,
      (this.sqlite.prepare(`PRAGMA table_info(${table})`).all() as Record<string, unknown>[])
        .map((column) => ({
          name: column.name,
          type: column.type,
          notnull: Number(column.notnull),
          default: column.dflt_value,
          primaryKey: Number(column.pk),
        }))
        .sort((left, right) => String(left.name).localeCompare(String(right.name))),
    ]));
    const indexes = (this.sqlite.prepare(
      `SELECT name, tbl_name AS tableName, sql FROM sqlite_master
       WHERE type = 'index' AND name NOT LIKE 'sqlite_autoindex_%'
       ORDER BY name`,
    ).all() as Record<string, unknown>[]).map((row) => ({
      ...row,
      sql: typeof row.sql === "string" ? row.sql.replace(/\s+/g, " ").trim() : row.sql,
    }));
    return { tables, columns, indexes };
  }

  close(): void { this.sqlite.close(); }
}

function makeEnv(db: SqliteD1): Env {
  return { DB: db as unknown as D1Database } as Env;
}

describe("ordered database migrations", () => {
  let db: SqliteD1;

  beforeEach(() => {
    _resetDbReady();
    db = new SqliteD1();
  });

  afterEach(() => {
    _resetDbReady();
    db.close();
  });

  it("builds a fresh database in order and only becomes ready after success", async () => {
    await initializeDatabase(makeEnv(db));

    expect(getDbReady()).toBe(true);
    expect(db.versions()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    expect(db.columns("entries")).toEqual(expect.arrayContaining([
      "owner_user_id",
      "retention_score",
      "last_recalled_at",
      "valid_from",
      "valid_to",
      "recorded_at",
      "epistemic_status",
      "current_episode_id",
      "revision",
      "created_by_user_id",
      "visibility",
      "vector_sync_pending",
      "updated_at",
    ]));
    expect(db.columns("edges")).toContain("confidence");
    expect(db.columns("documents")).toContain("title_origin");

    const ownerColumn = db.executedSql.findIndex((statement) =>
      statement.startsWith("ALTER TABLE entries ADD COLUMN owner_user_id"));
    const ownerIndex = db.executedSql.findIndex((statement) =>
      statement.startsWith("CREATE INDEX IF NOT EXISTS idx_entries_owner"));
    expect(ownerColumn).toBeGreaterThan(-1);
    expect(ownerIndex).toBeGreaterThan(ownerColumn);

    const tables = db.sqlite.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`,
    ).all() as { name: string }[];
    expect(tables.map((row) => row.name)).toEqual(expect.arrayContaining([
      "entries",
      "edges",
      "users",
      "episodes",
      "entry_snapshots",
      "passages",
      "documents",
      "document_sections",
      "edge_proposals",
      "agent_runs",
      "agent_events",
      "vector_cleanup_queue",
      "user_deactivations",
      "service_identities",
      "service_credentials",
      "security_events",
      "action_proposals",
      "proposal_events",
      "awareness_events",
      "overlap_awareness_reconciliation",
      "edge_versions",
    ]));
  });

  it("keeps schema.sql compatible with runtime-owned migration records", async () => {
    db.sqlite.exec(schemaSnapshot);

    expect(db.versions()).toEqual([]);
    await initializeDatabase(makeEnv(db));

    expect(db.versions()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    expect(db.sqlite.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_entries_owner'`,
    ).get()).toMatchObject({ name: "idx_entries_owner" });
  });

  it("converges to the same tables, columns, and indexes from both bootstrap paths", async () => {
    await initializeDatabase(makeEnv(db));
    const runtimeSignature = db.schemaSignature();

    const snapshotDb = new SqliteD1();
    try {
      snapshotDb.sqlite.exec(schemaSnapshot);
      _resetDbReady();
      await initializeDatabase(makeEnv(snapshotDb));
      expect(snapshotDb.schemaSignature()).toEqual(runtimeSignature);
    } finally {
      snapshotDb.close();
    }
  });

  it("upgrades the pre-owner legacy schema without losing existing data", async () => {
    db.sqlite.exec(`
      CREATE TABLE entries (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        source TEXT NOT NULL DEFAULT 'api',
        created_at INTEGER NOT NULL,
        vector_ids TEXT NOT NULL DEFAULT '[]'
      );
      CREATE TABLE edges (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'relates_to',
        weight REAL NOT NULL DEFAULT 0.5,
        provenance TEXT NOT NULL DEFAULT 'inferred',
        metadata TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(source_id, target_id, type)
      );
      INSERT INTO entries (id, content, tags, source, created_at, vector_ids)
      VALUES ('legacy-1', 'preserve me', '[]', 'api', 1000, '[]');
    `);
    // The operator-facing schema command must also be safe against legacy
    // tables; runtime migrations remain responsible for adding columns.
    db.sqlite.exec(schemaSnapshot);

    await initializeDatabase(makeEnv(db));

    const legacy = db.sqlite.prepare(
      `SELECT content, owner_user_id, retention_score, epistemic_status
       FROM entries WHERE id = 'legacy-1'`,
    ).get() as Record<string, unknown>;
    const system = db.sqlite.prepare(
      `SELECT id, status FROM users WHERE username = '_system'`,
    ).get() as Record<string, unknown>;

    expect(legacy).toMatchObject({
      content: "preserve me",
      owner_user_id: system.id,
      retention_score: 1,
      epistemic_status: "canonical",
    });
    expect(system.status).toBe("inactive");
    expect(db.columns("edges")).toEqual(expect.arrayContaining([
      "confidence",
      "revision",
      "last_actor_kind",
      "last_actor_id",
      "last_mutation_kind",
      "last_mutation_id",
    ]));
    expect(db.versions()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);

    _resetDbReady();
    await initializeDatabase(makeEnv(db));
    expect(db.versions()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    expect(db.sqlite.prepare(
      `SELECT COUNT(*) AS count FROM users WHERE username = '_system'`,
    ).get()).toMatchObject({ count: 1 });
  });

  it("backfills v5 tenancy fail-closed and bootstraps the deterministic admin", async () => {
    db.failOn = /ALTER TABLE users ADD COLUMN role/;
    await expect(initializeDatabase(makeEnv(db))).rejects.toThrow(
      "Database migration 5 (team_tenancy) failed",
    );
    expect(db.versions()).toEqual([1, 2, 3, 4]);

    db.sqlite.exec(`
      INSERT INTO users (
        id, username, normalized_username, auth_key_hash, auth_key_prefix,
        status, created_at
      ) VALUES
        ('user-b', 'bob', 'bob', 'hash-b', 'slm_b.', 'active', 100),
        ('user-a', 'alice', 'alice', 'hash-a', 'slm_a.', 'active', 100),
        ('user-old', 'old', 'old', 'hash-old', 'slm_old.', 'inactive', 1);

      INSERT INTO entries (
        id, content, tags, source, created_at, vector_ids, owner_user_id
      ) VALUES
        ('public-array', 'public', '["project:x"]', 'api', 1000, '[]', 'user-a'),
        ('private-array', 'private', '["private","project:x"]', 'api', 1001, '[]', 'user-a'),
        ('malformed', 'malformed', '{not-json', 'api', 1002, '[]', 'user-a'),
        ('valid-scalar', 'scalar', '"private"', 'api', 1003, '[]', 'user-a'),
        ('mixed-array', 'mixed', '[1,"project:x"]', 'api', 1004, '[]', 'user-a');

      INSERT INTO edge_proposals (
        id, source_id, target_id, type, reason, proposed_by, status,
        created_at, resolved_at
      ) VALUES
        ('legacy-approved', 'public-array', 'private-array', 'contradicts',
         'approved once', 'user-a', 'approved', 1100, 1200),
        ('legacy-rejected', 'public-array', 'private-array', 'contradicts',
         'rejected once', 'user-b', 'rejected', 1300, 1400);
    `);

    db.failOn = null;
    await initializeDatabase(makeEnv(db));

    const entries = db.sqlite.prepare(`
      SELECT id, created_by_user_id, visibility, vector_sync_pending, updated_at
      FROM entries ORDER BY id
    `).all() as Record<string, unknown>[];
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    expect(byId.get("public-array")).toMatchObject({
      created_by_user_id: "user-a",
      visibility: "public",
      vector_sync_pending: 0,
      updated_at: 1000,
    });
    expect(byId.get("private-array")?.visibility).toBe("private");
    expect(byId.get("malformed")?.visibility).toBe("private");
    expect(byId.get("valid-scalar")?.visibility).toBe("private");
    expect(byId.get("mixed-array")?.visibility).toBe("private");

    const users = db.sqlite.prepare(`
      SELECT id, role FROM users WHERE id IN ('user-a', 'user-b', 'user-old')
      ORDER BY id
    `).all() as { id: string; role: string }[];
    expect(users).toEqual([
      { id: "user-a", role: "admin" },
      { id: "user-b", role: "member" },
      { id: "user-old", role: "member" },
    ]);

    expect(db.sqlite.prepare(
      `SELECT COUNT(*) AS count FROM edge_proposals`,
    ).get()).toMatchObject({ count: 2 });
    expect(db.sqlite.prepare(
      `SELECT resolved_by FROM edge_proposals WHERE id = 'legacy-approved'`,
    ).get()).toEqual({ resolved_by: null });

    // Historical rows may repeat a terminal status, while exactly one pending
    // row for the same relationship remains enforced.
    db.sqlite.exec(`
      INSERT INTO edge_proposals (
        id, source_id, target_id, type, reason, proposed_by, status, created_at
      ) VALUES (
        'pending-1', 'public-array', 'private-array', 'contradicts',
        'retry', 'user-a', 'pending', 1500
      );
    `);
    expect(() => db.sqlite.exec(`
      INSERT INTO edge_proposals (
        id, source_id, target_id, type, reason, proposed_by, status, created_at
      ) VALUES (
        'pending-duplicate', 'public-array', 'private-array', 'contradicts',
        'duplicate', 'user-a', 'pending', 1501
      );
    `)).toThrow();
    db.sqlite.exec(`
      UPDATE edge_proposals
      SET status = 'rejected', resolved_at = 1600, resolved_by = 'user-b'
      WHERE id = 'pending-1';
      INSERT INTO edge_proposals (
        id, source_id, target_id, type, reason, proposed_by, status, created_at
      ) VALUES (
        'pending-2', 'public-array', 'private-array', 'contradicts',
        'new review', 'user-a', 'pending', 1700
      );
      UPDATE edge_proposals
      SET status = 'rejected', resolved_at = 1800, resolved_by = 'user-a'
      WHERE id = 'pending-2';
    `);
    expect(db.sqlite.prepare(`
      SELECT COUNT(*) AS count FROM edge_proposals
      WHERE source_id = 'public-array' AND target_id = 'private-array'
        AND type = 'contradicts' AND status = 'rejected'
    `).get()).toMatchObject({ count: 3 });

    // Cold-start bootstrap ignores the now-inactive prior admin and promotes
    // the next deterministic active account without touching existing history.
    db.sqlite.exec(`UPDATE users SET status = 'inactive' WHERE id = 'user-a'`);
    _resetDbReady();
    await initializeDatabase(makeEnv(db));
    expect(db.sqlite.prepare(
      `SELECT role FROM users WHERE id = 'user-b'`,
    ).get()).toEqual({ role: "admin" });
  });

  it("rolls v5 table rebuilds and columns back together, then retries", async () => {
    db.failOn = /CREATE UNIQUE INDEX IF NOT EXISTS idx_edge_proposals_pending_unique/;

    await expect(initializeDatabase(makeEnv(db))).rejects.toThrow(
      "Database migration 5 (team_tenancy) failed",
    );

    expect(db.versions()).toEqual([1, 2, 3, 4]);
    expect(db.columns("users")).not.toContain("role");
    expect(db.columns("entries")).not.toContain("visibility");
    expect(db.columns("edge_proposals")).not.toContain("resolved_by");
    expect(db.sqlite.prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'edge_proposals'`,
    ).get()).toMatchObject({
      sql: expect.stringContaining("UNIQUE(source_id, target_id, type, status)"),
    });
    expect(db.sqlite.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'user_deactivations'`,
    ).get()).toBeUndefined();

    db.failOn = null;
    await initializeDatabase(makeEnv(db));
    expect(db.versions()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    expect(db.columns("entries")).toContain("visibility");
    expect(db.columns("edge_proposals")).toContain("resolved_by");
  });

  it("migrates legacy operator audit and edge proposals into governed v6 records", async () => {
    db.failOn = /ALTER TABLE agent_runs ADD COLUMN actor_kind/;
    await expect(initializeDatabase(makeEnv(db))).rejects.toThrow(
      "Database migration 6 (operator_governance) failed",
    );
    expect(db.versions()).toEqual([1, 2, 3, 4, 5]);

    db.sqlite.exec(`
      INSERT INTO users (
        id, username, normalized_username, auth_key_hash, auth_key_prefix,
        status, created_at, role
      ) VALUES
        ('operator', 'operator', 'operator', 'hash-o', 'slm_o.', 'active', 10, 'admin'),
        ('reviewer', 'reviewer', 'reviewer', 'hash-r', 'slm_r.', 'active', 20, 'member');
      INSERT INTO entries (
        id, content, tags, source, created_at, vector_ids, owner_user_id,
        created_by_user_id, visibility, updated_at
      ) VALUES
        ('source', 'source', '[]', 'api', 100, '[]', 'operator', 'operator', 'public', 100),
        ('target', 'target', '[]', 'api', 101, '[]', 'reviewer', 'reviewer', 'public', 101);
      INSERT INTO edge_proposals (
        id, source_id, target_id, type, reason, proposed_by, status,
        created_at, resolved_at, resolved_by
      ) VALUES
        ('edge-pending', 'source', 'target', 'supports', 'review this',
         '_nightly_scan', 'pending', 200, NULL, NULL),
        ('edge-approved', 'source', 'target', 'contradicts', 'accepted',
         'operator', 'approved', 210, 220, 'reviewer');
      INSERT INTO agent_runs (
        id, user_id, started_at, completed_at, tool_count
      ) VALUES ('run-legacy', 'operator', 300, 400, 2);
      INSERT INTO agent_events (
        id, run_id, tool_name, input_summary, output_summary, duration_ms,
        error, created_at
      ) VALUES
        ('event-b', 'run-legacy', 'remember', 'input b', 'output b', 12, 'boom', 310),
        ('event-a', 'run-legacy', 'recall', 'input a', 'output a', 10, NULL, 310);
    `);

    db.failOn = null;
    await initializeDatabase(makeEnv(db));

    expect(db.sqlite.prepare(`
      SELECT actor_kind, actor_id, auth_method, autonomy_profile,
        policy_version, status, requested_at, succeeded_at
      FROM agent_runs WHERE id = 'run-legacy'
    `).get()).toEqual({
      actor_kind: "human",
      actor_id: "operator",
      auth_method: "legacy",
      autonomy_profile: "legacy",
      policy_version: "legacy",
      status: "succeeded",
      requested_at: 300,
      succeeded_at: 400,
    });
    expect(db.sqlite.prepare(`
      SELECT id, sequence, event_type, actor_id, status
      FROM agent_events WHERE run_id = 'run-legacy'
      ORDER BY sequence
    `).all()).toEqual([
      { id: "event-a", sequence: 1, event_type: "succeeded", actor_id: "operator", status: "succeeded" },
      { id: "event-b", sequence: 2, event_type: "failed", actor_id: "operator", status: "failed" },
    ]);

    expect(db.sqlite.prepare(`
      SELECT id, action_type, proposer_kind, proposer_id, visibility_scope,
        payload_hash, target_ids, status, reviewer_id, executed_at,
        idempotency_key
      FROM action_proposals ORDER BY id
    `).all()).toEqual([
      {
        id: "legacy-edge:edge-approved",
        action_type: "edge.publish",
        proposer_kind: "human",
        proposer_id: "operator",
        visibility_scope: "team",
        payload_hash: null,
        target_ids: '["source","target"]',
        status: "executed",
        reviewer_id: "reviewer",
        executed_at: 220,
        idempotency_key: "legacy-edge-proposal:edge-approved",
      },
      {
        id: "legacy-edge:edge-pending",
        action_type: "edge.publish",
        proposer_kind: "system",
        proposer_id: "_nightly_scan",
        visibility_scope: "team",
        payload_hash: null,
        target_ids: '["source","target"]',
        status: "pending",
        reviewer_id: null,
        executed_at: null,
        idempotency_key: "legacy-edge-proposal:edge-pending",
      },
    ]);
    expect(db.sqlite.prepare(
      `SELECT COUNT(*) AS count FROM edge_proposals`,
    ).get()).toMatchObject({ count: 2 });
    expect(db.sqlite.prepare(`
      SELECT proposal_id, sequence, event_type
      FROM proposal_events ORDER BY proposal_id, sequence
    `).all()).toEqual([
      { proposal_id: "legacy-edge:edge-approved", sequence: 1, event_type: "migrated" },
      { proposal_id: "legacy-edge:edge-approved", sequence: 2, event_type: "executed" },
      { proposal_id: "legacy-edge:edge-pending", sequence: 1, event_type: "migrated" },
    ]);
    expect(() => db.sqlite.exec(`
      UPDATE proposal_events SET event_type = 'tampered'
      WHERE proposal_id = 'legacy-edge:edge-approved' AND sequence = 1
    `)).toThrow("proposal_events are append-only");

    db.sqlite.exec(`
      INSERT INTO action_proposals (
        id, action_type, proposer_kind, proposer_id, payload_json, reason,
        autonomy_profile, policy_version, idempotency_key, created_at, updated_at
      ) VALUES (
        'manual-proposal', 'entry.update', 'human', 'operator', '{}',
        'manual review', 'human', 'v1', 'manual-key', 500, 500
      );
    `);
    expect(() => db.sqlite.exec(`
      INSERT INTO action_proposals (
        id, action_type, proposer_kind, proposer_id, payload_json, reason,
        autonomy_profile, policy_version, idempotency_key, created_at, updated_at
      ) VALUES (
        'manual-duplicate', 'entry.update', 'human', 'operator', '{}',
        'duplicate', 'human', 'v1', 'manual-key', 501, 501
      )
    `)).toThrow();
  });

  it("rolls v6 audit expansion and governance tables back together, then retries", async () => {
    db.failOn = /CREATE TABLE IF NOT EXISTS action_proposals/;

    await expect(initializeDatabase(makeEnv(db))).rejects.toThrow(
      "Database migration 6 (operator_governance) failed",
    );

    expect(db.versions()).toEqual([1, 2, 3, 4, 5]);
    expect(db.columns("agent_runs")).not.toContain("actor_kind");
    expect(db.columns("agent_events")).not.toContain("sequence");
    expect(db.sqlite.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'service_identities'`,
    ).get()).toBeUndefined();
    expect(db.sqlite.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'action_proposals'`,
    ).get()).toBeUndefined();

    db.failOn = null;
    await initializeDatabase(makeEnv(db));
    expect(db.versions()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    expect(db.columns("agent_runs")).toContain("actor_kind");
    expect(db.columns("agent_events")).toContain("sequence");
    expect(db.sqlite.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'action_proposals'`,
    ).get()).toEqual({ name: "action_proposals" });
  });

  it("rolls v7 overlap-awareness tables back together, then retries", async () => {
    db.failOn = /CREATE INDEX IF NOT EXISTS idx_awareness_events_pair/;

    await expect(initializeDatabase(makeEnv(db))).rejects.toThrow(
      "Database migration 7 (overlap_awareness) failed",
    );

    expect(db.versions()).toEqual([1, 2, 3, 4, 5, 6]);
    expect(db.sqlite.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'awareness_events'`,
    ).get()).toBeUndefined();
    expect(db.sqlite.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'overlap_awareness_reconciliation'`,
    ).get()).toBeUndefined();

    db.failOn = null;
    await initializeDatabase(makeEnv(db));
    expect(db.versions()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    expect(db.sqlite.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'awareness_events'`,
    ).get()).toEqual({ name: "awareness_events" });
    expect(db.sqlite.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'overlap_awareness_reconciliation'`,
    ).get()).toEqual({ name: "overlap_awareness_reconciliation" });
  });

  it("backfills one document envelope per episode and enforces the invariant", async () => {
    db.failOn = /CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_episode_unique/;
    await expect(initializeDatabase(makeEnv(db))).rejects.toThrow(
      "Database migration 8 (episode_document_invariant) failed",
    );
    expect(db.versions()).toEqual([1, 2, 3, 4, 5, 6, 7]);

    db.sqlite.exec(`
      INSERT INTO entries (
        id, content, tags, source, created_at, vector_ids,
        owner_user_id, revision
      ) VALUES ('entry-doc-backfill', 'Current state', '[]', 'api', 100, '[]', 'owner-1', 3);
      INSERT INTO episodes (
        id, entry_id, content, content_type, source, created_at,
        materialized_content, content_hash, mutation_id, mutation_kind,
        owner_user_id, source_url
      ) VALUES (
        'episode-doc-backfill', 'entry-doc-backfill', 'Raw state', 'text',
        'api', 100, 'Current state', 'content-hash', 'mutation-1',
        'capture', 'owner-1', NULL
      );
    `);

    db.failOn = null;
    await initializeDatabase(makeEnv(db));
    expect(db.versions()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    const documents = db.sqlite.prepare(
      `SELECT episode_id, owner_user_id, content_type, content_hash, version
       FROM documents WHERE episode_id = 'episode-doc-backfill'`,
    ).all();
    expect(documents).toEqual([{
      episode_id: "episode-doc-backfill",
      owner_user_id: "owner-1",
      content_type: "text",
      content_hash: "content-hash",
      version: "3",
    }]);
    expect(() => db.sqlite.exec(`
      INSERT INTO documents (
        id, title, content_type, created_at, episode_id, owner_user_id
      ) VALUES ('duplicate-document', 'Duplicate', 'text', 200, 'episode-doc-backfill', 'owner-1');
    `)).toThrow();
  });

  it("adds an explicit title-origin discriminator without changing document revision provenance", async () => {
    db.failOn = /ALTER TABLE documents ADD COLUMN title_origin/;
    await expect(initializeDatabase(makeEnv(db))).rejects.toThrow(
      "Database migration 11 (document_title_origin) failed",
    );
    expect(db.versions()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(db.columns("documents")).not.toContain("title_origin");

    db.sqlite.exec(`
      INSERT INTO documents (
        id, title, content_type, created_at, owner_user_id, version
      ) VALUES (
        'legacy-title', 'Legacy title whose provenance is unknown',
        'research', 100, 'owner-1', 'revision-unchanged'
      );
    `);

    db.failOn = null;
    await initializeDatabase(makeEnv(db));

    expect(db.versions()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    expect(db.sqlite.prepare(`
      SELECT title_origin, version FROM documents WHERE id = 'legacy-title'
    `).get()).toEqual({
      title_origin: "generated",
      version: "revision-unchanged",
    });
    expect(() => db.sqlite.exec(`
      UPDATE documents SET title_origin = 'inferred' WHERE id = 'legacy-title';
    `)).toThrow();

    db.sqlite.exec(`
      INSERT INTO documents (
        id, title, content_type, created_at, owner_user_id, version
      ) VALUES ('default-origin', 'Default', 'text', 200, 'owner-1', '7');
    `);
    expect(db.sqlite.prepare(`
      SELECT title_origin, version FROM documents WHERE id = 'default-origin'
    `).get()).toEqual({ title_origin: "generated", version: "7" });
  });

  it("backfills edge version history and records update/delete revisions", async () => {
    db.failOn = /CREATE TRIGGER IF NOT EXISTS edge_versions_after_insert/;
    await expect(initializeDatabase(makeEnv(db))).rejects.toThrow(
      "Database migration 10 (audit_and_edge_history) failed",
    );
    expect(db.versions()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(db.columns("edges")).not.toContain("revision");
    expect(db.sqlite.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'edge_versions'`,
    ).get()).toBeUndefined();

    db.sqlite.exec(`
      INSERT INTO edges (
        id, source_id, target_id, type, weight, provenance, metadata,
        confidence, created_at, updated_at
      ) VALUES (
        'legacy-edge', 'source-a', 'target-b', 'supports', 0.7,
        'explicit', '{"confidence":0.7}', 0.7, 100, 110
      );
    `);

    db.failOn = null;
    await initializeDatabase(makeEnv(db));
    expect(db.versions()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    expect(db.columns("edges")).toContain("revision");
    expect(db.sqlite.prepare(`
      SELECT edge_id, revision, is_deleted, mutation_kind, actor_kind,
        actor_id, recorded_at
      FROM edge_versions WHERE edge_id = 'legacy-edge'
    `).all()).toEqual([{
      edge_id: "legacy-edge",
      revision: 1,
      is_deleted: 0,
      mutation_kind: "legacy",
      actor_kind: "system",
      actor_id: "_migration",
      recorded_at: 110,
    }]);

    db.sqlite.exec(`
      UPDATE edges
      SET revision = revision + 1,
          updated_at = 200,
          last_actor_kind = 'human',
          last_actor_id = 'reviewer',
          last_mutation_kind = 'explicit-link',
          last_mutation_id = 'mutation-2'
      WHERE id = 'legacy-edge';
      DELETE FROM edges WHERE id = 'legacy-edge';
    `);
    expect(db.sqlite.prepare(`
      SELECT revision, is_deleted, mutation_kind, actor_id
      FROM edge_versions WHERE edge_id = 'legacy-edge'
      ORDER BY revision
    `).all()).toEqual([
      { revision: 1, is_deleted: 0, mutation_kind: "legacy", actor_id: "_migration" },
      { revision: 2, is_deleted: 0, mutation_kind: "explicit-link", actor_id: "reviewer" },
      { revision: 3, is_deleted: 1, mutation_kind: "explicit-link", actor_id: "reviewer" },
    ]);
  });

  it("propagates migration failure, rolls back its version, and permits retry", async () => {
    db.failOn = /CREATE INDEX IF NOT EXISTS idx_entries_owner/;

    await expect(initializeDatabase(makeEnv(db))).rejects.toThrow(
      "Database migration 2 (entry_and_edge_features) failed",
    );

    expect(getDbReady()).toBe(false);
    expect(db.versions()).toEqual([1]);
    expect(db.columns("entries")).not.toContain("owner_user_id");

    db.failOn = null;
    await initializeDatabase(makeEnv(db));

    expect(getDbReady()).toBe(true);
    expect(db.versions()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    expect(db.columns("entries")).toContain("owner_user_id");
  });

  it("fails closed when migration history is unknown or inconsistent", async () => {
    db.sqlite.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      );
      INSERT INTO schema_migrations VALUES (2, 'entry_and_edge_features', 1);
    `);

    await expect(initializeDatabase(makeEnv(db))).rejects.toThrow(
      "Database migration history is not contiguous",
    );
    expect(getDbReady()).toBe(false);
  });

  it("does not trust version rows when the physical schema is incomplete", async () => {
    db.sqlite.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      );
      INSERT INTO schema_migrations VALUES (1, 'core_tables', 1);
      INSERT INTO schema_migrations VALUES (2, 'entry_and_edge_features', 1);
      INSERT INTO schema_migrations VALUES (3, 'memory_and_operator_tables', 1);
      INSERT INTO schema_migrations VALUES (4, 'provenance_integrity', 1);
      INSERT INTO schema_migrations VALUES (5, 'team_tenancy', 1);
      INSERT INTO schema_migrations VALUES (6, 'operator_governance', 1);
      CREATE TABLE entries (id TEXT PRIMARY KEY, content TEXT NOT NULL);
    `);

    await expect(initializeDatabase(makeEnv(db))).rejects.toThrow(
      "Database migration 8 (episode_document_invariant) failed",
    );
    expect(getDbReady()).toBe(false);
  });

  it("rolls back provenance migration columns and version together, then retries", async () => {
    db.failOn = /CREATE INDEX IF NOT EXISTS idx_entries_current_episode/;

    await expect(initializeDatabase(makeEnv(db))).rejects.toThrow(
      "Database migration 4 (provenance_integrity) failed",
    );

    expect(getDbReady()).toBe(false);
    expect(db.versions()).toEqual([1, 2, 3]);
    expect(db.columns("entries")).not.toContain("current_episode_id");
    expect(db.columns("episodes")).not.toContain("materialized_content");
    expect(db.sqlite.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'vector_cleanup_queue'`,
    ).get()).toBeUndefined();

    db.failOn = null;
    await initializeDatabase(makeEnv(db));

    expect(getDbReady()).toBe(true);
    expect(db.versions()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    expect(db.columns("entries")).toContain("current_episode_id");
    expect(db.columns("episodes")).toContain("materialized_content");
  });

  it("backfills only provable legacy episode values and leaves current lineage unknown", async () => {
    db.failOn = /ALTER TABLE entries ADD COLUMN current_episode_id/;
    await expect(initializeDatabase(makeEnv(db))).rejects.toThrow(
      "Database migration 4 (provenance_integrity) failed",
    );
    expect(db.versions()).toEqual([1, 2, 3]);

    db.sqlite.exec(`
      INSERT INTO entries (
        id, content, tags, source, created_at, vector_ids, owner_user_id
      ) VALUES (
        'legacy-entry', 'current projection', '[]', 'api', 1000, '[]', 'owner-1'
      );
      INSERT INTO episodes (
        id, entry_id, content, content_type, source, created_at
      ) VALUES (
        'legacy-episode', 'legacy-entry', 'verbatim source', 'text', 'api', 1000
      );
    `);

    db.failOn = null;
    await initializeDatabase(makeEnv(db));

    const episode = db.sqlite.prepare(`
      SELECT materialized_content, mutation_kind, owner_user_id
      FROM episodes WHERE id = 'legacy-episode'
    `).get() as Record<string, unknown>;
    const entry = db.sqlite.prepare(`
      SELECT current_episode_id, revision
      FROM entries WHERE id = 'legacy-entry'
    `).get() as Record<string, unknown>;

    expect(episode).toEqual({
      materialized_content: "verbatim source",
      mutation_kind: "legacy",
      owner_user_id: "owner-1",
    });
    expect(entry).toEqual({ current_episode_id: null, revision: 0 });
  });
});

describe("migration 16 — capture receipts, status metadata and stage fencing", () => {
  let db: SqliteD1;

  beforeEach(() => {
    _resetDbReady();
    db = new SqliteD1();
  });

  afterEach(() => {
    _resetDbReady();
    db.close();
  });

  it("is the next ordered migration and keeps earlier versions contiguous", async () => {
    await initializeDatabase(makeEnv(db));
    expect(db.versions()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
  });

  it("adds a nullable status_change_json to episodes", async () => {
    await initializeDatabase(makeEnv(db));
    const columns = db.sqlite.prepare(`PRAGMA table_info(episodes)`).all() as
      { name: string; notnull: number; dflt_value: string | null }[];
    const statusChange = columns.find((column) => column.name === "status_change_json");
    expect(statusChange).toMatchObject({ notnull: 0, dflt_value: null });

    db.sqlite.exec(`INSERT INTO episodes (id, entry_id, content, created_at)
      VALUES ('ep-1', 'entry-1', 'x', 1)`);
    const row = db.sqlite.prepare(`SELECT status_change_json FROM episodes WHERE id = 'ep-1'`)
      .get() as Record<string, unknown>;
    expect(row.status_change_json).toBeNull();
  });

  it("creates capture_receipts with the exact contract columns and primary key", async () => {
    await initializeDatabase(makeEnv(db));
    const columns = db.sqlite.prepare(`PRAGMA table_info(capture_receipts)`).all() as
      { name: string; type: string; notnull: number; pk: number }[];
    expect(columns.map((column) => column.name).sort()).toEqual([
      "actor_id",
      "actor_kind",
      "created_at",
      "entry_id",
      "episode_id",
      "erased_at",
      "key_hash",
      "mutation_id",
      "request_hash",
      "revision",
      "state",
    ]);
    expect(columns.filter((column) => column.pk > 0).map((column) => column.name).sort())
      .toEqual(["actor_id", "actor_kind", "key_hash"]);
    for (const name of ["actor_kind", "actor_id", "key_hash", "entry_id", "state", "created_at"]) {
      expect(columns.find((column) => column.name === name)?.notnull).toBe(1);
    }

    const tables = db.sqlite.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table'`,
    ).all() as { name: string }[];
    expect(tables.map((row) => row.name)).toContain("capture_receipts");

    const indexes = db.sqlite.prepare(
      `SELECT name, tbl_name AS tableName FROM sqlite_master WHERE type = 'index'`,
    ).all() as { name: string; tableName: string }[];
    expect(indexes.some((row) => row.tableName === "capture_receipts" && row.name.includes("entry")))
      .toBe(true);
  });

  it("enforces the receipt state and actor-kind domains", async () => {
    await initializeDatabase(makeEnv(db));
    const insert = (state: string, actorKind: string) => db.sqlite.prepare(
      `INSERT INTO capture_receipts (actor_kind, actor_id, key_hash, entry_id, state, created_at)
       VALUES (?, 'actor', ?, 'entry', ?, 1)`,
    ).run(actorKind, `hash-${state}-${actorKind}`, state);

    expect(() => insert("committed", "human")).not.toThrow();
    expect(() => insert("erased", "service")).not.toThrow();
    expect(() => insert("pending", "human")).toThrow(/CHECK/i);
    expect(() => insert("committed", "robot")).toThrow(/CHECK/i);
  });

  it("rejects a duplicate retry key inside the same actor namespace only", async () => {
    await initializeDatabase(makeEnv(db));
    const insert = (actorKind: string, actorId: string, keyHash: string) => db.sqlite.prepare(
      `INSERT INTO capture_receipts (actor_kind, actor_id, key_hash, entry_id, state, created_at)
       VALUES (?, ?, ?, 'entry', 'committed', 1)`,
    ).run(actorKind, actorId, keyHash);

    insert("human", "alice", "same-key");
    expect(() => insert("human", "alice", "same-key")).toThrow(/UNIQUE/i);
    expect(() => insert("human", "bob", "same-key")).not.toThrow();
    expect(() => insert("service", "alice", "same-key")).not.toThrow();
  });

  it("adds capture-stage fencing columns that default existing delete rows", async () => {
    await initializeDatabase(makeEnv(db));
    const columns = db.sqlite.prepare(`PRAGMA table_info(vector_cleanup_queue)`).all() as
      { name: string; notnull: number; dflt_value: string | null }[];
    for (const name of [
      "kind",
      "stage_entry_id",
      "stage_episode_id",
      "lease_expires_at",
      "claim_token",
    ]) {
      expect(columns.map((column) => column.name)).toContain(name);
    }
    expect(columns.find((column) => column.name === "kind"))
      .toMatchObject({ notnull: 1, dflt_value: "'delete'" });
    for (const name of ["stage_entry_id", "stage_episode_id", "lease_expires_at", "claim_token"]) {
      expect(columns.find((column) => column.name === name)?.notnull).toBe(0);
    }

    // An unspecified kind is a legacy delete job, never an unconditional stage.
    db.sqlite.exec(`INSERT INTO vector_cleanup_queue (id, vector_ids, reason, created_at, updated_at)
      VALUES ('job-1', '["v1"]', 'entry-version:e:m', 1, 1)`);
    expect(db.sqlite.prepare(`SELECT kind FROM vector_cleanup_queue WHERE id = 'job-1'`)
      .get()).toEqual({ kind: "delete" });
    expect(() => db.sqlite.prepare(`INSERT INTO vector_cleanup_queue
      (id, vector_ids, reason, kind, created_at, updated_at) VALUES ('job-2', '[]', 'r', 'bogus', 1, 1)`)
      .run()).toThrow(/CHECK/i);
  });

  it("provides a stable entry-list index for cursor pagination", async () => {
    await initializeDatabase(makeEnv(db));
    const indexes = db.sqlite.prepare(
      `SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'entries'`,
    ).all() as { name: string; sql: string }[];
    const ordered = indexes.find((row) =>
      /created_at\s+DESC/i.test(row.sql ?? "") && /\bid\s+DESC/i.test(row.sql ?? ""));
    expect(ordered).toBeTruthy();
  });

  it("is safe to run repeatedly and converges with the schema.sql bootstrap", async () => {
    await initializeDatabase(makeEnv(db));
    const first = db.schemaSignature();
    _resetDbReady();
    await initializeDatabase(makeEnv(db));
    expect(db.schemaSignature()).toEqual(first);
    expect(db.versions()).toHaveLength(16);
  });

  it("upgrades a database that stopped at migration 15 without losing rows", async () => {
    await initializeDatabase(makeEnv(db));
    // Simulate a pre-16 deployment: drop the new artifacts and forget version 16.
    db.sqlite.exec(`
      DELETE FROM schema_migrations WHERE version = 16;
      DROP TABLE capture_receipts;
      ALTER TABLE episodes DROP COLUMN status_change_json;
      INSERT INTO vector_cleanup_queue (id, vector_ids, reason, created_at, updated_at)
        VALUES ('legacy-job', '["v-legacy"]', 'entry-version:e:m', 5, 5);
    `);
    _resetDbReady();
    await initializeDatabase(makeEnv(db));

    expect(db.versions()).toContain(16);
    expect(db.columns("episodes")).toContain("status_change_json");
    expect(db.columns("capture_receipts")).toContain("key_hash");
    expect(db.sqlite.prepare(
      `SELECT kind, stage_entry_id, stage_episode_id, lease_expires_at, claim_token
       FROM vector_cleanup_queue WHERE id = 'legacy-job'`,
    ).get()).toEqual({
      kind: "delete",
      stage_entry_id: null,
      stage_episode_id: null,
      lease_expires_at: null,
      claim_token: null,
    });
  });
});
