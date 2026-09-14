import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer } from "../../src/mcp";
import { EDGE_TYPES } from "../../src/graph";
import { _resetDbReady, initializeDatabase } from "../../src/testing";
import { SqliteD1 } from "../helpers/sqlite-d1";
import type { ActorContext, Env, HumanActorContext, ServiceActorContext, ServiceScope } from "../../src/types";

const alice: HumanActorContext = { kind: "human", actorId: "alice", userId: "alice", role: "admin", authMethod: "personal_api_key", scopes: new Set() };
const bob: HumanActorContext = { ...alice, actorId: "bob", userId: "bob", role: "member" };
let db: SqliteD1;
let env: Env;
let pending: Promise<unknown>[];
let clients: Client[];
let client: Client;

async function connect(actor: ActorContext = alice) {
  const ctx = { waitUntil: (promise: Promise<unknown>) => { pending.push(promise.catch(() => {})); }, passThroughOnException() {} } as ExecutionContext;
  const server = buildMcpServer(env, ctx, actor);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const connected = new Client({ name: "mcp-contract-test", version: "1" });
  clients.push(connected);
  await connected.connect(clientTransport);
  return connected;
}

async function call(name: string, args: Record<string, unknown>, connected = client): Promise<any> {
  // Exercise SDK schema validation and JSON-RPC tool results, not private handlers.
  return connected.callTool({ name, arguments: args });
}

function seedEntry(id: string, owner = "alice", visibility = "private") {
  db.sqlite.prepare(`INSERT INTO entries (id,content,tags,source,created_at,vector_ids,owner_user_id,visibility,revision,epistemic_status,recorded_at)
    VALUES (?,? ,?,'api',1000,'[]',?,?,3,'candidate',3000)`)
    .run(id, `evidence for ${id}`, JSON.stringify(visibility === "private" ? ["private"] : []), owner, visibility);
}

function expectFailure(result: any, code: string, retryable = false) {
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toMatchObject({ ok: false, error: { code, retryable } });
  expect(result.structuredContent.request_id).toEqual(expect.any(String));
}

beforeEach(async () => {
  db = new SqliteD1({ applySchema: false });
  pending = [];
  clients = [];
  _resetDbReady();
  env = {
    DB: db as unknown as D1Database,
    AI: { run: vi.fn(async (_model: string, input: any) => ({ data: (input.text ?? [""]).map(() => new Array(384).fill(0.01)) })) },
    VECTORIZE: { upsert: vi.fn(async () => ({ mutationId: "u" })), deleteByIds: vi.fn(async () => ({ mutationId: "d" })), query: vi.fn(async () => ({ matches: [] })), getByIds: vi.fn(async () => []) },
    OAUTH_KV: { get: vi.fn(async () => null), put: vi.fn(async () => {}), delete: vi.fn(async () => {}) },
    AUTH_TOKEN: "test-token", SLM_WRITE_MODE: "enabled",
  } as unknown as Env;
  await initializeDatabase(env);
  for (const [id, role] of [["alice", "admin"], ["bob", "member"]]) {
    db.sqlite.prepare(`INSERT INTO users (id,username,normalized_username,auth_key_hash,auth_key_prefix,status,created_at,role) VALUES (?,?,?,'','','active',1,?)`).run(id, id, id, role);
  }
  client = await connect();
});

afterEach(async () => {
  await Promise.all(clients.map(connected => connected.close()));
  for (let index = 0; index < pending.length; index++) await pending[index];
  db.close();
});

const singleEntryCases: Array<[string, Record<string, unknown>]> = [
  ["append", { addition: "new evidence" }],
  ["update", { content: "replacement evidence" }],
  ["set_status", { status: "draft" }],
  ["set_epistemic_status", { new_status: "qualified" }],
  ["reinforce", {}],
  ["forget", {}],
  ["connections", {}],
  ["passages", {}],
  ["history", {}],
  ["restore", {}],
];

