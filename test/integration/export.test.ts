import { describe, it, expect, beforeEach } from "vitest";
import worker from "../../src/testing";
import { makeTestEnv, makeTestDb } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import type { Env } from "../../src/testing";
import { D1Mock } from "../helpers/d1-mock";
import { AUTH_PEPPER, hmacKey } from "../../src/auth";

const ctx = { waitUntil: (_: Promise<any>) => {} } as any;

function seedEntry(db: D1Mock, id: string, content: string, tags: string[] = [], created_at = 1000) {
  db.entries.push({ id, content, tags: JSON.stringify(tags), source: "api", created_at, vector_ids: '["v1"]', recall_count: 0, importance_score: 0, contradiction_wins: 0, contradiction_losses: 0 });
}

async function seedExportActor(db: D1Mock) {
  const secret = "export-secret";
  db.users.push({
    id: "export-owner", username: "export-owner", normalized_username: "export-owner",
    auth_key_hash: await hmacKey(secret, AUTH_PEPPER), auth_key_prefix: "slm_export",
    status: "active", created_at: 1,
  });
  return { username: "export-owner", key: `slm_export-owner.${secret}` };
}

describe("GET /export", () => {
  let env: Env;
  let db: D1Mock;

  beforeEach(() => {
    db = makeTestDb();
    env = makeTestEnv(db);
  });

  it("requires auth", async () => {
    const res = await worker.fetch(req("GET", "/export", { token: null }), env, ctx);
    expect(res.status).toBe(401);
  });

  it("returns all public entries when the count exceeds the /list cap of 100", async () => {
    for (let i = 0; i < 150; i++) seedEntry(db, `e${i}`, `Memory ${i}`, [], 1000 + i);

    const res = await worker.fetch(req("GET", "/export"), env, ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(data.version).toBe(3);
    expect(typeof data.exported_at).toBe("number");
    expect(data.entries).toHaveLength(150);
    // newest first
    expect(data.entries[0].id).toBe("e149");
  });

  it("includes edges and parses tags to real arrays", async () => {
    seedEntry(db, "a", "Memory A", ["work", "kind:semantic"]);
    seedEntry(db, "b", "Memory B", ["idea"]);
    db.edges.push({ id: "edge-1", source_id: "a", target_id: "b", type: "relates_to", weight: 0.7, provenance: "inferred", metadata: "{}", created_at: 1, updated_at: 1 });

    const res = await worker.fetch(req("GET", "/export"), env, ctx);
    const data = await res.json() as any;
    const a = data.entries.find((e: any) => e.id === "a");
    expect(a.tags).toEqual(["work", "kind:semantic"]); // array, not a JSON string
    expect(data.edges).toEqual([
      { source_id: "a", target_id: "b", type: "relates_to", weight: 0.7, provenance: "inferred", created_at: 1, confidence: 1 },
    ]);
  });

  it("never includes vector_ids (deployment-specific, import re-embeds)", async () => {
    seedEntry(db, "a", "Memory A");

    const res = await worker.fetch(req("GET", "/export"), env, ctx);
    const data = await res.json() as any;
    expect(data.entries[0]).not.toHaveProperty("vector_ids");
  });

  it("exports an empty brain as a valid structure with empty arrays", async () => {
    const res = await worker.fetch(req("GET", "/export"), env, ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(data.entries).toEqual([]);
    expect(data.edges).toEqual([]);
  });

  // ── Export modes ────────────────────────────────────────────────────────────

  it("default mode returns all public entries (backward compatible)", async () => {
    db.entries.push(
      { id: "pub1", content: "Public A", tags: "[]", source: "api", created_at: 1000, vector_ids: "[]", owner_user_id: "_system" },
      { id: "priv1", content: "Private A", tags: '["private"]', source: "api", created_at: 2000, vector_ids: "[]", owner_user_id: "_system" },
    );

    const res = await worker.fetch(req("GET", "/export"), env, ctx);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(data.entries).toHaveLength(1);
    expect(data.entries[0].id).toBe("pub1");
  });

  it("mode=all_public returns all users' public entries", async () => {
    db.entries.push(
      { id: "pub1", content: "My public", tags: "[]", source: "api", created_at: 1000, vector_ids: "[]", owner_user_id: "_system" },
      { id: "pub2", content: "Other public", tags: "[]", source: "api", created_at: 2000, vector_ids: "[]", owner_user_id: "other-user" },
      { id: "priv1", content: "My private", tags: '["private"]', source: "api", created_at: 3000, vector_ids: "[]", owner_user_id: "_system" },
    );

    const res = await worker.fetch(req("GET", "/export?mode=all_public"), env, ctx);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(data.mode).toBe("all_public");
    expect(data.entries).toHaveLength(2);
    expect(data.entries.map((e: any) => e.id).sort()).toEqual(["pub1", "pub2"]);
  });

  it("mode=my_public returns only the user's public entries", async () => {
    const userCredentials = await seedExportActor(db);
    db.entries.push(
      { id: "pub1", content: "My public", tags: "[]", source: "api", created_at: 1000, vector_ids: "[]", owner_user_id: "export-owner" },
      { id: "pub2", content: "Other public", tags: "[]", source: "api", created_at: 2000, vector_ids: "[]", owner_user_id: "other-user" },
      { id: "priv1", content: "My private", tags: '["private"]', source: "api", created_at: 3000, vector_ids: "[]", owner_user_id: "export-owner" },
    );

    const res = await worker.fetch(req("GET", "/export?mode=my_public", { userCredentials }), env, ctx);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(data.mode).toBe("my_public");
    expect(data.entries).toHaveLength(1);
    expect(data.entries[0].id).toBe("pub1");
  });

  it("mode=my_private returns only the user's private entries", async () => {
    const userCredentials = await seedExportActor(db);
    db.entries.push(
      { id: "pub1", content: "My public", tags: "[]", source: "api", created_at: 1000, vector_ids: "[]", owner_user_id: "export-owner" },
      { id: "priv1", content: "My private", tags: '["private"]', source: "api", created_at: 2000, vector_ids: "[]", owner_user_id: "export-owner" },
      { id: "priv2", content: "Other private", tags: '["private"]', source: "api", created_at: 3000, vector_ids: "[]", owner_user_id: "other-user" },
    );

    const res = await worker.fetch(req("GET", "/export?mode=my_private", { userCredentials }), env, ctx);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(data.mode).toBe("my_private");
    expect(data.entries).toHaveLength(1);
    expect(data.entries[0].id).toBe("priv1");
  });

  it("edges are filtered to match exported entry set", async () => {
    const userCredentials = await seedExportActor(db);
    db.entries.push(
      { id: "pub1", content: "Public A", tags: "[]", source: "api", created_at: 1000, vector_ids: "[]", owner_user_id: "export-owner" },
      { id: "priv1", content: "Private A", tags: '["private"]', source: "api", created_at: 2000, vector_ids: "[]", owner_user_id: "export-owner" },
    );
    db.edges.push(
      { id: "e1", source_id: "pub1", target_id: "priv1", type: "relates_to", weight: 0.8, provenance: "inferred", metadata: "{}", created_at: 1, updated_at: 1 },
      { id: "e2", source_id: "pub1", target_id: "pub1", type: "relates_to", weight: 0.5, provenance: "inferred", metadata: "{}", created_at: 1, updated_at: 1 },
    );

    // my_private only exports priv1, so only edges with both endpoints in {priv1} should be included
    const res = await worker.fetch(req("GET", "/export?mode=my_private", { userCredentials }), env, ctx);
    const data = await res.json() as any;
    expect(data.entries).toHaveLength(1);
    expect(data.entries[0].id).toBe("priv1");
    // Edge e1 connects pub1→priv1 — pub1 is not exported, so e1 is excluded
    // Edge e2 connects pub1→pub1 — pub1 is not exported, so e2 is excluded
    expect(data.edges).toHaveLength(0);
  });

  it("returns total_count in response", async () => {
    db.entries.push(
      { id: "pub1", content: "Public A", tags: "[]", source: "api", created_at: 1000, vector_ids: "[]", owner_user_id: "_system" },
      { id: "pub2", content: "Public B", tags: "[]", source: "api", created_at: 2000, vector_ids: "[]", owner_user_id: "_system" },
    );

    const res = await worker.fetch(req("GET", "/export"), env, ctx);
    const data = await res.json() as any;
    expect(data.total_count).toBe(2);
  });

  it("invalid mode returns 400", async () => {
    const res = await worker.fetch(req("GET", "/export?mode=invalid"), env, ctx);
    expect(res.status).toBe(400);
    const data = await res.json() as any;
    expect(data.ok).toBe(false);
  });
});
