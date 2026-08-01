import { describe, it, expect, beforeEach, vi } from "vitest";
import worker, { captureEntry } from "../../src/testing";
import { makeTestEnv, makeTestDb, makeVectorizeMock, makeKVMock } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import type { Env } from "../../src/testing";
import { D1Mock } from "../helpers/d1-mock";
import { TEST_USER_ID } from "../helpers/test-principal";

const ctx = { waitUntil: (_: Promise<any>) => {} } as any;

function makeMatch(id: string, score: number, overrides: Record<string, any> = {}) {
  return { id, score, metadata: { parentId: id, isUpdate: false, ...overrides } };
}

function makeContradictionAI(response: string): Ai {
  return {
    run: vi.fn().mockImplementation(async (model: string) => {
      if (model === "@cf/baai/bge-small-en-v1.5") return { data: [new Array(384).fill(0.1)] };
      return new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(`data: {"response":${JSON.stringify(response)}}\n\n`));
          c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
          c.close();
        },
      });
    }),
  } as unknown as Ai;
}

describe("Bitemporal facts (Ticket 05)", () => {
  let env: Env;
  let db: D1Mock;

  beforeEach(() => {
    db = makeTestDb();
    env = makeTestEnv(db);
  });

  it("new entries anchor valid time and knowledge time to their atomic first version", async () => {
    const res = await worker.fetch(
      req("POST", "/capture", { body: { content: "Test temporal entry" } }),
      env, ctx
    );
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);

    const entry = db.entries.find((e: any) => e.id === data.id);
    expect(entry).toBeDefined();
    expect(entry!.valid_from).toBe(entry!.created_at);
    expect(entry!.recorded_at).toBe(entry!.created_at);
    expect(entry!.valid_to).toBeNull();
    expect(entry!.revision).toBe(1);
    expect(entry!.current_episode_id).toEqual(expect.any(String));
    const episode = db.episodes.find((row: any) => row.id === entry!.current_episode_id);
    expect(episode).toMatchObject({
      entry_id: data.id,
      content: "Test temporal entry",
      materialized_content: "Test temporal entry",
      mutation_kind: "capture",
      created_at: entry!.recorded_at,
    });
  });

  it("a semantic contradiction does not infer temporal supersession", async () => {
    const createdAt = Date.now() - 1_000;
    db.entries.push({
      id: "incumbent",
      content: "I live in NYC",
      tags: "[]",
      source: "api",
      created_at: createdAt,
      vector_ids: '["incumbent-vector"]',
      recall_count: 0,
      importance_score: 0,
      contradiction_wins: 0,
      contradiction_losses: 0,
      owner_user_id: TEST_USER_ID,
      valid_from: createdAt,
      valid_to: null,
      recorded_at: createdAt,
      epistemic_status: "candidate",
      revision: 0,
      current_episode_id: null,
      visibility: "public",
    });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [makeMatch("incumbent", 0.72)],
        }),
      }),
      AI: makeContradictionAI(
        '{"contradicts":true,"conflicting_id":"incumbent","reason":"different city"}',
      ),
    });

    const result = await captureEntry(
      "I moved to LA",
      [],
      "api",
      env,
      ctx,
      TEST_USER_ID,
      { visibility: "public" },
    );

    expect(result.status).toBe("contradiction");
    if (result.status !== "contradiction") return;
    const incumbent = db.entries.find((entry: any) => entry.id === "incumbent");
    const candidate = db.entries.find((entry: any) => entry.id === result.id);
    expect(incumbent.valid_to).toBeNull();
    expect(candidate.valid_to).toBeNull();
    expect(JSON.parse(incumbent.tags)).not.toContain("status:deprecated");
    expect(JSON.parse(candidate.tags)).toEqual(
      expect.arrayContaining(["status:draft", "contradiction-candidate"]),
    );
  });

  it("as_of filter excludes entries whose valid_from is after the query timestamp", async () => {
    const now = Date.now();
    const SYSTEM_USER_ID = "sys-user-1";

    db.users.push({
      id: SYSTEM_USER_ID, username: "_system", normalized_username: "_system",
      auth_key_hash: "", auth_key_prefix: "", status: "active", created_at: now,
    });

    // Entry valid from now+1hour (in the future) — should be excluded
    db.entries.push({
      id: "future-entry", content: "Future fact", tags: "[]", source: "api",
      created_at: now - 100000, vector_ids: "[]", recall_count: 0, importance_score: 0,
      contradiction_wins: 0, contradiction_losses: 0, owner_user_id: SYSTEM_USER_ID,
      valid_from: now + 3600000, valid_to: null, recorded_at: now - 100000,
      epistemic_status: "canonical",
    });
    // Entry valid from the past — should be included
    db.entries.push({
      id: "past-entry", content: "Past fact", tags: "[]", source: "api",
      created_at: now - 200000, vector_ids: "[]", recall_count: 0, importance_score: 0,
      contradiction_wins: 0, contradiction_losses: 0, owner_user_id: SYSTEM_USER_ID,
      valid_from: now - 200000, valid_to: null, recorded_at: now - 200000,
      epistemic_status: "canonical",
    });

    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [
            makeMatch("future-entry", 0.9),
            makeMatch("past-entry", 0.8),
          ],
        }),
      }),
    });

    const res = await worker.fetch(
      req("GET", `/recall?query=test&as_of=${now}`),
      env, ctx
    );
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    // Only the past-entry should be returned (future-entry's valid_from > as_of)
    const ids = data.results.map((r: any) => r.id);
    expect(ids).toContain("past-entry");
    expect(ids).not.toContain("future-entry");
  });

  it("as_of filter excludes entries whose valid_to is before the query timestamp", async () => {
    const now = Date.now();
    const SYSTEM_USER_ID = "sys-user-2";

    db.users.push({
      id: SYSTEM_USER_ID, username: "_system", normalized_username: "_system",
      auth_key_hash: "", auth_key_prefix: "", status: "active", created_at: now,
    });

    // Entry already expired (valid_to in the past) — should be excluded
    db.entries.push({
      id: "expired-entry", content: "Expired fact", tags: "[]", source: "api",
      created_at: now - 200000, vector_ids: "[]", recall_count: 0, importance_score: 0,
      contradiction_wins: 0, contradiction_losses: 0, owner_user_id: SYSTEM_USER_ID,
      valid_from: now - 200000, valid_to: now - 100000, recorded_at: now - 200000,
      epistemic_status: "stale",
    });
    // Entry still valid — should be included
    db.entries.push({
      id: "current-entry", content: "Current fact", tags: "[]", source: "api",
      created_at: now - 200000, vector_ids: "[]", recall_count: 0, importance_score: 0,
      contradiction_wins: 0, contradiction_losses: 0, owner_user_id: SYSTEM_USER_ID,
      valid_from: now - 200000, valid_to: null, recorded_at: now - 200000,
      epistemic_status: "canonical",
    });

    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [
            makeMatch("expired-entry", 0.9),
            makeMatch("current-entry", 0.8),
          ],
        }),
      }),
    });

    const res = await worker.fetch(
      req("GET", `/recall?query=test&as_of=${now}`),
      env, ctx
    );
    const data = await res.json() as any;
    const ids = data.results.map((r: any) => r.id);
    expect(ids).toContain("current-entry");
    expect(ids).not.toContain("expired-entry");
  });

  it("entries with NULL temporal columns are treated as currently valid", async () => {
    const now = Date.now();
    const SYSTEM_USER_ID = "sys-user-3";

    db.users.push({
      id: SYSTEM_USER_ID, username: "_system", normalized_username: "_system",
      auth_key_hash: "", auth_key_prefix: "", status: "active", created_at: now,
    });

    // Pre-migration entry with no temporal columns set
    db.entries.push({
      id: "legacy-entry", content: "Legacy fact", tags: "[]", source: "api",
      created_at: now - 100000, vector_ids: "[]", recall_count: 0, importance_score: 0,
      contradiction_wins: 0, contradiction_losses: 0, owner_user_id: SYSTEM_USER_ID,
    });

    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [makeMatch("legacy-entry", 0.9)],
        }),
      }),
    });

    const res = await worker.fetch(
      req("GET", `/recall?query=test&as_of=${now}`),
      env, ctx
    );
    const data = await res.json() as any;
    expect(data.results).toHaveLength(1);
    expect(data.results[0].id).toBe("legacy-entry");
  });
});
