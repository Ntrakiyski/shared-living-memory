import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, chmodSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { createLoadClient, parseSseStream, validateRecallFixtures } from "../../scripts/staging-agent-load.mjs";

const root = resolve(import.meta.dirname, "../..");
const account = "11111111111111111111111111111111";
const origin = "https://staging.example.test";
const stageD1 = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const stageKv = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const prodD1 = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const prodKv = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const dirs: string[] = [];
const servers: Server[] = [];
const databases: DatabaseSync[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(done => server.close(() => done()));
  }
  for (const db of databases.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function fixture(options: { badBinding?: boolean; failFirstCleanup?: boolean; badProvenance?: boolean; malformedWhoami?: boolean; wrongEnv?: boolean; retryWrite?: boolean; failAfterWrites?: boolean; pendingCleanup?: boolean; malformedSse?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "slm-staging-cli-")); dirs.push(dir);
  const db = new DatabaseSync(":memory:"); databases.push(db);
  db.exec(readFileSync(join(root, "db/schema.sql"), "utf8"));
  let version = "version-1", sequence = 0, requests = 0, attemptedWrites = 0, retryCount = 0;
  let cleanupAttempts = 0, cleanupInFlight = 0, peakCleanup = 0;
  const counts = { created: 0, deleted: 0, raw: 0, chat: 0, status: 0, preflight: 0 };
  const erasures = new Map<string, string>();
  const bodies: any[] = [];
  const writerPaths = Array.from({ length: 4 }, (_, i) => {
    const path = join(dir, `writer-${i}.key`); writeFileSync(path, `slm_actor-${i}.fake-secret-${i}`, { mode: 0o600 }); return path;
  });
  const vars = { SLM_DEPLOYMENT_ID: "slm-fractals-staging", SLM_ENVIRONMENT: "staging", SLM_PUBLIC_BASE_URL: origin,
    SLM_RELEASE_ID: "cccccccccccccccccccccccccccccccccccccccc", SLM_WRITE_MODE: "enabled" };
  const config = {
    name: "shared-living-memory", main: join(root, "src/index.ts"), compatibility_date: "2025-01-01", account_id: account,
    d1_databases: [{ binding: "DB", database_id: prodD1 }], kv_namespaces: [{ binding: "OAUTH_KV", id: prodKv }],
    vectorize: [{ binding: "VECTORIZE", index_name: "production-vectors" }],
    env: { staging: { name: "shared-living-memory-staging", vars,
      d1_databases: [{ binding: "DB", database_id: stageD1 }], kv_namespaces: [{ binding: "OAUTH_KV", id: stageKv }],
      vectorize: [{ binding: "VECTORIZE", index_name: "staging-vectors" }], ai: { binding: "AI" }, assets: { directory: join(root, "public") } } },
  };
  const configFile = join(dir, "wrangler.json"); writeFileSync(configFile, JSON.stringify(config));
  const whoami = (actor: string) => ({ principal: { id: actor, kind: "human", name: actor }, credential_type: "personal_api_key", tool_profile: "full",
    deployment: { id: vars.SLM_DEPLOYMENT_ID, environment: options.wrongEnv ? "production" : "staging", canonical_url: origin,
      release_id: vars.SLM_RELEASE_ID, write_mode: "enabled" } });
  function success(data: any) { return { ok: true, data, warnings: [], request_id: "request" }; }
  const server = createServer(async (request, response) => {
    requests++;
    let text = ""; for await (const part of request) text += part;
    const body = text ? JSON.parse(text) : null;
    const path = new URL(request.url!, "http://127.0.0.1").pathname;
    const host = request.headers["x-fixture-host"];
    const send = (status: number, data: any, headers: Record<string, string> = {}) => {
      response.writeHead(status, { "content-type": "application/json", ...headers }); response.end(JSON.stringify(data));
    };
    try {
      if (host === "api.cloudflare.com") {
        expect(request.headers.authorization).toBe("Bearer fixture-cloudflare-token");
        if (path.endsWith("/deployments")) return send(200, { success: true, result: { deployments: [{ versions: [{ version_id: version, percentage: 100 }] }] } });
        if (path.includes("/versions/")) return send(200, { success: true, result: { id: version, resources: { bindings: [
          { type: "d1", name: "DB", id: options.badBinding ? prodD1 : stageD1 },
          { type: "kv_namespace", name: "OAUTH_KV", namespace_id: stageKv },
          { type: "vectorize", name: "VECTORIZE", index_name: "staging-vectors" },
          ...Object.entries(vars).map(([name, value]) => ({ type: "plain_text", name, text: value })),
        ] } } });
        if (path.endsWith("/query")) {
          expect(body.sql.trim()).toMatch(/^SELECT /i);
          return send(200, { success: true, result: [{ success: true, results: db.prepare(body.sql).all(...body.params) }] });
        }
        return send(404, {});
      }
      const actor = /^Bearer slm_(actor-\d)\./.exec(String(request.headers.authorization))?.[1];
      if (!actor) return send(401, { ok: false });
      if (path === "/api/whoami") {
        counts.preflight++;
        return send(200, options.malformedWhoami ? { ok: false } : success(whoami(actor)));
      }
      if (path === "/forget") {
        const cleanupAttempt = ++cleanupAttempts;
        if (options.failFirstCleanup) {
          peakCleanup = Math.max(peakCleanup, ++cleanupInFlight);
          await new Promise(resolve => setTimeout(resolve, 10));
          cleanupInFlight--;
          if (cleanupAttempt === 1) return send(500, { ok: false });
        }
        expect(body.confirm_entry_id).toBe(body.id);
        const entry = db.prepare("SELECT * FROM entries WHERE id = ?").get(body.id) as any;
        expect(entry?.owner_user_id).toBe(actor);
        db.prepare("DELETE FROM entries WHERE id = ?").run(body.id);
        db.prepare("DELETE FROM passages WHERE episode_id IN (SELECT id FROM episodes WHERE entry_id = ?)").run(body.id);
        db.prepare("DELETE FROM documents WHERE episode_id IN (SELECT id FROM episodes WHERE entry_id = ?)").run(body.id);
        db.prepare("DELETE FROM episodes WHERE entry_id = ?").run(body.id);

        db.prepare("DELETE FROM entry_snapshots WHERE entry_id = ?").run(body.id);
        db.prepare("UPDATE capture_receipts SET state = 'erased' WHERE entry_id = ?").run(body.id);
        counts.deleted++;
        const operation = `erasure-${body.id}`; erasures.set(operation, actor);
        return send(200, { ok: true, operation_id: operation, erasure_status: "complete" });
      }
      if (path === "/erasure-status") return send(200, { ok: true, erasure: { status: options.pendingCleanup ? "pending_cleanup" : "complete" } });
      if (path === "/chat") {
        counts.chat++;
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write('data: {"response":"The lighthouse archives navigation decisions [Source 1]."}\n\n');
        // Delayed completion proves the client waits past its first token.
        setTimeout(() => response.end(options.malformedSse ? "" : 'data: [DONE]\n\n'), 15);
        return;
      }
      if (path !== "/mcp") return send(404, {});
      const rpc = (result: any) => {
        // Alternate JSON and real SSE responses in all scenarios.
        const payload = { jsonrpc: "2.0", id: body.id, result };
        if (requests % 2) {
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.end(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
        } else send(200, payload);
      };
      if (body.method === "initialize") return rpc({ serverInfo: { name: "shared-living-memory", version: "1.1.0" } });
      const name = body.params.name, args = body.params.arguments;
      const ok = (data: any) => rpc({ content: [{ type: "text", text: "fixture" }], structuredContent: success(data) });
      const fail = (code: string) => rpc({ isError: true, content: [{ type: "text", text: "principal fixture error" }], structuredContent: { ok: false, error: { code, retryable: false } } });
      if (name === "whoami") return ok(whoami(actor));
      if (name === "remember_batch") {
        attemptedWrites++;
        if (options.retryWrite && !retryCount) { retryCount++; return send(429, {}, { "retry-after": "0" }); }
        if (options.failAfterWrites && counts.created >= 2) return fail("invalid_request");
        const spec = args.items[0]; bodies.push(spec);
        expect(args.items).toHaveLength(1);
        expect(Buffer.byteLength(spec.content)).toBe(1024);
        const keyHash = createHash("sha256").update(spec.idempotency_key.trim()).digest("hex");
        let receipt = db.prepare("SELECT * FROM capture_receipts WHERE actor_id = ? AND key_hash = ?").get(actor, keyHash) as any;
        const replayed = !!receipt;
        if (receipt?.state === "erased") return fail("capture_erased");
        if (!receipt) {
          const id = `entry-${++sequence}`, episode = `episode-${sequence}`;
          db.prepare("INSERT INTO entries(id, content, created_at, source, owner_user_id, revision, current_episode_id, visibility) VALUES (?, ?, 1, ?, ?, 1, ?, ?)").run(id, spec.content, spec.source, actor, episode, spec.visibility);
          db.prepare("INSERT INTO episodes(id, entry_id, content, created_at) VALUES (?, ?, ?, 1)").run(episode, id, spec.content);
          if (!options.badProvenance) db.prepare("INSERT INTO documents(id, episode_id, title, created_at) VALUES (?, ?, ?, 1)").run(`doc-${sequence}`, episode, spec.source_title);
          expect(spec.source_url).toContain("https://example.test/");
          db.prepare("INSERT INTO passages(id, episode_id, entry_id, content, created_at) VALUES (?, ?, ?, ?, 1)").run(`passage-${sequence}`, episode, id, spec.content);
          db.prepare("INSERT INTO capture_receipts(actor_kind, actor_id, key_hash, entry_id, episode_id, revision, state, created_at) VALUES ('human', ?, ?, ?, ?, 1, 'committed', 1)").run(actor, keyHash, id, episode);
          receipt = { entry_id: id, episode_id: episode, revision: 1 }; counts.created++;
        }
        const entry = db.prepare("SELECT * FROM entries WHERE id = ?").get(receipt.entry_id) as any;
        return ok({ items: [{ client_item_id: spec.client_item_id, status: replayed ? "replayed" : "created", data: {
          outcome: replayed ? "replayed" : "created", capture_mode: "create_only",
          entry: { entry_id: receipt.entry_id, revision: entry.revision, visibility: spec.visibility, owner: { id: actor } },
          receipt: { entry_id: receipt.entry_id, episode_id: receipt.episode_id, revision: receipt.revision }, matched_entry: null,
        } }], summary: { created: replayed ? 0 : 1, replayed: replayed ? 1 : 0, failed: 0 } });
      }
      if (name === "set_status") {
        counts.status++;
        expect(["canonical", "draft", "deprecated"]).toContain(args.status);
        const row = db.prepare("SELECT * FROM entries WHERE id = ?").get(args.id) as any;
        if (row?.owner_user_id !== actor) return fail("not_owner");
        if (row.revision !== args.expected_revision) return fail("revision_conflict");
        const episode = `episode-status-${counts.status}`;
        db.prepare("UPDATE entries SET revision = revision + 1, current_episode_id = ? WHERE id = ?").run(episode, row.id);
        db.prepare("INSERT INTO episodes(id, entry_id, content, created_at) VALUES (?, ?, ?, 1)").run(episode, row.id, row.content);
        db.prepare("INSERT INTO documents(id, episode_id, title, created_at) VALUES (?, ?, 'fixture', 1)").run(`doc-status-${counts.status}`, episode);
        db.prepare("INSERT INTO entry_snapshots(id, entry_id, content, created_at) VALUES (?, ?, ?, 1)").run(`snapshot-status-${counts.status}`, row.id, row.content);
        return ok({ entry: { entry_id: row.id, revision: row.revision + 1 } });
      }
      if (name === "list_recent" || name === "recall") {
        const rows = db.prepare("SELECT * FROM entries WHERE owner_user_id = ? OR visibility = 'public' ORDER BY id").all(actor) as any[];
        const mapped = rows.map(row => ({ entry: { entry_id: row.id, owner: { id: row.owner_user_id }, visibility: row.visibility }, citations: [{ id: "passage" }] }));
        if (name === "recall") {
          expect(args).toEqual({ query: expect.any(String), topK: 5, include_insight: false });
          counts.raw++;
          return ok({ semantic_available: true, retrieval_mode: "hybrid", matches: mapped.slice(0, args.topK) });
        }
        const offset = args.cursor ? Number(args.cursor) : 0;
        return ok({ entries: mapped.slice(offset, offset + args.n).map(item => ({ ...item.entry, content: "fixture", created_at: 1 })), next_cursor: mapped.length > offset + args.n ? String(offset + args.n) : null });
      }
      return fail("unknown_tool");
    } catch (error) { send(500, { error: String(error) }); }
  });
  servers.push(server);
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as any).port;
  const env = { ...process.env, SLM_TEST_FIXTURE_ORIGIN: `http://127.0.0.1:${port}`, SLM_ENVIRONMENT: "staging", SLM_URL: origin,
    SLM_EXPECTED_DEPLOYMENT_ID: vars.SLM_DEPLOYMENT_ID, SLM_EXPECTED_RELEASE_ID: vars.SLM_RELEASE_ID, SLM_KEY_FILE: writerPaths[0], SLM_WRITER_KEY_FILES: JSON.stringify(writerPaths),
    SLM_WRANGLER_FILE: configFile, SLM_MANIFEST_FILE: join(dir, "manifest.json"), CLOUDFLARE_ACCOUNT_ID: account,
    CLOUDFLARE_API_TOKEN: "fixture-cloudflare-token", SLM_CLEANUP_MANIFEST: join(dir, "cleanup.jsonl"), SLM_LOAD_REPORT: join(dir, "report.json") };
  delete (env as any).CLOUDFLARE_API_TOKEN_FILE;
  async function cli(script: string, args: string[] = [], overrides = {}) {
    return await new Promise<{ code: number | null; stdout: string; stderr: string }>((done, reject) => {
      const child = spawn(process.execPath, ["--import", join(root, "test/helpers/staging-fetch-fixture.mjs"), join(root, "scripts", script), ...args], {
        cwd: root, env: { ...env, ...overrides }, stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "", stderr = "";
      child.stdout.on("data", data => stdout += data); child.stderr.on("data", data => stderr += data);
      child.once("error", reject); child.once("exit", code => done({ code, stdout, stderr }));
    });
  }
  return { env, dir, db, cli, counts, bodies, writerPaths, config, configFile,
    mutateVersion: () => version = "version-2", cleanupStats: () => ({ attempts: cleanupAttempts, peak: peakCleanup }), attempts: () => attemptedWrites, requests: () => requests };
}

it("runs the real preflight and all finite CLI scenarios over authenticated JSON/SSE HTTP with cleanup", async () => {
  const f = await fixture({ retryWrite: true });
  const preflight = await f.cli("check-staging-bindings.mjs");
  expect(preflight.code, preflight.stderr).toBe(0);
  expect(statSync(f.env.SLM_MANIFEST_FILE).mode & 0o777).toBe(0o600);
  const result = await f.cli("staging-agent-load.mjs", ["--confirm-cleanup"]);
  expect(result.code, result.stderr + result.stdout).toBe(0);
  const report = JSON.parse(readFileSync(f.env.SLM_LOAD_REPORT, "utf8"));
  expect(report.ok).toBe(true);
  expect(report.raw_recall_workload).toBe("default_recall");
  expect(result.stdout).toContain('"workload":"default_recall"');
  expect(report.scenarios.filter((s: any) => s.kind === "independent_writes")).toHaveLength(9);
  for (const scenario of report.scenarios.filter((s: any) => s.kind === "independent_writes")) {
    expect(scenario.measured.requests).toBe(100); expect(scenario.warmup.requests).toBe(10);
    expect(scenario.receipts).toBe(100); expect(scenario.final_rows).toBe(100);
  }
  for (const scenario of report.scenarios.filter((s: any) => s.kind === "latency")) {
    expect(scenario.measured.requests).toBe(100); expect(scenario.warmup.requests).toBe(10);
  }
  const raw = report.scenarios.find((s: any) => s.mode === "raw");
  expect(raw.workload).toBe("default_recall");
  expect(f.counts.raw).toBe(111); // One readiness probe, ten warmups, 100 measured.
  const generated = report.scenarios.find((s: any) => s.mode === "generated");
  expect(generated.measured.p50_ms).toBeGreaterThanOrEqual(14);
  expect(f.counts.chat).toBe(110);
  expect(f.counts.created).toBe(997);
  expect(f.counts.deleted).toBe(f.counts.created);
  expect(f.db.prepare("SELECT COUNT(*) AS count FROM entries").get()).toEqual({ count: 0 });
  expect(f.db.prepare("SELECT COUNT(*) AS count FROM capture_receipts WHERE state != 'erased'").get()).toEqual({ count: 0 });
  expect(statSync(f.env.SLM_CLEANUP_MANIFEST).mode & 0o777).toBe(0o600);
  const artifactText = readFileSync(f.env.SLM_LOAD_REPORT, "utf8") + readFileSync(f.env.SLM_CLEANUP_MANIFEST, "utf8") + result.stdout + result.stderr;
  expect(artifactText).not.toContain("fake-secret"); expect(artifactText).not.toContain("fixture-cloudflare-token");
}, 60_000);

it.each([{ badBinding: true }, { malformedWhoami: true }, { wrongEnv: true }])("rejects invalid authenticated preflight evidence before any fixture write: %j", async options => {
  const f = await fixture(options);
  const result = await f.cli("check-staging-bindings.mjs");
  expect(result.code).toBe(1); expect(f.attempts()).toBe(0);
});

it("rejects envs instead of validating a configuration Wrangler ignores", async () => {
  const f = await fixture();
  const config = { ...f.config, envs: f.config.env, env: undefined };
  writeFileSync(f.configFile, JSON.stringify(config));
  const result = await f.cli("check-staging-bindings.mjs");
  expect(result.code).toBe(1); expect(result.stderr).toContain("staging_environment_missing");
  expect(f.requests()).toBe(0);
});

it("rechecks the live version before trusting a saved manifest", async () => {
  const f = await fixture();
  expect((await f.cli("check-staging-bindings.mjs")).code).toBe(0);
  f.mutateVersion();
  const result = await f.cli("staging-agent-load.mjs", ["--confirm-cleanup"]);
  expect(result.code).toBe(1); expect(result.stderr).toContain("manifest_stale_or_changed"); expect(f.attempts()).toBe(0);
});

it("cleans accepted IDs after a failed write scenario and returns failure", async () => {
  const f = await fixture({ failAfterWrites: true });
  f.db.prepare("INSERT INTO entries(id, content, created_at, owner_user_id) VALUES ('unrelated', 'survives', 1, 'actor-0')").run();
  expect((await f.cli("check-staging-bindings.mjs")).code).toBe(0);
  const result = await f.cli("staging-agent-load.mjs", ["--confirm-cleanup"]);
  expect(result.code).toBe(1);
  expect(f.counts.created).toBe(2); expect(f.counts.deleted).toBe(2);
  expect(f.db.prepare("SELECT id FROM entries").all()).toEqual([{ id: "unrelated" }]);
  const report = JSON.parse(readFileSync(f.env.SLM_LOAD_REPORT, "utf8"));
  expect(report.ok).toBe(false); expect(report.error).toBe("supported_write_target_failed");
}, 20_000);

it("rejects broad key-file permissions and production origins before network access", async () => {
  const f = await fixture();
  chmodSync(f.writerPaths[0], 0o644);
  expect((await f.cli("check-staging-bindings.mjs")).code).toBe(1);
  chmodSync(f.writerPaths[0], 0o600);
  for (const SLM_URL of ["https://memory.fractals-solutions.com", "https://shared-living-memory.nikolay-trakiyski.workers.dev", "https://u:p@staging.example.test", `${origin}#fragment`]) {
    expect((await f.cli("check-staging-bindings.mjs", [], { SLM_URL })).code).toBe(1);
  }
  expect(f.requests()).toBe(0);
});

it("rejects tool errors, wrong RPC ids, redirects and malformed success bodies", async () => {
  for (const variant of ["tool", "wrong_id", "malformed", "redirect"]) {
    let attempts = 0;
    const client = createLoadClient({ origin, key: "synthetic", sleep: async () => {}, fetchImpl: async (_url: any, init: any) => {
      attempts++; const request = JSON.parse(init.body);
      if (variant === "redirect") return new Response("", { status: 307, headers: { location: "https://evil.example.test" } });
      if (variant === "malformed") return new Response("<html>not MCP</html>");
      const result = variant === "tool"
        ? { isError: true, structuredContent: { ok: false, error: { code: "dependency_unavailable", retryable: false } }, content: [{ text: "principal" }] }
        : { structuredContent: { ok: true, data: { principal: {} } } };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: variant === "wrong_id" ? "other" : request.id, result }));
    } });
    expect((await client.tool("whoami")).ok).toBe(false);
    expect(attempts).toBe(1);
  }
  expect(parseSseStream('event: message\ndata: {"a":\ndata: 1}\n\n')).toEqual([{ event: "message", data: '{"a":\n1}' }]);
});


