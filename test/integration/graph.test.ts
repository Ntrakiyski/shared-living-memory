import { describe, it, expect, beforeEach } from "vitest";
import worker from "../../src/testing";
import { makeTestEnv, makeTestDb } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import type { Env } from "../../src/testing";
import { D1Mock } from "../helpers/d1-mock";
import { AUTH_PEPPER, hmacKey } from "../../src/auth";

const ctx = { waitUntil: (_: Promise<any>) => {} } as any;

function seedEntry(db: D1Mock, id: string, content: string, tags: string[] = [], importance = 0, owner_user_id = "") {
  db.entries.push({ id, content, tags: JSON.stringify(tags), source: "api", created_at: 1000, vector_ids: "[]", importance_score: importance, owner_user_id });
}

function pushEdge(db: D1Mock, source_id: string, target_id: string, type = "relates_to", weight = 0.7) {
  db.edges.push({ id: `${source_id}-${target_id}-${type}`, source_id, target_id, type, weight, provenance: "inferred", metadata: "{}", created_at: 1, updated_at: 1 });
}

describe("GET /graph", () => {
  let env: Env;
  let db: D1Mock;

  beforeEach(() => {
    db = makeTestDb();
    env = makeTestEnv(db);
  });

  it("requires auth", async () => {
    const res = await worker.fetch(req("GET", "/graph", { token: null }), env, ctx);
    expect(res.status).toBe(401);
  });

  it("returns nodes and the edges among them, with kind and status annotations", async () => {
    seedEntry(db, "a", "Memory A", ["kind:semantic"]);
    seedEntry(db, "b", "Memory B", ["kind:episodic", "status:deprecated"]);
    pushEdge(db, "a", "b");

    const res = await worker.fetch(req("GET", "/graph"), env, ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(data.nodes.map((n: any) => n.id).sort()).toEqual(["a", "b"]);
    const a = data.nodes.find((n: any) => n.id === "a");
    expect(a).toMatchObject({ kind: "semantic", status: null, label: "Memory A" });
    const b = data.nodes.find((n: any) => n.id === "b");
    expect(b).toMatchObject({ kind: "episodic", status: "deprecated" });
    expect(data.edges).toEqual([{ source: "a", target: "b", type: "relates_to", weight: 0.7, confidence: 1 }]);
  });

  it("never returns dangling edges (an endpoint missing from the node set)", async () => {
    seedEntry(db, "a", "Memory A");
    seedEntry(db, "b", "Memory B");
    pushEdge(db, "a", "b");
    pushEdge(db, "a", "ghost"); // ghost has no entry row

    const res = await worker.fetch(req("GET", "/graph"), env, ctx);
    const data = await res.json() as any;
    expect(data.nodes.map((n: any) => n.id).sort()).toEqual(["a", "b"]);
    expect(data.edges).toHaveLength(1);
    expect(data.edges[0]).toMatchObject({ source: "a", target: "b" });
  });

  it("returns the neighborhood of a seed when ?seed= is given", async () => {
    seedEntry(db, "seed", "Seed");
    seedEntry(db, "n1", "One hop");
    seedEntry(db, "n2", "Two hops");
    seedEntry(db, "far", "Unconnected");
    pushEdge(db, "seed", "n1");
    pushEdge(db, "n1", "n2");

    const res = await worker.fetch(req("GET", "/graph?seed=seed"), env, ctx);
    const data = await res.json() as any;
    expect(data.nodes.map((n: any) => n.id).sort()).toEqual(["n1", "n2", "seed"]);
    expect(data.nodes.map((n: any) => n.id)).not.toContain("far");
  });

  it("returns the whole graph by default — no node cap", async () => {
    for (let i = 0; i < 250; i++) seedEntry(db, `n${i}`, `Memory ${i}`);
    for (let i = 0; i < 249; i++) pushEdge(db, `n${i}`, `n${i + 1}`);

    const res = await worker.fetch(req("GET", "/graph"), env, ctx);
    const data = await res.json() as any;
    expect(data.nodes).toHaveLength(250);
    expect(data.edges).toHaveLength(249);
  });

  it("still honors an explicit ?limit=", async () => {
    for (let i = 0; i < 10; i++) seedEntry(db, `n${i}`, `Memory ${i}`);
    for (let i = 0; i < 9; i++) pushEdge(db, `n${i}`, `n${i + 1}`);

    const res = await worker.fetch(req("GET", "/graph?limit=4"), env, ctx);
    const data = await res.json() as any;
    expect(data.nodes).toHaveLength(4);
  });

  it("excludes other users' private entries from graph nodes", async () => {
    seedEntry(db, "pub", "Public note", [], 0, "u1");
    seedEntry(db, "priv-other", "Other private", ["private"], 0, "u2");
    seedEntry(db, "mine", "My note", [], 0, "u1");
    pushEdge(db, "pub", "priv-other");
    pushEdge(db, "pub", "mine");

    const res = await worker.fetch(req("GET", "/graph"), env, ctx);
    const data = await res.json() as any;
    const nodeIds = data.nodes.map((n: any) => n.id);
    expect(nodeIds).toContain("pub");
    expect(nodeIds).toContain("mine");
    expect(nodeIds).not.toContain("priv-other");
  });

  it("includes user's own private entries in graph", async () => {
    const secret = "graph-secret";
    db.users.push({ id: "sys", username: "graph-owner", normalized_username: "graph-owner", auth_key_hash: await hmacKey(secret, AUTH_PEPPER), auth_key_prefix: "slm_graph", status: "active", created_at: 1000 });
    seedEntry(db, "mine", "My private", ["private"], 0, "sys");
    // Private graph nodes form a separate visibility partition because edges
    // do not carry ACLs of their own.
    seedEntry(db, "other", "My other private", ["private"], 0, "sys");
    pushEdge(db, "mine", "other");

    const res = await worker.fetch(req("GET", "/graph", {
      userCredentials: { username: "graph-owner", key: `slm_sys.${secret}` },
    }), env, ctx);
    const data = await res.json() as any;
    const nodeIds = data.nodes.map((n: any) => n.id);
    expect(nodeIds).toContain("mine");
  });

  it("shows edges between public entries across users", async () => {
    seedEntry(db, "a", "User1 public", [], 0, "u1");
    seedEntry(db, "b", "User2 public", [], 0, "u2");
    pushEdge(db, "a", "b");

    const res = await worker.fetch(req("GET", "/graph"), env, ctx);
    const data = await res.json() as any;
    expect(data.edges).toHaveLength(1);
    expect(data.edges[0]).toMatchObject({ source: "a", target: "b" });
  });
});
