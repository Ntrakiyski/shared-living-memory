import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { recallEntries } from "../../src/recall";
import type { Env } from "../../src/types";
import { makeAIMock, makeKVMock, makeVectorizeMock } from "../helpers/make-env";

const schema = readFileSync(resolve(process.cwd(), "db/schema.sql"), "utf8");
const USER_ID = "recall-version-user";

class SqliteD1Statement {
  constructor(
    private readonly owner: SqliteD1,
    private readonly sql: string,
    private readonly values: unknown[] = [],
  ) {}

  bind(...values: unknown[]): SqliteD1Statement {
    return new SqliteD1Statement(this.owner, this.sql, values);
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

  prepare(sql: string): SqliteD1Statement {
    return new SqliteD1Statement(this, sql);
  }

  close(): void {
    this.sqlite.close();
  }
}

function vectorMatch(vectorId: string, entryId: string, episodeId: string, score: number) {
  return {
    id: vectorId,
    score,
    metadata: {
      parentId: entryId,
      episode_id: episodeId,
      owner_user_id: USER_ID,
      is_private: false,
      created_at: 100,
      tags: [],
    },
  };
}

describe("versioned and bitemporal recall", () => {
  let db: SqliteD1;
  let env: Env;
  let vectorQuery: any;
  let waits: Promise<unknown>[];
  let ctx: ExecutionContext;

  beforeEach(() => {
    db = new SqliteD1();
    vectorQuery = vi.fn().mockResolvedValue({ matches: [] });
    env = {
      DB: db as unknown as D1Database,
      VECTORIZE: makeVectorizeMock({ query: vectorQuery }),
      AI: makeAIMock(),
      OAUTH_KV: makeKVMock(),
      AUTH_TOKEN: "test-token",
    } as Env;
    waits = [];
    ctx = { waitUntil: (promise: Promise<unknown>) => { waits.push(promise); } } as ExecutionContext;
  });

  afterEach(async () => {
    await Promise.allSettled(waits);
    db.close();
  });

  function insertEntry(input: {
    id: string;
    content: string;
    episodeId: string;
    recordedAt: number;
    validFrom?: number | null;
    validTo?: number | null;
    tags?: string[];
    revision?: number;
    ownerUserId?: string;
    visibility?: "private" | "public";
  }): void {
    db.sqlite.prepare(
      `INSERT INTO entries (
         id, content, tags, source, created_at, vector_ids, owner_user_id,
         valid_from, valid_to, recorded_at, epistemic_status,
         current_episode_id, revision, visibility
       ) VALUES (?, ?, ?, 'api', 50, '[]', ?, ?, ?, ?, 'canonical', ?, ?, ?)`
    ).run(
      input.id,
      input.content,
      JSON.stringify(input.tags ?? []),
      input.ownerUserId ?? USER_ID,
      input.validFrom ?? 0,
      input.validTo ?? null,
      input.recordedAt,
      input.episodeId,
      input.revision ?? 2,
      input.visibility ?? "private",
    );
  }

  function insertSnapshot(input: {
    id: string;
    entryId: string;
    content: string;
    episodeId: string;
    recordedAt: number;
    validFrom?: number | null;
    validTo?: number | null;
    tags?: string[];
    revision?: number;
  }): void {
    db.sqlite.prepare(
      `INSERT INTO entry_snapshots (
         id, entry_id, content, tags, source, created_at, episode_id,
         mutation_kind, recorded_at, valid_from, valid_to,
         epistemic_status, revision
       ) VALUES (?, ?, ?, ?, 'api', ?, ?, 'update', ?, ?, ?, 'canonical', ?)`
    ).run(
      input.id,
      input.entryId,
      input.content,
      JSON.stringify(input.tags ?? []),
      input.recordedAt,
      input.episodeId,
      input.recordedAt,
      input.validFrom ?? 0,
      input.validTo ?? null,
      input.revision ?? 1,
    );
  }

  function insertPassage(input: {
    id: string;
    entryId: string;
    episodeId: string;
    content: string;
    createdAt?: number;
    documentId?: string | null;
    sectionId?: string | null;
    page?: number | null;
    pageEnd?: number | null;
  }): void {
    db.sqlite.prepare(
      `INSERT INTO passages (
         id, entry_id, episode_id, document_id, section_id, content,
         section, page, page_end, start_offset, end_offset, vector_ids, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'Evidence', ?, ?, 10, 20, '[]', ?)`
    ).run(
      input.id,
      input.entryId,
      input.episodeId,
      input.documentId ?? null,
      input.sectionId ?? null,
      input.content,
      input.page ?? null,
      input.pageEnd ?? null,
      input.createdAt ?? 100,
    );
  }

  async function recall(query: string, options: { knownAt?: number; asOf?: number; topK?: number } = {}) {
    return recallEntries(
      { query, topK: options.topK ?? 5, userId: USER_ID, knownAt: options.knownAt, asOf: options.asOf },
      env,
      ctx,
    );
  }

  it("excludes stale version-scoped vectors and passages from default recall", async () => {
    insertEntry({ id: "entry", content: "Current launch fact", episodeId: "episode-current", recordedAt: 300 });
    insertPassage({ id: "passage-old", entryId: "entry", episodeId: "episode-old", content: "Old evidence", createdAt: 200 });
    insertPassage({ id: "passage-current", entryId: "entry", episodeId: "episode-current", content: "Current evidence", createdAt: 100 });
    vectorQuery.mockResolvedValue({
      matches: [
        vectorMatch("old-vector", "entry", "episode-old", 0.99),
        vectorMatch("current-vector", "entry", "episode-current", 0.8),
      ],
    });

    const result = await recall("launch fact");

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].content).toBe("Current launch fact");
    expect(result.matches[0].passages?.map(passage => passage.id)).toEqual(["passage-current"]);
  });

