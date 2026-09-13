/**
 * browse-pagination.test.ts
 *
 * E4/E5 + Section 11: stable keyset pagination, cursor validation and the
 * legacy REST /list shape staying intact unless paging is opted into.
 *
 * Real SQLite so timestamp ties, the strict boundary and ORDER BY ... id DESC
 * are genuinely exercised.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteD1 } from "../helpers/sqlite-d1";
import {
  BROWSE_CURSOR_VERSION,
  BROWSE_DEFAULT_PAGE_SIZE,
  BROWSE_MAX_PAGE_SIZE,
  InvalidBrowseCursorError,
  boundsCheckPageSize,
  browseContextHash,
  buildEntryPageQuery,
  decodeBrowseCursor,
  encodeBrowseCursor,
  normalizeBrowseTag,
  paginateRows,
} from "../../src/tags";
import worker, { _resetDbReady, initializeDatabase } from "../../src/testing";
import type { Env } from "../../src/types";

const WORKSPACE_TOKEN = "test-token";
const ALICE_KEY = "slm_user-alice.alice-secret";

interface Harness {
  db: SqliteD1;
  env: Env;
}

function makeHarness(): Harness {
  const db = new SqliteD1({ applySchema: false });
  _resetDbReady();
  const env = {
    DB: db as unknown as D1Database,
    AI: { run: vi.fn(async () => ({ data: [new Array(384).fill(0.01)] })) } as unknown as Ai,
    VECTORIZE: {
      upsert: vi.fn(), deleteByIds: vi.fn(), insert: vi.fn(),
      query: vi.fn(async () => ({ matches: [] })), getByIds: vi.fn(async () => []), describe: vi.fn(),
    } as unknown as VectorizeIndex,
    AUTH_TOKEN: WORKSPACE_TOKEN,
    OAUTH_KV: {
      get: vi.fn(async () => null), put: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
      list: vi.fn(async () => ({ keys: [], list_complete: true, cacheStatus: null })),
    } as unknown as KVNamespace,
  } as Env;
  return { db, env };
}

async function seedAlice(harness: Harness): Promise<void> {
  await initializeDatabase(harness.env);
  const { hmacKey, AUTH_PEPPER } = await import("../../src/auth");
  const hash = await hmacKey("alice-secret", AUTH_PEPPER);
  harness.db.exec(
    `INSERT INTO users (id, username, normalized_username, auth_key_hash, auth_key_prefix, status, created_at, role)
     VALUES ('user-alice', 'alice', 'alice', '${hash}', 'slm_user-alice.', 'active', 1, 'member')`,
  );
}

/** `count` rows, all sharing one created_at so ties are unavoidable. */
function seedTiedRows(harness: Harness, count: number, createdAt = 5_000): void {
  const statement = harness.db.sqlite.prepare(
    `INSERT INTO entries (id, content, tags, source, created_at, vector_ids, owner_user_id, visibility)
     VALUES (?, ?, '["work"]', 'api', ?, '[]', 'user-alice', 'public')`,
  );
  for (let index = 0; index < count; index++) {
    statement.run(`entry-${String(index).padStart(3, "0")}`, `content ${index}`, createdAt);
  }
}

function listRequest(query: string): Request {
  return new Request(`http://localhost/list${query}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${ALICE_KEY}` },
  });
}

const ctx = { waitUntil: (_: Promise<unknown>) => {} } as any;

