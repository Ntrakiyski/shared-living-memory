import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createActionProposal,
  executeApprovedProposal,
  getActionProposal,
  reviewActionProposal,
} from "../../src/action-proposals";
import { commitEntryVersion } from "../../src/entry-version-service";
import { LLM_MODEL } from "../../src/config";
import { detectCrossUserContradictions } from "../../src/lifecycle";
import {
  MandatoryAuditError,
  reconcileMandatoryAuditCompletions,
} from "../../src/mandatory-audit";
import {
  captureServicePrivateDraft,
  OperatorDraftIdempotencyError,
} from "../../src/operator-memory";
import { decideOperatorAction, OperatorPolicyError } from "../../src/operator-policy";
import { ServiceActorValidationError, verifyServiceActor } from "../../src/service-actor";
import { ACTION_TYPES, type ActionType, type Env, type HumanActorContext, type ServiceActorContext, type ServiceScope } from "../../src/types";

const schema = readFileSync(resolve(process.cwd(), "db/schema.sql"), "utf8");

class SqliteStatement {
  constructor(
    private readonly owner: SqliteD1,
    readonly sql: string,
    private readonly values: unknown[] = [],
  ) {}

  bind(...values: unknown[]): SqliteStatement {
    return new SqliteStatement(this.owner, this.sql, values);
  }

  async run(): Promise<any> {
    this.owner.maybeFail(this.sql);
    const result = this.owner.sqlite.prepare(this.sql).run(...this.values as SQLInputValue[]);
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  }

  async all<T = Record<string, unknown>>(): Promise<any> {
    this.owner.maybeFail(this.sql);
    const results = this.owner.sqlite.prepare(this.sql).all(...this.values as SQLInputValue[]) as T[];
    return { success: true, results, meta: { changes: 0 } };
  }

  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    this.owner.maybeFail(this.sql);
    const found = this.owner.sqlite.prepare(this.sql).get(...this.values as SQLInputValue[]) as Record<string, unknown> | undefined;
    if (!found) return null;
    return (column ? found[column] : found) as T;
  }
}

class SqliteD1 {
  readonly sqlite = new DatabaseSync(":memory:");
  failOn: RegExp | null = null;
  failRemaining: number | null = null;

  constructor() {
    this.sqlite.exec(schema);
  }

  maybeFail(sql: string): void {
    if (!this.failOn?.test(sql)) return;
    if (this.failRemaining !== null) {
      if (this.failRemaining <= 0) return;
      this.failRemaining -= 1;
    }
    throw new Error("injected D1 audit failure");
  }

  prepare(sql: string): SqliteStatement {
    return new SqliteStatement(this, sql);
  }

