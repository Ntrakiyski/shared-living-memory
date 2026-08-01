import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  commitEntryVersion,
  EntryVersionCommitError,
  EntryVersionRevisionConflictError,
  EntryVersionVectorStageError,
} from "../../src/entry-version-service";
import type { Env } from "../../src/types";

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
    this.owner.executed.push(this.sql.replace(/\s+/g, " ").trim());
    const result = this.owner.sqlite
      .prepare(this.sql)
      .run(...this.values as SQLInputValue[]);
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  }

  async all<T = Record<string, unknown>>(): Promise<any> {
    const results = this.owner.sqlite
      .prepare(this.sql)
      .all(...this.values as SQLInputValue[]) as T[];
    return { success: true, results, meta: { changes: 0 } };
  }

  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    const row = this.owner.sqlite
      .prepare(this.sql)
      .get(...this.values as SQLInputValue[]) as Record<string, unknown> | undefined;
    if (!row) return null;
    return (column ? row[column] : row) as T;
  }
}

class SqliteD1 {
  readonly sqlite = new DatabaseSync(":memory:");
  readonly executed: string[] = [];
  beforeNextBatch: (() => void) | null = null;
  failBatchAt: number | null = null;

  constructor() {
    this.sqlite.exec(schema);
  }

  prepare(sql: string): SqliteStatement {
    return new SqliteStatement(this, sql);
  }

  async batch(statements: SqliteStatement[]): Promise<any[]> {
    const beforeBatch = this.beforeNextBatch;
    this.beforeNextBatch = null;
    beforeBatch?.();
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const results: any[] = [];
      for (let index = 0; index < statements.length; index++) {
        if (this.failBatchAt === index) throw new Error("injected batch failure");
        results.push(await statements[index].run());
      }
      this.failBatchAt = null;
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.failBatchAt = null;
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  count(table: string): number {
    return Number((this.sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count);
  }

  close(): void {
    this.sqlite.close();
  }
}

interface Harness {
  db: SqliteD1;
  env: Env;
  vectors: Map<string, unknown>;
  upsert: ReturnType<typeof vi.fn>;
  deleteByIds: ReturnType<typeof vi.fn>;
}

function makeHarness(): Harness {
  const db = new SqliteD1();
  const vectors = new Map<string, unknown>();
  const upsert = vi.fn(async (items: { id: string }[]) => {
    for (const item of items) vectors.set(item.id, item);
    return { mutationId: "upsert" };
  });
  const deleteByIds = vi.fn(async (ids: string[]) => {
    for (const id of ids) vectors.delete(id);
    return { mutationId: "delete" };
  });
  const env = {
    DB: db as unknown as D1Database,
    AI: {
      run: vi.fn(async (_model: string, options: { text: string[] }) => ({
        data: [new Array(384).fill((options.text[0]?.length ?? 0) / 1000 + 0.01)],
      })),
    } as unknown as Ai,
    VECTORIZE: {
      upsert,
      deleteByIds,
      insert: vi.fn(),
      query: vi.fn(),
      getByIds: vi.fn(),
      describe: vi.fn(),
    } as unknown as VectorizeIndex,
    AUTH_TOKEN: "test-token",
    OAUTH_KV: {} as KVNamespace,
  } as Env;
  return { db, env, vectors, upsert, deleteByIds };
}

function row<T>(db: SqliteD1, sql: string, ...values: SQLInputValue[]): T {
  return db.sqlite.prepare(sql).get(...values) as T;
}

function rows<T>(db: SqliteD1, sql: string, ...values: SQLInputValue[]): T[] {
  return db.sqlite.prepare(sql).all(...values) as T[];
}

const actorUserId = "user-alice";

async function capture(harness: Harness, overrides: Record<string, unknown> = {}) {
  return commitEntryVersion({
    kind: "capture",
    actorUserId,
    rawContent: "Original memory",
    materializedContent: "Original memory",
    tags: ["work"],
    source: "api",
    now: 1_000,
    ...overrides,
  }, harness.env);
}

describe("commitEntryVersion", () => {
  let harness: Harness;

  beforeEach(() => {
    harness = makeHarness();
  });

  afterEach(() => {
    harness.db.close();
  });

  it("atomically creates an entry and immutable episode with verbatim input", async () => {
    const verbatim = "  # Raw tag\n\nKeep   every space.  \n";
    const result = await capture(harness, {
      rawContent: verbatim,
      materializedContent: verbatim,
      entryId: "entry-exact",
      now: 1_234,
    });

    const entry = row<any>(harness.db, "SELECT * FROM entries WHERE id = ?", result.entryId);
    const episode = row<any>(harness.db, "SELECT * FROM episodes WHERE id = ?", result.episodeId);

    expect(result).toMatchObject({ created: true, revision: 1, snapshotId: null });
    expect(entry.content).toBe(verbatim);
    expect(entry.current_episode_id).toBe(result.episodeId);
    expect(entry.revision).toBe(1);
    expect(entry.created_by_user_id).toBe(actorUserId);
    expect(entry.visibility).toBe("private");
    expect(entry.vector_sync_pending).toBe(0);
    expect(entry.updated_at).toBe(1_234);
    expect(JSON.parse(entry.vector_ids)).toEqual(result.vectorIds);
    expect(episode.content).toBe(verbatim);
    expect(episode.materialized_content).toBe(verbatim);
    expect(episode.mutation_kind).toBe("capture");
    expect(episode.owner_user_id).toBe(actorUserId);
    const expectedHash = Array.from(new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verbatim)),
    )).map((byte) => byte.toString(16).padStart(2, "0")).join("");
    expect(episode.content_hash).toBe(expectedHash);
    const documents = rows<any>(harness.db, "SELECT * FROM documents WHERE episode_id = ?", result.episodeId);
    expect(documents).toHaveLength(1);
    expect(documents[0]).toMatchObject({
      id: result.documentId,
      episode_id: result.episodeId,
      owner_user_id: actorUserId,
      content_type: "text",
      content_hash: expectedHash,
      version: "1",
    });
    expect(harness.db.count("passages")).toBe(0);
    expect([...harness.vectors.keys()].every((id) => id.startsWith(`ev:${result.episodeId}:`))).toBe(true);
    expect([...harness.vectors.keys()].every((id) => new TextEncoder().encode(id).length <= 64)).toBe(true);
  });

