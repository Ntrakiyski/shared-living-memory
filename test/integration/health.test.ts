import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import worker from "../../src/testing";
import { makeTestEnv, makeTestDb } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import { D1Mock } from "../helpers/d1-mock";

const ctx = { waitUntil: (_: Promise<any>) => {} } as any;

/** Deployment metadata every deployed environment must configure. */
const DEPLOYMENT = {
  SLM_DEPLOYMENT_ID: "slm-test-deployment",
  SLM_ENVIRONMENT: "test",
  SLM_PUBLIC_BASE_URL: "https://memory.example.test",
  SLM_RELEASE_ID: "test-sha",
  SLM_WRITE_MODE: "enabled",
};

describe("GET /health", () => {
  let db: D1Mock;
  beforeEach(() => { db = makeTestDb(); });

  it("returns 200 without auth (liveness)", async () => {
    const env = makeTestEnv(db, DEPLOYMENT);
    const res = await worker.fetch(req("GET", "/health", { token: null }), env, ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
  });

  it("accepts any auth method", async () => {
    const env = makeTestEnv(db, DEPLOYMENT);
    const res = await worker.fetch(req("GET", "/health"), env, ctx);
    expect(res.status).toBe(200);
  });

  it("reports non-secret deployment metadata without a database query", async () => {
    const env = makeTestEnv(db, DEPLOYMENT);
    const res = await worker.fetch(req("GET", "/health", { token: null }), env, ctx);
    const data = await res.json() as any;
    expect(data.status).toBe("ok");
    expect(data.deployment).toEqual({
      id: "slm-test-deployment",
      environment: "test",
      canonical_url: "https://memory.example.test",
      release_id: "test-sha",
      write_mode: "enabled",
    });
    expect(JSON.stringify(data)).not.toMatch(/auth_key|api_key|secret|token/i);
  });

  it("stays live but reports configuration_error when metadata is missing", async () => {
    const env = makeTestEnv(db);
    const res = await worker.fetch(req("GET", "/health", { token: null }), env, ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.status).toBe("configuration_error");
    expect(data.missing_configuration).toEqual([
      "SLM_DEPLOYMENT_ID",
      "SLM_ENVIRONMENT",
      "SLM_PUBLIC_BASE_URL",
      "SLM_RELEASE_ID",
    ]);
    // Liveness never leaks a secret while reporting the gap.
    expect(JSON.stringify(data)).not.toMatch(/auth_key|api_key|secret/i);
  });
});

describe("GET /ready", () => {
  let db: D1Mock;
  beforeEach(() => { db = makeTestDb(); });

  it("returns 200 when configuration is valid and D1 is reachable", async () => {
    const env = makeTestEnv(db, DEPLOYMENT);
    const res = await worker.fetch(req("GET", "/ready"), env, ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(data.status).toBe("ready");
  });

  it("returns 503 not_ready when required deployment metadata is missing", async () => {
    const env = makeTestEnv(db);
    const res = await worker.fetch(req("GET", "/ready"), env, ctx);
    expect(res.status).toBe(503);
    const data = await res.json() as any;
    expect(data.status).toBe("not_ready");
    expect(data.reason).toBe("configuration_error");
    expect(data.missing_configuration).toContain("SLM_DEPLOYMENT_ID");
  });

  it("returns 503 maintenance_read_only in read-only mode", async () => {
    const env = makeTestEnv(db, { ...DEPLOYMENT, SLM_WRITE_MODE: "read-only" });
    const res = await worker.fetch(req("GET", "/ready"), env, ctx);
    expect(res.status).toBe(503);
    const data = await res.json() as any;
    expect(data.status).toBe("maintenance_read_only");
    expect(data.deployment.write_mode).toBe("read-only");
  });

  it("returns 503 not_ready for an invalid write mode", async () => {
    const env = makeTestEnv(db, { ...DEPLOYMENT, SLM_WRITE_MODE: "sometimes" });
    const res = await worker.fetch(req("GET", "/ready"), env, ctx);
    expect(res.status).toBe(503);
    const data = await res.json() as any;
    expect(data.status).toBe("not_ready");
    expect(data.reason).toBe("configuration_error");
  });
});

describe("local development configuration", () => {
  it("names every deployment variable in .dev.vars.example", () => {
    // A developer copying the example must end up with a /ready that explains
    // itself rather than a bare 503, so the example has to name all five.
    const example = readFileSync(join(process.cwd(), ".dev.vars.example"), "utf8");
    for (const name of [
      "AUTH_TOKEN",
      "SLM_DEPLOYMENT_ID",
      "SLM_ENVIRONMENT",
      "SLM_PUBLIC_BASE_URL",
      "SLM_RELEASE_ID",
      "SLM_WRITE_MODE",
    ]) {
      expect({ name, present: new RegExp(`^${name}=`, "m").test(example) })
        .toEqual({ name, present: true });
    }
  });

  it("uses synthetic local values, never a real deployment", () => {
    const example = readFileSync(join(process.cwd(), ".dev.vars.example"), "utf8");
    expect(example).toMatch(/SLM_ENVIRONMENT=test/);
    // No production host or identifier may appear in the committed example.
    expect(example).not.toMatch(/fractals-solutions\.com/);
    expect(example).not.toMatch(/slm-fractals-production/);
  });
});