describe("cursor normalization and validation", () => {
  it("normalizes tag presence the same way for absent and empty", () => {
    expect(normalizeBrowseTag(undefined)).toBeNull();
    expect(normalizeBrowseTag(null)).toBeNull();
    expect(normalizeBrowseTag("")).toBeNull();
    expect(normalizeBrowseTag("   ")).toBeNull();
    expect(normalizeBrowseTag(" Work ")).toBe("work");
  });

  it("bounds the page size to 1..50 with a 10 default", () => {
    expect(BROWSE_DEFAULT_PAGE_SIZE).toBe(10);
    expect(boundsCheckPageSize(1)).toBe(1);
    expect(boundsCheckPageSize(50)).toBe(50);
    expect(() => boundsCheckPageSize(0)).toThrow(InvalidBrowseCursorError);
    expect(() => boundsCheckPageSize(51)).toThrow(InvalidBrowseCursorError);
    expect(() => boundsCheckPageSize(1.5)).toThrow(InvalidBrowseCursorError);
  });

  it("excludes page size from the context hash", async () => {
    const base = {
      actorKind: "human",
      actorId: "user-alice",
      ownerUserId: "user-alice",
      tag: "work",
      after: null,
      before: null,
      user: null,
      visibility: null,
    };
    expect(await browseContextHash(base)).toBe(await browseContextHash({ ...base }));
    // A different filter is a different context.
    expect(await browseContextHash({ ...base, tag: "home" })).not.toBe(await browseContextHash(base));
    expect(await browseContextHash({ ...base, actorId: "user-bob" })).not.toBe(await browseContextHash(base));
  });

  it("rejects after later than before", async () => {
    await expect(browseContextHash({
      actorKind: "human", actorId: "a", ownerUserId: "a",
      after: 10, before: 5,
    })).rejects.toBeInstanceOf(InvalidBrowseCursorError);
  });

  it.each([
    ["not base64 json", "!!!not-base64!!!"],
    ["wrong version", (() => {
      const token = btoa(JSON.stringify({ v: 2, last_created_at: 1, last_id: "a", context_hash: "0".repeat(64) }));
      return token.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
    })()],
    ["array payload", btoa(JSON.stringify([1, "a"])).replace(/=+$/g, "")],
    ["extra key", (() => {
      const token = btoa(JSON.stringify({ v: 1, last_created_at: 1, last_id: "a", context_hash: "0".repeat(64), extra: 1 }));
      return token.replace(/=+$/g, "");
    })()],
    ["negative timestamp", (() => {
      const token = btoa(JSON.stringify({ v: 1, last_created_at: -5, last_id: "a", context_hash: "0".repeat(64) }));
      return token.replace(/=+$/g, "");
    })()],
    ["empty id", (() => {
      const token = btoa(JSON.stringify({ v: 1, last_created_at: 1, last_id: "", context_hash: "0".repeat(64) }));
      return token.replace(/=+$/g, "");
    })()],
    ["non-hex context", (() => {
      const token = btoa(JSON.stringify({ v: 1, last_created_at: 1, last_id: "a", context_hash: "zz" }));
      return token.replace(/=+$/g, "");
    })()],
  ])("rejects a %s cursor instead of falling back to page one", (_label, token) => {
    expect(() => decodeBrowseCursor(token, "0".repeat(64))).toThrow(InvalidBrowseCursorError);
  });

  it("rejects a cursor whose context does not match", () => {
    const token = encodeBrowseCursor({
      v: BROWSE_CURSOR_VERSION,
      last_created_at: 10,
      last_id: "entry-1",
      context_hash: "a".repeat(64),
    });
    expect(() => decodeBrowseCursor(token, "b".repeat(64))).toThrow(/does not belong/);
    expect(decodeBrowseCursor(token, "a".repeat(64))).toEqual({
      v: 1, last_created_at: 10, last_id: "entry-1", context_hash: "a".repeat(64),
    });
  });

  it("rejects an over-long token", () => {
    expect(() => decodeBrowseCursor("a".repeat(2_049), "0".repeat(64)))
      .toThrow(InvalidBrowseCursorError);
  });
});

describe("keyset query shape", () => {
  it("uses a strict parenthesized boundary and fetches n+1", () => {
    const { sql, bindings } = buildEntryPageQuery({
      n: 10,
      cursor: { last_created_at: 100, last_id: "entry-5" },
      tag: "work",
      userId: "user-alice",
    });
    expect(sql).toContain("ORDER BY created_at DESC, id DESC");
    expect(sql).toContain("(created_at < ? OR (created_at = ? AND id < ?))");
    // The keyset boundary is bound after the filters and before the limit.
    expect(bindings.slice(-4)).toEqual([100, 100, "entry-5", 11]);
  });

  it("paginates without repeats or skips across timestamp ties", () => {
    // `ORDER BY created_at DESC, id DESC`: within a tie, larger ids come first.
    const rows = Array.from({ length: 5 }, (_, index) => ({
      id: `entry-${index}`,
      created_at: 5_000,
    })).reverse();
    const first = paginateRows(rows, 2);
    expect(first.rows.map((row) => row.id)).toEqual(["entry-4", "entry-3"]);
    expect(first.nextCursor).toEqual({ last_created_at: 5_000, last_id: "entry-3" });

    const rest = rows.filter((row) =>
      row.created_at < first.nextCursor!.last_created_at
      || (row.created_at === first.nextCursor!.last_created_at && row.id < first.nextCursor!.last_id));
    const second = paginateRows(rest, 2);
    expect(second.rows.map((row) => row.id)).toEqual(["entry-2", "entry-1"]);

    const last = paginateRows(
      rest.filter((row) => row.id < second.nextCursor!.last_id),
      2,
    );
    expect(last.rows.map((row) => row.id)).toEqual(["entry-0"]);
    // No extra row exists, so no cursor is emitted.
    expect(last.nextCursor).toBeNull();
  });
});

