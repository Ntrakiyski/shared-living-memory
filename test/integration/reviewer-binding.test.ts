/**
 * reviewer-binding.test.ts
 *
 * G2/G3/G4 + Section 7.4: a designated reviewer binds a proposal's audience to
 * the proposer, the subject owner and one immutable account. Only that account
 * may approve or reject, and the binding cannot be changed under a reused
 * idempotency key.
 *
 * Real SQLite so the payload hash, the guarded updates and the audience
 * predicate run against the real schema.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteD1 } from "../helpers/sqlite-d1";
import {
  createActionProposal,
  executeApprovedProposal,
  listActionProposals,
  reviewActionProposal,
} from "../../src/action-proposals";
import { commitEntryVersion } from "../../src/entry-version-service";
import type { Env, HumanActorContext, ServiceScope } from "../../src/types";

const SCOPES: ServiceScope[] = ["memory:read", "proposal:read", "proposal:create", "audit:write", "run:write"];
const ctxStub = { waitUntil: (_: Promise<unknown>) => {}, passThroughOnException: () => {} } as never;

interface Harness {
  db: SqliteD1;
  env: Env;
}

function human(id: string, role: "admin" | "member" = "member"): HumanActorContext {
  return {
    kind: "human",
    actorId: id,
    userId: id,
    role,
    authMethod: "personal_api_key",
    scopes: new Set(),
  };
}

const RESEARCHER = "user-researcher";
const JARVIS = "user-jarvis";
const ENGINEER = "user-engineer";
const OTHER_ADMIN = "user-admin";

function makeHarness(): Harness {
  const db = new SqliteD1();
  for (const [id, role] of [
    [RESEARCHER, "member"],
    [JARVIS, "member"],
    [ENGINEER, "member"],
    [OTHER_ADMIN, "admin"],
  ] as const) {
    db.exec(
      `INSERT INTO users (id, username, normalized_username, auth_key_hash, auth_key_prefix, status, created_at, role)
       VALUES ('${id}', '${id.replace("user-", "")}', '${id.replace("user-", "")}', 'hash', 'p', 'active', 1, '${role}')`,
    );
  }
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

async function seedCandidate(harness: Harness): Promise<string> {
  const committed = await commitEntryVersion({
    kind: "capture",
    actorUserId: RESEARCHER,
    entryId: "entry-research",
    rawContent: "Researcher candidate",
    materializedContent: "Researcher candidate",
    tags: ["work"],
    source: "mcp:researcher",
    visibility: "public",
    epistemicStatus: "candidate",
  }, harness.env);
  return committed.entryId;
}

function submission(entryId: string, overrides: Record<string, unknown> = {}) {
  return {
    actor: human(RESEARCHER),
    actionType: "entry.epistemic-status.set" as const,
    payload: { entryId, status: "reviewed" },
    targetIds: [entryId],
    expectedRevision: 1,
    visibilityScope: "team" as const,
    reason: "Evidence checked against the source",
    idempotencyKey: "proposal-key-1",
    reviewerUsername: "jarvis",
    ...overrides,
  };
}

function proposalRow(harness: Harness, id: string): { payload_json: string; payload_hash: string } {
  return harness.db.one<{ payload_json: string; payload_hash: string }>(
    "SELECT payload_json, payload_hash FROM action_proposals WHERE id = ?", id,
  );
}

describe("designated reviewer binding (G2/G3)", () => {
  let harness: Harness;
  let entryId: string;

  beforeEach(async () => {
    harness = makeHarness();
    entryId = await seedCandidate(harness);
  });

  afterEach(() => {
    harness.db.close();
  });

  it("binds the resolved immutable user id before the payload hash is computed", async () => {
    const proposal = await createActionProposal(harness.env, submission(entryId));
    const row = proposalRow(harness, proposal.id);
    expect(JSON.parse(row.payload_json).reviewerUserId).toBe(JARVIS);
    expect(proposal.audience).toEqual({ mode: "designated", designated_reviewer_id: JARVIS });
    expect(proposal.designatedReviewerId).toBe(JARVIS);
    // The hash covers the binding, so it changes with it.
    const withOther = await createActionProposal(harness.env, submission(entryId, {
      idempotencyKey: "proposal-key-2",
      reviewerUsername: "engineer",
    }));
    expect(proposalRow(harness, withOther.id).payload_hash).not.toBe(row.payload_hash);
  });

  it("leaves an unassigned proposal explicitly legacy", async () => {
    const proposal = await createActionProposal(harness.env, submission(entryId, {
      reviewerUsername: undefined,
      idempotencyKey: "legacy-key",
    }));
    expect(proposal.audience).toEqual({ mode: "legacy", designated_reviewer_id: null });
    expect(JSON.parse(proposalRow(harness, proposal.id).payload_json).reviewerUserId).toBeUndefined();
  });

  it("rejects a caller-supplied payload.reviewerUserId", async () => {
    await expect(createActionProposal(harness.env, submission(entryId, {
      payload: { entryId, status: "reviewed", reviewerUserId: JARVIS },
      idempotencyKey: "injected-key",
    }))).rejects.toMatchObject({ code: "invalid_input" });
    expect(harness.db.count("action_proposals")).toBe(0);
  });

  it("rejects an unresolvable, inactive, self or subject-owner reviewer", async () => {
    // Case is normalized once and surrounding whitespace is trimmed, so those
    // are accepted; an unknown account, an invalid grammar and an over-long
    // name are not.
    for (const reviewerUsername of ["nobody", "bad name", "x".repeat(33)]) {
      await expect(createActionProposal(harness.env, submission(entryId, {
        reviewerUsername,
        idempotencyKey: `bad-${reviewerUsername.length}-${reviewerUsername.slice(0, 3)}`,
      }))).rejects.toMatchObject({ code: "invalid_input" });
    }
    // Self-designation and subject-owner designation both require a separate account.
    await expect(createActionProposal(harness.env, submission(entryId, {
      reviewerUsername: "researcher", idempotencyKey: "self-key",
    }))).rejects.toMatchObject({ code: "invalid_input" });

    harness.db.exec(`UPDATE users SET status = 'deactivating' WHERE id = '${JARVIS}'`);
    await expect(createActionProposal(harness.env, submission(entryId, {
      reviewerUsername: "jarvis", idempotencyKey: "inactive-key",
    }))).rejects.toMatchObject({ code: "invalid_input" });
    expect(harness.db.count("action_proposals")).toBe(0);
  });

  it("rejects changing the reviewer under a reused idempotency key", async () => {
    await createActionProposal(harness.env, submission(entryId));
    await expect(createActionProposal(harness.env, submission(entryId, {
      reviewerUsername: "engineer",
    }))).rejects.toMatchObject({ code: "idempotency_conflict" });

    // The same key with the same reviewer replays.
    const replayed = await createActionProposal(harness.env, submission(entryId));
    expect(replayed.designatedReviewerId).toBe(JARVIS);
    expect(harness.db.count("action_proposals")).toBe(1);
  });

  it("hides the proposal from everyone outside the audience, including admins", async () => {
    const proposal = await createActionProposal(harness.env, submission(entryId));

    for (const actor of [human(ENGINEER), human(OTHER_ADMIN)]) {
      const visible = await listActionProposals(harness.env, { actor });
      expect(visible.map((entry) => entry.id)).not.toContain(proposal.id);
      await expect(reviewActionProposal(harness.env, {
        actor,
        proposalId: proposal.id,
        decision: "approve",
        reason: "looks fine",
      })).rejects.toBeTruthy();
    }

    // The proposer and the designated reviewer can both see it.
    for (const actor of [human(RESEARCHER), human(JARVIS)]) {
      const visible = await listActionProposals(harness.env, { actor });
      expect(visible.map((entry) => entry.id)).toContain(proposal.id);
    }
  });

  it("lets only the designated reviewer approve, and keeps the owner unchanged", async () => {
    const proposal = await createActionProposal(harness.env, submission(entryId));

    const approved = await reviewActionProposal(harness.env, {
      actor: human(JARVIS),
      proposalId: proposal.id,
      decision: "approve",
      reason: "Evidence checked",
    });
    expect(approved.reviewerId).toBe(JARVIS);
    expect(approved.status).toBe("pending");

    const executed = await executeApprovedProposal(harness.env, {
      actor: human(JARVIS),
      proposalId: proposal.id,
    });
    expect(executed.proposalId).toBe(proposal.id);

    // Ownership never moved, and the reviewer is not recorded as the owner.
    expect(harness.db.one<{ owner_user_id: string }>(
      "SELECT owner_user_id FROM entries WHERE id = ?", entryId,
    ).owner_user_id).toBe(RESEARCHER);
    // The reviewer is recorded as the reviewer and the executor — never
    // substituted for the owner.
    expect(harness.db.one<{ reviewer_id: string; executor_id: string; proposer_id: string }>(
      "SELECT reviewer_id, executor_id, proposer_id FROM action_proposals WHERE id = ?", proposal.id,
    )).toEqual({ reviewer_id: JARVIS, executor_id: JARVIS, proposer_id: RESEARCHER });
    expect(harness.db.one<{ epistemic_status: string }>(
      "SELECT epistemic_status FROM entries WHERE id = ?", entryId,
    ).epistemic_status).toBe("reviewed");
  });

  it("refuses review by the proposer once a reviewer is bound", async () => {
    const proposal = await createActionProposal(harness.env, submission(entryId));
    await expect(reviewActionProposal(harness.env, {
      actor: human(RESEARCHER),
      proposalId: proposal.id,
      decision: "approve",
      reason: "self approval",
    })).rejects.toBeTruthy();
    expect(harness.db.one<{ status: string; reviewer_id: string | null }>(
      "SELECT status, reviewer_id FROM action_proposals WHERE id = ?", proposal.id,
    )).toEqual({ status: "pending", reviewer_id: null });
  });

  it("keeps an executed result replayable after the reviewer deactivates, without re-executing", async () => {
    const proposal = await createActionProposal(harness.env, submission(entryId));
    await reviewActionProposal(harness.env, {
      actor: human(JARVIS), proposalId: proposal.id, decision: "approve", reason: "ok",
    });
    await executeApprovedProposal(harness.env, {
      actor: human(JARVIS), proposalId: proposal.id,
    });

    harness.db.exec(`UPDATE users SET status = 'deactivated' WHERE id = '${JARVIS}'`);

    // The completed audit record remains readable to a still-authorized caller.
    const replay = await executeApprovedProposal(harness.env, {
      actor: human(RESEARCHER), proposalId: proposal.id,
    });
    expect(replay.proposalId).toBe(proposal.id);
    // Exactly one version change happened: the entry is still at revision 2.
    expect(harness.db.one<{ revision: number }>(
      "SELECT revision FROM entries WHERE id = ?", entryId,
    ).revision).toBe(2);
  });

  it("marks an unbound proposal as legacy so existing review behaviour is unchanged", async () => {
    const legacy = await createActionProposal(harness.env, submission(entryId, {
      reviewerUsername: undefined,
      idempotencyKey: "legacy-flow",
    }));
    const other = human(OTHER_ADMIN);
    const visible = await listActionProposals(harness.env, { actor: other });
    expect(visible.map((entry) => entry.id)).toContain(legacy.id);
  });
});

describe("proposal tool structured results (Section 4.4)", () => {
  let harness: Harness;
  let entryId: string;

  beforeEach(async () => {
    harness = makeHarness();
    entryId = await seedCandidate(harness);
  });

  afterEach(() => {
    harness.db.close();
  });

  async function tool(
    harnessIn: Harness,
    name: string,
    input: Record<string, unknown>,
    actor: HumanActorContext = human(RESEARCHER),
  ) {
    const { buildMcpServer } = await import("../../src/mcp");
    const server = buildMcpServer(harnessIn.env, ctxStub, actor, "full") as any;
    return server._registeredTools[name].handler(input, {});
  }

  it("wraps each proposal tool in its documented outer field", async () => {
    const created = await tool(harness, "create_action_proposal", {
      action_type: "entry.epistemic-status.set",
      payload_json: JSON.stringify({ entryId, status: "reviewed" }),
      target_ids: [entryId],
      expected_revision: 1,
      visibility_scope: "team",
      reason: "Evidence checked",
      idempotency_key: "structured-1",
      reviewer_username: "jarvis",
    });
    const createdData = created.structuredContent.data;
    expect(Object.keys(createdData)).toEqual(["proposal"]);
    // The mapped proposal carries the audience and designated reviewer.
    expect(createdData.proposal.audience).toEqual({
      mode: "designated",
      designated_reviewer_id: "user-jarvis",
    });
    expect(createdData.proposal.designatedReviewerId).toBe("user-jarvis");

    const listed = await tool(harness, "list_action_proposals", {});
    expect(Object.keys(listed.structuredContent.data)).toEqual(["proposals"]);
    expect(listed.structuredContent.data.proposals[0].audience.mode).toBe("designated");

    const reviewed = await tool(harness, "review_action_proposal", {
      proposal_id: createdData.proposal.id,
      decision: "approve",
      reason: "Approved",
    }, human(JARVIS));
    expect(Object.keys(reviewed.structuredContent.data)).toEqual(["proposal"]);
    expect(reviewed.structuredContent.data.proposal.reviewerId).toBe("user-jarvis");

    const executed = await tool(harness, "execute_approved_action", {
      proposal_id: createdData.proposal.id,
    }, human(JARVIS));
    expect(Object.keys(executed.structuredContent.data)).toEqual(["execution"]);
    expect(executed.structuredContent.data.execution.proposalId).toBe(createdData.proposal.id);
  });
});

describe("M2: proposal-driven status metadata", () => {
  let harness: Harness;
  let entryId: string;

  beforeEach(async () => {
    harness = makeHarness();
    entryId = await seedCandidate(harness);
  });

  afterEach(() => {
    harness.db.close();
  });

  it("records the executor as actor and the approving account as reviewer", async () => {
    const proposal = await createActionProposal(harness.env, submission(entryId));
    await reviewActionProposal(harness.env, {
      actor: human(JARVIS), proposalId: proposal.id, decision: "approve",
      reason: "Evidence checked against the source",
    });
    await executeApprovedProposal(harness.env, { actor: human(JARVIS), proposalId: proposal.id });

    const change = JSON.parse(harness.db.one<{ status_change_json: string }>(
      `SELECT status_change_json FROM episodes
       WHERE entry_id = ? AND status_change_json IS NOT NULL LIMIT 1`,
      entryId,
    ).status_change_json);

    expect(change).toMatchObject({
      axis: "epistemic",
      from: "candidate",
      to: "reviewed",
      reason_status: "provided",
      actor: { kind: "human", id: JARVIS },
      reviewer: { kind: "human", id: JARVIS },
      proposal_id: proposal.id,
    });
    // The submission rationale is the change's reason, and the owner is never
    // substituted as the actor or the reviewer.
    expect(change.reason).toBe("Evidence checked against the source");
    expect(change.actor.id).not.toBe(RESEARCHER);
    expect(change.reviewer.id).not.toBe(RESEARCHER);
    // The revision links the metadata to the version it produced.
    expect(harness.db.one<{ revision: number }>(
      "SELECT revision FROM entries WHERE id = ?", entryId,
    ).revision).toBe(change.revision);
  });

  it("leaves pre-release episodes explicitly unknown", async () => {
    // The original capture episode predates this release's metadata.
    expect(harness.db.one<{ status_change_json: string | null }>(
      `SELECT status_change_json FROM episodes WHERE entry_id = ? ORDER BY created_at ASC LIMIT 1`,
      entryId,
    ).status_change_json).toBeNull();
  });
});

describe("designated audience cannot be widened by any other principal", () => {
  let harness: Harness;
  let entryId: string;

  beforeEach(async () => {
    harness = makeHarness();
    entryId = await seedCandidate(harness);
  });

  afterEach(() => {
    harness.db.close();
  });

  it("denies an internal system actor at the policy layer for proposal reads", async () => {
    await createActionProposal(harness.env, submission(entryId));
    const systemActor = {
      kind: "system" as const,
      actorId: "_reconciliation",
      systemId: "_reconciliation",
      authMethod: "scheduled-worker",
      scopes: new Set<never>(),
    };
    // System identities are default-denied; the only whitelisted one (the nightly
    // contradiction scanner) may create an edge proposal and nothing else. So no
    // system actor can reach the audience predicate at all, and the designated
    // rule is a second layer rather than the only one.
    await expect(listActionProposals(harness.env, { actor: systemActor as never }))
      .rejects.toMatchObject({ decision: { reasonCode: "system_default_deny" } });
  });

  it("refuses a system actor at review and execute on a designated proposal", async () => {
    const proposal = await createActionProposal(harness.env, submission(entryId));
    const systemActor = {
      kind: "system" as const,
      actorId: "_reconciliation",
      systemId: "_reconciliation",
      authMethod: "scheduled-worker",
      scopes: new Set<never>(),
    };
    await expect(reviewActionProposal(harness.env, {
      actor: systemActor as never,
      proposalId: proposal.id,
      decision: "approve",
      reason: "internal",
    })).rejects.toBeTruthy();
    await expect(executeApprovedProposal(harness.env, {
      actor: systemActor as never,
      proposalId: proposal.id,
    })).rejects.toBeTruthy();
    expect(harness.db.one<{ reviewer_id: string | null }>(
      "SELECT reviewer_id FROM action_proposals WHERE id = ?", proposal.id,
    ).reviewer_id).toBeNull();
  });
});
