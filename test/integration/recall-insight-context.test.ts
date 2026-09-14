import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv } from "../helpers/make-env";
import { recallEntries } from "../../src/recall";
import type { Env } from "../../src/types";

const ctx = { waitUntil: (_: Promise<unknown>) => {}, passThroughOnException: () => {} } as ExecutionContext;

describe("insight evidence uses authorized retrieval metadata (real SQLite)", () => {
  let db: SqliteD1;
  let env: Env;
  beforeEach(() => {
    db = new SqliteD1();
    env = makeTestEnv(undefined, { DB: db as unknown as D1Database });
    for (const id of ["alice", "bob"]) {
      db.sqlite.prepare(`INSERT INTO users (id,username,normalized_username,auth_key_hash,auth_key_prefix,status,created_at)
        VALUES (?,?,?,'hash','prefix','active',1)`).run(id, id, id);
    }
    const insert = db.sqlite.prepare(`INSERT INTO entries (id,content,tags,source,created_at,vector_ids,owner_user_id,visibility,revision,epistemic_status)
      VALUES (?,?,?,?,5000,'[]',?,?,2,'canonical')`);
    insert.run("decision", "Inspector decision: adopt the existing test app. Explicitly NOT adopted: a second self-hosted Inspector container.", '["decision","private"]', "meeting", "alice", "private");
    insert.run("trial", "Inspector recommendation: VERDICT TRIAL. Adopt a self-hosted Inspector at http://127.0.0.1:3001/mcp/inspector.", '["recommendation","status:active"]', "assessment", "bob", "public");
    insert.run("hidden", "Inspector secret from Bob", '["private"]', "secret source", "bob", "private");
    vi.mocked(env.AI.run).mockImplementation(async (model: string): Promise<any> => {
      if (model.includes("bge")) return { data: [new Array(384).fill(0.1)] };
      return new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"response":"Fixture response"}\n\ndata: [DONE]\n\n'));
        controller.close();
      } });
    });
  });
  afterEach(() => db.close());

  function evidence() {
    const call = vi.mocked(env.AI.run).mock.calls.find(([, input]: any) => input.messages?.[0]?.role === "system");
    expect(call).toBeDefined();
    return JSON.parse((call![1] as any).messages[1].content);
  }

  it("keeps a private decision and public recommendation distinct, with exact URLs and status", async () => {
    const before = db.all("SELECT * FROM entries");
    const result = await recallEntries({ query: "Inspector", userId: "alice", topK: 5, hops: 0 }, env, ctx);
    expect(result.matches.map(match => match.id).sort()).toEqual(["decision", "trial"]);
    const memories = evidence().memories;
    expect(memories.find((memory: any) => memory.id === "decision")).toMatchObject({
      tags: ["decision", "private"], source: "meeting", epistemicStatus: "canonical", revision: 2,
    });
    expect(memories.find((memory: any) => memory.id === "trial")).toMatchObject({ tags: ["recommendation", "status:active"], source: "assessment", epistemicStatus: "canonical" });
    expect(JSON.stringify(memories)).toContain("http://127.0.0.1:3001/mcp/inspector");
    expect(JSON.stringify(memories)).not.toContain("Inspector secret");
    expect(db.all("SELECT * FROM entries")).toEqual(before);
    expect(db.count("edges")).toBe(0);
    expect(db.count("episodes")).toBe(0);
  });

  it.each(["explicit", "inferred"])("preserves direction and %s provenance, suppressing invisible legacy edge endpoints", async (provenance) => {
    // Same owner and visibility for the permitted relation. A legacy corrupt
    // edge to Bob's private entry must never reveal its endpoint to Alice.
    db.exec("UPDATE entries SET owner_user_id = 'alice', visibility = 'private', tags = '[\"private\",\"recommendation\"]' WHERE id = 'trial'");
    const insert = db.sqlite.prepare(`INSERT INTO edges (id,source_id,target_id,type,weight,provenance,created_at,updated_at,confidence)
      VALUES (?,?,?,'supersedes',1,?,5000,5000,1)`);
    insert.run("edge-valid", "decision", "trial", provenance);
    insert.run("edge-hidden", "hidden", "decision", "explicit");
    const result = await recallEntries({ query: "Inspector", userId: "alice", topK: 5, hops: 0 }, env, ctx);
    expect(result.matches.find(match => match.id === "decision")?.relations).toEqual([{ type: "supersedes", confidence: 1, targetId: "trial", direction: "outbound", provenance }]);
    expect(result.matches.find(match => match.id === "trial")?.relations).toEqual([{ type: "supersedes", confidence: 1, targetId: "decision", direction: "inbound", provenance }]);
    const memories = evidence().memories;
    expect(memories.find((memory: any) => memory.id === "decision").relations[0].direction).toBe("outbound");
    expect(memories.find((memory: any) => memory.id === "trial").relations[0].direction).toBe("inbound");
    expect(memories.find((memory: any) => memory.id === "trial").relations[0].provenance).toBe(provenance);
    expect(JSON.stringify(memories)).not.toContain("hidden");
    expect(db.count("edges")).toBe(2);
  });

  it("raw recall leaves generation disabled even with conflicting evidence", async () => {
    const result = await recallEntries({ query: "Inspector", userId: "alice", topK: 5, hops: 0, skipInsight: true }, env, ctx);
    expect(result.matches).toHaveLength(2);
    expect(result.insight).toBe("");
    expect(vi.mocked(env.AI.run).mock.calls.some(([, input]: any) => input.messages?.[0]?.role === "system")).toBe(false);
  });
});