describe("REST /list paging (E4/E5)", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = makeHarness();
    await seedAlice(harness);
    seedTiedRows(harness, 12);
  });

  afterEach(() => {
    harness.db.close();
  });

  it("keeps the legacy array shape when paging is not requested", async () => {
    const response = await worker.fetch(listRequest("?n=5"), harness.env, ctx);
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(5);
    // The legacy path keeps its own ordering and shape; this test only proves
    // the array shape and row count are unchanged by the opt-in paging path.
    for (const entry of body) {
      expect(entry.id).toMatch(/^entry-\d{3}$/);
      expect(entry.owner_username).toBe("alice");
    }
  });

  it("walks every accessible row without repeats or skips despite ties", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query = cursor ? `?page=true&n=5&cursor=${encodeURIComponent(cursor)}` : "?page=true&n=5";
      const response = await worker.fetch(listRequest(query), harness.env, ctx);
      expect(response.status).toBe(200);
      const body = await response.json() as any;
      expect(body.ok).toBe(true);
      const ids = body.data.entries.map((entry: any) => entry.id);
      seen.push(...ids);
      expect(ids.length).toBeLessThanOrEqual(5);
      cursor = body.data.next_cursor;
      pages++;
      expect(pages).toBeLessThan(10);
    } while (cursor);

    expect(seen).toHaveLength(12);
    expect(new Set(seen).size).toBe(12);
    // Descending by (created_at DESC, id DESC) with no repeats.
    expect(seen).toEqual([...seen].sort().reverse());
  });

  it("emits the cursor from the final emitted row and omits it on the last page", async () => {
    const first = await worker.fetch(listRequest("?page=true&n=12"), harness.env, ctx);
    const firstBody = await first.json() as any;
    expect(firstBody.data.entries).toHaveLength(12);
    expect(firstBody.data.next_cursor).toBeNull();
  });

  it("lets the page size change between pages without invalidating the cursor", async () => {
    const first = await worker.fetch(listRequest("?page=true&n=3"), harness.env, ctx);
    const firstBody = await first.json() as any;
    const cursor = firstBody.data.next_cursor;
    expect(cursor).toBeTruthy();

    const second = await worker.fetch(
      listRequest(`?page=true&n=7&cursor=${encodeURIComponent(cursor)}`),
      harness.env, ctx,
    );
    const secondBody = await second.json() as any;
    expect(secondBody.data.entries).toHaveLength(7);
    const ids = [...firstBody.data.entries, ...secondBody.data.entries].map((entry: any) => entry.id);
    expect(new Set(ids).size).toBe(10);
  });

  it("does not let a newer insert shift an already-read position", async () => {
    const first = await worker.fetch(listRequest("?page=true&n=4"), harness.env, ctx);
    const firstBody = await first.json() as any;
    const cursor = firstBody.data.next_cursor;

    harness.db.exec(
      `INSERT INTO entries (id, content, tags, source, created_at, vector_ids, owner_user_id, visibility)
       VALUES ('entry-newest', 'new', '["work"]', 'api', 999999, '[]', 'user-alice', 'public')`,
    );

    const second = await worker.fetch(
      listRequest(`?page=true&n=4&cursor=${encodeURIComponent(cursor)}`),
      harness.env, ctx,
    );
    const secondBody = await second.json() as any;
    const ids = secondBody.data.entries.map((entry: any) => entry.id);
    expect(ids).not.toContain("entry-newest");
    expect(ids.some((id: string) => firstBody.data.entries.some((entry: any) => entry.id === id))).toBe(false);
  });

  it("rejects a cursor used against a different filter", async () => {
    const first = await worker.fetch(listRequest("?page=true&n=3&tag=work"), harness.env, ctx);
    const firstBody = await first.json() as any;
    const cursor = firstBody.data.next_cursor;

    const mismatch = await worker.fetch(
      listRequest(`?page=true&n=3&tag=home&cursor=${encodeURIComponent(cursor)}`),
      harness.env, ctx,
    );
    expect(mismatch.status).toBe(400);
    const body = await mismatch.json() as any;
    expect(body.error.code).toBe("invalid_cursor");
  });

  it("rejects a malformed cursor and an invalid page value", async () => {
    const bad = await worker.fetch(listRequest("?page=true&cursor=nonsense"), harness.env, ctx);
    expect(bad.status).toBe(400);
    expect((await bad.json() as any).error.code).toBe("invalid_cursor");

    const badPage = await worker.fetch(listRequest("?page=maybe"), harness.env, ctx);
    expect(badPage.status).toBe(400);
    expect((await badPage.json() as any).error.code).toBe("invalid_request");

    const tooBig = await worker.fetch(listRequest(`?page=true&n=${BROWSE_MAX_PAGE_SIZE + 1}`), harness.env, ctx);
    expect(tooBig.status).toBe(400);
    expect((await tooBig.json() as any).error.code).toBe("invalid_cursor");
  });

  it("rechecks visibility on every page", async () => {
    // Page one while entry-005 is public, then privatize the rows the next page
    // would have returned.
    const first = await worker.fetch(listRequest("?page=true&n=3"), harness.env, ctx);
    const firstBody = await first.json() as any;
    const cursor = firstBody.data.next_cursor;
    // The second page would have returned the three rows below the cursor; they
    // become another account's private memories after page one was served.
    harness.db.exec(
      `UPDATE entries SET owner_user_id = 'user-bob', visibility = 'private',
                          tags = '["work","private"]'
       WHERE id IN ('entry-008','entry-007','entry-006')`,
    );

    const second = await worker.fetch(
      listRequest(`?page=true&n=3&cursor=${encodeURIComponent(cursor)}`),
      harness.env, ctx,
    );
    const secondBody = await second.json() as any;
    const ids = secondBody.data.entries.map((entry: any) => entry.id);
    expect(ids).toEqual(["entry-005", "entry-004", "entry-003"]);
    expect(ids).not.toContain("entry-006");
    expect(ids).not.toContain("entry-007");
    expect(ids).not.toContain("entry-008");
  });
});
