import { beforeEach, describe, expect, it } from "vitest";

import worker from "../../src/testing";
import { AUTH_PEPPER, hmacKey } from "../../src/auth";
import { makeTestDb, makeTestEnv } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import type { Env } from "../../src/testing";
import { D1Mock } from "../helpers/d1-mock";

const ctx = { waitUntil: (_: Promise<any>) => {} } as any;

describe("private child artifacts", () => {
  let db: D1Mock;
  let env: Env;
  let credentials: { username: string; key: string };

  beforeEach(async () => {
    db = makeTestDb();
    env = makeTestEnv(db);
    const secret = "alice-private-artifacts";
    db.users.push({
      id: "alice", username: "Alice", normalized_username: "alice",
      auth_key_hash: await hmacKey(secret, AUTH_PEPPER), auth_key_prefix: "slm_alice",
      status: "active", created_at: 1,
    });
    credentials = { username: "Alice", key: `slm_alice.${secret}` };
  });

  it("makes restore owner-only and indistinguishable from a missing parent", async () => {
    db.entries.push({
      id: "history", content: "Current public value", tags: "[]", source: "api",
      created_at: 1, vector_ids: "[]", owner_user_id: "bob",
    });
    db.entry_snapshots.push({
      id: "snapshot-secret", entry_id: "history", content: "historical secret",
      tags: "[]", source: "api", created_at: 1,
    });

    const hidden = await worker.fetch(req("POST", "/restore", {
      body: { entry_id: "history", snapshot_id: "snapshot-secret" },
      userCredentials: credentials,
    }), env, ctx);
    const hiddenBody = await hidden.text();

    db.entries = db.entries.filter((entry: any) => entry.id !== "history");
    const missing = await worker.fetch(req("POST", "/restore", {
      body: { entry_id: "history", snapshot_id: "snapshot-secret" },
      userCredentials: credentials,
    }), env, ctx);

    expect(hidden.status).toBe(404);
    expect(missing.status).toBe(hidden.status);
    expect(await missing.text()).toBe(hiddenBody);
    expect(hiddenBody).not.toContain("historical secret");
  });

  it("never exposes Alice's prior private text after she edits and publishes the entry", async () => {
    const bobSecret = "bob-private-artifacts";
    db.users.push({
      id: "bob", username: "Bob", normalized_username: "bob",
      auth_key_hash: await hmacKey(bobSecret, AUTH_PEPPER), auth_key_prefix: "slm_bob",
      status: "active", created_at: 1,
    });
    const bobCredentials = { username: "Bob", key: `slm_bob.${bobSecret}` };

    const captured = await worker.fetch(req("POST", "/capture", {
      body: { content: "Alice confidential first draft" },
      userCredentials: credentials,
    }), env, ctx);
    const capturedBody = await captured.json() as any;
    expect(capturedBody.visibility).toBe("private");

    const updated = await worker.fetch(req("POST", "/update", {
      body: { id: capturedBody.id, content: "Harmless team note" },
      userCredentials: credentials,
    }), env, ctx);
    expect(updated.status).toBe(200);
    const entry = db.entries.find((candidate: any) => candidate.id === capturedBody.id);
    entry.visibility = "public";
    entry.tags = JSON.stringify(JSON.parse(entry.tags).filter((tag: string) => tag !== "private"));

    const exported = await worker.fetch(req("GET", "/export?mode=team_public", {
      userCredentials: bobCredentials,
    }), env, ctx);
    const exportText = await exported.text();

    expect(exported.status).toBe(200);
    expect(exportText).toContain("Harmless team note");
    expect(exportText).not.toContain("Alice confidential first draft");
  });
});