it("requires the exact candidate SHA and refuses a mismatched deployed release", async () => {
  const f = await fixture();
  for (const SLM_EXPECTED_RELEASE_ID of ["", "candidate", "a".repeat(40)]) {
    const result = await f.cli("check-staging-bindings.mjs", [], { SLM_EXPECTED_RELEASE_ID });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(SLM_EXPECTED_RELEASE_ID.length === 40 ? "deployed_vars_mismatch" : "expected_release_required");
  }
  expect(f.attempts()).toBe(0);
});

it("detects incomplete authoritative provenance using the real schema and cleans only run IDs", async () => {
  const f = await fixture({ badProvenance: true });
  expect((await f.cli("check-staging-bindings.mjs")).code).toBe(0);
  const result = await f.cli("staging-agent-load.mjs", ["--confirm-cleanup"]);
  expect(result.code).toBe(1);
  const report = JSON.parse(readFileSync(f.env.SLM_LOAD_REPORT, "utf8"));
  expect(report.error).toBe("partial_or_missing_provenance");
  expect(f.counts.created).toBe(110); expect(f.counts.deleted).toBe(110);
}, 20_000);

it("measures complete chat SSE and rejects missing completion or stream errors", async () => {
  for (const body of ['data: {"response":"Citation [Source 1]"}\n\n', 'data: {"error":"failed"}\n\ndata: [DONE]\n\n']) {
    const client = createLoadClient({ origin, key: "fixture", fetchImpl: async () => new Response(body, { headers: { "content-type": "text/event-stream" } }) });
    expect((await client.chat("fixture")).ok).toBe(false);
  }
});

