/**
 * Per-user compression tests — verifies that compression correctly scopes
 * entries by user ownership and visibility.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { compressTag, compressionEligibilitySql } from "../../src/testing";
import { makeTestEnv, makeTestDb, makeVectorizeMock } from "../helpers/make-env";
import type { Env } from "../../src/testing";
import { D1Mock } from "../helpers/d1-mock";

function makeSseStream(response: string) {
  return new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(`data: {"response":${JSON.stringify(response)}}\n\n`));
      c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      c.close();
    },
  });
}

function makeDigestAI(digestText = "Compressed digest text") {
  return {
    run: vi.fn().mockImplementation(async (_model: string, opts: any) => {
      if (_model === "@cf/baai/bge-small-en-v1.5")
        return { data: [new Array(384).fill(0.1)] };
      if (opts?.stream)
        return makeSseStream(digestText);
      return { response: "3" };
    }),
  } as unknown as Ai;
}

function makeCtx() {
  const pending: Promise<any>[] = [];
  return {
    ctx: { waitUntil: (p: Promise<any>) => pending.push(p) } as any as ExecutionContext,
    drain: () => Promise.allSettled(pending),
  };
}

function seed(db: D1Mock, id: string, content: string, tags: string[] = [], ownerId = "", opts: { importance?: number; recall?: number; created_at?: number } = {}) {
  const createdAt = opts.created_at ?? Date.now() - 100000;
  db.entries.push({
    id,
    content,
    tags: JSON.stringify(tags),
    source: "api",
    created_at: createdAt,
    vector_ids: "[]",
    recall_count: opts.recall ?? 0,
    importance_score: opts.importance ?? 0,
    owner_user_id: ownerId,
    created_by_user_id: ownerId,
    visibility: tags.includes("private") ? "private" : "public",
    revision: 0,
    valid_from: null,
    valid_to: null,
    recorded_at: createdAt,
    epistemic_status: "canonical",
    current_episode_id: null,
    updated_at: createdAt,
  });
}

describe("Per-user compression", () => {
  let env: Env;
  let db: D1Mock;

  beforeEach(() => {
    db = makeTestDb();
    env = makeTestEnv(db, { AI: makeDigestAI() });
  });

  describe("compressionEligibilitySql with ownerUserId", () => {
    it("adds owner_user_id filter when ownerUserId is provided", () => {
      const sql = compressionEligibilitySql("", "user-1");
      expect(sql).toContain("owner_user_id");
      expect(sql).toContain("?");
    });

    it("does not add owner_user_id filter when no ownerUserId", () => {
      const sql = compressionEligibilitySql("");
      expect(sql).not.toContain("owner_user_id");
    });

    it("requires exact ownership instead of public visibility", () => {
      const sql = compressionEligibilitySql("", "user-1");
      expect(sql).toContain("owner_user_id = ?");
      expect(sql).not.toContain("tags NOT LIKE");
    });
  });

  describe("compressTag with userId", () => {
    it("only compresses entries owned by the user", async () => {
      // Seed 15 entries tagged "project" owned by user-1
      for (let i = 0; i < 15; i++) {
        seed(db, `u1-${i}`, `User 1 note ${i}`, ["project"], "user-1");
      }
      // Seed 10 entries tagged "project" owned by user-2 (private)
      for (let i = 0; i < 10; i++) {
        seed(db, `u2-${i}`, `User 2 private note ${i}`, ["project", "private"], "user-2");
      }

      const { ctx } = makeCtx();
      const result = await compressTag("project", env, ctx, "user-1");

      // Should only compress user-1's 15 entries, not user-2's 10
      expect(result.entriesUsed).toBe(15);
      expect(result.synthesizedId).toBeTruthy();
    });

    it("does not read or mutate another user's public entries and owns the digest", async () => {
      // Seed 12 entries tagged "project" owned by user-1
      for (let i = 0; i < 12; i++) {
        seed(db, `u1-${i}`, `User 1 note ${i}`, ["project"], "user-1");
      }
      // Seed 5 public entries from user-2. Visibility must not grant mutation rights.
      for (let i = 0; i < 5; i++) {
        seed(db, `u2-pub-${i}`, `User 2 public note ${i}`, ["project"], "user-2");
      }
      const foreignBefore = db.entries
        .filter(entry => entry.owner_user_id === "user-2")
        .map(entry => ({ id: entry.id, content: entry.content, tags: entry.tags, owner: entry.owner_user_id }));

      const { ctx, drain } = makeCtx();
      const result = await compressTag("project", env, ctx, "user-1");
      await drain();

      expect(result.entriesUsed).toBe(12);
      expect(db.entries
        .filter(entry => entry.owner_user_id === "user-2")
        .map(entry => ({ id: entry.id, content: entry.content, tags: entry.tags, owner: entry.owner_user_id })))
        .toEqual(foreignBefore);

      const digest = db.entries.find(entry => entry.id === result.synthesizedId);
      expect(digest.owner_user_id).toBe("user-1");
      expect(digest.visibility).toBe("public");
      expect(JSON.parse(digest.tags)).not.toContain("private");
    });

    it("excludes private entries from other users", async () => {
      // Seed 12 entries tagged "project" owned by user-1
      for (let i = 0; i < 12; i++) {
        seed(db, `u1-${i}`, `User 1 note ${i}`, ["project"], "user-1");
      }
      // Seed 10 private entries from user-2 (should be excluded)
      for (let i = 0; i < 10; i++) {
        seed(db, `u2-priv-${i}`, `User 2 private note ${i}`, ["project", "private"], "user-2");
      }

      const { ctx } = makeCtx();
      const result = await compressTag("project", env, ctx, "user-1");

      // Should only compress user-1's 12 entries
      expect(result.entriesUsed).toBe(12);
    });

    it("keeps a digest private when any owned source is private", async () => {
      for (let i = 0; i < 9; i++) {
        seed(db, `u1-public-${i}`, `User 1 public note ${i}`, ["project"], "user-1");
      }
      seed(db, "u1-private", "User 1 private note", ["project", "private"], "user-1");

      const { ctx, drain } = makeCtx();
      const result = await compressTag("project", env, ctx, "user-1");
      await drain();

      expect(result.entriesUsed).toBe(10);
      const digest = db.entries.find(entry => entry.id === result.synthesizedId);
      expect(digest.owner_user_id).toBe("user-1");
      expect(digest.visibility).toBe("private");
      expect(JSON.parse(digest.tags)).toContain("private");
    });

    it("fails closed for non-array tag metadata", async () => {
      for (let i = 0; i < 9; i++) {
        seed(db, `valid-${i}`, `Valid note ${i}`, ["project"], "user-1");
      }
      seed(db, "malformed", "Malformed metadata", ["project"], "user-1");
      db.entries.find(entry => entry.id === "malformed")!.tags = JSON.stringify("project");

      const before = { ...db.entries.find(entry => entry.id === "malformed") };
      const { ctx } = makeCtx();
      const result = await compressTag("project", env, ctx, "user-1");

      expect(result).toEqual({ synthesizedId: null, entriesUsed: 0, text: "" });
      expect(db.entries.find(entry => entry.id === "malformed")).toMatchObject({
        id: before.id,
        content: before.content,
        tags: before.tags,
        owner_user_id: before.owner_user_id,
        revision: before.revision,
      });
    });

    it("refuses ownerless legacy entries under an actor-scoped compression", async () => {
      // Ownerless legacy rows cannot be mutated by a maintenance actor.
      for (let i = 0; i < 15; i++) {
        seed(db, `entry-${i}`, `Note ${i}`, ["project"]);
      }

      const { ctx } = makeCtx();
      const result = await compressTag("project", env, ctx, "user-1");

      expect(result).toEqual({ synthesizedId: null, entriesUsed: 0, text: "" });
    });
  });
});