  it("returns the selected historical snapshot and its episode passages for knownAt", async () => {
    insertEntry({ id: "entry", content: "Current replacement", episodeId: "episode-current", recordedAt: 300 });
    insertSnapshot({
      id: "snapshot-old",
      entryId: "entry",
      content: "Historical launch decision",
      episodeId: "episode-old",
      recordedAt: 100,
    });
    insertPassage({ id: "passage-old", entryId: "entry", episodeId: "episode-old", content: "Historical source evidence" });
    insertPassage({ id: "passage-current", entryId: "entry", episodeId: "episode-current", content: "Current source evidence" });
    vectorQuery.mockResolvedValue({
      matches: [
        vectorMatch("current-vector", "entry", "episode-current", 0.99),
        vectorMatch("old-vector", "entry", "episode-old", 0.8),
      ],
    });

    const result = await recall("historical launch", { knownAt: 200 });

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].content).toBe("Historical launch decision");
    expect(result.matches[0].passages?.map(passage => passage.id)).toEqual(["passage-old"]);
  });

  it("recalls a token-disjoint historical paraphrase while denying foreign lineage and private parents", async () => {
    insertEntry({
      id: "target",
      content: "Current release approach",
      episodeId: "episode-target-current",
      recordedAt: 300,
    });
    insertSnapshot({
      id: "target-old",
      entryId: "target",
      content: "Blue green deployment selected for production release",
      episodeId: "episode-target-old",
      recordedAt: 100,
    });
    insertPassage({
      id: "target-old-passage",
      entryId: "target",
      episodeId: "episode-target-old",
      content: "Historical traffic-shift evidence",
    });

    insertEntry({
      id: "foreign-lineage",
      content: "Different public memory",
      episodeId: "episode-foreign-current",
      recordedAt: 300,
    });
    insertSnapshot({
      id: "foreign-old",
      entryId: "foreign-lineage",
      content: "Unrelated historical state",
      episodeId: "episode-foreign-old",
      recordedAt: 100,
    });
    insertEntry({
      id: "private-parent",
      content: "Other user's private current state",
      episodeId: "episode-private-current",
      recordedAt: 300,
      ownerUserId: "other-user",
      visibility: "private",
    });
    insertSnapshot({
      id: "private-old",
      entryId: "private-parent",
      content: "Other user's private historical state",
      episodeId: "episode-private-old",
      recordedAt: 100,
    });
    vectorQuery.mockResolvedValue({
      matches: [
        // This real episode belongs to another entry and must not authorize a
        // forged parentId even though it has the strongest score.
        vectorMatch("wrong-entry-vector", "target", "episode-foreign-old", 0.99),
        // Hostile Vectorize metadata cannot expose another user's private row.
        vectorMatch("private-vector", "private-parent", "episode-private-old", 0.98),
        vectorMatch("historical-vector", "target", "episode-target-old", 0.8),
      ],
    });

    const result = await recall("switch traffic without downtime", { knownAt: 200 });

    expect(result.matches.map(match => match.id)).toEqual(["target"]);
    expect(result.matches[0].content).toBe("Blue green deployment selected for production release");
    expect(result.matches[0].passages?.map(passage => passage.id)).toEqual(["target-old-passage"]);
  });

  it("reconstructs current, valid-time, knowledge-time, and combined bitemporal views", async () => {
    insertEntry({
      id: "entry",
      content: "Current policy gamma",
      episodeId: "episode-current",
      recordedAt: 300,
      validFrom: 200,
      validTo: null,
      revision: 3,
    });
    insertSnapshot({
      id: "snapshot-initial",
      entryId: "entry",
      content: "Initial policy alpha",
      episodeId: "episode-initial",
      recordedAt: 100,
      validFrom: 0,
      validTo: null,
      revision: 1,
    });
    insertSnapshot({
      id: "snapshot-middle",
      entryId: "entry",
      content: "Middle policy beta",
      episodeId: "episode-middle",
      recordedAt: 200,
      validFrom: 100,
      validTo: 200,
      revision: 2,
    });
    vectorQuery.mockResolvedValue({
      matches: [
        vectorMatch("current-vector", "entry", "episode-current", 0.99),
        vectorMatch("middle-vector", "entry", "episode-middle", 0.9),
        vectorMatch("initial-vector", "entry", "episode-initial", 0.8),
      ],
    });

    const current = await recall("policy");
    const validTime = await recall("policy", { asOf: 150 });
    const knowledgeTime = await recall("policy", { knownAt: 150 });
    const bitemporal = await recall("policy", { asOf: 250, knownAt: 250 });

    expect(current.matches.map(match => match.content)).toEqual(["Current policy gamma"]);
    expect(validTime.matches.map(match => match.content)).toEqual(["Middle policy beta"]);
    expect(knowledgeTime.matches.map(match => match.content)).toEqual(["Initial policy alpha"]);
    // At transaction time 250 the current correction was not known yet. The
    // initial version was still believed to cover world time 250.
    expect(bitemporal.matches.map(match => match.content)).toEqual(["Initial policy alpha"]);

    const unchanged = db.sqlite.prepare(
      `SELECT recall_count, last_recalled_at FROM entries WHERE id = 'entry'`,
    ).get() as { recall_count: number; last_recalled_at: number | null };
    expect(unchanged).toEqual({ recall_count: 0, last_recalled_at: null });
    expect(db.sqlite.prepare(`SELECT COUNT(*) AS count FROM entry_snapshots`).get()).toEqual({ count: 2 });
  });

  it("combines knowledge time with the selected state's valid-time interval", async () => {
    insertEntry({ id: "entry", content: "Current policy", episodeId: "episode-current", recordedAt: 300 });
    insertSnapshot({
      id: "snapshot-old",
      entryId: "entry",
      content: "Historical policy",
      episodeId: "episode-old",
      recordedAt: 100,
      validFrom: 50,
      validTo: 150,
    });
    vectorQuery.mockResolvedValue({ matches: [vectorMatch("old-vector", "entry", "episode-old", 0.9)] });

    const validThen = await recall("historical policy", { knownAt: 200, asOf: 100 });
    const expiredThen = await recall("historical policy", { knownAt: 200, asOf: 175 });

    expect(validThen.matches.map(match => match.id)).toEqual(["entry"]);
    expect(expiredThen.matches).toEqual([]);
  });

  it("never crosses document, section, or episode boundaries while hydrating citations", async () => {
    insertEntry({ id: "entry", content: "Cited current fact", episodeId: "episode-current", recordedAt: 300 });
    db.sqlite.prepare(
      `INSERT INTO documents (id, title, source_url, content_type, created_at, episode_id, owner_user_id)
       VALUES ('doc-current', 'Current document', 'https://example.com/current', 'research', 100, 'episode-current', ?),
              ('doc-old', 'Old document', 'https://example.com/old', 'research', 90, 'episode-old', ?)`
    ).run(USER_ID, USER_ID);
    db.sqlite.prepare(
      `INSERT INTO document_sections (
         id, document_id, title, level, order_index, created_at,
         page_start, page_end, start_offset, end_offset
       ) VALUES ('section-current', 'doc-current', 'Current section', 1, 0, 100, 7, 8, 5, 25),
                ('section-old', 'doc-old', 'Old section', 1, 0, 90, 1, 2, 0, 15)`
    ).run();
    insertPassage({
      id: "valid-passage",
      entryId: "entry",
      episodeId: "episode-current",
      content: "Valid cited evidence",
      documentId: "doc-current",
      sectionId: "section-current",
      page: 7,
      pageEnd: 8,
    });
    insertPassage({ id: "old-passage", entryId: "entry", episodeId: "episode-old", content: "Old evidence", documentId: "doc-old", sectionId: "section-old" });
    insertPassage({ id: "wrong-document", entryId: "entry", episodeId: "episode-current", content: "Wrong document", documentId: "doc-old", sectionId: "section-old" });
    insertPassage({ id: "wrong-section", entryId: "entry", episodeId: "episode-current", content: "Wrong section", documentId: "doc-current", sectionId: "section-old" });
    vectorQuery.mockResolvedValue({ matches: [vectorMatch("current-vector", "entry", "episode-current", 0.9)] });

    const result = await recall("cited current");

    expect(result.matches[0].passages).toEqual([expect.objectContaining({
      id: "valid-passage",
      documentId: "doc-current",
      sectionId: "section-current",
      sourceUrl: "https://example.com/current",
      documentTitle: "Current document",
      page: 7,
      pageEnd: 8,
    })]);
  });

  it("cites the immutable episode when a conversational note has no passages", async () => {
    insertEntry({ id: "entry", content: "Current conversational fact", episodeId: "episode-current", recordedAt: 300 });
    db.sqlite.prepare(
      `INSERT INTO episodes (
         id, entry_id, content, content_type, source, created_at,
         materialized_content, mutation_kind, owner_user_id
       ) VALUES (
         'episode-current', 'entry', 'Exact conversational input', 'text',
         'api', 300, 'Current conversational fact', 'capture', ?
       )`,
    ).run(USER_ID);
    db.sqlite.prepare(
      `INSERT INTO documents (
         id, title, source_url, content_type, created_at, episode_id,
         owner_user_id
       ) VALUES (
         'doc-current', 'Conversation', NULL, 'text', 300,
         'episode-current', ?
       )`,
    ).run(USER_ID);
    vectorQuery.mockResolvedValue({ matches: [vectorMatch("current-vector", "entry", "episode-current", 0.9)] });

    const result = await recall("conversational fact");

    expect(result.matches[0].passages).toEqual([expect.objectContaining({
      id: "episode-current",
      content: "Exact conversational input",
      documentId: "doc-current",
      documentTitle: "Conversation",
      startOffset: 0,
      endOffset: 26,
    })]);
  });

  it("gives every result its own five-passage budget", async () => {
    insertEntry({ id: "entry-a", content: "Shared evidence alpha", episodeId: "episode-a", recordedAt: 300 });
    insertEntry({ id: "entry-b", content: "Shared evidence beta", episodeId: "episode-b", recordedAt: 300 });
    for (let index = 0; index < 6; index++) {
      insertPassage({ id: `a-${index}`, entryId: "entry-a", episodeId: "episode-a", content: `Alpha ${index}`, createdAt: 200 - index });
      insertPassage({ id: `b-${index}`, entryId: "entry-b", episodeId: "episode-b", content: `Beta ${index}`, createdAt: 200 - index });
    }
    vectorQuery.mockResolvedValue({
      matches: [
        vectorMatch("vector-a", "entry-a", "episode-a", 0.9),
        vectorMatch("vector-b", "entry-b", "episode-b", 0.8),
      ],
    });

    const result = await recall("shared evidence", { topK: 2 });

    expect(result.matches).toHaveLength(2);
    expect(result.matches.find(match => match.id === "entry-a")?.passages).toHaveLength(5);
    expect(result.matches.find(match => match.id === "entry-b")?.passages).toHaveLength(5);
  });
});