it("accepts real provider citation tokens over HTTP and rejects missing or impossible source numbers", async () => {
  let events: object[] = [];
  let requests = 0;
  const server = createServer((request, response) => {
    requests++;
    expect(request.url).toBe("/chat");
    expect(request.headers.authorization).toBe("Bearer fixture");
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  servers.push(server);
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address() as { port: number };
  const client = createLoadClient({ origin: `http://127.0.0.1:${address.port}`, key: "fixture" });
  const text = "The silver compass retains safe harbor decisions [1].";
  events = ["The silver compass retains safe harbor decisions [", 1, "]."].map(token => ({
    response: token, choices: [{ delta: { content: String(token) } }],
  }));
  const numbered = await client.chat("What does the silver compass retain?");
  expect(numbered.ok).toBe(true);
  if (numbered.ok) expect(numbered.value.answer_bytes).toBe(Buffer.byteLength(text));
  for (const citation of ["[Source 1]", "[Source 1](https://example.test/evidence)", "[1](https://example.test/evidence)"]) {
    events = [{ response: `Safe harbor decisions ${citation}.` }];
    expect((await client.chat("fixture")).ok).toBe(true);
  }
  for (const [answer, error] of [
    ["Safe harbor decisions.", "chat_grounding_missing"],
    ["Safe harbor decisions [0].", "chat_citation_invalid"],
    ["Safe harbor decisions [Source 9].", "chat_citation_invalid"],
    ["Safe harbor decisions [1] [-1].", "chat_citation_invalid"],
  ]) {
    events = [{ response: answer }];
    const result = await client.chat("fixture");
    expect(result).toMatchObject({ ok: false, error, retries: 0 });
  }
  expect(requests).toBe(8);
});


it("settles four concurrent cleanup workers and continues after one HTTP failure without retrying deletion", async () => {
  const f = await fixture({ badProvenance: true, failFirstCleanup: true });
  expect((await f.cli("check-staging-bindings.mjs")).code).toBe(0);
  const result = await f.cli("staging-agent-load.mjs", ["--confirm-cleanup"]);
  expect(result.code).toBe(1);
  expect(f.counts.created).toBe(110);
  expect(f.counts.deleted).toBe(109);
  expect(f.cleanupStats()).toEqual({ attempts: 110, peak: 4 });
  const report = JSON.parse(readFileSync(f.env.SLM_LOAD_REPORT, "utf8"));
  expect(report.cleanup).toEqual({ complete: 109, pending: 0, failed: 1 });
  expect(f.db.prepare("SELECT COUNT(*) AS count FROM entries").get()).toEqual({ count: 1 });
  expect(f.db.prepare("SELECT COUNT(*) AS count FROM capture_receipts WHERE state = 'erased'").get()).toEqual({ count: 109 });
  const journal = readFileSync(f.env.SLM_CLEANUP_MANIFEST, "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(journal.filter(row => row.type === "cleanup_failed")).toHaveLength(1);
  expect(journal.filter(row => row.type === "erasure")).toHaveLength(109);
}, 20_000);


it("checks every default recall result against recorded fixture IDs, ownership and visibility without filtering", () => {
  const fixtures = new Map([
    ["owned", { owner_id: "alice", spec: { visibility: "private" } }],
    ["public", { owner_id: "bob", spec: { visibility: "public" } }],
    ["private", { owner_id: "bob", spec: { visibility: "private" } }],
  ]);
  const match = (entry_id: string, owner: string, visibility: string) => ({ entry: { entry_id, owner: { id: owner }, visibility }, citations: [{ id: "evidence" }] });
  const valid = match("owned", "alice", "private");
  const data = (extra: any) => ({ semantic_available: true, matches: [valid, extra] });
  expect(validateRecallFixtures(data(match("public", "bob", "public")), "alice", fixtures)).toBeNull();
  expect(validateRecallFixtures(data(match("other-run", "alice", "private")), "alice", fixtures)).toBe("unexpected_fixture");
  expect(validateRecallFixtures(data(match("private", "bob", "public")), "alice", fixtures)).toBe("cross_owner_private_leak");
  expect(validateRecallFixtures(data(match("public", "alice", "public")), "alice", fixtures)).toBe("fixture_metadata_mismatch");
  expect(validateRecallFixtures(data(match("owned", "alice", "public")), "alice", fixtures)).toBe("fixture_metadata_mismatch");
  expect(validateRecallFixtures(data({ ...valid, citations: [] }), "alice", fixtures)).toBe("citations_missing");
  expect(validateRecallFixtures({ semantic_available: false, matches: [valid] }, "alice", fixtures)).toBe("semantic_unavailable");
  expect(validateRecallFixtures({ semantic_available: true, matches: [] }, "alice", fixtures)).toBe("semantic_matches_missing");
});
