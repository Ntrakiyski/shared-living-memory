import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../scripts/check-staging-bindings.mjs", () => ({ readVerifiedStage: vi.fn(async () => ({})) }));

async function runFixture(mode: "complete" | "pending" | "false-success" | "existing" | "redirect") {
  // The actual HTTP driver runs; only external Cloudflare binding proof is replaced.
  const { main } = await import("../../scripts/staging-semantic-canary.mjs");
  const { readVerifiedStage } = await import("../../scripts/check-staging-bindings.mjs");
  const entries = new Map<string, { owner: string; content: string; visibility: string }>();
  entries.set("preexisting", { owner: "unrelated", content: "Unrelated memory", visibility: "public" });
  const erased: string[] = [];
  const receipts: string[] = [];
  const requests: string[] = [];
  let userCount = 0;
  let entryCount = 0;
  let keyedCaptures = 0;
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    const url = new URL(req.url!, "http://localhost");
    requests.push(url.pathname);
    const owner = req.headers.authorization ?? "";
    let data: unknown;
    if (url.pathname === "/api/users") {
      expect(readVerifiedStage).toHaveBeenCalled();
      if (mode === "redirect") {
        res.statusCode = 307;
        res.setHeader("Location", `http://${req.headers.host}/steal`);
      } else {
        res.statusCode = 201;
        data = { ok: true, key: `slm_user${++userCount}.secret` };
      }
    } else if (url.pathname === "/capture/batch") {
      keyedCaptures++;
      const item = body.items[0];
      const id = mode === "existing" ? "preexisting" : `fixture-${++entryCount}`;
      const outcome = mode === "existing" ? "replayed" : "created";
      if (mode !== "existing") entries.set(id, { owner, ...item });
      data = { ok: true, data: { items: [{ client_item_id: item.client_item_id, status: outcome, data: {
        outcome, capture_mode: "create_only", entry: { entry_id: id }, receipt: { entry_id: id, episode_id: `episode-${id}`, revision: 1 },
      } }], summary: { created: outcome === "created" ? 1 : 0, replayed: outcome === "replayed" ? 1 : 0, failed: 0 } } };
    } else if (url.pathname === "/capture") {
      const match = [...entries].find(([, entry]) => entry.owner === owner && entry.content === body.content);
      if (match) {
        res.statusCode = 409;
        data = { ok: false, action: "blocked_duplicate", match_id: match[0] };
      } else {
        const id = `fixture-${++entryCount}`;
        entries.set(id, { owner, ...body });
        data = { ok: true, id, action: "stored" };
      }
    } else if (url.pathname === "/recall") {
      data = { ok: true, results: [...entries].filter(([, entry]) => entry.owner === owner || entry.visibility === "public")
        .map(([id]) => ({ id })) };
    } else if (url.pathname === "/forget") {
      if (body.id !== body.confirm_entry_id) {
        res.statusCode = 400;
        data = { ok: false, error: "confirmation_required" };
      } else {
        erased.push(body.id);
        if (mode !== "false-success") entries.delete(body.id);
        data = mode === "false-success" ? { ok: false, error: "not deleted" }
          : { ok: true, id: body.id, operation_id: `op-${body.id}`, erasure_status: mode === "pending" ? "pending_cleanup" : "complete", retry: false };
      }
    } else if (url.pathname === "/erasure-status") {
      const operation = url.searchParams.get("operation_id")!;
      receipts.push(operation);
      data = { ok: true, erasure: { operationId: operation, entryId: operation.slice(3), status: mode === "pending" ? "pending_cleanup" : "complete" } };
    } else {
      res.statusCode = 404;
      data = { ok: false };
    }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(data));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  vi.stubEnv("SLM_BASE_URL", origin);
  vi.stubEnv("SLM_ADMIN_KEY", "slm_admin.secret");
  vi.stubEnv("SLM_ADMIN_KEY_FILE", "");
  const output: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation(value => { output.push(String(value)); });
  let error: unknown;
  try { await main(); } catch (cause) { error = cause; }
  finally {
    log.mockRestore();
    vi.unstubAllEnvs();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  return { error, output, entries, erased, receipts, keyedCaptures, requests };
}

