import { describe, it, expect, beforeEach } from "vitest";
import worker, { _resetDbReady } from "../../src/testing";
import { makeTestEnv, makeTestDb } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import type { Env } from "../../src/testing";
import { D1Mock } from "../helpers/d1-mock";

function makeCtx() {
  const promises: Promise<any>[] = [];
  return {
    ctx: {
      waitUntil: (p: Promise<any>) => { promises.push(p); },
    } as any,
    flush: () => Promise.all(promises),
  };
}

describe("Visibility Enforcement", () => {
  let env: Env;
  let db: D1Mock;
  let aliceId: string;
  let bobId: string;
  let aliceKey: string;
  let bobKey: string;

  beforeEach(async () => {
    db = makeTestDb();
    env = makeTestEnv(db);
    _resetDbReady();

    // Initialize database (creates system user)
    const { ctx, flush } = makeCtx();
    await worker.fetch(req("GET", "/list"), env, ctx);
    await flush();

    // Create two users
    const createAlice = await worker.fetch(req("POST", "/api/users", { body: { username: "alice" } }), env, makeCtx().ctx);
    const aliceData = await createAlice.json() as any;
    aliceKey = aliceData.key;
    aliceId = db.users.find((u: any) => u.username === "alice")!.id;

    const createBob = await worker.fetch(req("POST", "/api/users", { body: { username: "bob" } }), env, makeCtx().ctx);
    const bobData = await createBob.json() as any;
    bobKey = bobData.key;
    bobId = db.users.find((u: any) => u.username === "bob")!.id;

    // Create entries: Alice's public, Alice's private, Bob's public, Bob's private
    const { ctx: ctx1, flush: flush1 } = makeCtx();
    await worker.fetch(
      req("POST", "/capture", { body: { content: "Alice public", visibility: "public" }, userCredentials: { username: "alice", key: aliceKey } }),
      env, ctx1
    );
    await flush1();

    const { ctx: ctx2, flush: flush2 } = makeCtx();
    await worker.fetch(
      req("POST", "/capture", { body: { content: "Alice private", tags: ["private"] }, userCredentials: { username: "alice", key: aliceKey } }),
      env, ctx2
    );
    await flush2();

    const { ctx: ctx3, flush: flush3 } = makeCtx();
    await worker.fetch(
      req("POST", "/capture", { body: { content: "Bob public", visibility: "public" }, userCredentials: { username: "bob", key: bobKey } }),
      env, ctx3
    );
    await flush3();

    const { ctx: ctx4, flush: flush4 } = makeCtx();
    await worker.fetch(
      req("POST", "/capture", { body: { content: "Bob private", tags: ["private"] }, userCredentials: { username: "bob", key: bobKey } }),
      env, ctx4
    );
    await flush4();
  });

  it("User A cannot see User B's private entries via GET /list", async () => {
    const { ctx, flush } = makeCtx();
    const res = await worker.fetch(
      req("GET", "/list?n=100", { userCredentials: { username: "alice", key: aliceKey } }),
      env, ctx
    );
    await flush();
    const data = await res.json() as any;
    const contents = data.map((e: any) => e.content);
    expect(contents).toContain("Alice public");
    expect(contents).toContain("Bob public");
    expect(contents).toContain("Alice private");
    expect(contents).not.toContain("Bob private");
  });

  it("User A can see User B's public entries via GET /list", async () => {
    const { ctx, flush } = makeCtx();
    const res = await worker.fetch(
      req("GET", "/list?n=100", { userCredentials: { username: "alice", key: aliceKey } }),
      env, ctx
    );
    await flush();
    const data = await res.json() as any;
    const contents = data.map((e: any) => e.content);
    expect(contents).toContain("Bob public");
  });

  it("User A sees all their own entries (private and public)", async () => {
    const { ctx, flush } = makeCtx();
    const res = await worker.fetch(
      req("GET", "/list?n=100", { userCredentials: { username: "alice", key: aliceKey } }),
      env, ctx
    );
    await flush();
    const data = await res.json() as any;
    const contents = data.map((e: any) => e.content);
    expect(contents).toContain("Alice public");
    expect(contents).toContain("Alice private");
  });

  it("User A cannot see User B's private entries via GET /entry", async () => {
    // Find Bob's private entry
    const bobPrivate = db.entries.find((e: any) => e.content === "Bob private");
    expect(bobPrivate).toBeDefined();

    const { ctx } = makeCtx();
    const res = await worker.fetch(
      req("GET", `/entry?id=${bobPrivate.id}`, { userCredentials: { username: "alice", key: aliceKey } }),
      env, ctx
    );
    expect(res.status).toBe(404);
  });

  it("User A cannot forget User B's entries", async () => {
    // Find Bob's public entry
    const bobPublic = db.entries.find((e: any) => e.content === "Bob public");
    expect(bobPublic).toBeDefined();

    const { ctx } = makeCtx();
    const res = await worker.fetch(
      req("POST", "/forget", { body: { id: bobPublic.id }, userCredentials: { username: "alice", key: aliceKey } }),
      env, ctx
    );
    expect(res.status).toBe(403);
  });

  it("System-owned entries explicitly captured as public are visible to all", async () => {
    const { ctx, flush } = makeCtx();
    await worker.fetch(
      req("POST", "/capture", { body: { content: "Legacy note", visibility: "public" } }),
      env, ctx
    );
    await flush();

    const legacyEntry = db.entries.find((e: any) => e.content === "Legacy note");
    expect(legacyEntry).toBeDefined();

    // Alice should see the legacy entry
    const { ctx: ctx2, flush: flush2 } = makeCtx();
    const res = await worker.fetch(
      req("GET", "/list?n=100", { userCredentials: { username: "alice", key: aliceKey } }),
      env, ctx2
    );
    await flush2();
    const data = await res.json() as any;
    const contents = data.map((e: any) => e.content);
    expect(contents).toContain("Legacy note");
  });

  it("User A cannot see User B's private entries in GET /graph", async () => {
    // Create edges between entries so they appear in the graph
    const alicePublic = db.entries.find((e: any) => e.content === "Alice public");
    const bobPublic = db.entries.find((e: any) => e.content === "Bob public");
    const bobPrivate = db.entries.find((e: any) => e.content === "Bob private");
    expect(alicePublic && bobPublic && bobPrivate).toBeTruthy();

    // Link entries to create graph edges
    await worker.fetch(
      req("POST", "/link", { body: { source_id: alicePublic.id, target_id: bobPublic.id }, userCredentials: { username: "alice", key: aliceKey } }),
      env, makeCtx().ctx
    );
    await worker.fetch(
      req("POST", "/link", { body: { source_id: bobPublic.id, target_id: bobPrivate.id }, userCredentials: { username: "bob", key: bobKey } }),
      env, makeCtx().ctx
    );

    // Alice's graph should not include Bob's private entry as a node
    const { ctx, flush } = makeCtx();
    const res = await worker.fetch(
      req("GET", "/graph", { userCredentials: { username: "alice", key: aliceKey } }),
      env, ctx
    );
    await flush();
    const data = await res.json() as any;
    const nodeIds = data.nodes.map((n: any) => n.id);
    expect(nodeIds).toContain(alicePublic.id);
    expect(nodeIds).toContain(bobPublic.id);
    expect(nodeIds).not.toContain(bobPrivate.id);
  });

  it("User A cannot see User B's private entries in GET /connections", async () => {
    // Create a link from Bob public to Bob private
    const bobPublic = db.entries.find((e: any) => e.content === "Bob public");
    const bobPrivate = db.entries.find((e: any) => e.content === "Bob private");
    expect(bobPublic && bobPrivate).toBeTruthy();

    await worker.fetch(
      req("POST", "/link", { body: { source_id: bobPublic.id, target_id: bobPrivate.id }, userCredentials: { username: "bob", key: bobKey } }),
      env, makeCtx().ctx
    );

    // Alice queries connections for Bob's public entry
    const { ctx, flush } = makeCtx();
    const res = await worker.fetch(
      req("GET", `/connections?id=${bobPublic.id}`, { userCredentials: { username: "alice", key: aliceKey } }),
      env, ctx
    );
    await flush();
    const data = await res.json() as any;
    const connIds = data.connections.map((c: any) => c.id);
    expect(connIds).not.toContain(bobPrivate.id);
  });

  it("User A cannot link User B's private entries", async () => {
    const alicePublic = db.entries.find((e: any) => e.content === "Alice public");
    const bobPrivate = db.entries.find((e: any) => e.content === "Bob private");
    expect(alicePublic && bobPrivate).toBeTruthy();

    const { ctx } = makeCtx();
    const res = await worker.fetch(
      req("POST", "/link", { body: { source_id: alicePublic.id, target_id: bobPrivate.id }, userCredentials: { username: "alice", key: aliceKey } }),
      env, ctx
    );
    expect(res.status).toBe(404);
  });

  it("User A cannot unlink User B's private entries", async () => {
    const bobPublic = db.entries.find((e: any) => e.content === "Bob public");
    const bobPrivate = db.entries.find((e: any) => e.content === "Bob private");
    expect(bobPublic && bobPrivate).toBeTruthy();

    // Bob creates a link first
    await worker.fetch(
      req("POST", "/link", { body: { source_id: bobPublic.id, target_id: bobPrivate.id }, userCredentials: { username: "bob", key: bobKey } }),
      env, makeCtx().ctx
    );

    // Alice tries to unlink
    const { ctx } = makeCtx();
    const res = await worker.fetch(
      req("POST", "/unlink", { body: { source_id: bobPublic.id, target_id: bobPrivate.id }, userCredentials: { username: "alice", key: aliceKey } }),
      env, ctx
    );
    expect(res.status).toBe(404);
  });
});
