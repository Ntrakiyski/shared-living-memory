/**
 * erasure-workerd-limit.test.ts
 *
 * E1/E3 + Section 9.1: the shared artifact collector must stay inside Workerd's
 * five-term compound-SELECT limit and must still delete every entry-owned child
 * artifact through the one shared erasure path.
 *
 * This runs against real SQLite with the compound-SELECT limit enforced, which
 * is the configuration the D1Mock-based suites could not reproduce.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SqliteD1,
  WORKERD_COMPOUND_SELECT_TERMS,
  countCompoundSelectTerms,
} from "../helpers/sqlite-d1";
import {
  collectEntryArtifactIds,
  eraseEntryArtifacts,
} from "../../src/erasure";
import { commitEntryVersion } from "../../src/entry-version-service";
import type { ActorContext, Env } from "../../src/types";

interface Harness {
  db: SqliteD1;
  env: Env;
  vectors: Map<string, unknown>;
}

function makeHarness(): Harness {
  const db = new SqliteD1({ maxCompoundSelectTerms: WORKERD_COMPOUND_SELECT_TERMS });
  const vectors = new Map<string, unknown>();
  const env = {
    DB: db as unknown as D1Database,
    AI: {
      run: vi.fn(async (_model: string, options: { text: string[] }) => ({
        data: [new Array(384).fill((options.text[0]?.length ?? 0) / 1000 + 0.01)],
      })),
    } as unknown as Ai,
    VECTORIZE: {
      upsert: vi.fn(async (items: { id: string }[]) => {
        for (const item of items) vectors.set(item.id, item);
        return { mutationId: "upsert" };
      }),
      deleteByIds: vi.fn(async (ids: string[]) => {
        for (const id of ids) vectors.delete(id);
        return { mutationId: "delete" };
      }),
      insert: vi.fn(),
      query: vi.fn(),
      getByIds: vi.fn(),
      describe: vi.fn(),
    } as unknown as VectorizeIndex,
    AUTH_TOKEN: "test-token",
    OAUTH_KV: {} as KVNamespace,
  } as Env;
  return { db, env, vectors };
}

const owner: ActorContext = {
  kind: "human",
  actorId: "user-owner",
  userId: "user-owner",
  role: "member",
  authMethod: "personal_api_key",
  scopes: new Set(),
};

const document = [
  "# Heading One",
  "",
  "Body paragraph with enough text to produce a passage.",
  "",
  "## Heading Two",
  "",
  "More body text for the second section.",
].join("\n");

async function captureDocument(harness: Harness, entryId: string, now: number) {
  return commitEntryVersion({
    kind: "capture",
    actorUserId: owner.actorId,
    entryId,
    rawContent: document,
    materializedContent: document,
    tags: ["work"],
    source: "api",
    now,
  }, harness.env);
}

describe("collectEntryArtifactIds under the Workerd compound-SELECT limit", () => {
  let harness: Harness;

  beforeEach(() => {
    harness = makeHarness();
  });

  afterEach(() => {
    harness.db.close();
  });

  it("stays within five compound SELECT terms", async () => {
    const created = await captureDocument(harness, "entry-a", 1_000);
    harness.db.executed.length = 0;

    await collectEntryArtifactIds({ DB: harness.db as unknown as D1Database }, "entry-a");

    const statements = harness.db.executed.filter((sql) => /\bUNION\b/i.test(sql));
    expect(statements).toHaveLength(1);
    expect(countCompoundSelectTerms(statements[0])).toBeLessThanOrEqual(WORKERD_COMPOUND_SELECT_TERMS);
    expect(created.entryId).toBe("entry-a");
  });

  it("reproduces the failure of the six-term shape at the same limit", async () => {
    const sixTerm = `SELECT id FROM entries WHERE id = ?
       UNION SELECT id FROM episodes WHERE entry_id = ?
       UNION SELECT id FROM entry_snapshots WHERE entry_id = ?
       UNION SELECT id FROM passages WHERE entry_id = ?
       UNION SELECT d.id FROM documents d WHERE d.episode_id IN (SELECT id FROM episodes WHERE entry_id = ?)
       UNION SELECT s.id FROM document_sections s WHERE s.document_id IN (SELECT id FROM documents WHERE episode_id = ?)`;
    expect(countCompoundSelectTerms(sixTerm)).toBe(6);

    const statement = harness.db.prepare(sixTerm).bind("a", "a", "a", "a", "a", "a");
    await expect(statement.all()).rejects.toThrow(/too many terms in compound SELECT/);
  });

  it("returns the entry itself plus every entry-owned child artifact", async () => {
    const first = await captureDocument(harness, "entry-a", 1_000);
    // A second version creates a snapshot of the first version.
    const second = await commitEntryVersion({
      kind: "update",
      actorUserId: owner.actorId,
      entryId: "entry-a",
      rawContent: `${document}\n\nAppended line.`,
      materializedContent: `${document}\n\nAppended line.`,
      now: 2_000,
    }, harness.env);

    const artifacts = await collectEntryArtifactIds(
      { DB: harness.db as unknown as D1Database },
      "entry-a",
    );

    expect(artifacts.has("entry-a")).toBe(true);
    expect(artifacts.has(first.episodeId)).toBe(true);
    expect(artifacts.has(second.episodeId)).toBe(true);
    expect(artifacts.has(second.snapshotId!)).toBe(true);
    expect(artifacts.has(second.documentId!)).toBe(true);
    for (const sectionId of second.sectionIds) expect(artifacts.has(sectionId)).toBe(true);
    for (const passageId of second.passageIds) expect(artifacts.has(passageId)).toBe(true);

    // The helper's own set matches the tables exactly.
    const childCount =
      harness.db.count("episodes")
      + harness.db.count("entry_snapshots")
      + harness.db.count("documents")
      + harness.db.count("document_sections")
      + harness.db.count("passages");
    expect(artifacts.size).toBe(childCount + 1);
  });

  it("erases every child artifact through the shared path and leaves other memories intact", async () => {
    await captureDocument(harness, "entry-a", 1_000);
    const other = await captureDocument(harness, "entry-b", 1_500);
    await commitEntryVersion({
      kind: "update",
      actorUserId: owner.actorId,
      entryId: "entry-a",
      rawContent: `${document}\n\nRevision two.`,
      materializedContent: `${document}\n\nRevision two.`,
      now: 2_000,
    }, harness.env);

    const artifacts = await collectEntryArtifactIds(
      { DB: harness.db as unknown as D1Database },
      "entry-a",
    );

    const result = await eraseEntryArtifacts("entry-a", owner, harness.env);
    expect(result.status).toBe("complete");

    const childTables = [
      "episodes",
      "entry_snapshots",
      "documents",
      "document_sections",
      "passages",
    ];
    for (const table of childTables) {
      const survivors = harness.db.all<{ id: string }>(`SELECT id FROM ${table}`)
        .map((row) => row.id)
        .filter((id) => artifacts.has(id) && id !== "entry-a");
      expect({ table, survivors }).toEqual({ table, survivors: [] });
    }
    expect(harness.db.count("episodes")).toBe(1);
    expect(harness.db.count("entry_snapshots")).toBe(0);
    expect(harness.db.one<{ count: number }>(
      "SELECT COUNT(*) AS count FROM entries WHERE id = 'entry-a'",
    ).count).toBe(0);

    // The unrelated memory and its artifacts survive untouched.
    expect(harness.db.one<{ count: number }>(
      "SELECT COUNT(*) AS count FROM entries WHERE id = 'entry-b'",
    ).count).toBe(1);
    expect(harness.db.one<{ count: number }>(
      "SELECT COUNT(*) AS count FROM episodes WHERE id = ?",
      other.episodeId,
    ).count).toBe(1);
  });

  it("returns not_found for an unknown entry instead of fabricating artifacts", async () => {
    const result = await eraseEntryArtifacts("missing-entry", owner, harness.env);
    expect(result.status).toBe("not_found");
    expect(harness.db.count("erasure_receipts")).toBe(0);
  });
});