const projectRoot = resolve(import.meta.dirname, "../..");
const canaryScript = resolve(projectRoot, "scripts/staging-semantic-canary.mjs");
const indexScript = resolve(projectRoot, "scripts/assert-vector-metadata-indexes.mjs");

function run(script: string, env: Record<string, string> = {}, input?: string) {
  return spawnSync(process.execPath, [script], {
    cwd: projectRoot,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", ...env } as unknown as NodeJS.ProcessEnv,
    input,
  });
}

function inspectCanaryExport(expression: string) {
  return spawnSync(process.execPath, [
    "--input-type=module",
    "--eval",
    `import * as canary from ${JSON.stringify(pathToFileURL(canaryScript).href)}; console.log(JSON.stringify(${expression}));`,
  ], {
    cwd: projectRoot,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "" } as unknown as NodeJS.ProcessEnv,
  });
}

function meaningfulTokens(value: string): Set<string> {
  return new Set(value.toLowerCase().match(/[a-z]+/g)?.filter(token => token.length >= 4) ?? []);
}

describe("semantic deployment scripts", () => {
  it("executes confirmed keyed-fixture cleanup and verifies every receipt", async () => {
    const result = await runFixture("complete");
    expect(result.error).toBeUndefined();
    expect(result.keyedCaptures).toBe(4);
    expect(result.erased).toHaveLength(4);
    expect(result.receipts).toHaveLength(4);
    expect([...result.entries.keys()]).toEqual(["preexisting"]);
  });

  it.each(["pending", "false-success"] as const)("fails without printing success when cleanup is %s", async mode => {
    const result = await runFixture(mode);
    expect(result.error).toMatchObject({ code: "CANARY_CLEANUP_FAILED" });
    expect(result.output.join("\n")).not.toContain("CANARY_OK");
    expect(result.erased).toHaveLength(4);
  });

  it("never registers a replayed or preexisting entry for deletion", async () => {
    const result = await runFixture("existing");
    expect(result.error).toMatchObject({ code: "CANARY_CAPTURE_FAILED" });
    expect(result.erased).toEqual([]);
    expect(result.entries.has("preexisting")).toBe(true);
  });

  it("never follows a redirect with fixture credentials", async () => {
    const result = await runFixture("redirect");
    expect(result.error).toMatchObject({ code: "CANARY_REQUEST_FAILED" });
    expect(result.requests).toEqual(["/api/users"]);
    expect(result.erased).toEqual([]);
  });
  it("requires an explicit staging URL and admin key", () => {
    const result = run(canaryScript);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("CANARY_CONFIG_MISSING");
  });

  it("refuses the production deployment", () => {
    const result = run(canaryScript, {
      SLM_BASE_URL: "https://shared-living-memory.nikolay-trakiyski.workers.dev",
      SLM_ADMIN_KEY: "not-a-real-key",
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("CANARY_PRODUCTION_REFUSED");
    expect(result.stderr).not.toContain("not-a-real-key");
  });

  it("refuses a configured production alias and rejects malformed production configuration", () => {
    const alias = run(canaryScript, {
      SLM_BASE_URL: "https://memory.example.test/staging-path",
      SLM_PRODUCTION_URL: "https://memory.example.test/production-path",
      SLM_ADMIN_KEY: "not-a-real-key",
    });
    expect(alias.status).toBe(2);
    expect(alias.stderr).toContain("CANARY_PRODUCTION_REFUSED");

    const malformed = run(canaryScript, {
      SLM_BASE_URL: "https://staging.example.test",
      SLM_PRODUCTION_URL: "not a URL",
      SLM_ADMIN_KEY: "not-a-real-key",
    });
    expect(malformed.status).toBe(2);
    expect(malformed.stderr).toContain("CANARY_PRODUCTION_URL_INVALID");
  });

  it("uses personal bearer auth and registers partial captures for cleanup", () => {
    const source = readFileSync(canaryScript, "utf8");
    expect(source).toContain("Authorization: `Bearer ${user?.key ?? adminKey}`");
    expect(source).not.toContain("X-Shared-Living-Memory-User");

    const firstCapture = source.indexOf("ids.alicePrivate = await capture");
    const firstRegistration = source.indexOf("created.push([alice, ids.alicePrivate])");
    const secondCapture = source.indexOf("ids.bobPrivate = await capture");
    expect(firstCapture).toBeGreaterThan(0);
    expect(firstRegistration).toBeGreaterThan(firstCapture);
    expect(secondCapture).toBeGreaterThan(firstRegistration);

  });

  it("defines four token-disjoint semantic probes including a public privacy decoy", () => {
    const inspected = inspectCanaryExport("canary.buildCanaryScenario('unit_test')");

    expect(inspected.status).toBe(0);
    const scenario = JSON.parse(inspected.stdout) as {
      contents: Record<string, string>;
      probes: Array<{
        name: string;
        actor: "alice" | "bob";
        query: string;
        expected: string;
        forbidden: string[];
      }>;
    };
    expect(Object.keys(scenario.contents)).toEqual([
      "alicePrivate",
      "bobPrivate",
      "alicePublic",
      "semantic",
    ]);
    expect(scenario.probes.map(probe => probe.name)).toEqual([
      "alice-own-private",
      "bob-own-private",
      "bob-public-privacy-decoy",
      "alice-semantic",
    ]);
    expect(scenario.probes.find(probe => probe.name === "bob-public-privacy-decoy")).toMatchObject({
      actor: "bob",
      expected: "alicePublic",
      forbidden: ["alicePrivate"],
    });
    for (const probe of scenario.probes) {
      const queryTokens = meaningfulTokens(probe.query);
      for (const target of [probe.expected, ...probe.forbidden]) {
        const targetTokens = meaningfulTokens(scenario.contents[target]);
        expect([...queryTokens].filter(token => targetTokens.has(token)), `${probe.name}:${target}`)
          .toEqual([]);
      }
    }
  });

  it("aborts every canary fetch after a fixed timeout", () => {
    const inspected = inspectCanaryExport(`await (async () => {
      const started = Date.now();
      let aborted = false;
      const hangingFetch = (_input, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("aborted"));
        });
      });
      try {
        await canary.fetchWithTimeout(hangingFetch, "https://staging.example.test", {}, 15);
      } catch {}
      return { aborted, elapsed: Date.now() - started };
    })()`);

    expect(inspected.status).toBe(0);
    const result = JSON.parse(inspected.stdout) as { aborted: boolean; elapsed: number };
    expect(result.aborted).toBe(true);
    expect(result.elapsed).toBeGreaterThanOrEqual(10);
    expect(result.elapsed).toBeLessThan(500);
  });

  it("keeps the canary timeout active through response-body decoding", () => {
    const inspected = inspectCanaryExport(`await (async () => {
      const started = Date.now();
      let aborted = false;
      const headersOnlyFetch = (_input, init) => Promise.resolve({
        json: () => new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("body aborted"));
          });
        }),
      });
      try {
        await canary.fetchWithTimeout(
          headersOnlyFetch,
          "https://staging.example.test",
          {},
          15,
          response => response.json(),
        );
      } catch {}
      return { aborted, elapsed: Date.now() - started };
    })()`);

    expect(inspected.status).toBe(0);
    const result = JSON.parse(inspected.stdout) as { aborted: boolean; elapsed: number };
    expect(result.aborted).toBe(true);
    expect(result.elapsed).toBeGreaterThanOrEqual(10);
    expect(result.elapsed).toBeLessThan(500);
  });

  it("accepts required metadata indexes and ignores extras", () => {
    const result = run(indexScript, {}, JSON.stringify({
      result: [
        { propertyName: "owner_user_id", indexType: "string" },
        { propertyName: "is_private", indexType: "boolean" },
        { propertyName: "extra", indexType: "string" },
      ],
    }));

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("VECTOR_METADATA_INDEXES_OK");
  });

  it("requires exact metadata property names from current Wrangler JSON", () => {
    const result = run(indexScript, {}, JSON.stringify({
      result: [
        { propertyName: "OWNER_USER_ID", indexType: "string" },
        { propertyName: "IS_PRIVATE", indexType: "boolean" },
      ],
    }));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "VECTOR_METADATA_INDEXES_INVALID:owner_user_id_missing,is_private_missing",
    );
  });

  it("fails metadata preflight with safe deterministic codes", () => {
    const result = run(indexScript, {}, JSON.stringify([
      { propertyName: "owner_user_id", type: "boolean" },
    ]));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "VECTOR_METADATA_INDEXES_INVALID:owner_user_id_type,is_private_missing",
    );
  });
});