describe("single-entry aliases through the MCP protocol", () => {
  it.each(singleEntryCases)("accepts id and entry_id for %s", async (name, args) => {
    for (const field of ["id", "entry_id"]) {
      const captured = await call("remember", { content: `Evidence for ${name} ${field}`, idempotency_key: `${name}-${field}` });
      const id = captured.structuredContent.data.entry.entry_id;
      if (name === "restore") {
        expect((await call("update", { id, content: "Updated evidence with an earlier snapshot" })).isError).not.toBe(true);
      }
      const result = await call(name, { ...args, [field]: id, ...(name === "forget" ? { confirm_entry_id: id } : {}) });
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
    }
  });

  it("exposes both spellings and rejects conflicting or absent IDs before side effects", async () => {
    seedEntry("owned"); seedEntry("second");
    const tools = (await client.listTools()).tools;
    for (const [name, args] of singleEntryCases) {
      const schema = tools.find(tool => tool.name === name)!.inputSchema;
      expect(schema.properties).toHaveProperty("id");
      expect(schema.properties).toHaveProperty("entry_id");
      const input = { ...args, ...(name === "forget" ? { confirm_entry_id: "owned" } : {}) };
      expectFailure(await call(name, { ...input, id: "owned", entry_id: "second" }), "invalid_request");
      expectFailure(await call(name, input), "invalid_request");
    }
    expect(db.count("entries")).toBe(2);
    expect(db.count("episodes")).toBe(0);
    expect(db.count("agent_runs")).toBe(0);
    expect(env.AI.run).not.toHaveBeenCalled();
    const accepted = await call("set_status", { id: "owned", entry_id: "owned", status: "draft", expected_revision: 3 });
    expect(accepted.structuredContent).toMatchObject({ ok: true, data: { entry_id: "owned", revision: 4 } });
  });
});

describe("safe MCP refusal envelopes", () => {
  it.each(["link", "propose_edge", "unlink"])("keeps missing and another owner's private entry indistinguishable for %s", async name => {
    seedEntry("owned"); seedEntry("hidden", "bob");
    const absent = await call(name, { source_id: "owned", target_id: "absent", type: "supports" });
    const hidden = await call(name, { source_id: "owned", target_id: "hidden", type: "supports" });
    expectFailure(absent, "not_found_or_inaccessible");
    expectFailure(hidden, "not_found_or_inaccessible");
    expect(hidden.structuredContent.error).toEqual(absent.structuredContent.error);
    expect(JSON.stringify(hidden)).not.toContain("evidence for hidden");
    expect(JSON.stringify(hidden)).not.toContain('"bob"');
    expect(db.count("edges")).toBe(0);
    expect(db.count("edge_proposals")).toBe(0);
  });

  it.each(["link", "propose_edge"])("explains the same-visibility policy for %s in both directions", async name => {
    seedEntry("private"); seedEntry("public", "bob", "public");
    for (const [source_id, target_id] of [["private", "public"], ["public", "private"]]) {
      const result = await call(name, { source_id, target_id, type: "supports" });
      expectFailure(result, "forbidden");
      expect(result.structuredContent.error.message).toContain("Both direct links and proposals require the same visibility");
    }
    expect(db.count("edges")).toBe(0);
    expect(db.count("edge_proposals")).toBe(0);
  });

  it("keeps cross-owner public links supported and counts logical unlink edges", async () => {
    seedEntry("a", "alice", "public"); seedEntry("b", "bob", "public");
    for (const [source_id, target_id, type] of [["a", "b", "supports"], ["b", "a", "supersedes"], ["a", "b", "relates_to"]]) {
      expect((await call("link", { source_id, target_id, type })).structuredContent.ok).toBe(true);
    }
    const listed = await call("connections", { entry_id: "a" });
    const connections = listed.structuredContent.data.connections;
    expect(connections).toHaveLength(3);
    expect(connections).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "b", source_id: "a", target_id: "b", type: "supports", direction: "outbound", edge_id: expect.any(String) }),
      expect.objectContaining({ id: "b", source_id: "b", target_id: "a", type: "supersedes", direction: "inbound" }),
      expect.objectContaining({ id: "b", type: "relates_to", direction: "undirected" }),
    ]));
    expect(listed.content[0].text).toContain("b → a");
    const filtered = await call("connections", { id: "a", type: "supersedes" });
    expect(filtered.structuredContent.data.connections).toHaveLength(1);
    const removed = await call("unlink", { source_id: "a", target_id: "b" });
    expect(removed.structuredContent, JSON.stringify(removed)).toMatchObject({ ok: true, data: { source_id: "a", target_id: "b", deleted: 3 } });
    expectFailure(await call("unlink", { source_id: "a", target_id: "b" }), "not_found_or_inaccessible");
    const empty = await call("connections", { id: "a" });
    expect(empty.structuredContent).toMatchObject({ ok: true, data: { connections: [] } });
  });

  it("marks missing single-entry refusals and deletion confirmation failures as tool errors", async () => {
    for (const [name, args] of singleEntryCases) {
      expectFailure(await call(name, { ...args, id: "absent", ...(name === "forget" ? { confirm_entry_id: "absent" } : {}) }), "not_found_or_inaccessible");
    }
    seedEntry("owned");
    expectFailure(await call("forget", { entry_id: "owned", confirm_entry_id: "wrong" }), "invalid_request");
    expect(db.count("entries")).toBe(1);
    expectFailure(await call("link", { source_id: "owned", target_id: "owned", type: "supports" }), "invalid_request");
    expectFailure(await call("propose_edge", { source_id: "owned", target_id: "owned", type: "supports" }), "invalid_request");
    expect(db.count("edge_proposals")).toBe(0);
  });

  it("reports role refusals, hidden proposals, and visibility changes without publishing edges", async () => {
    seedEntry("private"); seedEntry("public", "bob", "public");
    const member = await connect(bob);
    for (const name of ["approve-proposal", "reject-proposal", "approve_edge_proposal", "reject_edge_proposal"]) {
      expectFailure(await call(name, { proposal_id: "absent" }, member), "forbidden");
      expectFailure(await call(name, { proposal_id: "absent" }), "not_found_or_inaccessible");
    }
    db.exec(`INSERT INTO edge_proposals (id,source_id,target_id,type,reason,proposed_by,status,created_at) VALUES ('mixed','private','public','supports','','alice','pending',1)`);
    expectFailure(await call("approve-proposal", { proposal_id: "mixed" }), "forbidden");
    expect(db.one<{ status: string }>("SELECT status FROM edge_proposals WHERE id='mixed'").status).toBe("pending");
    expect(db.count("edges")).toBe(0);
  });

  it("keeps idempotency and stale-revision conflicts as MCP results with safe error fields", async () => {
    const created = await call("remember", { content: "Original evidence", idempotency_key: "same" });
    const id = created.structuredContent.data.entry.entry_id;
    expectFailure(await call("remember", { content: "Changed evidence", idempotency_key: "same" }), "idempotency_conflict");
    for (const [name, args] of [["append", { addition: "more" }], ["update", { content: "replacement" }]] as const) {
      expectFailure(await call(name, { ...args, entry_id: id, expected_revision: 0 }), "revision_conflict");
    }
    expect(db.count("entries")).toBe(1);
    expect(db.one<{ revision: number }>("SELECT revision FROM entries WHERE id=?", id).revision).toBe(1);
  });

  it("catches storage exceptions for tools outside the audit wrapper without exposing SQL", async () => {
    const prepare = db.prepare.bind(db);
    db.prepare = ((sql: string) => {
      if (sql.includes("recall_feedback") || sql.includes("SELECT owner_user_id FROM entries")) throw new Error("D1_ERROR private internal exception");
      return prepare(sql);
    }) as typeof db.prepare;
    for (const [name, args] of [["rate_recall", { recall_event_id: "some-event", rating: "helpful" }], ["forget", { id: "absent", confirm_entry_id: "absent" }]] as const) {
      const result = await call(name, args);
      expectFailure(result, "storage_unavailable", true);
      expect(JSON.stringify(result)).not.toContain("private internal exception");
      expect(JSON.stringify(result)).not.toContain("D1_ERROR");
    }
  });
});

