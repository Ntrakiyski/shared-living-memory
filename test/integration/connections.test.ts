import { describe, it, expect, beforeEach } from "vitest";
import worker from "../../src/testing";
import { makeTestEnv, makeTestDb } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import type { Env } from "../../src/testing";
import { D1Mock } from "../helpers/d1-mock";

const ctx = { waitUntil: (_: Promise<any>) => {} } as any;

function seedEntry(db: D1Mock, id: string, content: string, tags: string[] = [], owner_user_id = "") {
  db.entries.push({ id, content, tags: JSON.stringify(tags), source: "api", created_at: 1000, vector_ids: "[]", owner_user_id });
}

function pushEdge(db: D1Mock, source_id: string, target_id: string, type: string, weight = 0.5) {
  db.edges.push({ id: `${source_id}-${target_id}-${type}`, source_id, target_id, type, weight, provenance: "explicit", metadata: "{}", created_at: 1, updated_at: 1 });
}

describe("GET /connections", () => {
  let env: Env;
  let db: D1Mock;

  beforeEach(() => {
    db = makeTestDb();
    env = makeTestEnv(db);
  });

  it("requires auth", async () => {
    const res = await worker.fetch(req("GET", "/connections?id=a", { token: null }), env, ctx);
    expect(res.status).toBe(401);
  });

  it("returns 400 when id is missing", async () => {
    const res = await worker.fetch(req("GET", "/connections"), env, ctx);
    expect(res.status).toBe(400);
    const data = await res.json() as any;
    expect(data.ok).toBe(false);
  });

  it("returns the 1-hop neighbors of an entry with their edge type", async () => {
    seedEntry(db, "a", "Decision A");
    seedEntry(db, "b", "Outcome B");
    pushEdge(db, "a", "b", "relates_to", 0.7);

    const res = await worker.fetch(req("GET", "/connections?id=a"), env, ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(data.connections).toHaveLength(1);
    expect(data.connections[0]).toMatchObject({ id: "b", content: "Outcome B", type: "relates_to", label: "Related to" });
  });

  it("filters by relationship type", async () => {
    seedEntry(db, "a", "A");
    seedEntry(db, "b", "B");
    seedEntry(db, "c", "C");
    pushEdge(db, "a", "b", "relates_to");
    pushEdge(db, "a", "c", "supersedes");

    const res = await worker.fetch(req("GET", "/connections?id=a&type=supersedes"), env, ctx);
    const data = await res.json() as any;
    expect(data.connections.map((c: any) => c.id)).toEqual(["c"]);
  });

  it("serializes distinct pair relationships with endpoint direction", async () => {
    seedEntry(db, "a", "A");
    seedEntry(db, "b", "B");
    pushEdge(db, "a", "b", "relates_to", 0.9);
    pushEdge(db, "b", "a", "clarifies", 0.8);

    const res = await worker.fetch(req("GET", "/connections?id=a"), env, ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.connections).toEqual([
      expect.objectContaining({ id: "b", edge_id: "a-b-relates_to", source_id: "a", target_id: "b", direction: "undirected" }),
      expect.objectContaining({ id: "b", edge_id: "b-a-clarifies", source_id: "b", target_id: "a", direction: "inbound" }),
    ]);
  });

  it("returns an empty list when there are no connections", async () => {
    seedEntry(db, "a", "A");
    const res = await worker.fetch(req("GET", "/connections?id=a"), env, ctx);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(data.connections).toEqual([]);
  });

  it("excludes other users' private entries from connections", async () => {
    seedEntry(db, "a", "My entry", [], "u1");
    seedEntry(db, "b", "Other private", ["private"], "u2");
    seedEntry(db, "c", "Other public", [], "u2");
    pushEdge(db, "a", "b", "relates_to", 0.7);
    pushEdge(db, "a", "c", "relates_to", 0.7);

    const res = await worker.fetch(req("GET", "/connections?id=a"), env, ctx);
    const data = await res.json() as any;
    const ids = data.connections.map((c: any) => c.id);
    expect(ids).toContain("c");
    expect(ids).not.toContain("b");
  });

  it("shows cross-user public connections", async () => {
    seedEntry(db, "a", "User1 note", [], "u1");
    seedEntry(db, "b", "User2 note", [], "u2");
    pushEdge(db, "a", "b", "relates_to", 0.8);

    const res = await worker.fetch(req("GET", "/connections?id=a"), env, ctx);
    const data = await res.json() as any;
    expect(data.connections).toHaveLength(1);
    expect(data.connections[0].id).toBe("b");
  });

  it("does not reveal whether a private seed exists", async () => {
    const missing = await worker.fetch(req("GET", "/connections?id=hidden"), env, ctx);
    const missingBody = await missing.text();

    seedEntry(db, "hidden", "Another user's private memory", ["private"], "another-user");
    seedEntry(db, "public-neighbor", "Public neighbor");
    pushEdge(db, "hidden", "public-neighbor", "relates_to");
    const hidden = await worker.fetch(req("GET", "/connections?id=hidden"), env, ctx);

    expect(hidden.status).toBe(missing.status);
    expect(await hidden.text()).toBe(missingBody);
  });
});
