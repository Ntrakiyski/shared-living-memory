import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SqliteD1 } from "../helpers/sqlite-d1";
import worker, { _resetDbReady, initializeDatabase } from "../../src/testing";
import { buildMcpServer } from "../../src/mcp";
import { commitEntryVersion } from "../../src/entry-version-service";
import { hmacKey, AUTH_PEPPER } from "../../src/auth";
import type { ActorContext, Env, HumanActorContext, ServiceActorContext, ServiceScope } from "../../src/types";

const account: HumanActorContext = { kind: "human", actorId: "alice", userId: "alice", role: "admin", authMethod: "personal_api_key", scopes: new Set() };
const scopes: ServiceScope[] = ["memory:read", "memory:draft", "memory:propose", "proposal:create", "audit:write", "run:write"];
const credentialId = "11111111-1111-4111-8111-111111111111";
const service: ServiceActorContext = { kind: "service", actorId: "hermes", serviceIdentityId: "hermes", credentialId, ownerUserId: "alice", authMethod: "service_api_key", scopes: new Set(scopes) };
const personalKey = "slm_alice.alice-secret";
const serviceKey = `sbs_${credentialId}.service-secret`;
const ctx = { waitUntil: (promise: Promise<unknown>) => { void promise.catch(() => {}); }, passThroughOnException() {} } as ExecutionContext;
const bytes = (value: unknown) => new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value)).byteLength;
let db: SqliteD1;
let env: Env;

beforeEach(async () => {
  db = new SqliteD1({ applySchema: false });
  _resetDbReady();
  env = {
    DB: db as unknown as D1Database,
    AI: { run: vi.fn(async (_model: string, input: any) => input.stream
      ? new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('data: {"response":"Grounded answer [Source 1]"}\n\ndata: [DONE]\n\n')); controller.close(); } })
      : { data: (input.text ?? [""]).map(() => new Array(384).fill(0.01)) }) },
    VECTORIZE: { upsert: vi.fn(async () => ({ mutationId: "u" })), deleteByIds: vi.fn(async () => ({ mutationId: "d" })), query: vi.fn(async () => ({ matches: [] })), getByIds: vi.fn(async () => []) },
    OAUTH_KV: { get: vi.fn(async () => null), put: vi.fn(async () => {}), delete: vi.fn(async () => {}) },
    AUTH_TOKEN: "test-token",
  } as unknown as Env;
  await initializeDatabase(env);
  for (const username of ["alice", "bob"]) {
    db.sqlite.prepare(`INSERT INTO users (id,username,normalized_username,auth_key_hash,auth_key_prefix,status,created_at,role) VALUES (?,?,?,?,?,'active',1,'admin')`)
      .run(username, username, username, await hmacKey(`${username}-secret`, AUTH_PEPPER), `slm_${username}.`);
  }
  db.exec(`INSERT INTO service_identities (id,name,owner_user_id,status,default_autonomy_profile,created_by_user_id,created_at,updated_at) VALUES ('hermes','Hermes','alice','active','propose','alice',1,1)`);
  db.sqlite.prepare(`INSERT INTO service_credentials (id,service_identity_id,credential_hash,credential_prefix,scopes,status,created_by_user_id,created_at) VALUES (?,'hermes',?,?,?,'active','alice',1)`)
    .run(credentialId, await hmacKey("service-secret", AUTH_PEPPER), "sbs_test", JSON.stringify(scopes));
});

afterEach(() => db.close());

function tool(name: string, input: Record<string, unknown>, actor: ActorContext = account) {
  const server = buildMcpServer(env, ctx, actor) as any;
  return server._registeredTools[name].handler(input, {});
}