  async batch(statements: SqliteStatement[]): Promise<any[]> {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const results: any[] = [];
      for (const statement of statements) results.push(await statement.run());
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
}

interface Harness {
  db: SqliteD1;
  env: Env;
  vectors: Map<string, unknown>;
  upsert: ReturnType<typeof vi.fn>;
}

const ALL_SERVICE_SCOPES: ServiceScope[] = [
  "memory:read",
  "memory:draft",
  "memory:propose",
  "memory:execute-approved",
  "proposal:read",
  "proposal:create",
  "proposal:execute-approved",
  "audit:write",
  "run:write",
];

const human: HumanActorContext = {
  kind: "human",
  actorId: "user-reviewer",
  userId: "user-reviewer",
  role: "admin",
  authMethod: "user-key",
  scopes: new Set(),
};

function serviceActor(scopes: readonly ServiceScope[] = ALL_SERVICE_SCOPES): ServiceActorContext {
  return {
    kind: "service",
    actorId: "service-hermes",
    serviceIdentityId: "service-hermes",
    credentialId: "credential-hermes",
    ownerUserId: "user-owner",
    authMethod: "sbs-key",
    scopes: new Set(scopes),
  };
}

function makeHarness(
  scopes: readonly ServiceScope[] = ALL_SERVICE_SCOPES,
  autonomyProfile = "execute-approved",
): Harness {
  const db = new SqliteD1();
  db.sqlite.prepare(
    `INSERT INTO users (id, username, normalized_username, auth_key_hash, auth_key_prefix, status, created_at, role)
     VALUES (?, ?, ?, 'hash', 'prefix', 'active', 1, ?)`,
  ).run("user-owner", "owner", "owner", "admin");
  db.sqlite.prepare(
    `INSERT INTO users (id, username, normalized_username, auth_key_hash, auth_key_prefix, status, created_at, role)
     VALUES (?, ?, ?, 'hash', 'prefix', 'active', 1, ?)`,
  ).run(human.userId, "reviewer", "reviewer", human.role);
  db.sqlite.prepare(
    `INSERT INTO service_identities (
       id, name, owner_user_id, status, default_autonomy_profile,
       created_by_user_id, created_at, updated_at
     ) VALUES ('service-hermes', 'Hermes', 'user-owner', 'active', ?, 'user-owner', 1, 1)`,
  ).run(autonomyProfile);
  db.sqlite.prepare(
    `INSERT INTO service_credentials (
       id, service_identity_id, credential_hash, credential_prefix, scopes,
       status, created_by_user_id, created_at
     ) VALUES ('credential-hermes', 'service-hermes', 'credential-hash', 'sbs_test', ?, 'active', 'user-owner', 1)`,
  ).run(JSON.stringify(scopes));

  const vectors = new Map<string, unknown>();
  const upsert = vi.fn(async (items: { id: string }[]) => {
    for (const item of items) vectors.set(item.id, item);
    return { mutationId: "upsert" };
  });
  const env = {
    DB: db as unknown as D1Database,
    AI: {
      run: vi.fn(async (_model: string, options: { text: string[] }) => ({
        data: options.text.map(() => new Array(384).fill(0.01)),
      })),
    } as unknown as Ai,
    VECTORIZE: {
      upsert,
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
  return { db, env, vectors, upsert };
}

function one<T>(db: SqliteD1, sql: string, ...bindings: SQLInputValue[]): T {
  return db.sqlite.prepare(sql).get(...bindings) as T;
}

function many<T>(db: SqliteD1, sql: string, ...bindings: SQLInputValue[]): T[] {
  return db.sqlite.prepare(sql).all(...bindings) as T[];
}

async function seedVersionedEntry(
  harness: Harness,
  input: {
    entryId?: string;
    content: string;
    owner?: string;
    private?: boolean;
    epistemicStatus?: "candidate" | "reviewed" | "canonical";
    sourceUrl?: string;
    title?: string;
    contentType?: string;
  },
  now: number,
) {
  return commitEntryVersion({
    kind: "capture",
    actorUserId: input.owner ?? "user-owner",
    entryId: input.entryId,
    rawContent: input.content,
    materializedContent: input.content,
    tags: ["status:draft", ...(input.private === false ? [] : ["private"])],
    source: "test",
    sourceUrl: input.sourceUrl,
    title: input.title,
    contentType: input.contentType,
    visibility: input.private === false ? "public" : "private",
    epistemicStatus: input.epistemicStatus ?? "candidate",
    now,
  }, harness.env);
}

async function approveAndExecute(
  harness: Harness,
  input: {
    actionType: ActionType;
    payload: Record<string, unknown>;
    expectedRevision?: number;
    visibilityScope?: "private" | "team";
    key: string;
    now: number;
  },
) {
  const proposal = await createActionProposal(harness.env, {
    actor: serviceActor(),
    actionType: input.actionType,
    payload: input.payload,
    expectedRevision: input.expectedRevision,
    visibilityScope: input.visibilityScope,
    reason: `Test ${input.actionType}`,
    idempotencyKey: input.key,
    now: input.now,
  });
  await reviewActionProposal(harness.env, {
    actor: human,
    proposalId: proposal.id,
    decision: "approve",
    reason: "Reviewed in executor integration test",
    now: input.now + 1,
  });
  const result = await executeApprovedProposal(harness.env, {
    actor: serviceActor(),
    proposalId: proposal.id,
    now: input.now + 2,
  });
  const retried = await executeApprovedProposal(harness.env, {
    actor: serviceActor(),
    proposalId: proposal.id,
    now: input.now + 3,
  });
  expect(retried).toEqual(result);
  return { proposal, result };
}

describe("operator governance policy", () => {
  it("allows only safe private draft candidate capture as a direct service write", () => {
    const actor = serviceActor();
    const safe = decideOperatorAction({
      actor,
      operation: "entry.create",
      autonomyProfile: "propose",
      directCapture: {
        visibility: "private",
        lifecycleStatus: "draft",
        epistemicStatus: "candidate",
        mayMerge: false,
        mayAutoDeprecate: false,
      },
    });
    expect(safe.effect).toBe("allow");
    expect(decideOperatorAction({
      actor,
      operation: "entry.create",
      autonomyProfile: "propose",
      directCapture: {
        visibility: "public",
        lifecycleStatus: "draft",
        epistemicStatus: "candidate",
      },
    }).effect).toBe("proposal_required");
    expect(decideOperatorAction({ actor, operation: "entry.update", autonomyProfile: "propose" }).effect).toBe("proposal_required");
    expect(decideOperatorAction({ actor, operation: "entry.forget" }).effect).toBe("deny");
    expect(decideOperatorAction({ actor, operation: "edge.unlink" }).effect).toBe("deny");
    expect(decideOperatorAction({ actor, operation: "proposal.approve" }).effect).toBe("deny");
  });

  it("enforces autonomy profiles independently from credential scopes", () => {
    const actor = serviceActor();
    const safeDraft = {
      visibility: "private" as const,
      lifecycleStatus: "draft" as const,
      epistemicStatus: "candidate" as const,
      mayMerge: false,
      mayAutoDeprecate: false,
    };

    expect(decideOperatorAction({
      actor,
      operation: "entry.create",
      directCapture: safeDraft,
      autonomyProfile: "observe",
    })).toMatchObject({ effect: "deny", reasonCode: "autonomy_profile_insufficient" });
    expect(decideOperatorAction({
      actor,
      operation: "entry.create",
      directCapture: safeDraft,
      autonomyProfile: "draft",
    }).effect).toBe("allow");
    expect(decideOperatorAction({
      actor,
      operation: "proposal.create",
      proposedAction: "entry.update",
      autonomyProfile: "draft",
    })).toMatchObject({ effect: "deny", reasonCode: "autonomy_profile_insufficient" });
    expect(decideOperatorAction({
      actor,
      operation: "proposal.create",
      proposedAction: "entry.update",
      autonomyProfile: "propose",
    }).effect).toBe("allow");
    expect(decideOperatorAction({
      actor,
      operation: "proposal.execute",
      autonomyProfile: "propose",
    })).toMatchObject({ effect: "deny", reasonCode: "autonomy_profile_insufficient" });
    expect(decideOperatorAction({
      actor,
      operation: "proposal.execute",
      autonomyProfile: "execute-approved",
    }).effect).toBe("allow");
    expect(decideOperatorAction({
      actor,
      operation: "memory.read",
      autonomyProfile: "unknown",
    })).toMatchObject({ effect: "deny", reasonCode: "invalid_autonomy_profile" });
  });

  it("denies claimed scopes that are not persisted on the credential", async () => {
    const harness = makeHarness(["memory:draft", "audit:write", "run:write"]);
    await expect(verifyServiceActor(harness.env, serviceActor(), 100)).rejects.toBeInstanceOf(ServiceActorValidationError);
  });

  it("binds a service actor to its persisted owner", async () => {
    const harness = makeHarness();
    await expect(verifyServiceActor(harness.env, {
      ...serviceActor(),
      ownerUserId: "user-reviewer",
    }, 100)).rejects.toMatchObject({ code: "invalid_actor" });
  });

  it("preserves an authenticated request's narrower scope set", async () => {
    const harness = makeHarness();
    await expect(captureServicePrivateDraft(harness.env, {
      actor: serviceActor(["audit:write", "run:write"]),
      content: "Must not gain memory:draft from the credential",
      now: 100,
    })).rejects.toBeInstanceOf(OperatorPolicyError);
    expect(one<{ count: number }>(harness.db, `SELECT COUNT(*) AS count FROM entries`).count).toBe(0);
  });
});

describe("mandatory operator audit", () => {
  it("does not mutate memory when the requested audit record cannot persist", async () => {
    const harness = makeHarness(["memory:draft", "audit:write", "run:write"]);
    harness.db.failOn = /INSERT INTO agent_runs/;
    await expect(captureServicePrivateDraft(harness.env, {
      actor: serviceActor(["memory:draft", "audit:write", "run:write"]),
      content: "Never written when audit is down",
      now: 100,
    })).rejects.toBeInstanceOf(MandatoryAuditError);
    expect(one<{ count: number }>(harness.db, `SELECT COUNT(*) AS count FROM entries`).count).toBe(0);
    expect(harness.upsert).not.toHaveBeenCalled();
  });

  it("records request before a private draft candidate and never audits raw content", async () => {
    const harness = makeHarness(["memory:draft", "audit:write", "run:write"]);
    const secret = "private plan alpha";
    const result = await captureServicePrivateDraft(harness.env, {
      actor: serviceActor(["memory:draft", "audit:write", "run:write"]),
      content: secret,
      tags: ["team", "status:canonical"],
      now: 200,
    });
    const entry = one<{ tags: string; visibility: string; epistemic_status: string; revision: number }>(
      harness.db,
      `SELECT tags, visibility, epistemic_status, revision FROM entries WHERE id = ?`,
      result.entryId,
    );
    expect(entry.visibility).toBe("private");
    expect(entry.epistemic_status).toBe("candidate");
    expect(JSON.parse(entry.tags)).toEqual(expect.arrayContaining(["team", "status:draft", "private"]));
    expect(entry.tags).not.toContain("status:canonical");
    expect(many<{ status: string }>(harness.db, `SELECT status FROM agent_runs`)).toEqual([{ status: "succeeded" }]);
    expect(many<{ event_type: string }>(harness.db, `SELECT event_type FROM agent_events ORDER BY sequence`))
      .toEqual([{ event_type: "requested" }, { event_type: "succeeded" }]);
    const auditText = JSON.stringify(many(harness.db, `SELECT * FROM agent_runs`))
      + JSON.stringify(many(harness.db, `SELECT * FROM agent_events`));
    expect(auditText).not.toContain(secret);
  });

  it("durably reconciles a succeeded mutation when the completion audit batch fails", async () => {
    const harness = makeHarness(["memory:draft", "audit:write", "run:write"]);
    const secret = "completion retry must never store this raw draft";
    harness.db.failOn = /UPDATE agent_runs\s+SET completed_at/;
    harness.db.failRemaining = 1;

    await expect(captureServicePrivateDraft(harness.env, {
      actor: serviceActor(["memory:draft", "audit:write", "run:write"]),
      content: secret,
      now: 275,
    })).rejects.toMatchObject({
      name: "MandatoryAuditError",
      stage: "succeeded",
    });

    expect(one<{ count: number }>(harness.db, `SELECT COUNT(*) AS count FROM entries`).count).toBe(1);
    expect(one<{ status: string }>(harness.db, `SELECT status FROM agent_runs`).status).toBe("succeeded");
    expect(one<{ status: string; outcome: string }>(
      harness.db,
      `SELECT status, outcome FROM audit_completion_reconciliation`,
    )).toEqual({ status: "ready", outcome: "succeeded" });
    expect(many<{ event_type: string }>(
      harness.db,
      `SELECT event_type FROM agent_events ORDER BY sequence`,
    )).toEqual([{ event_type: "requested" }]);

    harness.db.failOn = null;
    harness.db.failRemaining = null;
    await expect(reconcileMandatoryAuditCompletions(harness.env, { now: 500 }))
      .resolves.toMatchObject({ completed: 1, retried: 0, deadLettered: 0 });
    expect(many<{ event_type: string }>(
      harness.db,
      `SELECT event_type FROM agent_events ORDER BY sequence`,
    )).toEqual([{ event_type: "requested" }, { event_type: "succeeded" }]);
    expect(one<{ status: string }>(
      harness.db,
      `SELECT status FROM audit_completion_reconciliation`,
    ).status).toBe("completed");

    await expect(reconcileMandatoryAuditCompletions(harness.env, { now: 600 }))
      .resolves.toMatchObject({ completed: 0, retried: 0, deadLettered: 0 });
    const auditText = JSON.stringify(many(harness.db, `SELECT * FROM agent_runs`))
      + JSON.stringify(many(harness.db, `SELECT * FROM agent_events`))
      + JSON.stringify(many(harness.db, `SELECT * FROM audit_completion_reconciliation`));
    expect(auditText).not.toContain(secret);
  });

  it("closes a stale pre-action reservation as indeterminate instead of guessing", async () => {
    const harness = makeHarness(["memory:draft", "audit:write", "run:write"]);
    harness.db.sqlite.exec(`
      INSERT INTO agent_runs (
        id, user_id, started_at, tool_count, actor_kind, actor_id,
        auth_method, autonomy_profile, policy_version, status,
        requested_scopes, granted_scopes, target_ids, requested_at
      ) VALUES (
        'stale-run', 'user-owner', 100, 1, 'service', 'service-hermes',
        'sbs-key', 'draft', 'operator-policy-v1', 'requested',
        '[]', '[]', '[]', 100
      );
      INSERT INTO agent_events (
        id, run_id, sequence, event_type, tool_name, actor_kind, actor_id,
        auth_method, autonomy_profile, policy_version, status,
        requested_scopes, granted_scopes, target_ids, created_at
      ) VALUES (
        'stale-request', 'stale-run', 1, 'requested', 'remember',
        'service', 'service-hermes', 'sbs-key', 'draft',
        'operator-policy-v1', 'requested', '[]', '[]', '[]', 100
      );
      INSERT INTO audit_completion_reconciliation (
        run_id, status, attempts, created_at, updated_at
      ) VALUES ('stale-run', 'reserved', 0, 100, 100);
    `);

    await expect(reconcileMandatoryAuditCompletions(harness.env, {
      now: 2_000,
      reservedStaleAfterMs: 1_000,
    })).resolves.toMatchObject({ reservedRecovered: 1, completed: 1 });

    expect(one<{ status: string; error_code: string }>(
      harness.db,
      `SELECT status, error_code FROM agent_runs WHERE id = 'stale-run'`,
    )).toEqual({ status: "indeterminate", error_code: "audit_outcome_unconfirmed" });
    expect(one<{ event_type: string; error: string }>(
      harness.db,
      `SELECT event_type, error FROM agent_events WHERE run_id = 'stale-run' AND sequence = 2`,
    )).toEqual({ event_type: "indeterminate", error: "AuditOutcomeUnconfirmed" });
  });

  it("bounds terminal-event retries and leaves an attributable dead letter", async () => {
    const harness = makeHarness(["memory:draft", "audit:write", "run:write"]);
    harness.db.failOn = /UPDATE agent_runs\s+SET completed_at/;
    harness.db.failRemaining = 1;
    await expect(captureServicePrivateDraft(harness.env, {
      actor: serviceActor(["memory:draft", "audit:write", "run:write"]),
      content: "redacted dead-letter draft",
      now: 700,
    })).rejects.toBeInstanceOf(MandatoryAuditError);

    harness.db.failOn = /INSERT OR IGNORE INTO agent_events/;
    harness.db.failRemaining = null;
    await expect(reconcileMandatoryAuditCompletions(harness.env, {
      now: 800,
      maxAttempts: 1,
    })).resolves.toMatchObject({ completed: 0, deadLettered: 1 });
    expect(one<{ status: string; outcome: string; attempts: number; last_error: string }>(
      harness.db,
      `SELECT status, outcome, attempts, last_error FROM audit_completion_reconciliation`,
    )).toEqual({
      status: "dead_letter",
      outcome: "succeeded",
      attempts: 1,
      last_error: "Error",
    });
    expect(one<{ status: string }>(harness.db, `SELECT status FROM agent_runs`).status).toBe("succeeded");
  });

  it("returns the original private draft when an idempotency key is retried", async () => {
    const harness = makeHarness(["memory:draft", "audit:write", "run:write"]);
    const request = {
      actor: serviceActor(["memory:draft", "audit:write", "run:write"]),
      content: "Retry-safe private plan",
      tags: ["team"],
      idempotencyKey: "draft-retry-1",
    } as const;
    const created = await captureServicePrivateDraft(harness.env, { ...request, now: 300 });
    const retried = await captureServicePrivateDraft(harness.env, { ...request, now: 400 });

    expect(retried).toEqual(created);
    expect(one<{ count: number }>(harness.db, `SELECT COUNT(*) AS count FROM entries`).count).toBe(1);
    expect(one<{ count: number }>(harness.db, `SELECT COUNT(*) AS count FROM episodes`).count).toBe(1);
    expect(many<{ status: string }>(harness.db, `SELECT status FROM agent_runs`))
      .toEqual([{ status: "succeeded" }, { status: "succeeded" }]);
  });

  it("rejects reusing an idempotency key for different draft content", async () => {
    const harness = makeHarness(["memory:draft", "audit:write", "run:write"]);
    const actor = serviceActor(["memory:draft", "audit:write", "run:write"]);
    await captureServicePrivateDraft(harness.env, {
      actor,
      content: "Original private plan",
      idempotencyKey: "draft-conflict-1",
      now: 500,
    });

    await expect(captureServicePrivateDraft(harness.env, {
      actor,
      content: "Different private plan",
      idempotencyKey: "draft-conflict-1",
      now: 600,
    })).rejects.toBeInstanceOf(OperatorDraftIdempotencyError);
    expect(one<{ count: number }>(harness.db, `SELECT COUNT(*) AS count FROM entries`).count).toBe(1);
  });
});

describe("generic action proposal state machine", () => {
  let harness: Harness;

  beforeEach(() => {
    harness = makeHarness();
  });

  it("uses persisted proposer and executor profiles instead of caller or proposal claims", async () => {
    const observeHarness = makeHarness(ALL_SERVICE_SCOPES, "observe");
    await expect(createActionProposal(observeHarness.env, {
      actor: serviceActor(),
      actionType: "entry.create",
      payload: { content: "Caller cannot elevate an observe-only service" },
      reason: "Attempted caller profile escalation",
      idempotencyKey: "profile-caller-escalation",
      autonomyProfile: "execute-approved",
      now: 250,
    } as Parameters<typeof createActionProposal>[1] & { autonomyProfile: string }))
      .rejects.toBeInstanceOf(OperatorPolicyError);
    expect(one<{ count: number }>(observeHarness.db, `SELECT COUNT(*) AS count FROM action_proposals`).count).toBe(0);

    const proposeHarness = makeHarness(ALL_SERVICE_SCOPES, "propose");
    const proposal = await createActionProposal(proposeHarness.env, {
      actor: serviceActor(),
      actionType: "entry.create",
      payload: { content: "Proposal profile must not authorize its executor" },
      reason: "Test executor profile revalidation",
      idempotencyKey: "profile-executor-recheck",
      now: 260,
    });
    expect(proposal.autonomyProfile).toBe("propose");
    await reviewActionProposal(proposeHarness.env, {
      actor: human,
      proposalId: proposal.id,
      decision: "approve",
      reason: "Approved by human",
      now: 261,
    });
    proposeHarness.db.sqlite.prepare(
      `UPDATE action_proposals SET autonomy_profile = 'execute-approved' WHERE id = ?`,
    ).run(proposal.id);
    await expect(executeApprovedProposal(proposeHarness.env, {
      actor: serviceActor(),
      proposalId: proposal.id,
      now: 262,
    })).rejects.toMatchObject({ decision: { reasonCode: "autonomy_profile_insufficient" } });
    expect((await getActionProposal(proposeHarness.env, proposal.id))?.status).toBe("pending");
  });

  it("creates idempotently, requires human review, executes once, and resumes idempotently", async () => {
    const createInput = {
      actor: serviceActor(),
      actionType: "entry.create" as const,
      payload: {
        content: "Human-approved shared fact",
        visibility: "public",
        lifecycleStatus: "canonical",
        epistemicStatus: "reviewed",
        tags: ["shared"],
      },
      reason: "Share a reviewed team fact",
      idempotencyKey: "proposal-team-fact-1",
      now: 300,
    };
    const proposal = await createActionProposal(harness.env, createInput);
    const repeated = await createActionProposal(harness.env, createInput);
    expect(repeated.id).toBe(proposal.id);
    expect(one<{ count: number }>(harness.db, `SELECT COUNT(*) AS count FROM action_proposals`).count).toBe(1);
    expect(one<{ count: number }>(harness.db, `SELECT COUNT(*) AS count FROM proposal_events WHERE event_type = 'created'`).count).toBe(1);
    await expect(createActionProposal(harness.env, {
      ...createInput,
      reason: "Different request using the same key",
    })).rejects.toMatchObject({ code: "idempotency_conflict" });

    await expect(reviewActionProposal(harness.env, {
      actor: serviceActor(),
      proposalId: proposal.id,
      decision: "approve",
      reason: "service cannot self-approve",
      now: 310,
    })).rejects.toBeInstanceOf(OperatorPolicyError);

    const approved = await reviewActionProposal(harness.env, {
      actor: human,
      proposalId: proposal.id,
      decision: "approve",
      reason: "Evidence checked",
      now: 320,
    });
    expect(approved.status).toBe("pending");
    expect(approved.reviewerKind).toBe("human");
    await reviewActionProposal(harness.env, {
      actor: human,
      proposalId: proposal.id,
      decision: "approve",
      reason: "Evidence checked",
      now: 321,
    });
    expect(one<{ count: number }>(harness.db, `SELECT COUNT(*) AS count FROM proposal_events WHERE event_type = 'approved'`).count).toBe(1);

    const executed = await executeApprovedProposal(harness.env, {
      actor: serviceActor(),
      proposalId: proposal.id,
      now: 330,
    });
    const retried = await executeApprovedProposal(harness.env, {
      actor: serviceActor(),
      proposalId: proposal.id,
      now: 340,
    });
    expect(retried).toEqual(executed);
    expect(executed.actionType).toBe("entry.create");
    if (!("entryId" in executed)) throw new Error("Expected entry execution result");
    expect(one<{ count: number }>(harness.db, `SELECT COUNT(*) AS count FROM entries WHERE id = ?`, executed.entryId).count).toBe(1);
    expect(one<{ count: number }>(harness.db, `SELECT COUNT(*) AS count FROM episodes WHERE mutation_id = ?`, `proposal:${proposal.id}`).count).toBe(1);
    expect(one<{ status: string }>(harness.db, `SELECT status FROM action_proposals WHERE id = ?`, proposal.id).status).toBe("executed");
    expect(many<{ event_type: string }>(
      harness.db,
      `SELECT event_type FROM proposal_events WHERE proposal_id = ? ORDER BY sequence`,
      proposal.id,
    ).map((row) => row.event_type)).toEqual(["created", "approved", "executing", "executed"]);
    const entry = one<{ visibility: string; epistemic_status: string; tags: string }>(
      harness.db,
      `SELECT visibility, epistemic_status, tags FROM entries WHERE id = ?`,
      executed.entryId,
    );
    expect(entry.visibility).toBe("public");
    expect(entry.epistemic_status).toBe("reviewed");
    expect(JSON.parse(entry.tags)).toContain("status:canonical");
  });

  it("marks an approved proposal stale when its entry precondition changed", async () => {
    const proposal = await createActionProposal(harness.env, {
      actor: serviceActor(),
      actionType: "entry.create",
      payload: { content: "Will become stale" },
      reason: "Candidate fact",
      idempotencyKey: "proposal-stale-1",
      now: 400,
    });
    await reviewActionProposal(harness.env, {
      actor: human,
      proposalId: proposal.id,
      decision: "approve",
      reason: "Approved before race",
      now: 410,
    });
    const targetId = proposal.targetIds[0];
    harness.db.sqlite.prepare(
      `INSERT INTO entries (
         id, content, tags, source, created_at, vector_ids, owner_user_id,
         valid_from, recorded_at, current_episode_id, revision,
         created_by_user_id, visibility, updated_at
       ) VALUES (?, 'competing', '["status:draft","private"]', 'human', 415, '[]',
                 'user-owner', 415, 415, NULL, 1, 'user-owner', 'private', 415)`,
    ).run(targetId);

    await expect(executeApprovedProposal(harness.env, {
      actor: serviceActor(),
      proposalId: proposal.id,
      now: 420,
    })).rejects.toMatchObject({ code: "stale" });
    expect((await getActionProposal(harness.env, proposal.id))?.status).toBe("stale");
    expect(one<{ count: number }>(harness.db, `SELECT COUNT(*) AS count FROM episodes WHERE mutation_id = ?`, `proposal:${proposal.id}`).count).toBe(0);
  });
});

describe("explicit governed action executors", () => {
  let harness: Harness;

  beforeEach(() => {
    harness = makeHarness();
  });

  it("executes append, update, lifecycle, and epistemic mutations as immutable revisions", async () => {
    const seeded = await seedVersionedEntry(harness, { content: "Initial memory" }, 1_000);

    const appended = await approveAndExecute(harness, {
      actionType: "entry.append",
      payload: { entryId: seeded.entryId, addition: "Approved addendum" },
      expectedRevision: 1,
      key: "executor-append",
      now: 1_100,
    });
    expect(appended.result).toMatchObject({ actionType: "entry.append", entryId: seeded.entryId, revision: 2 });
    expect(one<{ content: string }>(harness.db, `SELECT content FROM entries WHERE id = ?`, seeded.entryId).content)
      .toContain("Approved addendum");

    const updated = await approveAndExecute(harness, {
      actionType: "entry.update",
      payload: { entryId: seeded.entryId, content: "Approved replacement" },
      expectedRevision: 2,
      key: "executor-update",
      now: 1_200,
    });
    expect(updated.result).toMatchObject({ actionType: "entry.update", entryId: seeded.entryId, revision: 3 });

    const lifecycle = await approveAndExecute(harness, {
      actionType: "entry.status.set",
      payload: { entryId: seeded.entryId, status: "canonical" },
      expectedRevision: 3,
      key: "executor-status",
      now: 1_300,
    });
    expect(lifecycle.result).toMatchObject({ actionType: "entry.status.set", entryId: seeded.entryId, revision: 4 });

    const epistemic = await approveAndExecute(harness, {
      actionType: "entry.epistemic-status.set",
      payload: { entryId: seeded.entryId, status: "reviewed" },
      expectedRevision: 4,
      key: "executor-epistemic",
      now: 1_400,
    });
    expect(epistemic.result).toMatchObject({ actionType: "entry.epistemic-status.set", entryId: seeded.entryId, revision: 5 });

    const entry = one<{ content: string; tags: string; epistemic_status: string; revision: number }>(
      harness.db,
      `SELECT content, tags, epistemic_status, revision FROM entries WHERE id = ?`,
      seeded.entryId,
    );
    expect(entry).toMatchObject({ content: "Approved replacement", epistemic_status: "reviewed", revision: 5 });
    expect(JSON.parse(entry.tags)).toContain("status:canonical");
    expect(many<{ mutation_kind: string }>(
      harness.db,
      `SELECT mutation_kind FROM episodes WHERE entry_id = ? ORDER BY created_at, id`,
      seeded.entryId,
    ).map((row) => row.mutation_kind)).toEqual(["capture", "append", "update", "status", "status"]);
  });

  it("restores an owned snapshot into a new private draft candidate", async () => {
    const seeded = await seedVersionedEntry(harness, {
      content: "Original value",
      sourceUrl: "doi:10.1000/operator-history",
      contentType: "research",
    }, 2_000);
    await commitEntryVersion({
      kind: "update",
      actorUserId: "user-owner",
      entryId: seeded.entryId,
      expectedRevision: 1,
      rawContent: "Changed value",
      materializedContent: "Changed value",
      mutationId: "human-change-before-restore",
      now: 2_010,
    }, harness.env);
    const snapshot = one<{ id: string }>(
      harness.db,
      `SELECT id FROM entry_snapshots WHERE entry_id = ? AND mutation_id = ?`,
      seeded.entryId,
      "human-change-before-restore",
    );

    const restored = await approveAndExecute(harness, {
      actionType: "entry.restore",
      payload: { entryId: seeded.entryId, snapshotId: snapshot.id },
      expectedRevision: 2,
      key: "executor-restore",
      now: 2_100,
    });
    expect(restored.result.actionType).toBe("entry.restore");
    if (!("entryId" in restored.result)) throw new Error("Expected entry execution result");
    expect(restored.result.entryId).not.toBe(seeded.entryId);
    const entry = one<{ content: string; owner_user_id: string; visibility: string; epistemic_status: string; tags: string }>(
      harness.db,
      `SELECT content, owner_user_id, visibility, epistemic_status, tags FROM entries WHERE id = ?`,
      restored.result.entryId,
    );
    expect(entry).toMatchObject({
      content: "Original value",
      owner_user_id: "user-owner",
      visibility: "private",
      epistemic_status: "candidate",
    });
    expect(JSON.parse(entry.tags)).toEqual(expect.arrayContaining(["restored", "status:draft", "private"]));
    const restoredEnvelope = one<{ title: string; title_origin: string; source_url: string; content_type: string }>(
      harness.db,
      `SELECT d.title, d.title_origin, d.source_url, ep.content_type
       FROM entries e
       JOIN episodes ep ON ep.id = e.current_episode_id
       JOIN documents d ON d.episode_id = ep.id AND d.owner_user_id = e.owner_user_id
       WHERE e.id = ?`,
      restored.result.entryId,
    );
    expect(restoredEnvelope).toEqual({
      title: "doi:10.1000/operator-history",
      title_origin: "generated",
      source_url: "doi:10.1000/operator-history",
      content_type: "research",
    });
  });

  it("forces an operator restore of a public snapshot into a private draft candidate", async () => {
    const seeded = await seedVersionedEntry(harness, {
      content: "Originally public value",
      private: false,
    }, 2_200);
    await commitEntryVersion({
      kind: "update",
      actorUserId: "user-owner",
      entryId: seeded.entryId,
      expectedRevision: 1,
      rawContent: "Later public value",
      materializedContent: "Later public value",
      mutationId: "public-change-before-restore",
      now: 2_210,
    }, harness.env);
    const snapshot = one<{ id: string }>(
      harness.db,
      `SELECT id FROM entry_snapshots WHERE entry_id = ? AND mutation_id = ?`,
      seeded.entryId,
      "public-change-before-restore",
    );

    const restored = await approveAndExecute(harness, {
      actionType: "entry.restore",
      payload: { entryId: seeded.entryId, snapshotId: snapshot.id },
      expectedRevision: 2,
      key: "executor-public-restore-private",
      now: 2_300,
    });
    if (!("entryId" in restored.result)) throw new Error("Expected entry execution result");
    const entry = one<{ visibility: string; tags: string }>(
      harness.db,
      `SELECT visibility, tags FROM entries WHERE id = ?`,
      restored.result.entryId,
    );
    expect(entry.visibility).toBe("private");
    expect(JSON.parse(entry.tags)).toEqual(expect.arrayContaining(["restored", "status:draft", "private"]));
  });

  it("deprecates through the cleanup queue protocol without leaving active vectors", async () => {
    const seeded = await seedVersionedEntry(harness, { content: "Outdated memory" }, 3_000);
    const deprecated = await approveAndExecute(harness, {
      actionType: "entry.status.set",
      payload: { entryId: seeded.entryId, status: "deprecated" },
      expectedRevision: 1,
      key: "executor-deprecate",
      now: 3_100,
    });
    expect(deprecated.result).toMatchObject({ actionType: "entry.status.set", revision: 2 });
    const entry = one<{ tags: string; vector_ids: string }>(
      harness.db,
      `SELECT tags, vector_ids FROM entries WHERE id = ?`,
      seeded.entryId,
    );
    expect(JSON.parse(entry.tags)).toContain("status:deprecated");
    expect(entry.vector_ids).toBe("[]");
    expect(one<{ count: number }>(
      harness.db,
      `SELECT COUNT(*) AS count FROM vector_cleanup_queue WHERE id = ?`,
      `proposal-deprecate:${deprecated.proposal.id}`,
    ).count).toBe(0);
  });

  it("rechecks an existing entry revision after approval and marks a raced proposal stale", async () => {
    const seeded = await seedVersionedEntry(harness, { content: "Before race" }, 3_500);
    const proposal = await createActionProposal(harness.env, {
      actor: serviceActor(),
      actionType: "entry.update",
      payload: { entryId: seeded.entryId, content: "Approved but raced" },
      expectedRevision: 1,
      reason: "Revision must still match at execution",
      idempotencyKey: "executor-revision-race",
      now: 3_510,
    });
    await reviewActionProposal(harness.env, {
      actor: human,
      proposalId: proposal.id,
      decision: "approve",
      reason: "Approved before concurrent edit",
      now: 3_520,
    });
    await commitEntryVersion({
      kind: "update",
      actorUserId: "user-owner",
      entryId: seeded.entryId,
      expectedRevision: 1,
      rawContent: "Concurrent human edit",
      materializedContent: "Concurrent human edit",
      mutationId: "concurrent-human-edit",
      now: 3_530,
    }, harness.env);

    await expect(executeApprovedProposal(harness.env, {
      actor: serviceActor(),
      proposalId: proposal.id,
      now: 3_540,
    })).rejects.toMatchObject({ code: "stale" });
    expect((await getActionProposal(harness.env, proposal.id))?.status).toBe("stale");
    expect(one<{ count: number }>(
      harness.db,
      `SELECT COUNT(*) AS count FROM episodes WHERE mutation_id = ?`,
      `proposal:${proposal.id}`,
    ).count).toBe(0);
  });

  it("publishes and removes typed public edges with proposal provenance", async () => {
    const source = await seedVersionedEntry(harness, { content: "Public source", private: false }, 4_000);
    const target = await seedVersionedEntry(harness, {
      content: "Public target",
      owner: human.userId,
      private: false,
    }, 4_010);

    const published = await approveAndExecute(harness, {
      actionType: "edge.publish",
      payload: {
        sourceId: source.entryId,
        targetId: target.entryId,
        type: "supports",
        confidence: 0.9,
      },
      visibilityScope: "team",
      key: "executor-edge-publish",
      now: 4_100,
    });
    expect(published.result).toMatchObject({
      actionType: "edge.publish",
      sourceId: source.entryId,
      targetId: target.entryId,
      edgeType: "supports",
    });
    const edge = one<{ provenance: string; confidence: number; metadata: string }>(
      harness.db,
      `SELECT provenance, confidence, metadata FROM edges
       WHERE source_id = ? AND target_id = ? AND type = 'supports'`,
      source.entryId,
      target.entryId,
    );
    expect(edge).toMatchObject({ provenance: "explicit", confidence: 0.9 });
    expect(JSON.parse(edge.metadata)).toMatchObject({ proposal_id: published.proposal.id, reviewer_id: human.userId });

    const removed = await approveAndExecute(harness, {
      actionType: "edge.remove",
      payload: { sourceId: source.entryId, targetId: target.entryId, type: "supports" },
      visibilityScope: "team",
      key: "executor-edge-remove",
      now: 4_200,
    });
    expect(removed.result).toMatchObject({ actionType: "edge.remove", edgeType: "supports" });
    expect(one<{ count: number }>(
      harness.db,
      `SELECT COUNT(*) AS count FROM edges WHERE source_id = ? AND target_id = ? AND type = 'supports'`,
      source.entryId,
      target.entryId,
    ).count).toBe(0);
  });

  it("rejects stale, cross-owner private, team-visible private, and removed merge actions", async () => {
    const owned = await seedVersionedEntry(harness, { content: "Owned private" }, 5_000);
    const other = await seedVersionedEntry(harness, {
      content: "Other private",
      owner: human.userId,
    }, 5_010);

    await expect(createActionProposal(harness.env, {
      actor: serviceActor(),
      actionType: "entry.update",
      payload: { entryId: owned.entryId, content: "No revision" },
      reason: "Missing revision must fail",
      idempotencyKey: "executor-missing-revision",
    })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(createActionProposal(harness.env, {
      actor: serviceActor(),
      actionType: "entry.update",
      payload: { entryId: owned.entryId, content: "Would leak" },
      expectedRevision: 1,
      visibilityScope: "team",
      reason: "Private inbox must remain private",
      idempotencyKey: "executor-private-team",
    })).rejects.toMatchObject({ code: "forbidden" });
    await expect(createActionProposal(harness.env, {
      actor: serviceActor(),
      actionType: "edge.publish",
      payload: { sourceId: owned.entryId, targetId: other.entryId, type: "supports" },
      reason: "Cross-owner private edge must fail",
      idempotencyKey: "executor-private-cross-owner",
    })).rejects.toMatchObject({ code: "not_found" });
    expect(ACTION_TYPES).not.toContain("entry.merge");
    await expect(createActionProposal(harness.env, {
      actor: serviceActor(),
      actionType: "entry.merge" as ActionType,
      payload: { entryId: owned.entryId, content: "unsafe" },
      reason: "Removed action must fail closed",
      idempotencyKey: "executor-removed-merge",
    })).rejects.toMatchObject({ code: "invalid_input" });
  });
});

function configureNightlyCandidate(
  harness: Harness,
  targetEntryId: string,
  classifier: Record<string, unknown> | Error,
  score = 0.96,
) {
  const targetEpisodeId = one<{ current_episode_id: string }>(
    harness.db,
    `SELECT current_episode_id FROM entries WHERE id = ?`,
    targetEntryId,
  ).current_episode_id;
  const run = vi.fn(async (model: string) => {
    if (model === "@cf/baai/bge-small-en-v1.5") {
      return { data: [new Array(384).fill(0.01)] };
    }
    if (classifier instanceof Error) throw classifier;
    return { response: JSON.stringify(classifier) };
  });
  const query = vi.fn(async () => ({
    matches: [{
      id: `vector:${targetEntryId}`,
      score,
      metadata: { parentId: targetEntryId, episodeId: targetEpisodeId, is_private: false },
    }],
  }));
  (harness.env as any).AI = { run };
  (harness.env.VECTORIZE as any).query = query;
  return { run, query };
}

describe("nightly governed contradiction proposals", () => {
  let harness: Harness;

  beforeEach(() => {
    harness = makeHarness();
  });

  async function seedPair(leftContent: string, rightContent: string) {
    const now = Date.now();
    const leftEntry = await seedVersionedEntry(harness, {
      entryId: "nightly-left",
      content: leftContent,
      owner: "user-owner",
      private: false,
    }, now - 10);
    const rightEntry = await seedVersionedEntry(harness, {
      entryId: "nightly-right",
      content: rightContent,
      owner: human.userId,
      private: false,
    }, now);
    return { leftEntry, rightEntry };
  }

  it("uses similarity only for candidates and makes identical statements a no-op", async () => {
    const pair = await seedPair(
      "Project Atlas launches Friday.",
      "Project Atlas launches Friday.",
    );
    const configured = configureNightlyCandidate(harness, pair.rightEntry.entryId, {
      relationship: "direct_contradiction",
      confidence: 0.99,
      reason: "should never be consulted",
      left_quote: "Project Atlas launches Friday.",
      right_quote: "Project Atlas launches Friday.",
    });

    await expect(detectCrossUserContradictions(harness.env)).resolves.toMatchObject({ proposals: 0 });
    expect(configured.run.mock.calls.filter(([model]) => model === LLM_MODEL)).toHaveLength(0);
    expect(one<{ count: number }>(harness.db, `SELECT COUNT(*) AS count FROM action_proposals`).count).toBe(0);
    expect(one<{ count: number }>(harness.db, `SELECT COUNT(*) AS count FROM agent_runs`).count).toBe(0);
  });

  it("makes complementary statements a no-op after strict classification", async () => {
    const pair = await seedPair(
      "Project Atlas launches Friday.",
      "Project Atlas launch checklist is complete.",
    );
    configureNightlyCandidate(harness, pair.rightEntry.entryId, {
      relationship: "compatible",
      confidence: 0.98,
      reason: "A completed checklist is compatible with a Friday launch",
      left_quote: "",
      right_quote: "",
    });

    await expect(detectCrossUserContradictions(harness.env)).resolves.toMatchObject({ proposals: 0 });
    expect(one<{ count: number }>(harness.db, `SELECT COUNT(*) AS count FROM action_proposals`).count).toBe(0);
  });

  it("creates one audited team-visible edge.publish proposal for a confirmed contradiction", async () => {
    const pair = await seedPair(
      "Project Atlas launches on Friday.",
      "Project Atlas launch was cancelled.",
    );
    configureNightlyCandidate(harness, pair.rightEntry.entryId, {
      relationship: "direct_contradiction",
      confidence: 0.97,
      reason: "The scheduled launch was cancelled",
      left_quote: "launches on Friday",
      right_quote: "launch was cancelled",
    });

    await expect(detectCrossUserContradictions(harness.env)).resolves.toMatchObject({ proposals: 1 });
    const proposal = one<{
      id: string;
      action_type: string;
      proposer_kind: string;
      proposer_id: string;
      visibility_scope: string;
      payload_json: string;
      evidence_json: string;
      status: string;
      reviewer_id: string | null;
      idempotency_key: string;
    }>(harness.db, `SELECT * FROM action_proposals`);
    expect(proposal).toMatchObject({
      action_type: "edge.publish",
      proposer_kind: "system",
      proposer_id: "_nightly-contradiction-scan",
      visibility_scope: "team",
      status: "pending",
      reviewer_id: null,
    });
    expect(proposal.idempotency_key).toMatch(/^nightly-contradiction:[a-f0-9]{64}$/);
    expect(JSON.parse(proposal.payload_json)).toMatchObject({
      type: "contradicts",
      confidence: 0.97,
      weight: 0.97,
    });
    expect(new Set(JSON.parse(proposal.payload_json).sourceId
      ? [JSON.parse(proposal.payload_json).sourceId, JSON.parse(proposal.payload_json).targetId]
      : [])).toEqual(new Set([pair.leftEntry.entryId, pair.rightEntry.entryId]));
    expect(JSON.parse(proposal.evidence_json)[0]).toMatchObject({
      kind: "strict-contradiction-classification",
      confidence: 0.97,
      left: { quote: "launches on Friday" },
      right: { quote: "launch was cancelled" },
    });
    expect(one<{ count: number }>(harness.db, `SELECT COUNT(*) AS count FROM edge_proposals`).count).toBe(0);
    expect(one<{ count: number }>(harness.db, `SELECT COUNT(*) AS count FROM edges`).count).toBe(0);
    expect(one<{ status: string }>(harness.db, `SELECT status FROM agent_runs`)).toEqual({ status: "succeeded" });
    expect(many<{ event_type: string }>(
      harness.db,
      `SELECT event_type FROM agent_events ORDER BY sequence`,
    ).map(row => row.event_type)).toEqual(["requested", "succeeded"]);

    await reviewActionProposal(harness.env, {
      actor: human,
      proposalId: proposal.id,
      decision: "approve",
      reason: "Evidence confirms the direct conflict",
    });
    await expect(executeApprovedProposal(harness.env, {
      actor: human,
      proposalId: proposal.id,
    })).resolves.toMatchObject({
      actionType: "edge.publish",
      edgeType: "contradicts",
    });
    expect(one<{ count: number }>(
      harness.db,
      `SELECT COUNT(*) AS count FROM edges WHERE type = 'contradicts'`,
    ).count).toBe(1);
  });

  it("re-authorizes both endpoints and never classifies or exposes a private match", async () => {
    const now = Date.now();
    const publicEntry = await seedVersionedEntry(harness, {
      content: "Project Atlas launches Friday.",
      owner: "user-owner",
      private: false,
    }, now);
    const privateEntry = await seedVersionedEntry(harness, {
      content: "Private: Project Atlas launch was cancelled.",
      owner: human.userId,
      private: true,
    }, now);
    const configured = configureNightlyCandidate(harness, privateEntry.entryId, {
      relationship: "direct_contradiction",
      confidence: 0.99,
      reason: "private data must not reach this classifier",
      left_quote: "launches Friday",
      right_quote: "launch was cancelled",
    });

    await expect(detectCrossUserContradictions(harness.env)).resolves.toEqual({ scanned: 1, proposals: 0 });
    expect(publicEntry.entryId).not.toBe(privateEntry.entryId);
    expect(configured.run.mock.calls.filter(([model]) => model === LLM_MODEL)).toHaveLength(0);
    expect(one<{ count: number }>(harness.db, `SELECT COUNT(*) AS count FROM action_proposals`).count).toBe(0);
  });

  it("deduplicates both reverse candidates and later nightly retries with one stable key", async () => {
    const pair = await seedPair(
      "Project Atlas launches on Friday.",
      "Project Atlas launch was cancelled.",
    );
    const configured = configureNightlyCandidate(harness, pair.rightEntry.entryId, {
      relationship: "direct_contradiction",
      confidence: 0.97,
      reason: "The scheduled launch was cancelled",
      left_quote: "launches on Friday",
      right_quote: "launch was cancelled",
    });

    await expect(detectCrossUserContradictions(harness.env)).resolves.toMatchObject({ proposals: 1 });
    await expect(detectCrossUserContradictions(harness.env)).resolves.toMatchObject({ proposals: 0 });
    expect(one<{ count: number }>(harness.db, `SELECT COUNT(*) AS count FROM action_proposals`).count).toBe(1);
    expect(one<{ count: number }>(harness.db, `SELECT COUNT(*) AS count FROM agent_runs`).count).toBe(1);
    expect(configured.run.mock.calls.filter(([model]) => model === LLM_MODEL)).toHaveLength(1);
  });

  it("fails closed without a proposal or audit mutation when classification fails", async () => {
    const pair = await seedPair(
      "Project Atlas launches on Friday.",
      "Project Atlas launch was cancelled.",
    );
    configureNightlyCandidate(harness, pair.rightEntry.entryId, new Error("AI unavailable"));

    await expect(detectCrossUserContradictions(harness.env)).resolves.toMatchObject({ proposals: 0 });
    expect(one<{ count: number }>(harness.db, `SELECT COUNT(*) AS count FROM action_proposals`).count).toBe(0);
    expect(one<{ count: number }>(harness.db, `SELECT COUNT(*) AS count FROM agent_runs`).count).toBe(0);
  });
});
