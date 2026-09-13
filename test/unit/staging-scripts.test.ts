import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import * as load from "../../scripts/staging-agent-load.mjs";
import * as check from "../../scripts/check-staging-bindings.mjs";

const projectRoot = resolve(import.meta.dirname, "../..");

// Synthetic denylist ids — never real production ids.
const PROD_D1_ID = "prod-d1-0000-0000-0000-000000000001";
const PROD_KV_ID = "prod-kv-000000000000000000000000000001";
const PROD_VECTOR_NAME = "prod-shared-living-memory-vectors";

function productionConfig() {
  return {
    name: "shared-living-memory",
    vars: { SLM_DEPLOYMENT_ID: "slm-fractals-production" },
    d1_databases: [{ binding: "DB", database_id: PROD_D1_ID }],
    kv_namespaces: [{ binding: "OAUTH_KV", id: PROD_KV_ID }],
    vectorize: [{ binding: "VECTORIZE", index_name: PROD_VECTOR_NAME }],
  };
}

function stagingConfig() {
  // Staging labelled correctly, but copying production ids — must be rejected.
  return {
    name: "shared-living-memory-staging",
    vars: { SLM_DEPLOYMENT_ID: "slm-fractals-staging", SLM_ENVIRONMENT: "staging" },
    d1_databases: [{ binding: "DB", database_id: PROD_D1_ID }],
    kv_namespaces: [{ binding: "OAUTH_KV", id: PROD_KV_ID }],
    vectorize: [{ binding: "VECTORIZE", index_name: PROD_VECTOR_NAME }],
  };
}

describe("check-staging-bindings.mjs", () => {
  it("rejects a copied production D1/KV/Vectorize id even when the label says staging", () => {
    const denylist = check.buildDenylist(productionConfig());
    const staging = check.collectBindings(stagingConfig());
    const violations = check.compareBindings(staging, denylist);

    const types = violations.map(v => v.type);
    expect(types).toContain("shared_d1_id");
    expect(types).toContain("shared_kv_id");
    expect(types).toContain("shared_vectorize_index");
  });

  it("rejects the production script name and deployment id", () => {
    const denylist = check.buildDenylist(productionConfig());
    const staging = check.collectBindings({
      name: "shared-living-memory", // copied production script name
      vars: { SLM_DEPLOYMENT_ID: "slm-fractals-production" },
      d1_databases: [{ database_id: "staging-d1" }],
      kv_namespaces: [{ id: "staging-kv" }],
      vectorize: [{ index_name: "staging-vectors" }],
    });
    const types = check.compareBindings(staging, denylist).map(v => v.type);
    expect(types).toContain("production_script_name");
    expect(types).toContain("production_deployment_id");
  });

  it("fails closed when staging bindings are missing required fields", () => {
    expect(check.failClosedMissing(check.collectBindings({}))).toEqual([
      "script_name",
      "deployment_id",
      "d1_database_id",
      "kv_namespace_id",
      "vectorize_index_name",
    ]);
  });

  it("requires environment=staging and a matching deployment id in whoami", () => {
    const good = check.validateWhoami({
      deployment: {
        id: "slm-fractals-staging",
        environment: "staging",
        canonical_url: "https://staging.example.test",
        write_mode: "enabled",
      },
    }, { expectedDeploymentId: "slm-fractals-staging", expectedOrigin: "https://staging.example.test" });
    expect(good.ok).toBe(true);
    expect(good.errors).toEqual([]);

    const wrongEnv = check.validateWhoami({
      deployment: { id: "slm-fractals-staging", environment: "production" },
    });
    expect(wrongEnv.ok).toBe(false);
    expect(wrongEnv.errors).toContain("environment_not_staging");

    const wrongId = check.validateWhoami({
      deployment: { id: "not-the-stage", environment: "staging" },
    });
    expect(wrongId.ok).toBe(false);
    expect(wrongId.errors).toContain("deployment_id_mismatch");

    const missingDeployment = check.validateWhoami({ principal: {} });
    expect(missingDeployment.ok).toBe(false);
    expect(missingDeployment.errors).toContain("whoami_deployment_missing");
  });

  it("rejects a canonical_url whose origin does not match the expected stage origin", () => {
    const result = check.validateWhoami({
      deployment: { id: "slm-fractals-staging", environment: "staging", canonical_url: "https://production.example.test" },
    }, { expectedOrigin: "https://staging.example.test" });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("canonical_url_origin_mismatch");
  });

  it("parses JSONC with comments and trailing commas", () => {
    expect(check.parseJsonc('{\n// line comment\n"a": 1,\n/* block */ "b": [1, 2,],\n}')).toEqual({
      a: 1,
      b: [1, 2],
    });
  });

  it("reads the real wrangler.jsonc and verifies staging does not inherit production resources", () => {
    const config = check.parseJsonc(readFileSync(resolve(projectRoot, "wrangler.jsonc"), "utf8"));
    const denylist = check.buildDenylist(config);
    const staging = check.collectBindings(config.envs.staging);

    expect(denylist.d1_databases.some(d => d.database_id)).toBe(true);
    expect(denylist.kv_namespaces.some(k => k.id)).toBe(true);
    expect(denylist.vectorize.some(v => v.index_name)).toBe(true);

    expect(check.compareBindings(staging, denylist)).toEqual([]);
    expect(staging.script_name).not.toBe(denylist.script_name);
    expect(staging.deployment_id).not.toBe(denylist.deployment_id);
    expect(check.failClosedMissing(staging)).toEqual([]);
  });
});