  it("defaults new captures to private without using tags as the security decision", async () => {
    const omitted = await capture(harness, { tags: ["work"] });
    const explicitPublic = await capture(harness, {
      entryId: "entry-public",
      tags: ["private"],
      visibility: "public",
    });

    expect(row<any>(harness.db, "SELECT visibility FROM entries WHERE id = ?", omitted.entryId).visibility).toBe("private");
    expect(row<any>(harness.db, "SELECT visibility FROM entries WHERE id = ?", explicitPublic.entryId).visibility).toBe("public");
  });

  it("snapshots the complete prior visible state before a guarded update", async () => {
    const initial = await capture(harness, {
      tags: ["work", "private"],
      validFrom: 100,
      epistemicStatus: "reviewed",
    });
    const updated = await commitEntryVersion({
      kind: "update",
      actorUserId,
      entryId: initial.entryId,
      expectedRevision: 1,
      rawContent: "Edited phrase only",
      materializedContent: "Complete updated memory",
      tags: ["work"],
      source: "manual",
      validFrom: 200,
      validTo: 900,
      epistemicStatus: "qualified",
      now: 2_000,
    }, harness.env);

    const snapshot = row<any>(harness.db, "SELECT * FROM entry_snapshots WHERE id = ?", updated.snapshotId!);
    const entry = row<any>(harness.db, "SELECT * FROM entries WHERE id = ?", initial.entryId);
    const episode = row<any>(harness.db, "SELECT * FROM episodes WHERE id = ?", updated.episodeId);

    expect(snapshot).toMatchObject({
      content: "Original memory",
      tags: JSON.stringify(["work", "private"]),
      source: "api",
      episode_id: initial.episodeId,
      mutation_id: updated.mutationId,
      mutation_kind: "update",
      recorded_at: 1_000,
      valid_from: 100,
      valid_to: null,
      epistemic_status: "reviewed",
      revision: 1,
    });
    expect(entry).toMatchObject({
      content: "Complete updated memory",
      revision: 2,
      visibility: "private",
      updated_at: 2_000,
      vector_sync_pending: 0,
      valid_from: 200,
      valid_to: 900,
      epistemic_status: "qualified",
      current_episode_id: updated.episodeId,
    });
    expect(episode.content).toBe("Edited phrase only");
    expect(episode.materialized_content).toBe("Complete updated memory");
    expect(episode.parent_episode_id).toBe(initial.episodeId);
    const initialVectors = harness.upsert.mock.calls[0][0] as { metadata: { is_private: boolean } }[];
    const updatedVectors = harness.upsert.mock.calls[1][0] as { metadata: { is_private: boolean } }[];
    expect(initialVectors.every((vector) => vector.metadata.is_private)).toBe(true);
    // Removing the legacy tag is not an implicit publish operation.
    expect(updatedVectors.every((vector) => vector.metadata.is_private)).toBe(true);
  });