describe("MCP recall event and feedback result contract", () => {
  it("rates only the caller's persisted recall and exposes numeric revisions without text parsing", async () => {
    seedEntry("owned"); seedEntry("hidden", "bob");
    const recalled = await call("recall", { query: "evidence", topK: 5, hops: 0, include_insight: false });
    expect(recalled.isError).not.toBe(true);
    const data = recalled.structuredContent.data;
    expect(data.recall_event_id).toEqual(expect.any(String));
    expect(data.matches).toHaveLength(1);
    expect(data.matches[0].entry).toMatchObject({ entry_id: "owned", revision: 3 });
    const history = await call("history", { id: data.matches[0].entry.entry_id });
    expect(history.structuredContent.data.projection.revision).toBe(data.matches[0].entry.revision);
    const row = db.one<{ result_entry_ids: string; user_id: string; query_hash: string }>("SELECT result_entry_ids,user_id,query_hash FROM recall_events WHERE id=?", data.recall_event_id);
    expect(JSON.parse(row.result_entry_ids)).toEqual(data.matches.map((match: any) => match.entry.entry_id));
    expect(row.user_id).toBe("alice");
    expect(row.query_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(row.query_hash).not.toContain("evidence");
    const feedback = await call("rate_recall", { recall_event_id: ` ${data.recall_event_id} `, rating: "helpful" });
    expect(feedback.structuredContent).toMatchObject({ ok: true, data: { recall_event_id: data.recall_event_id, rating: "helpful", recorded: true } });
    const member = await connect(bob);
    const foreign = await call("rate_recall", { recall_event_id: data.recall_event_id, rating: "helpful" }, member);
    const invented = await call("rate_recall", { recall_event_id: "invented", rating: "helpful" }, member);
    expectFailure(foreign, "not_found_or_inaccessible");
    expectFailure(invented, "not_found_or_inaccessible");
    expect(foreign.structuredContent.error).toEqual(invented.structuredContent.error);
    expect(db.count("recall_feedback")).toBe(1);
  });

  it("keeps recall usable without an event ID when telemetry storage fails", async () => {
    seedEntry("owned");
    const prepare = db.prepare.bind(db);
    db.prepare = ((sql: string) => {
      if (sql.includes("INSERT INTO recall_events")) throw new Error("telemetry storage unavailable");
      return prepare(sql);
    }) as typeof db.prepare;
    const result = await call("recall", { query: "evidence", topK: 5, hops: 0, include_insight: false });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ ok: true, data: { recall_event_id: null }, warnings: ["recall_feedback_unavailable"] });
    expect(result.structuredContent.data.matches).toHaveLength(1);
    expect(db.count("recall_events")).toBe(0);
  });

  it("keeps maintenance recall free of telemetry writes and blocks rating with the shared envelope", async () => {
    seedEntry("owned");
    env.SLM_WRITE_MODE = "read-only";
    const readonlyClient = await connect();
    const recalled = await call("recall", { query: "evidence", topK: 5, hops: 0, include_insight: false }, readonlyClient);
    expect(recalled.structuredContent).toMatchObject({ ok: true, data: { recall_event_id: null, matches: [expect.any(Object)] } });
    expect(db.count("recall_events")).toBe(0);
    expectFailure(await call("rate_recall", { recall_event_id: "invented", rating: "helpful" }, readonlyClient), "maintenance_read_only", true);
    expect(db.count("recall_feedback")).toBe(0);
  });
});


