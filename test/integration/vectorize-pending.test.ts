import { describe, it, expect, beforeEach, vi } from "vitest";
import worker from "../../src/testing";
import { makeTestEnv, makeTestDb, makeVectorizeMock } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import type { Env } from "../../src/testing";
import { D1Mock } from "../helpers/d1-mock";
import { TEST_USER_ID } from "../helpers/test-principal";

const ctx = { waitUntil: (_: Promise<any>) => {} } as any;

function pastGraceEntry(id: string) {
  return {
    id,
    content: `Content for ${id}`,
    tags: '["work"]',
    source: "api",
    created_at: Date.now() - 600000, // 10 minutes ago — past default 5-min grace
    vector_ids: "[]",
    recall_count: 0,
    importance_score: 0,
    owner_user_id: TEST_USER_ID,
    visibility: "public",
    current_episode_id: `episode-${id}`,
    revision: 1,
  };
}

function seedPastGraceEntry(db: D1Mock, id: string) {
  db.entries.push(pastGraceEntry(id));
  db.episodes.push({
    id: `episode-${id}`,
    entry_id: id,
    mutation_id: `mutation-${id}`,
    materialized_content: `Content for ${id}`,
  });
}

describe("POST /vectorize-pending", () => {
  let env: Env;
  let db: D1Mock;

  beforeEach(() => {
    db = makeTestDb();
    env = makeTestEnv(db);
  });

  it("returns 401 without auth", async () => {
    const res = await worker.fetch(req("POST", "/vectorize-pending", { token: null }), env, ctx);
    expect(res.status).toBe(401);
  });

  it("returns { processed: 0, failed: 0, remaining: 0 } when no past-grace entries", async () => {
    const res = await worker.fetch(req("POST", "/vectorize-pending"), env, ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.processed).toBe(0);
    expect(data.failed).toBe(0);
    expect(data.remaining).toBe(0);
  });

  it("processes past-grace entries and returns correct counts", async () => {
    seedPastGraceEntry(db, "e1");
    seedPastGraceEntry(db, "e2");
    const res = await worker.fetch(req("POST", "/vectorize-pending"), env, ctx);
    const data = await res.json() as any;
    expect(data.processed).toBe(2);
    expect(data.failed).toBe(0);
    expect(data.remaining).toBe(0);
  });

  it("updates vector_ids in D1 after successful re-embed", async () => {
    db.entries.push(pastGraceEntry("fix-me"));
    db.episodes.push({ id: "episode-fix-me", entry_id: "fix-me", mutation_id: "mutation-fix-me", materialized_content: "Content for fix-me" });
    db.passages.push({
      id: "passage-fix-me", entry_id: "fix-me", episode_id: "episode-fix-me",
      content: "Evidence for fix-me", section: null, vector_ids: "[]",
    });
    await worker.fetch(req("POST", "/vectorize-pending"), env, ctx);
    const updated = db.entries.find((e: any) => e.id === "fix-me");
    const ids = JSON.parse(updated.vector_ids);
    expect(ids).toEqual(["ev:episode-fix-me:0"]);
    expect(JSON.parse(db.passages[0].vector_ids)).toEqual(["pv:passage-fix-me"]);
  });

  it("fails a pending legacy row closed instead of writing a legacy entry-only vector", async () => {
    const upsert = vi.fn();
    env = makeTestEnv(db, { VECTORIZE: makeVectorizeMock({ upsert }) });
    db.entries.push({ ...pastGraceEntry("legacy-pending"), current_episode_id: null });

    const res = await worker.fetch(req("POST", "/vectorize-pending"), env, ctx);
    const data = await res.json() as any;

    // The ordinary recovery batch is resumable: it reports item failures in a
    // 200 response so the browser can consume successes and retry remaining
    // rows. Only the explicit administrative full reindex is fail-fast/non-2xx.
    expect(res.status).toBe(200);
    expect(data).toMatchObject({ processed: 0, failed: 1, remaining: 1 });
    expect(upsert).not.toHaveBeenCalled();
    expect(db.entries[0].vector_ids).toBe("[]");
  });

  it("skips entries within the grace window (vector_ids=[] but recent)", async () => {
    db.entries.push({
      id: "pending",
      content: "Just captured",
      tags: "[]",
      source: "api",
      created_at: Date.now(), // within grace window
      vector_ids: "[]",
      recall_count: 0,
      importance_score: 0,
      owner_user_id: TEST_USER_ID,
    });
    const res = await worker.fetch(req("POST", "/vectorize-pending"), env, ctx);
    const data = await res.json() as any;
    expect(data.processed).toBe(0);
    expect(data.remaining).toBe(0);
  });

  it("skips entries that already have vector_ids populated", async () => {
    db.entries.push({
      id: "already-done",
      content: "Already vectorized",
      tags: "[]",
      source: "api",
      created_at: Date.now() - 600000,
      vector_ids: '["already-done"]',
      recall_count: 0,
      importance_score: 0,
      owner_user_id: TEST_USER_ID,
    });
    const res = await worker.fetch(req("POST", "/vectorize-pending"), env, ctx);
    const data = await res.json() as any;
    expect(data.processed).toBe(0);
  });

  it("counts failed and continues when canonical vector staging throws for one entry", async () => {
    seedPastGraceEntry(db, "bad");
    seedPastGraceEntry(db, "good");
    let callCount = 0;
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        upsert: vi.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 1) throw new Error("Vectorize error");
          return Promise.resolve({ mutationId: "m" });
        }),
      }),
    });
    const res = await worker.fetch(req("POST", "/vectorize-pending"), env, ctx);
    const data = await res.json() as any;
    expect(data.processed).toBe(1);
    expect(data.failed).toBe(1);
    expect(data.remaining).toBe(1);
  });

  it("respects VECTORIZE_GRACE_MS env var", async () => {
    // entry 90s old — past 60s grace but within default 300s
    db.entries.push({
      id: "e90",
      content: "90-second-old memory",
      tags: "[]",
      source: "api",
      created_at: Date.now() - 90000,
      vector_ids: "[]",
      recall_count: 0,
      importance_score: 0,
      owner_user_id: TEST_USER_ID,
      visibility: "public",
      current_episode_id: "episode-e90",
      revision: 1,
    });
    db.episodes.push({ id: "episode-e90", entry_id: "e90", mutation_id: "mutation-e90", materialized_content: "90-second-old memory" });
    env = makeTestEnv(db, { VECTORIZE_GRACE_MS: "60000" });
    const res = await worker.fetch(req("POST", "/vectorize-pending"), env, ctx);
    const data = await res.json() as any;
    expect(data.processed).toBe(1);
  });
});