async function rest(path: string, body?: unknown, key = personalKey) {
  const response = await worker.fetch(new Request(`http://localhost${path}`, {
    method: body === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), env, ctx);
  return { status: response.status, data: await response.json() as any };
}

function seedEntry(id: string, owner = "alice", content = "retrieval evidence", revision = 3) {
  db.sqlite.prepare(`INSERT INTO entries (id,content,tags,source,created_at,vector_ids,owner_user_id,visibility,revision,epistemic_status,recorded_at) VALUES (?,?,'[]','api',1000,'[]',?,'public',?,'candidate',3000)`)
    .run(id, content, owner, revision);
}

it("uses real recall ownership and revision as an accepted edit precondition", async () => {
  seedEntry("owned"); seedEntry("other", "bob", "retrieval other evidence", 7);
  const result = await tool("recall", { query: "retrieval", topK: 5, hops: 0, include_insight: false });
  const owned = result.structuredContent.data.matches.find((m: any) => m.entry.entry_id === "owned");
  const other = result.structuredContent.data.matches.find((m: any) => m.entry.entry_id === "other");
  expect(owned.entry).toMatchObject({ revision: 3, owner: { id: "alice", username: "alice" }, permissions: { mutate_directly: true, submit_change_proposal: true } });
  expect(other.entry).toMatchObject({ revision: 7, owner: { id: "bob", username: "bob" }, permissions: { mutate_directly: false, submit_change_proposal: false } });
  const edit = await tool("set_status", { id: "owned", status: "draft", expected_revision: owned.entry.revision });
  expect(edit.structuredContent).toMatchObject({ ok: true, data: { revision: 4 } });
  const conflict = await tool("set_status", { id: "owned", status: "canonical", expected_revision: 3 });
  expect(conflict.isError).toBe(true);
  expect(conflict.structuredContent.error.code).toBe("revision_conflict");
});

it("labels historical content separately from the current descriptor", async () => {
  seedEntry("history", "alice", "retrieval current body", 3);
  db.exec(`INSERT INTO entry_snapshots (id,entry_id,content,tags,source,created_at,recorded_at,revision,visibility,epistemic_status) VALUES ('old','history','retrieval old body','[]','api',1000,1000,1,'public','candidate')`);
  const result = await tool("recall", { query: "retrieval", topK: 5, hops: 0, include_insight: false, known_at: 2000 });
  expect(result.structuredContent.data.matches[0]).toMatchObject({ entry: { revision: 3 }, content: "retrieval old body", content_revision: 1, content_state: "historical" });
});

it("checks supplied append/update revisions on both transports before semantic work", async () => {
  seedEntry("owned");
  const update = await tool("update", { id: "owned", content: "replacement", expected_revision: 3 });
  expect(update.structuredContent).toMatchObject({ ok: true, data: { revision: 4 } });
  vi.mocked(env.AI.run).mockClear();
  for (const name of ["append", "update"]) {
    const input = { id: "owned", addition: "addition", content: "replacement", expected_revision: 3 };
    const staleMcp = await tool(name, input);
    expect(staleMcp.structuredContent).toMatchObject({ ok: false, error: { code: "revision_conflict" } });
    const staleRest = await rest(`/${name}`, input);
    expect(staleRest.status).toBe(409);
    expect((await rest(`/${name}`, { ...input, expected_revision: -1 })).status).toBe(400);
  }
  expect(env.AI.run).not.toHaveBeenCalled();
  expect(db.one<{ revision: number }>("SELECT revision FROM entries WHERE id='owned'").revision).toBe(4);
});

it("returns honest owner and transition failures without exposing hidden records", async () => {
  seedEntry("public", "bob"); seedEntry("private", "bob"); seedEntry("owned");
  db.exec("UPDATE entries SET visibility='private' WHERE id='private'");
  for (const name of ["append", "update", "set_status", "set_epistemic_status"]) {
    const input = { addition: "addition", content: "replacement", status: "draft", new_status: "reviewed" };
    const visible = await tool(name, { ...input, id: "public", entry_id: "public" });
    expect(visible.structuredContent).toMatchObject({ ok: false, error: { code: "not_owner" } });
    const hidden = await tool(name, { ...input, id: "private", entry_id: "private" });
    expect(hidden.structuredContent).toMatchObject({ ok: false, error: { code: "not_found_or_inaccessible" } });
  }
  const invalid = await tool("set_epistemic_status", { entry_id: "owned", new_status: "canonical" });
  expect(invalid.structuredContent).toMatchObject({ ok: false, error: { code: "invalid_transition", details: { allowed_next_states: ["reviewed"] } } });
});

it("bounds the same history object in text and structured output", async () => {
  seedEntry("history");
  const insert = db.sqlite.prepare(`INSERT INTO episodes (id,entry_id,content,source,created_at,owner_user_id,status_change_json) VALUES (?,'history','body','api',?,'alice',?)`);
  for (let index = 0; index < 50; index++) insert.run(`episode-${index}`, index, JSON.stringify({ reason: "😀".repeat(1000), from: "candidate", to: "reviewed" }));
  const result = await tool("history", { entry_id: "history" });
  const data = result.structuredContent.data;
  expect(bytes(data)).toBeLessThanOrEqual(4096);
  expect(bytes(result.content[0].text)).toBeLessThanOrEqual(4096);
  expect(JSON.parse(result.content[0].text)).toEqual(data);
  expect(data.truncated).toBe(true);
  expect(data.counts.episodes).toMatchObject({ total: 50, returned: data.episodes.length });
  expect(data.episodes.length).toBeLessThan(50);
  expect(data.episodes[0].status_change).toMatchObject({ reason_truncated: true, reason_original_code_points: 1000 });
});

it.each(["REST", "MCP"])("bounds %s pages with tied timestamps without skipping rows when page size changes", async transport => {
  for (let index = 0; index < 55; index++) seedEntry(`entry-${String(index).padStart(3, "0")}`, "alice", "😀".repeat(4000));
  db.sqlite.prepare(`UPDATE entries SET source = ?`).run("😀".repeat(512));
  const legacy = await rest("/list?n=1");
  expect(legacy.data[0].content).toHaveLength(8000);
  const seen: string[] = [];
  let cursor: string | null = null;
  do {
    const response: Awaited<ReturnType<typeof rest>> = transport === "REST"
      ? await rest(`/list?page=true&n=${seen.length ? 7 : 50}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`)
      : { status: 200, data: (await tool("list_recent", { n: seen.length ? 7 : 50, ...(cursor ? { cursor } : {}) })).structuredContent };
    expect(response.status).toBe(200);
    if (!seen.length) expect(response.data.data.entries.length).toBeLessThan(50);
    expect(bytes(response.data.data)).toBeLessThanOrEqual(131072);
    for (const row of response.data.data.entries) {
      expect(bytes(row.content)).toBeLessThanOrEqual(2048);
      expect(row.content_truncated).toBe(true);
      expect(row.original_content_bytes).toBe(16000);
      seen.push(row.entry_id);
    }
    cursor = response.data.data.next_cursor;
  } while (cursor);
  expect(seen).toHaveLength(55);
  expect(new Set(seen).size).toBe(55);
});

it("replays service REST batches through MCP with the original receipt and current revision", async () => {
  const items = [{ client_item_id: "one", idempotency_key: "service-retry", content: "Original service capture", source_url: "https://example.com", source_title: "Source title" }];
  const first = await rest("/capture/batch", { items }, serviceKey);
  expect(first.status).toBe(200);
  expect(first.data.data.summary).toEqual({ created: 1, replayed: 0, failed: 0 });
  const original = first.data.data.items[0].data;
  expect(Object.keys(original).sort()).toEqual(["capture_mode", "entry", "matched_entry", "outcome", "receipt"]);
  expect(original).toMatchObject({ capture_mode: "create_only", entry: { revision: 1, visibility: "private", lifecycle_status: "draft", epistemic_status: "candidate" } });
  await commitEntryVersion({ kind: "update", actorUserId: "alice", entryId: original.entry.entry_id, expectedRevision: 1, rawContent: "Edited", materializedContent: "Edited", source: "api:alice", tags: ["private", "status:draft"], epistemicStatus: "candidate" }, env);
  const replay = await tool("remember_batch", { items }, service);
  expect(replay.structuredContent.data.summary).toEqual({ created: 0, replayed: 1, failed: 0 });
  expect(replay.structuredContent.data.items[0]).toMatchObject({ status: "replayed", data: { outcome: "replayed", entry: { revision: 2 }, receipt: original.receipt } });
  expect(db.count("entries")).toBe(1);
});

it("uses identical personal single/batch contracts and truthful cross-transport replay revisions", async () => {
  const first = await tool("remember", { content: "Personal capture", idempotency_key: "personal-retry" });
  const initial = first.structuredContent.data;
  expect(initial.outcome).toBe("created");
  await tool("update", { id: initial.entry.entry_id, content: "Edited personal capture" });
  const replay = await rest("/capture/batch", { items: [{ client_item_id: "one", idempotency_key: "personal-retry", content: "Personal capture" }] });
  expect(replay.data.data.items[0].data).toMatchObject({ outcome: "replayed", capture_mode: "create_only", entry: { revision: 2 }, receipt: initial.receipt });
  expect(Object.keys(replay.data.data.items[0].data).sort()).toEqual(Object.keys(initial).sort());
});

it("keeps committed receipts successful when descriptor loading fails", async () => {
  const prepare = db.prepare.bind(db);
  vi.spyOn(db, "prepare").mockImplementation(sql => {
    if (sql.includes("SELECT id, revision, owner_user_id, visibility, tags, epistemic_status")) throw new Error("metadata down");
    return prepare(sql);
  });
  const result = await tool("remember", { content: "Committed capture", idempotency_key: "metadata-failure" });
  expect(result.structuredContent).toMatchObject({ ok: true, data: { entry: null, receipt: { revision: 1 } } });
  expect(result.structuredContent.warnings.join(" ")).toContain("metadata_unavailable");
  expect(db.count("entries")).toBe(1);
});

it("keeps service public requests and revoked credentials from writing", async () => {
  const item = { client_item_id: "public", idempotency_key: "public", content: "must not publish", visibility: "public" };
  const response = await rest("/capture/batch", { items: [item] }, serviceKey);
  expect(response.data.data.items[0]).toMatchObject({ status: "failed", error: { code: "forbidden" } });
  expect(db.count("entries")).toBe(0);
  db.exec(`UPDATE service_credentials SET status = 'revoked'`);
  const revoked = await rest("/capture/batch", { items: [{ ...item, visibility: "private" }] }, serviceKey);
  expect(revoked.status).toBe(401);
  expect(db.count("entries")).toBe(0);
});

it("revalidates service authority before each later batch item", async () => {
  const batch = db.batch.bind(db);
  vi.spyOn(db, "batch").mockImplementation(async statements => {
    const result = await batch(statements);
    if (db.count("entries") === 1) db.exec(`UPDATE service_credentials SET status = 'revoked'`);
    return result;
  });
  const items = ["first", "second", "third"].map(id => ({ client_item_id: id, idempotency_key: id, content: `${id} capture` }));
  const result = await rest("/capture/batch", { items }, serviceKey);
  expect(result.data.data.items.map((i: any) => i.status)).toEqual(["created", "failed", "failed"]);
  expect(db.count("entries")).toBe(1);
});

it("derives service descriptor permissions from current scopes without granting direct edits", async () => {
  seedEntry("owned"); seedEntry("other", "bob");
  const allowed = await tool("list_recent", { n: 10 }, service);
  const entries = allowed.structuredContent.data.entries;
  expect(entries.find((e: any) => e.entry_id === "owned").permissions).toEqual({ read_current: true, read_history: true, mutate_directly: false, submit_change_proposal: true });
  expect(entries.find((e: any) => e.entry_id === "other").permissions.submit_change_proposal).toBe(false);
  const readOnly = { ...service, scopes: new Set<ServiceScope>(["memory:read", "audit:write", "run:write"]) };
  const denied = await tool("list_recent", { n: 10 }, readOnly);
  expect(denied.structuredContent.data.entries.every((e: any) => !e.permissions.submit_change_proposal)).toBe(true);
  const noRead = await tool("list_recent", { n: 10 }, { ...service, scopes: new Set<ServiceScope>(["memory:draft", "audit:write", "run:write"]) });
  expect(noRead.isError).toBe(true);
});

it("reports service identity and actual capability scopes on both whoami transports", async () => {
  const mcp = await tool("whoami", {}, service);
  const response = await rest("/api/whoami", undefined, serviceKey);
  expect(mcp.structuredContent.data.principal.kind).toBe("service");
  expect(response.data.data.principal.kind).toBe("service");
  expect(mcp.structuredContent.data.capabilities).toEqual(response.data.data.capabilities);
  expect(response.data.data.capabilities).toEqual({ read_public: true, read_owner_private: true, direct_mutation_scope: "private_drafts", proposal_review: "none", erase_owned_entries: false });
  db.sqlite.prepare("UPDATE service_credentials SET scopes = ?").run(JSON.stringify(["audit:write", "run:write"]));
  const limited = { ...service, scopes: new Set<ServiceScope>(["audit:write", "run:write"]) };
  const attenuatedMcp = await tool("whoami", {}, limited);
  const attenuatedRest = await rest("/api/whoami", undefined, serviceKey);
  expect(attenuatedMcp.structuredContent.data.capabilities).toEqual(attenuatedRest.data.data.capabilities);
  expect(attenuatedRest.data.data.capabilities).toMatchObject({ read_public: false, read_owner_private: false, direct_mutation_scope: "none" });
});

it("retains all worst-case batch labels and safe outcomes within the complete data budget", async () => {
  const items = Array.from({ length: 10 }, (_, index) => ({ client_item_id: `${index}${"😀".repeat(63)}`, idempotency_key: `worst-${index}`, content: "bounded capture", source_title: "😀".repeat(512), source_url: `https://example.com/${"a".repeat(1800)}` }));
  const result = await rest("/capture/batch", { items });
  expect(result.data.data.items).toHaveLength(10);
  expect(result.data.data.summary.failed).toBe(0);
  expect(bytes(result.data.data)).toBeLessThanOrEqual(32768);
  expect(JSON.stringify(result.data.data)).not.toContain("source_url");
  expect(result.data.data.items.map((i: any) => i.client_item_id)).toEqual(items.map(i => i.client_item_id));
});

it("serves complete grounded chat SSE in maintenance without domain writes", async () => {
  seedEntry("evidence", "alice", "retrieval evidence for maintenance");
  env.SLM_WRITE_MODE = "read-only";
  const baseline = ["entries", "episodes", "entry_snapshots", "edges", "action_proposals"].map(table => db.count(table));
  const response = await worker.fetch(new Request("http://localhost/chat", { method: "POST", headers: { Authorization: `Bearer ${personalKey}`, "Content-Type": "application/json" }, body: JSON.stringify({ query: "retrieval evidence" }) }), env, ctx);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  expect(await response.text()).toContain("[DONE]");
  expect(["entries", "episodes", "entry_snapshots", "edges", "action_proposals"].map(table => db.count(table))).toEqual(baseline);
  expect(env.VECTORIZE.upsert).not.toHaveBeenCalled();
});