it("applies entry aliases to service reads without issuing human recall feedback IDs", async () => {
  seedEntry("owned");
  const scopes: ServiceScope[] = ["memory:read", "audit:write", "run:write"];
  const credentialId = "11111111-1111-4111-8111-111111111111";
  db.exec(`INSERT INTO service_identities (id,name,owner_user_id,status,default_autonomy_profile,created_by_user_id,created_at,updated_at) VALUES ('operator','Operator','alice','active','propose','alice',1,1)`);
  db.sqlite.prepare(`INSERT INTO service_credentials (id,service_identity_id,credential_hash,credential_prefix,scopes,status,created_by_user_id,created_at) VALUES (?,'operator','fixture','fixture',?,'active','alice',1)`)
    .run(credentialId, JSON.stringify(scopes));
  const service: ServiceActorContext = { kind: "service", actorId: "operator", serviceIdentityId: "operator", ownerUserId: "alice", credentialId, authMethod: "service_api_key", scopes: new Set(scopes) };
  const connected = await connect(service);
  expect((await connected.listTools()).tools.map(tool => tool.name)).not.toContain("rate_recall");
  expect((await call("connections", { entry_id: "owned" }, connected)).structuredContent).toMatchObject({ ok: true, data: { entry_id: "owned", connections: [] } });
  expect((await call("history", { id: "owned" }, connected)).structuredContent.data.projection.revision).toBe(3);
  expectFailure(await call("history", { id: "owned", entry_id: "different" }, connected), "invalid_request");
  expect((await call("recall", { query: "evidence", topK: 5, hops: 0, include_insight: false }, connected)).structuredContent).toMatchObject({ ok: true, data: { recall_event_id: null, matches: [expect.any(Object)] } });
  expect(db.count("recall_events")).toBe(0);
});

it("bounds enriched connections and sanitizes legacy source metadata", async () => {
  seedEntry("root");
  const secret = ["sk", "live", "s".repeat(24)].join("_");
  for (let index = 0; index < 8; index++) {
    seedEntry(`neighbor-${index}`);
    db.sqlite.prepare("UPDATE entries SET content=?,source=? WHERE id=?").run("Long evidence ".repeat(400), secret, `neighbor-${index}`);
    for (const type of Object.keys(EDGE_TYPES)) {
      db.sqlite.prepare(`INSERT INTO edges (id,source_id,target_id,type,weight,created_at,updated_at) VALUES (?,'root',?,?,1,1,1)`).run(`edge-${index}-${type}`, `neighbor-${index}`, type);
    }
  }
  const result = await call("connections", { id: "root" });
  expect(result.isError).not.toBe(true);
  const data = result.structuredContent.data;
  expect(data.truncated).toBe(true);
  expect(data.connections.length).toBeGreaterThan(0);
  expect(data.connections.length).toBeLessThan(8 * Object.keys(EDGE_TYPES).length);
  expect(new TextEncoder().encode(JSON.stringify(data)).byteLength).toBeLessThanOrEqual(131072);
  expect(JSON.stringify(result)).not.toContain(secret);
  expect(data.connections.every((connection: any) => connection.content_truncated)).toBe(true);
});