  it("cleans staged vectors and commits no artifacts after a late revision race", async () => {
    const initial = await capture(harness);
    const episodeCount = harness.db.count("episodes");
    const passageCount = harness.db.count("passages");
    const snapshotCount = harness.db.count("entry_snapshots");
    const oldVectorIds = new Set(harness.vectors.keys());

    harness.db.beforeNextBatch = () => {
      harness.db.sqlite.prepare("UPDATE entries SET revision = revision + 1 WHERE id = ?")
        .run(initial.entryId);
    };

    await expect(commitEntryVersion({
      kind: "update",
      actorUserId,
      entryId: initial.entryId,
      expectedRevision: 1,
      rawContent: "racing edit",
      materializedContent: "racing complete state",
      now: 2_000,
    }, harness.env)).rejects.toBeInstanceOf(EntryVersionRevisionConflictError);

    expect(harness.db.count("episodes")).toBe(episodeCount);
    expect(harness.db.count("passages")).toBe(passageCount);
    expect(harness.db.count("entry_snapshots")).toBe(snapshotCount);
    expect(harness.db.count("vector_cleanup_queue")).toBe(0);
    expect(new Set(harness.vectors.keys())).toEqual(oldVectorIds);
    const cleanupCall = harness.deleteByIds.mock.calls.at(-1)?.[0] as string[];
    expect(cleanupCall.every((id) => id.startsWith("ev:"))).toBe(true);
  });

  it("leaves D1 untouched when vector staging fails", async () => {
    harness.upsert.mockImplementationOnce(async (items: { id: string }[]) => {
      for (const item of items) harness.vectors.set(item.id, item);
      throw new Error("Vectorize unavailable");
    });

    await expect(capture(harness)).rejects.toBeInstanceOf(EntryVersionVectorStageError);

    expect(harness.db.count("entries")).toBe(0);
    expect(harness.db.count("episodes")).toBe(0);
    expect(harness.db.count("passages")).toBe(0);
    expect(harness.vectors.size).toBe(0);
    expect(harness.deleteByIds).toHaveBeenCalledTimes(1);
  });

  it("rolls D1 back and cleans every staged vector when the batch fails", async () => {
    harness.db.failBatchAt = 2;

    await expect(capture(harness, {
      contentType: "research",
      rawContent: "# One\nBody",
      materializedContent: "# One\nBody",
    })).rejects.toBeInstanceOf(EntryVersionCommitError);

    expect(harness.db.count("entries")).toBe(0);
    expect(harness.db.count("episodes")).toBe(0);
    expect(harness.db.count("documents")).toBe(0);
    expect(harness.db.count("document_sections")).toBe(0);
    expect(harness.db.count("passages")).toBe(0);
    expect(harness.vectors.size).toBe(0);
  });

