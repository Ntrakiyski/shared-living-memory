import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv } from "../helpers/make-env";
import { hashRecallQuery, recordRecallEvent, submitRecallFeedback } from "../../src/recall-events";
import { computePilotMetrics } from "../../src/pilot-metrics";
import { defaultHandler } from "../../src/routes";
import { hmacKey, AUTH_PEPPER } from "../../src/auth";
import { initializeDatabase } from "../../src/db";
import { buildMcpServer } from "../../src/mcp";
import type { Env, HumanActorContext } from "../../src/types";

const ctx = { waitUntil: (_: Promise<unknown>) => {}, passThroughOnException: () => {} } as ExecutionContext;
const alice: HumanActorContext = { kind: "human", actorId: "alice", userId: "alice", role: "member", authMethod: "personal_api_key", scopes: new Set() };

describe("recall feedback bound to actual reads (real SQLite)", () => {
  let db: SqliteD1;
  let env: Env;
  beforeEach(async () => {
    db = new SqliteD1();
    env = makeTestEnv(undefined, { DB: db as unknown as D1Database });
    await initializeDatabase(env);
    for (const name of ["alice", "bob"]) {
      db.sqlite.prepare(`INSERT INTO users (id, username, normalized_username, auth_key_hash, auth_key_prefix, status, created_at, role)
        VALUES (?, ?, ?, ?, ?, 'active', 1, 'member')`).run(name, name, name, await hmacKey(`${name}-secret`, AUTH_PEPPER), `slm_${name}.`);
    }
    db.exec(`INSERT INTO entries (id, content, tags, source, created_at, vector_ids, owner_user_id, visibility)
      VALUES ('memory-a', 'silver compass decision', '["private"]', 'api', 5000, '[]', 'alice', 'private')`);
  });
  afterEach(() => db.close());

  const input = { userId: "alice", client: "rest" as const, query: "SILVER compass", resultEntryIds: ["memory-a"], semanticUnavailable: false, durationMs: 15 };
  const feedback = (id: string, userId = "alice", rating: "helpful" | "not_helpful" = "helpful") =>
    submitRecallFeedback(env, { recallEventId: id, userId, rating, reason: "other" }, 20);
  const call = (method: string, path: string, body?: unknown, user = "alice") => defaultHandler.fetch(new Request(`http://localhost${path}`, {
    method, headers: { Authorization: `Bearer slm_${user}.${user}-secret`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), env, ctx);

  it("uses a keyed SHA256 digest, never reversible query bytes or plaintext", async () => {
    const normalized = "recall-query:v1:silver compass";
    expect(await hashRecallQuery("  SILVER \n compass ", "secret")).toBe(createHmac("sha256", "secret").update(normalized).digest("hex"));
    expect(await hashRecallQuery("silver compass", "other-secret")).not.toBe(await hashRecallQuery("silver compass", "secret"));
    await expect(hashRecallQuery("query", "")).rejects.toThrow();
    const event = await recordRecallEvent(env, input, 10);
    const stored = db.one<any>("SELECT * FROM recall_events WHERE id = ?", event.recall_event_id!);
    expect(stored).toMatchObject({ user_id: "alice", result_entry_ids: '["memory-a"]', result_count: 1, duration_ms: 15, created_at: 10 });
    expect(stored.query_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(stored)).not.toContain("SILVER compass");
  });

  it("rejects fabricated and other-owner events, and updates a rating only for its owner", async () => {
    const event = await recordRecallEvent(env, input, 10);
    expect(await feedback("invented")).toBe(false);
    expect(await feedback(event.recall_event_id!, "bob")).toBe(false);
    expect(db.count("recall_feedback")).toBe(0);
    expect(await feedback(event.recall_event_id!)).toBe(true);
    expect(await feedback(event.recall_event_id!, "alice", "not_helpful")).toBe(true);
    expect(db.count("recall_feedback")).toBe(1);
    expect(db.one<any>("SELECT * FROM recall_feedback")).toMatchObject({ user_id: "alice", rating: "not_helpful" });
  });

  it("does not advertise unstored events, while feedback storage failures propagate", async () => {
    db.exec("DROP TABLE recall_events");
    expect(await recordRecallEvent(env, input)).toEqual({ recall_event_id: null, warnings: ["recall_feedback_unavailable"] });
    await expect(feedback("any")).rejects.toThrow(/recall_events/);
    const response = await call("POST", "/recall-feedback", { recall_event_id: "any", rating: "helpful" });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "storage_unavailable", retryable: true } });
  });

  it.each(["silver", "no-such-evidence"]) ("REST returns a stored event for query %s and accepts its rating", async (query) => {
    const response = await call("GET", `/recall?query=${query}&include_insight=false`);
    expect(response.status).toBe(200);
    const result = await response.json() as any;
    expect(result.recall_event_id).toEqual(expect.any(String));
    expect(db.one<any>("SELECT result_entry_ids FROM recall_events WHERE id = ?", result.recall_event_id).result_entry_ids).toBe(JSON.stringify(result.results.map((entry: any) => entry.id)));
    const rated = await call("POST", "/recall-feedback", { recall_event_id: result.recall_event_id, rating: "helpful" });
    expect(rated.status).toBe(200);
    for (const [id, user] of [["fabricated", "alice"], [result.recall_event_id, "bob"]]) {
      const denied = await call("POST", "/recall-feedback", { recall_event_id: id, rating: "helpful" }, user);
      expect(denied.status).toBe(404);
    }
  });

  it("personal MCP returns final result IDs and supports the complete feedback lifecycle", async () => {
    const tools = (buildMcpServer(env, ctx, alice, "full") as any)._registeredTools;
    const recalled = await tools.recall.handler({ query: "silver", include_insight: false }, {});
    const data = recalled.structuredContent.data;
    expect(data.recall_event_id).toEqual(expect.any(String));
    expect(db.one<any>("SELECT result_entry_ids FROM recall_events WHERE id = ?", data.recall_event_id).result_entry_ids).toBe(JSON.stringify(data.matches.map((match: any) => match.entry.entry_id)));
    const rated = await tools.rate_recall.handler({ recall_event_id: data.recall_event_id, rating: "helpful", reason: "other" }, {});
    expect(rated.structuredContent.data.recorded).toBe(true);
    const invented = await tools.rate_recall.handler({ recall_event_id: "invented", rating: "helpful", reason: "other" }, {});
    expect(invented.structuredContent.error.code).toBe("not_found_or_inaccessible");
  });

  it("maintenance recall performs no telemetry or domain mutation", async () => {
    env.SLM_WRITE_MODE = "read-only";
    const before = db.all("SELECT * FROM entries");
    const response = await call("GET", "/recall?query=silver&include_insight=false");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ recall_event_id: null, warnings: ["recall_feedback_unavailable"] });
    expect(db.count("recall_events")).toBe(0);
    expect(db.all("SELECT * FROM entries")).toEqual(before);
    const rated = await call("POST", "/recall-feedback", { recall_event_id: "any", rating: "helpful" });
    expect(rated.status).toBe(503);
    expect(db.count("recall_feedback")).toBe(0);
  });

  it("metrics ignore historical fabricated or mismatched-owner feedback", async () => {
    const event = await recordRecallEvent(env, input, 10);
    await feedback(event.recall_event_id!);
    const insert = db.sqlite.prepare("INSERT INTO recall_feedback (id,recall_event_id,user_id,rating,reason,created_at) VALUES (?,?,?,'not_helpful','other',20)");
    insert.run("legacy-fake", "made-up", "alice");
    insert.run("legacy-wrong-owner", event.recall_event_id!, "bob");
    expect(await computePilotMetrics(env, 1)).toMatchObject({ totalRecalls: 1, ratedCount: 1, helpfulRate: 1 });
  });
});
