import { describe, it, expect, beforeEach } from "vitest";
import worker from "../../src/testing";
import { makeTestEnv, makeTestDb } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import { D1Mock } from "../helpers/d1-mock";

const ctx = { waitUntil: (_: Promise<any>) => {} } as any;

describe("GET /health", () => {
  let db: D1Mock;
  beforeEach(() => { db = makeTestDb(); });

  it("returns 200 without auth (liveness)", async () => {
    const env = makeTestEnv(db);
    const res = await worker.fetch(req("GET", "/health", { token: null }), env, ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
  });

  it("accepts any auth method", async () => {
    const env = makeTestEnv(db);
    const res = await worker.fetch(req("GET", "/health"), env, ctx);
    expect(res.status).toBe(200);
  });
});

describe("GET /ready", () => {
  let db: D1Mock;
  beforeEach(() => { db = makeTestDb(); });

  it("returns 200 when D1 is reachable", async () => {
    const env = makeTestEnv(db);
    const res = await worker.fetch(req("GET", "/ready"), env, ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(data.status).toBe("ready");
  });
});