  it("retains a durable cleanup queue item when stale-vector deletion fails", async () => {
    const initial = await capture(harness);
    const oldVectorIds = [...harness.vectors.keys()];
    harness.deleteByIds.mockRejectedValueOnce(new Error("delete outage"));

    const updated = await commitEntryVersion({
      kind: "replace",
      actorUserId,
      entryId: initial.entryId,
      expectedRevision: 1,
      rawContent: "Replacement input",
      materializedContent: "Replacement input",
      now: 2_000,
    }, harness.env);

    const queued = row<any>(harness.db, "SELECT * FROM vector_cleanup_queue WHERE id = ?", updated.cleanupQueueId!);
    expect(updated.cleanupPending).toBe(true);
    expect(JSON.parse(queued.vector_ids)).toEqual(oldVectorIds);
    expect(queued.reason).toContain(updated.mutationId);
    expect(queued.attempts).toBe(1);
    expect(queued.last_error).toBe("delete outage");
  });

  it("force-creates a restore with snapshot and episode lineage", async () => {
    const initial = await capture(harness);
    const update = await commitEntryVersion({
      kind: "update",
      actorUserId,
      entryId: initial.entryId,
      expectedRevision: 1,
      rawContent: "change",
      materializedContent: "Changed memory",
      now: 2_000,
    }, harness.env);
    const originalBefore = row<any>(harness.db, "SELECT * FROM entries WHERE id = ?", initial.entryId);

    const restored = await commitEntryVersion({
      kind: "restore",
      actorUserId,
      entryId: initial.entryId,
      forceCreate: true,
      restoredFromSnapshotId: update.snapshotId!,
      rawContent: "Original memory",
      materializedContent: "Original memory",
      source: "restore",
      now: 3_000,
    }, harness.env);

    const restoreEpisode = row<any>(harness.db, "SELECT * FROM episodes WHERE id = ?", restored.episodeId);
    const originalAfter = row<any>(harness.db, "SELECT * FROM entries WHERE id = ?", initial.entryId);
    expect(restored.created).toBe(true);
    expect(restored.entryId).not.toBe(initial.entryId);
    expect(restoreEpisode.restored_from_snapshot_id).toBe(update.snapshotId);
    expect(restoreEpisode.parent_episode_id).toBe(initial.episodeId);
    expect(restoreEpisode.owner_user_id).toBe(actorUserId);
    expect(originalAfter).toEqual(originalBefore);
  });

  it("creates an immutable baseline for a legacy entry using its original transaction time", async () => {
    harness.db.sqlite.prepare(
      `INSERT INTO entries (
         id, content, tags, source, created_at, vector_ids, owner_user_id,
         valid_from, recorded_at, epistemic_status, revision
       ) VALUES (?, ?, '[]', 'legacy-import', ?, '[]', ?, ?, ?, 'canonical', 0)`,
    ).run("legacy-entry", "Legacy exact state", 400, actorUserId, 300, 700);

    const result = await commitEntryVersion({
      kind: "update",
      actorUserId,
      entryId: "legacy-entry",
      expectedRevision: 0,
      rawContent: "legacy edit",
      materializedContent: "Modern state",
      now: 2_000,
    }, harness.env);

    const snapshot = row<any>(harness.db, "SELECT * FROM entry_snapshots WHERE id = ?", result.snapshotId!);
    const baseline = row<any>(harness.db, "SELECT * FROM episodes WHERE id = ?", snapshot.episode_id);
    const baselineDocuments = rows<any>(harness.db, "SELECT * FROM documents WHERE episode_id = ?", baseline.id);
    const episode = row<any>(harness.db, "SELECT * FROM episodes WHERE id = ?", result.episodeId);
    expect(baseline).toMatchObject({
      content: "Legacy exact state",
      materialized_content: "Legacy exact state",
      mutation_kind: "legacy",
      created_at: 700,
      owner_user_id: actorUserId,
    });
    expect(baselineDocuments).toHaveLength(1);
    expect(baselineDocuments[0]).toMatchObject({
      owner_user_id: actorUserId,
      content_type: "text",
      content_hash: baseline.content_hash,
      version: "0",
    });
    expect(episode.parent_episode_id).toBe(baseline.id);
  });

