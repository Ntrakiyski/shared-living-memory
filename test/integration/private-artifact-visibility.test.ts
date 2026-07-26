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
});
