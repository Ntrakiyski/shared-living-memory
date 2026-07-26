import { describe, it, expect, beforeEach } from "vitest";
import worker from "../../src/testing";
import { makeTestEnv, makeTestDb } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import type { Env } from "../../src/testing";
import { D1Mock } from "../helpers/d1-mock";
import { AUTH_PEPPER, hmacKey } from "../../src/auth";

const ctx = { waitUntil: (_: Promise<any>) => {} } as any;

describe("POST /link", () => {
  let env: Env;
  let db: D1Mock;

  beforeEach(() => {
    db = makeTestDb();
    db.entries.push(...["a", "b", "new", "old"].map(id => ({
      id, content: id, tags: "[]", source: "api", created_at: 1,
      vector_ids: "[]", owner_user_id: "",
    })));
    env = makeTestEnv(db);
  });

  it("requires auth", async () => {
    const res = await worker.fetch(req("POST", "/link", { body: { source_id: "a", target_id: "b" }, token: null }), env, ctx);
    expect(res.status).toBe(401);
  });

  it("returns 400 when ids are missing", async () => {
    const res = await worker.fetch(req("POST", "/link", { body: { source_id: "a" } }), env, ctx);
    expect(res.status).toBe(400);
    const data = await res.json() as any;
    expect(data.ok).toBe(false);
  });

  it("creates an explicit edge between two entries", async () => {
    const res = await worker.fetch(req("POST", "/link", { body: { source_id: "a", target_id: "b" } }), env, ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(data.type).toBe("relates_to");
    expect(db.edges).toHaveLength(1);
    expect(db.edges[0].provenance).toBe("explicit");
    expect(db.edges[0].weight).toBe(1); // user-asserted links are full weight
  });

  it("rejects a self-link", async () => {
    const res = await worker.fetch(req("POST", "/link", { body: { source_id: "a", target_id: "a" } }), env, ctx);
    expect(res.status).toBe(400);
    expect(db.edges).toHaveLength(0);
  });

  it("rejects an unknown edge type", async () => {
    const res = await worker.fetch(req("POST", "/link", { body: { source_id: "a", target_id: "b", type: "bogus" } }), env, ctx);
    expect(res.status).toBe(400);
    expect(db.edges).toHaveLength(0);
  });

  it("accepts a valid directed type and preserves order", async () => {
    const res = await worker.fetch(req("POST", "/link", { body: { source_id: "new", target_id: "old", type: "supersedes" } }), env, ctx);
    expect(res.status).toBe(200);
    expect(db.edges[0].type).toBe("supersedes");
    expect(db.edges[0].source_id).toBe("new");
    expect(db.edges[0].target_id).toBe("old");
  });

  it("requires both endpoint rows", async () => {
    const res = await worker.fetch(req("POST", "/link", {
      body: { source_id: "a", target_id: "missing" },
    }), env, ctx);

    expect(res.status).toBe(404);
    expect(db.edges).toHaveLength(0);
  });

  it("rejects public-private links even when the actor owns both entries", async () => {
    const secret = "link-secret";
    db.users.push({
      id: "link-owner", username: "link-owner", normalized_username: "link-owner",
      auth_key_hash: await hmacKey(secret, AUTH_PEPPER), auth_key_prefix: "slm_link", status: "active", created_at: 1,
    });
    const a = db.entries.find((entry: any) => entry.id === "a")!;
    const b = db.entries.find((entry: any) => entry.id === "b")!;
    a.owner_user_id = "link-owner";
    b.owner_user_id = "link-owner";
    b.tags = JSON.stringify(["private"]);

    const res = await worker.fetch(req("POST", "/link", {
      body: { source_id: "a", target_id: "b" },
      userCredentials: { username: "link-owner", key: `slm_link-owner.${secret}` },
    }), env, ctx);

    expect(res.status).toBe(400);
    expect(db.edges).toHaveLength(0);
  });
});