  it("links a research document, nested sections, passages, offsets, and pages to one episode", async () => {
    const content = "Preamble\n\n# Vision\nAlpha\n## Detail\nBeta\n# Next\nGamma";
    const result = await capture(harness, {
      rawContent: content,
      materializedContent: content,
      contentType: "research",
      sourceUrl: "https://example.test/research",
      page: 4,
      pageEnd: 6,
    });

    const documents = rows<any>(harness.db, "SELECT * FROM documents WHERE episode_id = ?", result.episodeId);
    const sections = rows<any>(harness.db, "SELECT * FROM document_sections WHERE document_id = ? ORDER BY order_index", result.documentId!);
    const passages = rows<any>(harness.db, "SELECT * FROM passages WHERE episode_id = ? ORDER BY start_offset", result.episodeId);

    expect(documents).toHaveLength(1);
    expect(documents[0]).toMatchObject({
      id: result.documentId,
      source_url: "https://example.test/research",
      owner_user_id: actorUserId,
      version: "1",
    });
    expect(sections.map((section) => section.title)).toEqual(["Vision", "Detail", "Next"]);
    expect(sections[1].parent_section_id).toBe(sections[0].id);
    expect(sections[2].parent_section_id).toBeNull();
    expect(sections.every((section) => section.page_start === 4 && section.page_end === 6)).toBe(true);
    expect(sections.every((section) => content.slice(section.start_offset, section.end_offset).startsWith("#"))).toBe(true);
    expect(passages[0]).toMatchObject({
      content: "Preamble\n\n",
      document_id: result.documentId,
      section_id: null,
      page: 4,
      page_end: 6,
      start_offset: 0,
      end_offset: 10,
    });
    expect(passages.slice(1).every((passage) => passage.document_id === result.documentId)).toBe(true);
    expect(passages.slice(1).every((passage) => passage.section_id !== null)).toBe(true);
    expect(passages.every((passage) => content.slice(passage.start_offset, passage.end_offset) === passage.content)).toBe(true);
    expect([...harness.vectors.keys()].every((id) => new TextEncoder().encode(id).length <= 64)).toBe(true);
  });

  it("retains historical document passage vectors while replacing only the entry projection", async () => {
    const initial = await capture(harness, {
      rawContent: "# Evidence\nFirst version",
      materializedContent: "# Evidence\nFirst version",
      contentType: "research",
    });
    const historicalPassageIds = rows<{ vector_ids: string }>(
      harness.db,
      "SELECT vector_ids FROM passages WHERE episode_id = ?",
      initial.episodeId,
    ).flatMap((passage) => JSON.parse(passage.vector_ids) as string[]);

    await commitEntryVersion({
      kind: "update",
      actorUserId,
      entryId: initial.entryId,
      expectedRevision: 1,
      rawContent: "Second version input",
      materializedContent: "# Evidence\nSecond version",
      contentType: "research",
      now: 2_000,
    }, harness.env);

    expect(harness.deleteByIds).toHaveBeenLastCalledWith(initial.vectorIds);
    expect(historicalPassageIds.every((id) => harness.vectors.has(id))).toBe(true);
  });

  it("keeps research citations current across a metadata-only status mutation", async () => {
    const content = "# Findings\nEvidence\n## Method\nDetails";
    const initial = await capture(harness, {
      rawContent: content,
      materializedContent: content,
      contentType: "research",
      sourceUrl: "https://example.test/paper",
      title: "Team Research Paper",
      page: 8,
      pageEnd: 9,
    });

    const status = await commitEntryVersion({
      kind: "status",
      actorUserId,
      entryId: initial.entryId,
      expectedRevision: 1,
      rawContent: "status:reviewed",
      materializedContent: content,
      tags: ["status:reviewed"],
      epistemicStatus: "reviewed",
      now: 2_000,
      // Intentionally omit contentType/sourceUrl/title/page. Metadata-only
      // writes must inherit the cited research projection.
    }, harness.env);

    const entry = row<any>(harness.db, "SELECT * FROM entries WHERE id = ?", initial.entryId);
    const episode = row<any>(harness.db, "SELECT * FROM episodes WHERE id = ?", status.episodeId);
    const documents = rows<any>(harness.db, "SELECT * FROM documents WHERE episode_id = ?", status.episodeId);
    const sections = rows<any>(
      harness.db,
      "SELECT * FROM document_sections WHERE document_id = ? ORDER BY order_index",
      status.documentId!,
    );
    const passages = rows<any>(
      harness.db,
      "SELECT * FROM passages WHERE episode_id = ? ORDER BY start_offset",
      status.episodeId,
    );

    expect(entry.current_episode_id).toBe(status.episodeId);
    expect(episode).toMatchObject({
      mutation_kind: "status",
      content_type: "research",
      source_url: "https://example.test/paper",
      materialized_content: content,
    });
    expect(documents).toHaveLength(1);
    expect(documents[0]).toMatchObject({
      id: status.documentId,
      title: "Team Research Paper",
      source_url: "https://example.test/paper",
      episode_id: status.episodeId,
    });
    expect(sections.map((section) => section.title)).toEqual(["Findings", "Method"]);
    expect(sections[1].parent_section_id).toBe(sections[0].id);
    expect(passages).toHaveLength(2);
    expect(passages.every((passage) => passage.document_id === status.documentId)).toBe(true);
    expect(passages.every((passage) => passage.section_id !== null)).toBe(true);
    expect(passages.every((passage) => passage.page === 8 && passage.page_end === 9)).toBe(true);
  });