describe("staging-agent-load.mjs — URL and origin safety", () => {
  it("rejects embedded credentials and fragments", () => {
    expect(load.parseStrictUrl("https://user:pass@staging.example.test").errors).toContain("url_credentials");
    expect(load.parseStrictUrl("https://staging.example.test/path#frag").errors).toContain("url_fragment");
    expect(load.parseStrictUrl("ftp://staging.example.test").errors).toContain("url_scheme");
    expect(load.parseStrictUrl("").errors).toContain("url_missing");
    expect(load.parseStrictUrl("https://staging.example.test").errors).toEqual([]);
  });

  it("recognises both production domains", () => {
    expect(load.isProductionOrigin("https://shared-living-memory.nikolay-trakiyski.workers.dev")).toBe(true);
    expect(load.isProductionOrigin("https://memory.fractals-solutions.com")).toBe(true);
    expect(load.isProductionOrigin("https://staging.example.test")).toBe(false);
  });

  it("rejects an unknown origin not in the verified manifest and production origins", () => {
    const unknown = load.preflightUrl("https://unknown.example.test", {
      manifestOrigin: "https://staging.example.test",
    });
    expect(unknown.ok).toBe(false);
    expect(unknown.errors).toContain("origin_not_in_manifest");

    const prod = load.preflightUrl("https://memory.fractals-solutions.com", {
      manifestOrigin: "https://staging.example.test",
    });
    expect(prod.ok).toBe(false);
    expect(prod.errors).toContain("production_origin_refused");

    const ok = load.preflightUrl("https://staging.example.test", {
      manifestOrigin: "https://staging.example.test",
    });
    expect(ok.ok).toBe(true);
    expect(ok.origin).toBe("https://staging.example.test");
  });

  it("flags cross-origin redirects", () => {
    expect(load.isCrossOriginRedirect("https://staging.example.test", "https://evil.example.test/x")).toBe(true);
    expect(load.isCrossOriginRedirect("https://staging.example.test", "/same-origin")).toBe(false);
  });
});

describe("staging-agent-load.mjs — retry policy", () => {
  it("caps retries at three for reads and keyed captures, zero otherwise", () => {
    expect(load.maxRetries("read")).toBe(3);
    expect(load.maxRetries("keyed-capture")).toBe(3);
    expect(load.maxRetries("unkeyed-remember")).toBe(0);
    expect(load.maxRetries("append")).toBe(0);
    expect(load.maxRetries("update")).toBe(0);
    expect(load.maxRetries("forget")).toBe(0);
  });

  it("classifies tools into retryable vs never-retry kinds", () => {
    expect(load.classifyToolKind("remember", { idempotency_key: "k1" })).toBe("keyed-capture");
    expect(load.classifyToolKind("remember", {})).toBe("unkeyed-remember");
    expect(load.classifyToolKind("recall")).toBe("read");
    expect(load.classifyToolKind("list_recent")).toBe("read");
    expect(load.classifyToolKind("append")).toBe("unkeyed-write");
    expect(load.classifyToolKind("update")).toBe("unkeyed-write");
    expect(load.classifyToolKind("forget")).toBe("forget");
    expect(load.isRetryableKind("keyed-capture")).toBe(true);
    expect(load.isRetryableKind("unkeyed-remember")).toBe(false);
  });

  it("honours the fixed delay ladder, larger Retry-After (bounded), and exhaustion", () => {
    expect(load.retryDelayMs(0)).toBe(500);
    expect(load.retryDelayMs(1)).toBe(1000);
    expect(load.retryDelayMs(2)).toBe(2000);
    expect(load.retryDelayMs(3)).toBeNull();

    expect(load.retryDelayMs(0, 5000)).toBe(5000);
    expect(load.retryDelayMs(0, 100000)).toBe(30000);
    expect(load.retryDelayMs(0, 100)).toBe(500);
  });

  it("parses Retry-After seconds and HTTP dates", () => {
    expect(load.parseRetryAfterMs({ "retry-after": "7" })).toBe(7000);
    expect(load.parseRetryAfterMs({})).toBeNull();
  });
});

describe("staging-agent-load.mjs — MCP response + cleanup manifest", () => {
  it("asserts HTTP status, JSON-RPC error and tool isError separately", () => {
    const toolError = load.parseMcpResponse(
      200,
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: { isError: true } }),
    );
    expect(toolError.httpOk).toBe(true);
    expect(toolError.toolIsError).toBe(true);
    expect(toolError.jsonrpcError).toBeNull();

    const rpcError = load.parseMcpResponse(
      500,
      JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "not found" } }),
    );
    expect(rpcError.httpOk).toBe(false);
    expect(rpcError.toolIsError).toBe(false);
    expect(rpcError.jsonrpcError).not.toBeNull();
  });

  it("parses SSE MCP responses", () => {
    const sse = load.parseMcpResponse(
      200,
      'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n',
      "text/event-stream",
    );
    expect(sse.sse).toBe(true);
    expect(sse.messages).toHaveLength(1);
    expect(sse.messages[0].result.ok).toBe(true);
  });

  it("writes the cleanup manifest with mode 0600", () => {
    const dir = mkdtempSync(join(tmpdir(), "slm-cleanup-"));
    try {
      const manifestPath = join(dir, "cleanup.json");
      const result = load.writeCleanupManifest(manifestPath, [
        { id: "fixture-1", owner: "alice", kind: "keyed-capture" },
      ]);
      expect(result.count).toBe(1);
      expect(statSync(manifestPath).mode & 0o777).toBe(0o600);
      expect(load.loadCleanupManifest(manifestPath)).toEqual([
        { id: "fixture-1", owner: "alice", kind: "keyed-capture" },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("computes nearest-rank p50/p95", () => {
    expect(load.p50([1, 2, 3, 4, 5])).toBe(3);
    expect(load.p95([1, 2, 3, 4, 5])).toBe(5);
    expect(load.computePercentile([], 95)).toBeNull();
  });
});
