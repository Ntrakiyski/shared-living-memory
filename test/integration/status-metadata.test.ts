/**
 * status-metadata.test.ts
 *
 * M1–M3 and G5 (Sections 7.1–7.3): reasons, revision preconditions and atomic
 * status metadata committed in the same guarded batch as the episode.
 *
 * Real SQLite so the guarded commit, the rollback and the CHECK constraints are
 * genuinely exercised.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteD1 } from "../helpers/sqlite-d1";
import {
  applyStatus,
  normalizeStatusReason,
  StatusChangeRejectedError,
} from "../../src/lifecycle";
import { commitEntryVersion } from "../../src/entry-version-service";
import { isProtectedFromAutomaticOverwrite } from "../../src/tags";
import {
  EPISTEMIC_STATUS_VALUES,
  VALID_EPISTEMIC_TRANSITIONS,
  isValidTransition,
  type Env,
  type EpistemicStatus,
} from "../../src/types";

interface Harness {
  db: SqliteD1;
  env: Env;
}

function makeHarness(): Harness {
  const db = new SqliteD1();
  const env = {
    DB: db as unknown as D1Database,
    AI: {
      run: vi.fn(async (_m: string, o: { text: string[] }) => ({
        data: o.text.map(() => new Array(384).fill(0.01)),
      })),
    } as unknown as Ai,
    VECTORIZE: {
      upsert: vi.fn(async () => ({ mutationId: "u" })),
      deleteByIds: vi.fn(async () => ({ mutationId: "d" })),
      insert: vi.fn(), query: vi.fn(), getByIds: vi.fn(), describe: vi.fn(),
    } as unknown as VectorizeIndex,
    AUTH_TOKEN: "test-token",
    OAUTH_KV: {} as KVNamespace,
  } as Env;
  return { db, env };
}

const OWNER = "user-alice";

async function seed(harness: Harness, overrides: Record<string, unknown> = {}) {
  return commitEntryVersion({
    kind: "capture",
    actorUserId: OWNER,
    entryId: "entry-1",
    rawContent: "Original content",
    materializedContent: "Original content",
    tags: ["work"],
    source: "api",
    epistemicStatus: "candidate",
    ...overrides,
  }, harness.env);
}

function statusChangeOf(harness: Harness, episodeId: string): any {
  const raw = harness.db.one<{ status_change_json: string | null }>(
    "SELECT status_change_json FROM episodes WHERE id = ?", episodeId,
  ).status_change_json;
  return raw === null ? null : JSON.parse(raw);
}

describe("status reason contract (M1)", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = makeHarness();
    await seed(harness);
  });

  afterEach(() => {
    harness.db.close();
  });

  it("trims, bounds and secret-checks a supplied reason", () => {
    expect(normalizeStatusReason("  because  ")).toBe("because");
    expect(normalizeStatusReason(undefined)).toBeNull();
    expect(normalizeStatusReason(null)).toBeNull();
    expect(() => normalizeStatusReason("")).toThrow(StatusChangeRejectedError);
    expect(() => normalizeStatusReason("   ")).toThrow(StatusChangeRejectedError);
    expect(() => normalizeStatusReason("x".repeat(2_001))).toThrow(StatusChangeRejectedError);
    expect(() => normalizeStatusReason(`ghp_${"A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8".slice(0, 36)}`))
      .toThrow(StatusChangeRejectedError);
    // Exactly 2000 code points is accepted.
    expect(Array.from(normalizeStatusReason("y".repeat(2_000))!).length).toBe(2_000);
  });

  it("records from/to/actor/revision and the reason in the same episode", async () => {
    const ok = await applyStatus("entry-1", "canonical", harness.env, OWNER, {
      reason: "  Reviewed with the team  ",
      actor: { kind: "human", id: OWNER },
    });
    expect(ok).toBe(true);

    const current = harness.db.one<{ current_episode_id: string; revision: number }>(
      "SELECT current_episode_id, revision FROM entries WHERE id = 'entry-1'",
    );
    const change = statusChangeOf(harness, current.current_episode_id);
    expect(change).toMatchObject({
      version: 1,
      axis: "lifecycle",
      from: null,
      to: "canonical",
      reason: "Reviewed with the team",
      reason_status: "provided",
      actor: { kind: "human", id: OWNER },
      reviewer: null,
      proposal_id: null,
      revision: current.revision,
    });
    expect(change.recorded_at).toBeGreaterThan(0);
  });

  it("keeps an omitted reason explicitly null and attributed as not provided", async () => {
    await applyStatus("entry-1", "draft", harness.env, OWNER);
    const current = harness.db.one<{ current_episode_id: string }>(
      "SELECT current_episode_id FROM entries WHERE id = 'entry-1'",
    );
    const change = statusChangeOf(harness, current.current_episode_id);
    expect(change.reason).toBeNull();
    expect(change.reason_status).toBe("not_provided");
    expect(change.from).toBeNull();
    expect(change.to).toBe("draft");
  });

  it("rejects an invalid reason before any mutation", async () => {
    const before = harness.db.one<{ revision: number }>(
      "SELECT revision FROM entries WHERE id = 'entry-1'",
    ).revision;
    const episodesBefore = harness.db.count("episodes");

    for (const reason of ["", "   ", "x".repeat(2_001), ["sk", "live", "A".repeat(25)].join("_")]) {
      await expect(applyStatus("entry-1", "canonical", harness.env, OWNER, { reason }))
        .rejects.toBeInstanceOf(StatusChangeRejectedError);
    }

    expect(harness.db.one<{ revision: number }>(
      "SELECT revision FROM entries WHERE id = 'entry-1'",
    ).revision).toBe(before);
    expect(harness.db.count("episodes")).toBe(episodesBefore);
  });
});

describe("revision preconditions (M3)", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = makeHarness();
    await seed(harness);
  });

  afterEach(() => {
    harness.db.close();
  });

  it("checks a supplied expected_revision before any generation", async () => {
    await expect(applyStatus("entry-1", "canonical", harness.env, OWNER, {
      expectedRevision: 7,
    })).rejects.toMatchObject({
      code: "revision_conflict",
      details: { expected_revision: 7, actual_revision: 1 },
    });
    expect(harness.db.count("episodes")).toBe(1);
    expect(harness.db.count("entry_snapshots")).toBe(0);
  });

  it("rejects a negative or fractional expected_revision as invalid input", async () => {
    for (const expectedRevision of [-1, 1.5]) {
      await expect(applyStatus("entry-1", "canonical", harness.env, OWNER, { expectedRevision }))
        .rejects.toMatchObject({ code: "invalid_request" });
    }
  });

  it("accepts one of two same-revision edits and rejects the stale one with no partial rows", async () => {
    const revision = harness.db.one<{ revision: number }>(
      "SELECT revision FROM entries WHERE id = 'entry-1'",
    ).revision;
    expect(revision).toBe(1);

    const first = await applyStatus("entry-1", "canonical", harness.env, OWNER, {
      expectedRevision: 1,
      reason: "first",
      actor: { kind: "human", id: OWNER },
    });
    expect(first).toBe(true);

    await expect(applyStatus("entry-1", "draft", harness.env, OWNER, {
      expectedRevision: 1,
      reason: "stale",
      actor: { kind: "human", id: OWNER },
    })).rejects.toMatchObject({ code: "revision_conflict" });

    // Exactly one extra episode and one extra snapshot from the accepted edit.
    expect(harness.db.count("episodes")).toBe(2);
    expect(harness.db.count("entry_snapshots")).toBe(1);
    const withMetadata = harness.db.all<{ id: string }>(
      "SELECT id FROM episodes WHERE status_change_json IS NOT NULL",
    );
    expect(withMetadata).toHaveLength(1);
    expect(harness.db.one<{ revision: number }>(
      "SELECT revision FROM entries WHERE id = 'entry-1'",
    ).revision).toBe(2);
  });

  it("leaves no status metadata when the guarded commit changes nothing", async () => {
    // A concurrent writer moves the revision between the pre-check and the commit.
    const promise = applyStatus("entry-1", "canonical", harness.env, OWNER, {
      reason: "raced",
      actor: { kind: "human", id: OWNER },
    });
    harness.db.beforeNextBatch = () => {
      harness.db.exec(`UPDATE entries SET revision = revision + 1 WHERE id = 'entry-1'`);
    };
    await expect(promise).rejects.toBeTruthy();

    expect(harness.db.count("episodes")).toBe(1);
    expect(harness.db.count("entry_snapshots")).toBe(0);
    expect(harness.db.count("documents")).toBe(1);
    // No partial status metadata survives the rolled-back batch.
    expect(harness.db.one<{ count: number }>(
      "SELECT COUNT(*) AS count FROM episodes WHERE status_change_json IS NOT NULL",
    ).count).toBe(0);
  });
});

describe("epistemic axis (M1/G5)", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = makeHarness();
    await seed(harness);
  });

  afterEach(() => {
    harness.db.close();
  });

  it("records the epistemic axis with an explicit actor and no fabricated reviewer", async () => {
    const committed = await commitEntryVersion({
      kind: "status",
      actorUserId: OWNER,
      entryId: "entry-1",
      expectedRevision: 1,
      rawContent: "epistemic:reviewed",
      materializedContent: "Original content",
      epistemicStatus: "reviewed",
      statusChange: {
        axis: "epistemic",
        reason: "Checked against the source",
        actor: { kind: "human", id: OWNER },
        reviewer: null,
        proposalId: null,
      },
    }, harness.env);

    expect(statusChangeOf(harness, committed.episodeId)).toMatchObject({
      axis: "epistemic",
      from: "candidate",
      to: "reviewed",
      reason: "Checked against the source",
      reason_status: "provided",
      actor: { kind: "human", id: OWNER },
      reviewer: null,
      revision: committed.revision,
    });
  });

  it("rejects an epistemic self-transition instead of fabricating a revision", async () => {
    await expect(commitEntryVersion({
      kind: "status",
      actorUserId: OWNER,
      entryId: "entry-1",
      expectedRevision: 1,
      rawContent: "epistemic:candidate",
      materializedContent: "Original content",
      epistemicStatus: "candidate",
      statusChange: {
        axis: "epistemic",
        reason: null,
        actor: { kind: "human", id: OWNER },
        reviewer: null,
        proposalId: null,
      },
    }, harness.env)).rejects.toMatchObject({ code: "invalid_input" });
    expect(harness.db.count("episodes")).toBe(1);
  });

  it("keeps the documented transition table exact and closed", () => {
    expect(Object.keys(VALID_EPISTEMIC_TRANSITIONS).sort())
      .toEqual([...EPISTEMIC_STATUS_VALUES].sort());
    expect(isValidTransition("candidate", "canonical")).toBe(false);
    expect(isValidTransition("candidate", "reviewed")).toBe(true);
    expect(isValidTransition("retracted", "stale")).toBe(false);
    expect(VALID_EPISTEMIC_TRANSITIONS.retracted).toEqual([]);
  });

  it("does not set a lifecycle or epistemic status for a tagless legacy row", async () => {
    harness.db.exec(
      `INSERT INTO entries (id, content, tags, source, created_at, vector_ids, owner_user_id)
       VALUES ('legacy-1', 'legacy', '[]', 'api', 1, '[]', '${OWNER}')`,
    );
    const row = harness.db.one<{ epistemic_status: string; tags: string }>(
      "SELECT epistemic_status, tags FROM entries WHERE id = 'legacy-1'",
    );
    // Legacy lifecycle values are a tag convention: no tag means unknown, not a
    // fabricated 'draft'. The epistemic column keeps its stored default.
    expect(JSON.parse(row.tags)).toEqual([]);
    expect(row.epistemic_status).toBe("canonical");
  });
});

describe("automatic overwrite protection (G5)", () => {
  it("protects high importance, legacy canonical and epistemic canonical/qualified", () => {
    expect(isProtectedFromAutomaticOverwrite({ tags: ["work"], importanceScore: 4 })).toBe(true);
    expect(isProtectedFromAutomaticOverwrite({ tags: ["status:canonical"], importanceScore: 0 })).toBe(true);
    expect(isProtectedFromAutomaticOverwrite({ tags: [], epistemicStatus: "canonical" })).toBe(true);
    expect(isProtectedFromAutomaticOverwrite({ tags: [], epistemicStatus: "qualified" })).toBe(true);
  });

  it("does not protect an ordinary candidate, and a legacy draft tag cannot un-protect it", () => {
    expect(isProtectedFromAutomaticOverwrite({ tags: ["work"], importanceScore: 3, epistemicStatus: "candidate" })).toBe(false);
    expect(isProtectedFromAutomaticOverwrite({ tags: ["status:draft"], importanceScore: 0, epistemicStatus: "candidate" })).toBe(false);
    // Epistemic protection is independent of the legacy tag.
    expect(isProtectedFromAutomaticOverwrite({ tags: ["status:draft"], importanceScore: 0, epistemicStatus: "canonical" })).toBe(true);
    expect(isProtectedFromAutomaticOverwrite({ tags: ["status:draft"], importanceScore: 0, epistemicStatus: "qualified" })).toBe(true);
    expect(isProtectedFromAutomaticOverwrite({ tags: [], importanceScore: null, epistemicStatus: null })).toBe(false);
  });
});