  it("refreshes a derived title on full replacement but preserves explicit provenance on append", async () => {
    const initialContent = "# Alice confidential planning title\n\nPrivate draft";
    const initial = await capture(harness, {
      rawContent: initialContent,
      materializedContent: initialContent,
      contentType: "research",
    });
    expect(row<any>(
      harness.db,
      "SELECT title FROM documents WHERE episode_id = ?",
      initial.episodeId,
    ).title).toBe("Alice confidential planning title");

    const replacementContent = "# Harmless team note\n\nSafe current text";
    const updated = await commitEntryVersion({
      kind: "update",
      actorUserId,
      entryId: initial.entryId,
      expectedRevision: 1,
      rawContent: replacementContent,
      materializedContent: replacementContent,
      now: 2_000,
    }, harness.env);
    expect(row<any>(
      harness.db,
      "SELECT title FROM documents WHERE episode_id = ?",
      updated.episodeId,
    ).title).toBe("Harmless team note");

    const explicitlyTitled = await commitEntryVersion({
      kind: "replace",
      actorUserId,
      entryId: initial.entryId,
      expectedRevision: 2,
      rawContent: "Replacement without a heading",
      materializedContent: "Replacement without a heading",
      title: "Approved source title",
      now: 3_000,
    }, harness.env);
    expect(row<any>(
      harness.db,
      "SELECT title FROM documents WHERE episode_id = ?",
      explicitlyTitled.episodeId,
    ).title).toBe("Approved source title");

    const appended = await commitEntryVersion({
      kind: "append",
      actorUserId,
      entryId: initial.entryId,
      expectedRevision: 3,
      rawContent: "# Incidental append heading\nExtra detail",
      materializedContent: "Replacement without a heading\n\n# Incidental append heading\nExtra detail",
      now: 4_000,
    }, harness.env);
    expect(row<any>(
      harness.db,
      "SELECT title FROM documents WHERE episode_id = ?",
      appended.episodeId,
    ).title).toBe("Approved source title");
  });

  it("preserves an explicit title across titleless update, merge, and replace mutations", async () => {
    for (const [index, kind] of (["update", "merge", "replace"] as const).entries()) {
      const initialContent = `# Generated heading ${kind}\n\nOriginal body`;
      const initial = await capture(harness, {
        entryId: `explicit-${kind}`,
        rawContent: initialContent,
        materializedContent: initialContent,
        contentType: "research",
        title: `Explicit provenance title ${kind}`,
        now: 10_000 + index * 100,
      });
      const replacementContent = `# Replacement heading ${kind}\n\nNew body`;
      const replacement = await commitEntryVersion({
        kind,
        actorUserId,
        entryId: initial.entryId,
        expectedRevision: 1,
        rawContent: replacementContent,
        materializedContent: replacementContent,
        now: 10_050 + index * 100,
      }, harness.env);

      expect(row<any>(
        harness.db,
        "SELECT title FROM documents WHERE episode_id = ?",
        replacement.episodeId,
      ).title).toBe(`Explicit provenance title ${kind}`);
    }
  });
});
