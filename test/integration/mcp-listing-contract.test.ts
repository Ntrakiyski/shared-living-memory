/**
 * mcp-listing-contract.test.ts
 *
 * Sections 4.3/4.5 + E5: MCP list_recent returns a structured, descriptor-shaped,
 * byte-bounded, cursor-paged result while its readable text stays useful to
 * clients that negotiate the older protocol version.
 *
 * Real SQLite so the keyset ordering, the owner lookup and the tie-breaking are
 * genuinely exercised.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteD1 } from "../helpers/sqlite-d1";
import { buildMcpServer } from "../../src/mcp";
import {
  CONTENT_EXCERPT_MAX_BYTES,
  boundContentExcerpt,
  buildEntryDescriptor,
  entryPermissions,
  fitWithinBudget,
  lifecycleStatusFromTags,
  pageCounts,
  utf8Bytes,
} from "../../src/mcp-results";
import type { Env, HumanActorContext } from "../../src/types";

const ctx = { waitUntil: (_: Promise<unknown>) => {}, passThroughOnException: () => {} } as any;

interface Harness {
  db: SqliteD1;
  env: Env;
}

function makeHarness(): Harness {
  const db = new SqliteD1();
  db.exec(
    `INSERT INTO users (id, username, normalized_username, auth_key_hash, auth_key_prefix, status, created_at, role)
     VALUES ('user-alice', 'alice', 'alice', 'hash', 'p', 'active', 1, 'member')`,
  );
  db.exec(
    `INSERT INTO users (id, username, normalized_username, auth_key_hash, auth_key_prefix, status, created_at, role)
     VALUES ('user-bob', 'bob', 'bob', 'hash', 'p', 'active', 1, 'member')`,
  );
  const env = {
    DB: db as unknown as D1Database,
    AI: { run: vi.fn(async () => ({ data: [new Array(384).fill(0.01)] })) } as unknown as Ai,
    VECTORIZE: {
      upsert: vi.fn(), deleteByIds: vi.fn(), insert: vi.fn(),
      query: vi.fn(async () => ({ matches: [] })), getByIds: vi.fn(async () => []), describe: vi.fn(),
    } as unknown as VectorizeIndex,
    AUTH_TOKEN: "test-token",
    OAUTH_KV: {} as KVNamespace,
  } as Env;
  return { db, env };
}

const ALICE: HumanActorContext = {
  kind: "human",
  actorId: "user-alice",
  userId: "user-alice",
  role: "member",
  authMethod: "personal_api_key",
  scopes: new Set(),
};

function seedEntries(harness: Harness, count: number, content = "body"): void {
  const statement = harness.db.sqlite.prepare(
    `INSERT INTO entries (id, content, tags, source, created_at, vector_ids, owner_user_id,
                          visibility, revision, epistemic_status)
     VALUES (?, ?, '["work"]', 'api', 5000, '[]', 'user-alice', 'public', 3, 'candidate')`,
  );
  for (let index = 0; index < count; index++) {
    statement.run(`entry-${String(index).padStart(3, "0")}`, `${content} ${index}`);
  }
}

function listRecent(harness: Harness, input: Record<string, unknown> = {}) {
  const server = buildMcpServer(harness.env, ctx, ALICE, "full") as any;
  return server._registeredTools.list_recent.handler(input, {});
}

describe("entry descriptor contract", () => {
  it("derives permissions from the verified actor and the entry owner", () => {
    const owner = { actorId: "user-alice", ownerUserId: "user-alice", isService: false };
    expect(entryPermissions(owner, "user-alice")).toEqual({
      read_current: true,
      read_history: true,
      mutate_directly: true,
      // The owner does not propose to itself; it corrects directly.
      submit_change_proposal: false,
    });
    expect(entryPermissions(owner, "user-bob")).toEqual({
      read_current: true,
      read_history: false,
      mutate_directly: false,
      submit_change_proposal: true,
    });
    // A service never gains history on someone else's entry.
    expect(entryPermissions({ ...owner, isService: true }, "user-bob")).toMatchObject({
      read_history: false,
      mutate_directly: false,
      submit_change_proposal: true,
    });
  });

  it("reports lifecycle_status as null when no lifecycle tag exists", () => {
    expect(lifecycleStatusFromTags([])).toBeNull();
    expect(lifecycleStatusFromTags(["work", "kind:semantic"])).toBeNull();
    expect(lifecycleStatusFromTags(["status:canonical"])).toBe("canonical");
    expect(lifecycleStatusFromTags(["status:deprecated"])).toBe("deprecated");
    expect(lifecycleStatusFromTags(["status:bogus"])).toBeNull();
  });

  it("names every descriptor field explicitly and never uses a bare id", () => {
    const descriptor = buildEntryDescriptor({
      id: "entry-1",
      revision: 4,
      owner_user_id: "user-alice",
      visibility: "public",
      tags: '["work","status:draft"]',
      epistemic_status: "reviewed",
    }, "alice", { actorId: "user-alice", ownerUserId: "user-alice", isService: false });

    expect(Object.keys(descriptor).sort()).toEqual([
      "entry_id", "epistemic_status", "lifecycle_status", "owner", "permissions", "revision", "visibility",
    ]);
    expect(descriptor).toMatchObject({
      entry_id: "entry-1",
      revision: 4,
      owner: { id: "user-alice", username: "alice" },
      visibility: "public",
      lifecycle_status: "draft",
      epistemic_status: "reviewed",
    });
    expect(JSON.stringify(descriptor)).not.toContain('"id":"entry-1"');
  });

  it("tolerates malformed tags without inventing a lifecycle status", () => {
    const descriptor = buildEntryDescriptor({
      id: "e", revision: 0, owner_user_id: "user-alice",
      visibility: null, tags: "not-json", epistemic_status: null,
    }, "alice", { actorId: "user-alice", ownerUserId: "user-alice", isService: false });
    expect(descriptor.lifecycle_status).toBeNull();
    expect(descriptor.visibility).toBe("private");
    expect(descriptor.revision).toBe(0);
  });
});

describe("output bounds", () => {
  it("does not truncate content that already fits", () => {
    const excerpt = boundContentExcerpt("short body");
    expect(excerpt).toEqual({
      content: "short body",
      content_truncated: false,
      original_content_bytes: utf8Bytes("short body"),
    });
  });

  it("truncates at a complete code-point boundary and reports the original size", () => {
    // Four bytes per emoji: an odd byte budget must not split a surrogate pair.
    const content = "😀".repeat(2_000);
    const excerpt = boundContentExcerpt(content);
    expect(excerpt.content_truncated).toBe(true);
    expect(utf8Bytes(excerpt.content)).toBeLessThanOrEqual(CONTENT_EXCERPT_MAX_BYTES);
    expect(excerpt.original_content_bytes).toBe(utf8Bytes(content));
    // No lone surrogate survived.
    expect(excerpt.content).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect([...excerpt.content].every((character) => character === "😀")).toBe(true);
  });

  it("keeps a mixed multibyte excerpt valid", () => {
    const content = "a".repeat(1_000) + "日本語".repeat(500);
    const excerpt = boundContentExcerpt(content);
    expect(utf8Bytes(excerpt.content)).toBeLessThanOrEqual(CONTENT_EXCERPT_MAX_BYTES);
    expect(excerpt.original_content_bytes).toBe(utf8Bytes(content));
    // Round-trips as valid text.
    expect(new TextDecoder().decode(new TextEncoder().encode(excerpt.content))).toBe(excerpt.content);
  });

  it("never omits every row when trimming to the data budget", () => {
    const rows = Array.from({ length: 5 }, (_, index) => ({ entry_id: `e-${index}`, body: "x".repeat(400) }));
    const bounded = fitWithinBudget(rows, 900);
    expect(bounded.items.length).toBeGreaterThanOrEqual(1);
    expect(bounded.omitted).toBe(rows.length - bounded.items.length);
  });

  it("exercises the byte boundary rather than only the happy path", () => {
    for (const budget of [4_096, 8_192, 65_536]) {
      const rows = Array.from({ length: 50 }, (_, index) => ({ id: `e-${index}`, text: "y".repeat(40) }));
      const bounded = fitWithinBudget(rows, budget);
      expect(utf8Bytes(JSON.stringify(bounded.items))).toBeLessThanOrEqual(budget);
      expect(bounded.items.length).toBeGreaterThanOrEqual(1);
      expect(bounded.omitted).toBe(rows.length - bounded.items.length);
    }
    // A budget smaller than one descriptor still emits the row rather than an
    // empty page: silently dropping the only row would look like "no results".
    const floor = fitWithinBudget([{ id: "e", text: "y".repeat(40) }], 10);
    expect(floor.items).toHaveLength(1);
    expect(floor.omitted).toBe(0);
    expect(fitWithinBudget([], 100)).toEqual({ items: [], omitted: 0 });
    expect(pageCounts(3, 10)).toEqual({ returned: 3, total: 10, truncated: true });
    expect(pageCounts(10, 10)).toEqual({ returned: 10, total: 10, truncated: false });
  });
});

describe("MCP list_recent structured result (E5)", () => {
  let harness: Harness;

  beforeEach(() => {
    harness = makeHarness();
    seedEntries(harness, 12);
  });

  afterEach(() => {
    harness.db.close();
  });

  it("returns descriptors plus a next_cursor and readable text", async () => {
    const result = await listRecent(harness, { n: 5 });
    const data = result.structuredContent.data;
    expect(result.structuredContent.ok).toBe(true);
    expect(data.entries).toHaveLength(5);
    expect(data.next_cursor).toBeTruthy();

    const first = data.entries[0];
    expect(first.entry).toMatchObject({
      entry_id: "entry-011",
      revision: 3,
      owner: { id: "user-alice", username: "alice" },
      visibility: "public",
      lifecycle_status: null,
      epistemic_status: "candidate",
      permissions: {
        read_current: true,
        read_history: true,
        mutate_directly: true,
        submit_change_proposal: false,
      },
    });
    expect(first.content_truncated).toBe(false);
    expect(first.original_content_bytes).toBe(utf8Bytes(first.content));
    expect(typeof first.created_at).toBe("number");
    expect(result.content[0].text).toContain("entry-011");
    expect(result.content[0].text).toContain("next_cursor");
  });

  it("walks every row without repeats and stops with a null cursor", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const result = await listRecent(harness, cursor ? { n: 5, cursor } : { n: 5 });
      const data = result.structuredContent.data;
      seen.push(...data.entries.map((item: any) => item.entry.entry_id));
      cursor = data.next_cursor;
      pages++;
      expect(pages).toBeLessThan(10);
    } while (cursor);

    expect(seen).toHaveLength(12);
    expect(new Set(seen).size).toBe(12);
    expect(seen).toEqual([...seen].sort().reverse());
  });

  it("rejects a bad cursor as an explicit tool error instead of page one", async () => {
    const result = await listRecent(harness, { n: 5, cursor: "nonsense" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("invalid_cursor");
  });

  it("rejects a cursor from a different filter", async () => {
    const first = await listRecent(harness, { n: 3, tag: "work" });
    const cursor = first.structuredContent.data.next_cursor;
    const mismatch = await listRecent(harness, { n: 3, tag: "home", cursor });
    expect(mismatch.isError).toBe(true);
    expect(mismatch.content[0].text).toContain("invalid_cursor");
  });

  it("succeeds with an empty array rather than an error when nothing matches", async () => {
    const result = await listRecent(harness, { n: 5, tag: "absent-tag" });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.ok).toBe(true);
    expect(result.structuredContent.data.entries).toEqual([]);
    expect(result.structuredContent.data.next_cursor).toBeNull();
    expect(result.content[0].text).toBe("No entries found.");
  });

  it("truncates over-long content at the excerpt bound while keeping the row", async () => {
    harness.db.exec(
      `INSERT INTO entries (id, content, tags, source, created_at, vector_ids, owner_user_id, visibility)
       VALUES ('entry-huge', '${"😀".repeat(3_000)}', '[]', 'api', 99999, '[]', 'user-alice', 'public')`,
    );
    const result = await listRecent(harness, { n: 1 });
    const item = result.structuredContent.data.entries[0];
    expect(item.entry.entry_id).toBe("entry-huge");
    expect(item.content_truncated).toBe(true);
    expect(utf8Bytes(item.content)).toBeLessThanOrEqual(CONTENT_EXCERPT_MAX_BYTES);
    expect(item.original_content_bytes).toBe(utf8Bytes("😀".repeat(3_000)));
  });
});
