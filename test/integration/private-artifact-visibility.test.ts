import { beforeEach, describe, expect, it, vi } from "vitest";

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

  it("restores the historical document envelope through the authenticated REST endpoint", async () => {
    db.entries.push({
      id: "owned-history", content: "Current value", tags: '["private"]', source: "api",
      created_at: 2, vector_ids: "[]", owner_user_id: "alice", visibility: "private",
      current_episode_id: "current-episode", revision: 2,
    });
    db.episodes.push(
      {
        id: "historical-episode", entry_id: "owned-history", owner_user_id: "alice",
        content: "Historical research", materialized_content: "Historical research",
        source_url: "urn:isbn:9780141036144", content_type: "research", created_at: 1,
      },
      {
        id: "current-episode", entry_id: "owned-history", owner_user_id: "alice",
        content: "Current value", materialized_content: "Current value",
        source_url: "https://example.test/current", content_type: "text", created_at: 2,
      },
    );
    db.documents.push({
      id: "historical-document", episode_id: "historical-episode", owner_user_id: "alice",
      title: "Historical explicit title", source_url: "urn:isbn:9780141036144", created_at: 1,
    });
    db.entry_snapshots.push({
      id: "historical-snapshot", entry_id: "owned-history", episode_id: "historical-episode",
      content: "Historical research", tags: '["private"]', source: "api", created_at: 3,
      valid_from: null, valid_to: null, epistemic_status: "candidate", revision: 1,
    });

    const response = await worker.fetch(req("POST", "/restore", {
      body: { entry_id: "owned-history", snapshot_id: "historical-snapshot" },
      userCredentials: credentials,
    }), env, ctx);
    const body = await response.json() as any;
    const restored = db.entries.find((entry: any) => entry.id === body.id);
    const episode = db.episodes.find((candidate: any) => candidate.id === restored?.current_episode_id);
    const document = db.documents.find((candidate: any) => candidate.episode_id === episode?.id);

    expect(response.status).toBe(200);
    expect(episode).toMatchObject({ source_url: "urn:isbn:9780141036144", content_type: "research" });
    expect(document).toMatchObject({ title: "Historical explicit title", source_url: "urn:isbn:9780141036144" });
  });

  it("never exposes Alice's prior private text or derived title after she edits and publishes the entry", async () => {
    const bobSecret = "bob-private-artifacts";
    db.users.push({
      id: "bob", username: "Bob", normalized_username: "bob",
      auth_key_hash: await hmacKey(bobSecret, AUTH_PEPPER), auth_key_prefix: "slm_bob",
      status: "active", created_at: 1,
    });
    const bobCredentials = { username: "Bob", key: `slm_bob.${bobSecret}` };

    const captured = await worker.fetch(req("POST", "/capture", {
      body: { content: "# Alice confidential first draft\n\nPrivate working details" },
      userCredentials: credentials,
    }), env, ctx);
    const capturedBody = await captured.json() as any;
    expect(capturedBody.visibility).toBe("private");
    const privateEpisodeId = db.entries.find((candidate: any) => candidate.id === capturedBody.id)?.current_episode_id;
    expect(db.documents.find((document: any) => document.episode_id === privateEpisodeId)?.title)
      .toBe("Alice confidential first draft Private working details");

    const updated = await worker.fetch(req("POST", "/update", {
      body: { id: capturedBody.id, content: "# Harmless team note\n\nSafe for everyone" },
      userCredentials: credentials,
    }), env, ctx);
    expect(updated.status).toBe(200);

    vi.mocked(env.VECTORIZE.getByIds).mockImplementation(async (ids: string[]) => ids.map((id) => ({
      id,
      values: new Array(384).fill(0.1),
      metadata: {},
    })) as any);
    const published = await worker.fetch(req("POST", `/entries/${capturedBody.id}/visibility`, {
      body: { visibility: "public" },
      userCredentials: credentials,
    }), env, ctx);
    expect(published.status).toBe(200);
    expect(await published.json()).toMatchObject({ ok: true, visibility: "public" });

    const exported = await worker.fetch(req("GET", "/export?mode=team_public", {
      userCredentials: bobCredentials,
    }), env, ctx);
    const exportText = await exported.text();

    expect(exported.status).toBe(200);
    expect(exportText).toContain("Harmless team note");
    expect(exportText).not.toContain("Alice confidential first draft");
    expect(exportText).not.toContain("Private working details");
  });
});
