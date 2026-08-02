import { describe, it, expect, beforeEach, vi } from "vitest";
import worker from "../../src/testing";
import { makeTestEnv, makeTestDb, makeVectorizeMock } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import type { Env } from "../../src/testing";
import { D1Mock } from "../helpers/d1-mock";

const ctx = { waitUntil: (_: Promise<any>) => {} } as any;

function makeMatch(id: string, score: number, overrides: Record<string, any> = {}) {
  return {
    id,
    score,
    metadata: { parentId: id, episodeId: `episode-${id}`, isUpdate: false, ...overrides },
  };
}

describe("Recall v2 — relations in results (Ticket 09)", () => {
  let env: Env;
  let db: D1Mock;

  beforeEach(() => {
    db = makeTestDb();
    env = makeTestEnv(db);
  });

  it("recall returns relations field for entries with linked edges", async () => {
    const now = Date.now();
    const SYSTEM_USER_ID = "sys-user-rel";

    db.users.push({
      id: SYSTEM_USER_ID, username: "_system", normalized_username: "_system",
      auth_key_hash: "", auth_key_prefix: "", status: "active", created_at: now,
    });

    db.entries.push(
      {
        id: "entry-a", content: "First fact", tags: "[]", source: "api",
        created_at: now, vector_ids: "[]", recall_count: 0, importance_score: 0,
        contradiction_wins: 0, contradiction_losses: 0, owner_user_id: SYSTEM_USER_ID,
        valid_from: now, valid_to: null, recorded_at: now, epistemic_status: "canonical",
        current_episode_id: "episode-entry-a",
      },
      {
        id: "entry-b", content: "Second fact", tags: "[]", source: "api",
        created_at: now, vector_ids: "[]", recall_count: 0, importance_score: 0,
        contradiction_wins: 0, contradiction_losses: 0, owner_user_id: SYSTEM_USER_ID,
        valid_from: now, valid_to: null, recorded_at: now, epistemic_status: "canonical",
        current_episode_id: "episode-entry-b",
      },
    );

    // Edge from A to B
    db.edges.push({
      source_id: "entry-a", target_id: "entry-b", type: "relates_to",
      weight: 0.8, provenance: "explicit", metadata: JSON.stringify({ confidence: 0.9 }),
      created_at: now, updated_at: now,
    });

    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [
            makeMatch("entry-a", 0.9),
            makeMatch("entry-b", 0.7),
          ],
        }),
      }),
    });

    const res = await worker.fetch(
      req("GET", `/recall?query=test&topK=5`),
      env, ctx
    );
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(data.results).toHaveLength(2);

    // entry-a has a relation to entry-b
    const entryA = data.results.find((r: any) => r.id === "entry-a");
    expect(entryA.relations).toBeDefined();
    expect(entryA.relations.length).toBeGreaterThanOrEqual(1);
    expect(entryA.relations[0]).toMatchObject({
      type: "relates_to",
    });

    // entry-b has no outgoing edges — the current implementation only maps relations
    // for the source side of each edge, so entry-b has no relations field.
    const entryB = data.results.find((r: any) => r.id === "entry-b");
    expect(entryB.relations).toBeUndefined();
  });

  it("recall returns epistemic_status in results", async () => {
    const now = Date.now();
    const SYSTEM_USER_ID = "sys-user-epi";

    db.users.push({
      id: SYSTEM_USER_ID, username: "_system", normalized_username: "_system",
      auth_key_hash: "", auth_key_prefix: "", status: "active", created_at: now,
    });

    db.entries.push({
      id: "canonical-entry", content: "Canonical fact", tags: "[]", source: "api",
      created_at: now, vector_ids: "[]", recall_count: 0, importance_score: 0,
      contradiction_wins: 0, contradiction_losses: 0, owner_user_id: SYSTEM_USER_ID,
      valid_from: now, valid_to: null, recorded_at: now, epistemic_status: "canonical",
      current_episode_id: "episode-canonical-entry",
    });

    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [makeMatch("canonical-entry", 0.9)],
        }),
      }),
    });

    const res = await worker.fetch(
      req("GET", `/recall?query=test&topK=5`),
      env, ctx
    );
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(data.results).toHaveLength(1);
    expect(data.results[0].epistemic_status).toBe("canonical");
  });

  it("does not hydrate relation IDs that point at another user's private entry", async () => {
    const now = Date.now();
    db.entries.push(
      {
        id: "visible", content: "Visible project fact", tags: "[]", source: "api",
        created_at: now, vector_ids: "[]", recall_count: 0, importance_score: 0,
        contradiction_wins: 0, contradiction_losses: 0, owner_user_id: "public-owner",
        valid_from: now, valid_to: null, recorded_at: now, epistemic_status: "canonical",
        current_episode_id: "episode-visible",
      },
      {
        id: "secret-target", content: "Private linked fact", tags: JSON.stringify(["private"]), source: "api",
        created_at: now, vector_ids: "[]", recall_count: 0, importance_score: 0,
        contradiction_wins: 0, contradiction_losses: 0, owner_user_id: "another-user",
        valid_from: now, valid_to: null, recorded_at: now, epistemic_status: "canonical",
      },
    );
    db.edges.push({
      source_id: "visible", target_id: "secret-target", type: "relates_to",
      weight: 0.8, provenance: "explicit", metadata: "{}", created_at: now, updated_at: now,
    });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({ matches: [makeMatch("visible", 0.9)] }),
      }),
    });

    const res = await worker.fetch(req("GET", "/recall?query=project&topK=5"), env, ctx);
    const body = await res.text();
    const data = JSON.parse(body);

    expect(data.results[0].relations).toBeUndefined();
    expect(body).not.toContain("secret-target");
  });
});
