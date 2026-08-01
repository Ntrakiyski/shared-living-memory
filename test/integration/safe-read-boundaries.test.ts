import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { AUTH_PEPPER, hmacKey } from "../../src/auth";
import { _resetDbReady, initializeDatabase } from "../../src/db";
import { buildMcpServer } from "../../src/mcp";
import { defaultHandler } from "../../src/routes";
import type { Env, HumanActorContext } from "../../src/types";
import { makeAIMock, makeKVMock, makeVectorizeMock } from "../helpers/make-env";
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
    const row = this.owner.sqlite.prepare(this.sql).get(...this.values as SQLInputValue[]) as Record<string, unknown> | undefined;
    if (!row) return null;
    return (column ? row[column] : row) as T;
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

const ctx = {
  waitUntil: (_promise: Promise<unknown>) => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

function actor(userId: string): HumanActorContext {
  return {
    kind: "human",
    actorId: userId,
    userId,
    role: "member",
    authMethod: "test",
    scopes: new Set(),
  };
}

function callTool(server: ReturnType<typeof buildMcpServer>, name: string, input: Record<string, unknown>) {
  return (server as any)._registeredTools[name].handler(input, {});
}

async function seedUser(db: SqliteD1, id: string) {
  const secret = `${id}-secret`;
  const key = `slm_${id}.${secret}`;
  db.sqlite.prepare(
    `INSERT INTO users (
       id, username, normalized_username, auth_key_hash, auth_key_prefix,
       status, created_at, role
     ) VALUES (?, ?, ?, ?, ?, 'active', 1, 'member')`,
  ).run(id, id, id, await hmacKey(secret, AUTH_PEPPER), key.slice(0, 15));
  return { username: id, key };
}

describe("safe read boundaries with real SQLite", () => {
  let db: SqliteD1;
  let env: Env;
  let vectorQuery: ReturnType<typeof vi.fn>;
  let alice: { username: string; key: string };
  let bob: { username: string; key: string };

  beforeEach(async () => {
    _resetDbReady();
    db = new SqliteD1();
    vectorQuery = vi.fn().mockResolvedValue({ matches: [] });
    env = {
      DB: db as unknown as D1Database,
      AI: makeAIMock(),
      VECTORIZE: makeVectorizeMock({
        query: vectorQuery as unknown as VectorizeIndex["query"],
      }),
      AUTH_TOKEN: "test-token",
      OAUTH_KV: makeKVMock(),
    } as Env;
    await initializeDatabase(env);
    alice = await seedUser(db, "alice");
    bob = await seedUser(db, "bob");
  });

  afterEach(() => {
    _resetDbReady();
    db.close();
  });

  it("never returns or feeds cross-user legacy source metadata through REST recall, hierarchy, list, or graph siblings", async () => {
    const secret = `sk_live_${"s".repeat(24)}`;
    const forged = "FORGED_METADATA_FIELD";
    db.sqlite.exec(`
      INSERT INTO entries (
        id, content, tags, source, created_at, vector_ids, owner_user_id,
        created_by_user_id, visibility, current_episode_id, revision
      ) VALUES
        ('alice-risk', 'Safe public content', '[]',
         'legacy\n${forged} ${secret}', 20, '[]', 'alice', 'alice', 'public', 'alice-risk-episode', 1),
        ('bob-seed', 'Bob public seed', '[]', 'bob-safe-source',
         10, '[]', 'bob', 'bob', 'public', NULL, 1),
        ('alice-custom', 'Custom citation content', '[]', 'integration',
         5, '[]', 'alice', 'alice', 'public', 'alice-custom-episode', 1);

      INSERT INTO episodes (
        id, entry_id, content, content_type, source, created_at,
        materialized_content, owner_user_id, source_url
      ) VALUES
        ('alice-risk-episode', 'alice-risk', 'Safe public content', 'research', 'legacy', 20,
         'Safe public content', 'alice', 'https://example.test/${secret}'),
        ('alice-custom-episode', 'alice-custom', 'Custom citation content', 'research', 'integration', 5,
         'Custom citation content', 'alice', 'zotero://select/library/items/SAFE123');

      INSERT INTO documents (
        id, title, source_url, content_type, created_at, episode_id,
        owner_user_id, content_hash, version, title_origin
      ) VALUES
        ('alice-risk-document', 'Secret ${secret}', 'https://example.test/${secret}',
         'research', 20, 'alice-risk-episode', 'alice', '${secret}',
         'legacy\n${forged}', 'generated'),
        ('alice-custom-document', 'Custom source', 'zotero://select/library/items/SAFE123',
         'research', 5, 'alice-custom-episode', 'alice', NULL, '1', 'explicit');

      INSERT INTO document_sections (
        id, document_id, title, level, order_index, created_at,
        start_offset, end_offset
      ) VALUES (
        'alice-risk-section', 'alice-risk-document', 'Section\n${forged}',
        1, 0, 20, 0, 19
      );

      INSERT INTO passages (
        id, entry_id, episode_id, document_id, section_id, content,
        section, start_offset, end_offset, vector_ids, created_at
      ) VALUES (
        'alice-risk-passage', 'alice-risk', 'alice-risk-episode',
        'alice-risk-document', 'alice-risk-section', 'Safe public content',
        'Passage\n${forged}', 0, 19, '[]', 20
      );

      INSERT INTO edges (
        id, source_id, target_id, type, weight, provenance, metadata,
        confidence, created_at, updated_at
      ) VALUES (
        'bob-to-alice', 'bob-seed', 'alice-risk', 'relates_to', 0.8,
        'explicit', '{}', 1.0, 20, 20
      );
    `);
    vectorQuery.mockResolvedValue({
      matches: [{
        id: "alice-risk-vector",
        score: 0.95,
        metadata: {
          parentId: "alice-risk",
          episodeId: "alice-risk-episode",
          episode_id: "alice-risk-episode",
          owner_user_id: "alice",
          is_private: false,
          created_at: 20,
          tags: [],
        },
      }],
    });

    const requests = await Promise.all([
      defaultHandler.fetch(req("GET", "/list?n=20", { userCredentials: bob }), env, ctx),
      defaultHandler.fetch(req("GET", "/team-activity", { userCredentials: bob }), env, ctx),
      defaultHandler.fetch(req("GET", "/recall?query=public&topK=5", { userCredentials: bob }), env, ctx),
      defaultHandler.fetch(req("GET", "/entries/alice-risk/hierarchy", { userCredentials: bob }), env, ctx),
      defaultHandler.fetch(req("GET", "/entry?id=alice-risk", { userCredentials: bob }), env, ctx),
      defaultHandler.fetch(req("GET", "/connections?id=bob-seed", { userCredentials: bob }), env, ctx),
      defaultHandler.fetch(req("GET", "/graph?seed=bob-seed", { userCredentials: bob }), env, ctx),
    ]);
    expect(requests.every((response) => response.status === 200)).toBe(true);
    const bodies = await Promise.all(requests.map((response) => response.json() as Promise<any>));
    const [list, activity, recall, hierarchy, entry, connections] = bodies;

    expect(list.find((item: any) => item.id === "alice-risk")?.source).toBeNull();
    expect(activity.entries.find((item: any) => item.id === "alice-risk")?.source).toBeNull();
    expect(recall.results[0]).toMatchObject({ id: "alice-risk", source: null });
    expect(recall.results[0].passages[0]).toMatchObject({
      documentTitle: null,
      sourceUrl: null,
      section: null,
    });
    expect(hierarchy.document).toMatchObject({
      title: null,
      source_url: null,
      content_hash: null,
      version: null,
    });
    expect(hierarchy.passages[0].section).toBeNull();
    expect(hierarchy.sections[0].title).toBeNull();
    expect(entry.entry.source).toBeNull();
    expect(connections.connections[0]).toMatchObject({ id: "alice-risk", source: null });

    const serialized = JSON.stringify(bodies);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(forged);

    const [ownerHierarchy, publicHierarchy] = await Promise.all([
      defaultHandler.fetch(req("GET", "/entries/alice-custom/hierarchy", { userCredentials: alice }), env, ctx),
      defaultHandler.fetch(req("GET", "/entries/alice-custom/hierarchy", { userCredentials: bob }), env, ctx),
    ]);
    expect((await ownerHierarchy.json() as any).document.source_url)
      .toBe("zotero://select/library/items/SAFE123");
    expect((await publicHierarchy.json() as any).document.source_url).toBeNull();
  });

  it("authorizes ownerless documents only through already owner-scoped episodes and passages", async () => {
    db.sqlite.exec(`
      INSERT INTO entries (
        id, content, tags, source, created_at, vector_ids, owner_user_id,
        created_by_user_id, visibility, current_episode_id, revision, recorded_at
      ) VALUES (
        'alice-history', 'Current state', '["private"]', 'api', 20, '[]',
        'alice', 'alice', 'private', 'episode-current', 2, 20
      );

      INSERT INTO episodes (
        id, entry_id, content, content_type, source, created_at,
        materialized_content, mutation_kind, owner_user_id, source_url
      ) VALUES
        ('episode-historical', 'alice-history', 'Historical state', 'research', 'api', 10,
         'Historical state', 'capture', 'alice', 'urn:isbn:9780141036144'),
        ('episode-current', 'alice-history', 'Current state', 'text', 'api', 20,
         'Current state', 'update', 'alice', NULL);

      INSERT INTO documents (
        id, title, source_url, content_type, created_at, episode_id,
        owner_user_id, version, title_origin
      ) VALUES
        ('document-historical', 'Historical generated title', 'urn:isbn:9780141036144',
         'research', 10, 'episode-historical', '', '1', 'generated'),
        ('document-current', 'Current generated title', NULL,
         'text', 20, 'episode-current', '', '2', 'generated');

      INSERT INTO entry_snapshots (
        id, entry_id, content, tags, source, created_at, episode_id,
        mutation_kind, recorded_at, revision, visibility
      ) VALUES (
        'snapshot-historical', 'alice-history', 'Historical state', '["private"]',
        'api', 15, 'episode-historical', 'update', 10, 1, 'private'
      );

      INSERT INTO passages (
        id, entry_id, episode_id, document_id, content, start_offset,
        end_offset, vector_ids, created_at
      ) VALUES (
        'ownerless-passage', 'alice-history', 'episode-historical',
        'document-historical', 'Historical state', 0, 16, '[]', 10
      );
    `);

    const ownerExport = await defaultHandler.fetch(
      req("GET", "/export?mode=my_data", { userCredentials: alice }),
      env,
      ctx,
    );
    const ownerData = await ownerExport.json() as any;
    expect(ownerExport.status).toBe(200);
    expect(ownerData.documents.map((document: any) => document.id).sort()).toEqual([
      "document-current",
      "document-historical",
    ]);

    const ownerHistory = await callTool(
      buildMcpServer(env, ctx, actor("alice")),
      "history",
      { entry_id: "alice-history" },
    );
    const ownerHistoryData = JSON.parse(ownerHistory.content[0].text);
    expect(ownerHistoryData.episodes).toContainEqual(expect.objectContaining({
      id: "episode-historical",
      source_title: "Historical generated title",
    }));

    const deniedHistory = await callTool(
      buildMcpServer(env, ctx, actor("bob")),
      "history",
      { entry_id: "alice-history" },
    );
    expect(deniedHistory.content[0].text).toBe("No history found for entry alice-history.");

    const deniedRestore = await defaultHandler.fetch(req("POST", "/restore", {
      body: { entry_id: "alice-history", snapshot_id: "snapshot-historical" },
      userCredentials: bob,
    }), env, ctx);
    expect(deniedRestore.status).toBe(404);

    const restored = await defaultHandler.fetch(req("POST", "/restore", {
      body: { entry_id: "alice-history", snapshot_id: "snapshot-historical" },
      userCredentials: alice,
    }), env, ctx);
    const restoredBody = await restored.json() as any;
    expect(restored.status).toBe(200);
    const restoredDocument = db.sqlite.prepare(`
      SELECT d.title, d.title_origin, d.version
      FROM entries e
      JOIN documents d ON d.episode_id = e.current_episode_id
      WHERE e.id = ?
    `).get(restoredBody.id);
    expect(restoredDocument).toEqual({
      title: "Historical generated title",
      title_origin: "generated",
      version: "1",
    });

    const bobExport = await defaultHandler.fetch(
      req("GET", "/export?mode=my_data", { userCredentials: bob }),
      env,
      ctx,
    );
    expect((await bobExport.json() as any).documents).toEqual([]);
  });

  it("restores legacy generated envelopes whose titles contain only non-space whitespace", async () => {
    const sourceUrl = "https://example.test/whitespace-title";
    db.sqlite.exec(`
      INSERT INTO entries (
        id, content, tags, source, created_at, vector_ids, owner_user_id,
        created_by_user_id, visibility, current_episode_id, revision
      ) VALUES (
        'whitespace-title-source', 'Current state', '["private"]', 'api',
        20, '[]', 'alice', 'alice', 'private', NULL, 1
      );

      INSERT INTO episodes (
        id, entry_id, content, content_type, source, created_at,
        materialized_content, mutation_kind, owner_user_id, source_url
      ) VALUES (
        'whitespace-title-episode', 'whitespace-title-source',
        'Historical body', 'research', 'api', 10, 'Historical body',
        'capture', 'alice', '${sourceUrl}'
      );

      INSERT INTO documents (
        id, title, source_url, content_type, created_at, episode_id,
        owner_user_id, version, title_origin
      ) VALUES (
        'whitespace-title-document', char(9) || char(10), '${sourceUrl}',
        'research', 10, 'whitespace-title-episode', 'alice', '1', 'generated'
      );

      INSERT INTO entry_snapshots (
        id, entry_id, content, tags, source, created_at, episode_id,
        mutation_kind, recorded_at, revision, visibility
      ) VALUES (
        'whitespace-title-snapshot', 'whitespace-title-source',
        'Historical body', '["private"]', 'api', 15,
        'whitespace-title-episode', 'update', 10, 1, 'private'
      );
    `);

    const restored = await defaultHandler.fetch(req("POST", "/restore", {
      body: {
        entry_id: "whitespace-title-source",
        snapshot_id: "whitespace-title-snapshot",
      },
      userCredentials: alice,
    }), env, ctx);
    const restoredBody = await restored.json() as any;

    expect(restored.status).toBe(200);
    expect(db.sqlite.prepare(`
      SELECT d.title, d.title_origin, d.source_url
      FROM entries e
      JOIN documents d ON d.episode_id = e.current_episode_id
      WHERE e.id = ?
    `).get(restoredBody.id)).toEqual({
      title: sourceUrl,
      title_origin: "generated",
      source_url: sourceUrl,
    });
  });
});
