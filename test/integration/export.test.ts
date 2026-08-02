import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/testing";
import { AUTH_PEPPER, hmacKey } from "../../src/auth";
import { makeTestDb, makeTestEnv } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import type { Env } from "../../src/testing";
import { D1Mock } from "../helpers/d1-mock";

const ctx = { waitUntil: (_: Promise<any>) => {} } as any;

async function seedActor(db: D1Mock, id: string) {
  const secret = `${id}-secret`;
  db.users.push({
    id, username: id, normalized_username: id,
    auth_key_hash: await hmacKey(secret, AUTH_PEPPER), auth_key_prefix: `slm_${id}`,
    status: "active", created_at: 1,
  });
  return { username: id, key: `slm_${id}.${secret}` };
}

function seedEntry(db: D1Mock, values: Record<string, unknown>) {
  db.entries.push({
    id: "entry", content: "Memory", tags: "[]", source: "api", created_at: 1,
    updated_at: 1, vector_ids: "[]", owner_user_id: "alice", created_by_user_id: "alice",
    visibility: "private", revision: 1, current_episode_id: null,
    ...values,
  });
}

describe("GET /export", () => {
  let env: Env;
  let db: D1Mock;

  beforeEach(() => {
    db = makeTestDb();
    env = makeTestEnv(db);
  });

  it("requires authentication and an explicit supported mode", async () => {
    expect((await worker.fetch(req("GET", "/export?mode=my_data", { token: null }), env, ctx)).status).toBe(401);

    const missing = await worker.fetch(req("GET", "/export"), env, ctx);
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({
      ok: false,
      error: "mode is required and must be my_data or team_public",
    });

    const invalid = await worker.fetch(req("GET", "/export?mode=all_public"), env, ctx);
    expect(invalid.status).toBe(400);
  });

  it("my_data exports only the owner entries with complete owner-authorized history", async () => {
    const alice = await seedActor(db, "alice");
    seedEntry(db, { id: "mine", current_episode_id: "mine-current" });
    seedEntry(db, { id: "other", owner_user_id: "bob", created_by_user_id: "bob", visibility: "public" });
    db.episodes.push(
      { id: "mine-old", entry_id: "mine", content: "mine old", materialized_content: "mine old", created_at: 1 },
      { id: "mine-current", entry_id: "mine", content: "mine current", materialized_content: "mine current", created_at: 2 },
      { id: "other-episode", entry_id: "other", content: "other history", materialized_content: "other history", created_at: 1 },
    );
    db.entry_snapshots.push(
      { id: "mine-snapshot", entry_id: "mine", content: "mine snapshot", created_at: 1 },
      { id: "other-snapshot", entry_id: "other", content: "other snapshot", created_at: 1 },
    );
    db.passages.push(
      { id: "mine-passage", entry_id: "mine", episode_id: "mine-old", document_id: "mine-doc", content: "mine passage", created_at: 1, vector_ids: "[]" },
      { id: "mine-legacy-passage", entry_id: "mine", episode_id: null, document_id: "mine-legacy-doc", content: "mine legacy passage", created_at: 2, vector_ids: "[]" },
      { id: "mine-ownerless-passage", entry_id: "mine", episode_id: null, document_id: "mine-ownerless-passage-doc", content: "mine ownerless passage", created_at: 2, vector_ids: "[]" },
      { id: "mine-cross-owner-passage", entry_id: "mine", episode_id: "mine-current", document_id: "other-doc", content: "owned passage with foreign document reference", created_at: 3, vector_ids: "[]" },
      { id: "other-passage", entry_id: "other", episode_id: "other-episode", document_id: "other-doc", content: "other passage", created_at: 1, vector_ids: "[]" },
    );
    db.documents.push(
      { id: "mine-doc", episode_id: "mine-old", owner_user_id: "alice", title: "Mine", created_at: 1 },
      { id: "mine-ownerless-episode-doc", episode_id: "mine-current", owner_user_id: "", title: "Mine ownerless current", created_at: 2 },
      { id: "mine-legacy-doc", episode_id: null, owner_user_id: "alice", title: "Mine legacy", created_at: 2 },
      { id: "mine-ownerless-passage-doc", episode_id: null, owner_user_id: "", title: "Mine ownerless passage", created_at: 2 },
      { id: "other-doc", episode_id: "other-episode", owner_user_id: "bob", title: "Other", created_at: 1 },
    );
    db.document_sections.push(
      { id: "mine-section", document_id: "mine-doc", title: "Mine", order_index: 0 },
      { id: "mine-ownerless-episode-section", document_id: "mine-ownerless-episode-doc", title: "Mine ownerless current", order_index: 0 },
      { id: "mine-legacy-section", document_id: "mine-legacy-doc", title: "Mine legacy", order_index: 0 },
      { id: "mine-ownerless-passage-section", document_id: "mine-ownerless-passage-doc", title: "Mine ownerless passage", order_index: 0 },
      { id: "other-section", document_id: "other-doc", title: "Other", order_index: 0 },
    );

    const res = await worker.fetch(req("GET", "/export?mode=my_data", { userCredentials: alice }), env, ctx);
    const data = await res.json() as any;

    expect(res.status).toBe(200);
    expect(data.mode).toBe("my_data");
    expect(data.entries.map((entry: any) => entry.id)).toEqual(["mine"]);
    expect(data.episodes.map((episode: any) => episode.id).sort()).toEqual(["mine-current", "mine-old"]);
    expect(data.snapshots.map((snapshot: any) => snapshot.id)).toEqual(["mine-snapshot"]);
    expect(data.passages.map((passage: any) => passage.id).sort()).toEqual(["mine-cross-owner-passage", "mine-legacy-passage", "mine-ownerless-passage", "mine-passage"]);
    expect(data.documents.map((document: any) => document.id).sort()).toEqual([
      "mine-doc",
      "mine-legacy-doc",
      "mine-ownerless-episode-doc",
      "mine-ownerless-passage-doc",
    ]);
    expect(data.document_sections.map((section: any) => section.id).sort()).toEqual([
      "mine-legacy-section",
      "mine-ownerless-episode-section",
      "mine-ownerless-passage-section",
      "mine-section",
    ]);
    expect(JSON.stringify(data)).not.toContain("other history");
    expect(data.entries[0]).not.toHaveProperty("vector_ids");
  });

  it("loads 101 owner histories across a real second batch without querying per artifact", async () => {
    const alice = await seedActor(db, "alice");
    for (let index = 0; index < 101; index++) {
      const entryId = `mine-${index}`;
      const episodeId = `episode-${index}`;
      const documentId = `document-${index}`;
      seedEntry(db, { id: entryId, current_episode_id: episodeId });
      db.episodes.push({ id: episodeId, entry_id: entryId, content: `history ${index}`, materialized_content: `history ${index}`, created_at: index + 1 });
      db.entry_snapshots.push({ id: `snapshot-${index}`, entry_id: entryId, content: `snapshot ${index}`, created_at: index + 1 });
      db.passages.push({ id: `passage-${index}`, entry_id: entryId, episode_id: episodeId, document_id: documentId, content: `passage ${index}`, created_at: index + 1, vector_ids: "[]" });
      db.documents.push({ id: documentId, episode_id: episodeId, owner_user_id: "alice", title: `Document ${index}`, created_at: index + 1 });
      db.document_sections.push({ id: `section-${index}`, document_id: documentId, title: `Section ${index}`, order_index: 0 });
    }
    // Prime one-time database initialization so the count measures only the
    // export read plan, not schema compatibility probes.
    await worker.fetch(req("GET", "/export?mode=my_data", { userCredentials: alice }), env, ctx);
    const preparedSql: string[] = [];
    const originalPrepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
      preparedSql.push(sql.replace(/\s+/g, " ").trim());
      return originalPrepare(sql);
    }) as D1Mock["prepare"]);

    const res = await worker.fetch(req("GET", "/export?mode=my_data", { userCredentials: alice }), env, ctx);
    const data = await res.json() as any;
    const artifactQueries = preparedSql.filter((sql) =>
      /FROM (episodes|entry_snapshots|passages|documents|document_sections)\b/.test(sql));

    expect(res.status).toBe(200);
    expect(data.entries).toHaveLength(101);
    expect(data.episodes).toContainEqual(expect.objectContaining({ id: "episode-100", content: "history 100" }));
    expect(data.snapshots).toContainEqual(expect.objectContaining({ id: "snapshot-100", content: "snapshot 100" }));
    expect(data.passages).toContainEqual(expect.objectContaining({ id: "passage-100", content: "passage 100" }));
    expect(data.documents).toContainEqual(expect.objectContaining({ id: "document-100", title: "Document 100" }));
    expect(data.document_sections).toContainEqual(expect.objectContaining({ id: "section-100", title: "Section 100" }));
    expect(artifactQueries.length).toBeLessThanOrEqual(10);
    expect(artifactQueries.every((sql) => (sql.match(/\?/g) ?? []).length <= 100)).toBe(true);
    expect(artifactQueries.every((sql) => !/WHERE (entry_id|episode_id|document_id) = \?/.test(sql))).toBe(true);
  });

  it("team_public exports current public projections and scalar source metadata without history", async () => {
    const bob = await seedActor(db, "bob");
    seedEntry(db, { id: "public", content: "Current public", visibility: "public", current_episode_id: "public-current" });
    seedEntry(db, { id: "private", content: "Current private", visibility: "private", current_episode_id: "private-current" });
    db.episodes.push(
      { id: "public-current", entry_id: "public", content: "Current public", materialized_content: "Current public", source_url: "https://example.test/source", content_type: "research", created_at: 2 },
      { id: "public-old", entry_id: "public", content: "historical secret", materialized_content: "historical secret", created_at: 1 },
      { id: "private-current", entry_id: "private", content: "Current private", materialized_content: "Current private", created_at: 2 },
    );
    db.documents.push({ id: "public-doc", episode_id: "public-current", owner_user_id: "alice", title: "Safe source title", source_url: "https://example.test/source", created_at: 2 });

    const res = await worker.fetch(req("GET", "/export?mode=team_public", { userCredentials: bob }), env, ctx);
    const data = await res.json() as any;

    expect(res.status).toBe(200);
    expect(data.mode).toBe("team_public");
    expect(data.entries).toEqual([
      expect.objectContaining({
        id: "public",
        content: "Current public",
        source_url: "https://example.test/source",
        source_title: "Safe source title",
      }),
    ]);
    expect(data).not.toHaveProperty("episodes");
    expect(data).not.toHaveProperty("snapshots");
    expect(data).not.toHaveProperty("passages");
    expect(data).not.toHaveProperty("documents");
    expect(data).not.toHaveProperty("document_sections");
    expect(data).not.toHaveProperty("edges");
    expect(JSON.stringify(data)).not.toContain("historical secret");
    expect(JSON.stringify(data)).not.toContain("Current private");
  });

  it("sanitizes unsafe legacy and integration source metadata only at the public export boundary", async () => {
    const bob = await seedActor(db, "bob");
    const githubSecret = `ghp_${"a".repeat(36)}`;
    const openAiSecret = `sk-proj-${"b".repeat(32)}`;
    const oversizedTitle = `${"t".repeat(512)}OVERSIZED_TITLE_TAIL`;
    const oversizedUrl = `https://example.test/${"u".repeat(2048)}OVERSIZED_URL_TAIL`;
    const oversizedSource = `${"s".repeat(512)}OVERSIZED_SOURCE_TAIL`;
    const credentialUrl = "https://alice:private-password@example.test/source";
    const fixtures = [
      { id: "safe", source: "api", title: "Safe exact title", url: "https://example.test/safe" },
      { id: "legacy-source-secret", source: githubSecret, title: "Source secret", url: "https://example.test/source-secret" },
      { id: "legacy-source-control", source: "legacy\nFORGED_SOURCE_FIELD", title: "Source control", url: "https://example.test/source-control" },
      { id: "legacy-source-oversized", source: oversizedSource, title: "Source oversized", url: "https://example.test/source-oversized" },
      { id: "legacy-title-secret", source: "legacy-import", title: githubSecret, url: "https://example.test/legacy" },
      { id: "legacy-title-control", source: "legacy-import", title: "Safe title\tFORGED_TITLE_FIELD", url: "https://example.test/title-control" },
      { id: "integration-url-secret", source: "github", title: "Integration title", url: `https://example.test/${openAiSecret}` },
      { id: "integration-url-control", source: "github", title: "URL control", url: "https://example.test/safe\rFORGED_URL_FIELD" },
      { id: "legacy-title-oversized", source: "legacy-import", title: oversizedTitle, url: "https://example.test/title" },
      { id: "integration-url-oversized", source: "github", title: "Oversized URL", url: oversizedUrl },
      { id: "integration-url-userinfo", source: "github", title: "Credential URL", url: credentialUrl },
      { id: "legacy-url-invalid", source: "legacy-import", title: "Invalid URL", url: "not a valid URL" },
    ];
    for (const fixture of fixtures) {
      const episodeId = `${fixture.id}-episode`;
      seedEntry(db, {
        id: fixture.id,
        source: fixture.source,
        content: `Public ${fixture.id}`,
        visibility: "public",
        current_episode_id: episodeId,
      });
      db.episodes.push({
        id: episodeId,
        entry_id: fixture.id,
        content: `Public ${fixture.id}`,
        materialized_content: `Public ${fixture.id}`,
        source_url: fixture.url,
        created_at: 2,
      });
      db.documents.push({
        id: `${fixture.id}-document`,
        episode_id: episodeId,
        owner_user_id: "alice",
        title: fixture.title,
        source_url: fixture.url,
        created_at: 2,
      });
    }

    const res = await worker.fetch(req("GET", "/export?mode=team_public", { userCredentials: bob }), env, ctx);
    const data = await res.json() as any;
    const byId = new Map(data.entries.map((entry: any) => [entry.id, entry]));
    const serialized = JSON.stringify(data);

    expect(res.status).toBe(200);
    expect(byId.get("safe")).toMatchObject({
      source: "api",
      source_title: "Safe exact title",
      source_url: "https://example.test/safe",
    });
    expect(byId.get("legacy-source-secret")).toMatchObject({ source: null });
    expect(byId.get("legacy-source-control")).toMatchObject({ source: null });
    expect(byId.get("legacy-source-oversized")).toMatchObject({ source: null });
    expect(byId.get("legacy-title-secret")).toMatchObject({ source_title: null });
    expect(byId.get("legacy-title-control")).toMatchObject({ source_title: null });
    expect(byId.get("integration-url-secret")).toMatchObject({ source_url: null });
    expect(byId.get("integration-url-control")).toMatchObject({ source_url: null });
    expect(byId.get("legacy-title-oversized")).toMatchObject({ source_title: null });
    expect(byId.get("integration-url-oversized")).toMatchObject({ source_url: null });
    expect(byId.get("integration-url-userinfo")).toMatchObject({ source_url: null });
    expect(byId.get("legacy-url-invalid")).toMatchObject({ source_url: null });
    expect(serialized).not.toContain(githubSecret);
    expect(serialized).not.toContain(openAiSecret);
    expect(serialized).not.toContain("OVERSIZED_TITLE_TAIL");
    expect(serialized).not.toContain("OVERSIZED_URL_TAIL");
    expect(serialized).not.toContain("OVERSIZED_SOURCE_TAIL");
    expect(serialized).not.toContain("alice:private-password");
    expect(serialized).not.toContain("FORGED_");
    expect(db.documents.find((document: any) => document.id === "integration-url-userinfo-document")?.source_url)
      .toBe(credentialUrl);
  });
});
