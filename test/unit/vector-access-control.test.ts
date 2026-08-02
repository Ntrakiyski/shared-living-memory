import { describe, expect, it, vi } from "vitest";
import {
  checkDuplicateAndContradiction,
  neighborsFromVectorQuery,
  queryVisibleVectors,
} from "../../src/testing";
import { makeTestDb, makeTestEnv, makeVectorizeMock } from "../helpers/make-env";

const ALICE = "user-alice";
const BOB = "user-bob";

function entry(id: string, ownerUserId: string, tags: string[], content = id) {
  return {
    id,
    content,
    tags: JSON.stringify(tags),
    source: "test",
    created_at: 1,
    vector_ids: JSON.stringify([`v-${id}`]),
    current_episode_id: `episode-${id}`,
    owner_user_id: ownerUserId,
    recall_count: 0,
    importance_score: 0,
  };
}

function match(id: string, score: number, parentId = id) {
  return { id: `v-${id}`, score, metadata: { parentId, episodeId: `episode-${parentId}` } };
}

function embeddingAI() {
  return {
    run: vi.fn().mockImplementation(async (model: string) => {
      if (model === "@cf/baai/bge-small-en-v1.5") return { data: [new Array(384).fill(0.1)] };
      throw new Error("LLM must not receive a cross-user candidate");
    }),
  } as unknown as Ai;
}

describe("Vectorize ACL", () => {
  it("queries owner and public scopes separately, merges duplicates, and caps results", async () => {
    const db = makeTestDb();
    db.entries.push(
      entry("own-public", ALICE, []),
      entry("own-private", ALICE, ["private"]),
      entry("other-public", BOB, []),
    );
    const query = vi.fn().mockImplementation(async (_values: number[], opts: VectorizeQueryOptions) => {
      if ((opts.filter as any)?.owner_user_id) {
        return { matches: [match("own-public", 0.8), match("own-private", 0.7)] };
      }
      return { matches: [match("other-public", 0.9), match("own-public", 0.8)] };
    });
    const env = makeTestEnv(db, { VECTORIZE: makeVectorizeMock({ query }) });

    const result = await queryVisibleVectors([0.1], env, { topK: 2, userId: ALICE });

    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls.map(call => call[1]?.filter)).toEqual([
      { owner_user_id: { $eq: ALICE } },
      { is_private: { $eq: false } },
    ]);
    expect(query.mock.calls.every(call => !("metadataFilter" in call[1]))).toBe(true);
    expect(result.matches.map(m => m.metadata?.parentId)).toEqual(["other-public", "own-public"]);
  });

  it("drops another user's private match even when Vectorize violates both filters", async () => {
    const db = makeTestDb();
    db.entries.push(
      entry("own", ALICE, []),
      entry("bob-secret", BOB, ["private"], "BOB PRIVATE PAYLOAD"),
      { ...entry("corrupt", BOB, []), tags: "not-json" },
    );
    const hostileMatches = [
      match("bob-secret", 0.999),
      match("ghost", 0.95),
      match("corrupt", 0.9),
      match("own", 0.7),
    ];
    const query = vi.fn().mockResolvedValue({ matches: hostileMatches });
    const env = makeTestEnv(db, { VECTORIZE: makeVectorizeMock({ query }) });

    const visible = await queryVisibleVectors([0.1], env, { topK: 5, userId: ALICE });
    const neighbors = await neighborsFromVectorQuery([0.1], env, ALICE);

    expect(visible.matches.map(m => m.metadata?.parentId)).toEqual(["own"]);
    expect(neighbors).toEqual([{ id: "own", score: 0.7 }]);
    expect(query.mock.calls.every(call => call[1]?.filter)).toBe(true);
  });

  it("never falls back to an unfiltered query when a scoped query fails", async () => {
    const db = makeTestDb();
    const query = vi.fn().mockRejectedValue(new Error("filtered query failed"));
    const env = makeTestEnv(db, { VECTORIZE: makeVectorizeMock({ query }) });

    await expect(queryVisibleVectors([0.1], env, { topK: 5, userId: ALICE }))
      .rejects.toThrow("filtered query failed");
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls.every(call => call[1]?.filter)).toBe(true);
  });

  it("treats a 0.99 cross-user public match as informational, never duplicate or LLM input", async () => {
    const db = makeTestDb();
    db.entries.push(entry("bob-public", BOB, [], "Bob's public architecture note"));
    db.users.push({ id: BOB, username: "bob", status: "active", created_at: 1 });
    const ai = embeddingAI();
    const query = vi.fn().mockResolvedValue({ matches: [match("bob-public", 0.99)] });
    const env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({ query }),
      AI: ai,
    });

    const result = await checkDuplicateAndContradiction("Alice's new note", env, ALICE);

    expect(result.duplicate).toEqual({ status: "unique" });
    expect(result.contradiction).toEqual({ detected: false });
    expect(result.mergeAction).toBeNull();
    expect(result.crossUserSimilar).toEqual({
      entryId: "bob-public",
      ownerUserId: BOB,
      ownerUsername: "bob",
      score: 0.99,
    });
    expect(result.neighbors).toEqual([{ id: "bob-public", score: 0.99 }]);
    expect((ai.run as any).mock.calls).toHaveLength(1);
  });

  it("excludes hostile private content from an LLM prompt even when an owned candidate is evaluated", async () => {
    const db = makeTestDb();
    db.entries.push(
      entry("alice-note", ALICE, [], "Alice visible candidate"),
      entry("bob-secret", BOB, ["private"], "BOB PRIVATE PAYLOAD"),
    );
    const aiRun = vi.fn().mockImplementation(async (model: string) => {
      if (model === "@cf/baai/bge-small-en-v1.5") return { data: [new Array(384).fill(0.1)] };
      return new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"response":"{\\"contradicts\\":false}"}\n\n'));
          controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
    });
    const env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [match("bob-secret", 0.99), match("alice-note", 0.7)],
        }),
      }),
      AI: { run: aiRun } as unknown as Ai,
    });

    const result = await checkDuplicateAndContradiction("Alice's new note", env, ALICE);

    expect(result.duplicate).toEqual({ status: "unique" });
    expect(result.crossUserSimilar).toBeNull();
    expect(result.neighbors).toEqual([{ id: "alice-note", score: 0.7 }]);
    expect(aiRun).toHaveBeenCalledTimes(2);
    const prompt = aiRun.mock.calls[1][1].messages[0].content as string;
    expect(prompt).toContain("Alice visible candidate");
    expect(prompt).not.toContain("BOB PRIVATE PAYLOAD");
  });
});
