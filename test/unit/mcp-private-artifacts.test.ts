import { beforeEach, describe, expect, it } from "vitest";

import { buildMcpServer } from "../../src/mcp";
import { makeTestDb, makeTestEnv } from "../helpers/make-env";
import { D1Mock } from "../helpers/d1-mock";
import type { HumanActorContext } from "../../src/types";

const ctx = {
  waitUntil: (_: Promise<any>) => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

const humanActor = (userId: string): HumanActorContext => ({
  kind: "human" as const,
  actorId: userId,
  userId,
  role: "member" as const,
  authMethod: "test",
  scopes: new Set(),
});

function callTool(server: ReturnType<typeof buildMcpServer>, name: string, input: Record<string, unknown>) {
  return (server as any)._registeredTools[name].handler(input, {});
}

describe("MCP private child artifacts", () => {
  let db: D1Mock;

  beforeEach(() => {
    db = makeTestDb();
  });

  it("does not expose passages for another actor's private parent", async () => {
    db.entries.push({
      id: "hidden", content: "private parent", tags: JSON.stringify(["private"]),
      source: "api", created_at: 1, vector_ids: "[]", owner_user_id: "bob",
    });
    db.passages.push({
      id: "hidden-passage", entry_id: "hidden", content: "passage secret",
      section: "Secret", start_offset: 0, end_offset: 14, created_at: 1,
    });
    const server = buildMcpServer(makeTestEnv(db), ctx, humanActor("alice"));

    const hidden = await callTool(server, "passages", { entry_id: "hidden" });
    db.entries = db.entries.filter((entry: any) => entry.id !== "hidden");
    const missing = await callTool(server, "passages", { entry_id: "hidden" });

    expect(hidden).toEqual(missing);
    expect(JSON.stringify(hidden)).not.toContain("passage secret");
  });

  it("bounds legacy citation metadata and suppresses detected secrets without truncating valid citations", async () => {
    const secret = `sk_live_${"s".repeat(24)}`;
    const longTitle = `${"T".repeat(512)}TITLE_TAIL`;
    const longUrl = `https://example.test/${"u".repeat(2_048)}URL_TAIL`;
    db.entries.push({
      id: "citations", content: "public parent", tags: "[]", visibility: "public",
      source: "api", created_at: 1, vector_ids: "[]", owner_user_id: "alice",
      current_episode_id: "current-episode",
    });
    db.documents.push(
      { id: "safe-doc", episode_id: "current-episode", owner_user_id: "alice", title: "Complete safe title", source_url: "https://example.test/complete-source" },
      { id: "secret-doc", episode_id: "current-episode", owner_user_id: "alice", title: `Secret ${secret}`, source_url: `https://example.test/${secret}` },
      { id: "long-doc", episode_id: "current-episode", owner_user_id: "alice", title: longTitle, source_url: longUrl },
    );
    db.passages.push(
      { id: "safe-passage", entry_id: "citations", episode_id: "current-episode", document_id: "safe-doc", content: "Safe evidence", start_offset: 0, end_offset: 13, created_at: 1 },
      { id: "secret-passage", entry_id: "citations", episode_id: "current-episode", document_id: "secret-doc", content: "Evidence with unsafe metadata", start_offset: 14, end_offset: 43, created_at: 2 },
      { id: "long-passage", entry_id: "citations", episode_id: "current-episode", document_id: "long-doc", content: "Evidence with legacy metadata", start_offset: 44, end_offset: 73, created_at: 3 },
    );
    const server = buildMcpServer(makeTestEnv(db), ctx, humanActor("alice"));

    const result = await callTool(server, "passages", { entry_id: "citations" });
    const text = result.content[0].text;

    expect(text).toContain("Complete safe title");
    expect(text).toContain("https://example.test/complete-source");
    expect(text).not.toContain(secret);
    expect(text).not.toContain("TITLE_TAIL");
    expect(text).not.toContain("URL_TAIL");
  });

  it("uses owner URI fidelity only for the owner and rejects citation line injection", async () => {
    const fixtures = [
      { key: "doi", title: "DOI", url: "doi:10.1000/owner", section: "Section" },
      { key: "urn", title: "URN", url: "urn:isbn:9780141036144", section: "Section" },
      { key: "custom", title: "Custom", url: "zotero://select/library/items/SAFE123", section: "Section" },
      { key: "web", title: "Web", url: "https://example.test/public", section: "Section" },
      { key: "unsafe", title: "Title\nFORGED_TITLE", url: "javascript:alert(1)", section: "Section\rFORGED_SECTION" },
    ];
    for (const [index, fixture] of fixtures.entries()) {
      const entryId = `citation-${fixture.key}`;
      const episodeId = `episode-${fixture.key}`;
      const documentId = `document-${fixture.key}`;
      db.entries.push({
        id: entryId, content: `${fixture.key} parent`, tags: "[]", visibility: "public",
        source: "api", created_at: index + 1, vector_ids: "[]", owner_user_id: "alice",
        current_episode_id: episodeId,
      });
      db.documents.push({
        id: documentId, episode_id: episodeId, owner_user_id: "alice",
        title: fixture.title, source_url: fixture.url,
      });
      db.passages.push({
        id: `passage-${fixture.key}`, entry_id: entryId, episode_id: episodeId,
        document_id: documentId, content: `${fixture.key} evidence`, section: fixture.section,
        start_offset: 0, end_offset: 1,
      });
    }

    const ownerServer = buildMcpServer(makeTestEnv(db), ctx, humanActor("alice"));
    const publicServer = buildMcpServer(makeTestEnv(db), ctx, humanActor("bob"));
    const ownerText = (await Promise.all(fixtures.map(async (fixture) =>
      (await callTool(ownerServer, "passages", { entry_id: `citation-${fixture.key}` })).content[0].text,
    ))).join("\n");
    const publicText = (await Promise.all(fixtures.map(async (fixture) =>
      (await callTool(publicServer, "passages", { entry_id: `citation-${fixture.key}` })).content[0].text,
    ))).join("\n");

    expect(ownerText).toContain("doi:10.1000/owner");
    expect(ownerText).toContain("urn:isbn:9780141036144");
    expect(ownerText).toContain("zotero://select/library/items/SAFE123");
    expect(ownerText).not.toContain("javascript:");
    expect(ownerText).not.toContain("FORGED_");
    expect(publicText).not.toContain("doi:10.1000/owner");
    expect(publicText).not.toContain("urn:isbn:9780141036144");
    expect(publicText).not.toContain("zotero://select/library/items/SAFE123");
    expect(publicText).toContain("https://example.test/public");
  });

  it("serializes direct passage metadata without delimiter ambiguity", async () => {
    const title = 'Trusted"; url=https://attacker.invalid; title="Forged';
    const section = 'Decision"; page=999; section="Forged';
    const url = "https://example.test/source;page=999";
    db.entries.push({
      id: "delimiter-citation", content: "parent", tags: "[]", visibility: "private",
      source: "api", created_at: 1, vector_ids: "[]", owner_user_id: "alice",
      current_episode_id: "delimiter-episode",
    });
    db.documents.push({
      id: "delimiter-document", episode_id: "delimiter-episode", owner_user_id: "alice",
      title, source_url: url,
    });
    db.passages.push({
      id: "delimiter-passage", entry_id: "delimiter-citation", episode_id: "delimiter-episode",
      document_id: "delimiter-document", content: "Primary evidence", section,
      page: 7, start_offset: 0, end_offset: 16,
    });

    const result = await callTool(buildMcpServer(makeTestEnv(db), ctx, humanActor("alice")), "passages", {
      entry_id: "delimiter-citation",
    });
    const metadataLine = result.content[0].text.split("\n").find((line: string) => line.startsWith("1. "));

    expect(metadataLine).toBeDefined();
    expect(JSON.parse(metadataLine!.slice(3))).toEqual({
      title,
      section,
      page: 7,
      startOffset: 0,
      endOffset: 16,
      url,
    });
  });

  it("restores historical title, URL, and type from the owned snapshot envelope", async () => {
    db.entries.push({
      id: "restore-source", content: "Current value", tags: "[]", visibility: "private",
      source: "api", created_at: 1, vector_ids: "[]", owner_user_id: "alice",
      current_episode_id: "current-episode", revision: 2,
    });
    db.episodes.push({
      id: "historical-episode", entry_id: "restore-source", owner_user_id: "alice",
      content: "Historical research", materialized_content: "Historical research",
      source_url: "doi:10.1000/historical", content_type: "research", created_at: 1,
    });
    db.documents.push({
      id: "historical-document", episode_id: "historical-episode", owner_user_id: "alice",
      title: "Historical generated title", title_origin: "generated",
      source_url: "doi:10.1000/historical", created_at: 1,
    });
    db.entry_snapshots.push({
      id: "historical-snapshot", entry_id: "restore-source", episode_id: "historical-episode",
      content: "Historical research", tags: "[]", source: "api", created_at: 2,
      valid_from: null, valid_to: null,
    });

    const result = await callTool(buildMcpServer(makeTestEnv(db), ctx, humanActor("alice")), "restore", {
      entry_id: "restore-source",
      snapshot_id: "historical-snapshot",
    });
    const match = result.content[0].text.match(/New entry ID: ([0-9a-f-]+)/i);
    expect(match).not.toBeNull();
    const restored = db.entries.find((entry: any) => entry.id === match?.[1]);
    const episode = db.episodes.find((candidate: any) => candidate.id === restored?.current_episode_id);
    const document = db.documents.find((candidate: any) => candidate.episode_id === episode?.id);

    expect(episode).toMatchObject({ source_url: "doi:10.1000/historical", content_type: "research" });
    expect(document).toMatchObject({
      title: "Historical generated title",
      title_origin: "generated",
      source_url: "doi:10.1000/historical",
    });
  });

  it("derives a generated restore title when a legacy envelope title is empty", async () => {
    const sourceUrl = "https://example.test/blank-title";
    db.entries.push({
      id: "blank-title-source", content: "Current value", tags: "[]", visibility: "private",
      source: "api", created_at: 1, vector_ids: "[]", owner_user_id: "alice",
      current_episode_id: "blank-current-episode", revision: 2,
    });
    db.episodes.push({
      id: "blank-historical-episode", entry_id: "blank-title-source", owner_user_id: "alice",
      content: "Historical body", materialized_content: "Historical body",
      source_url: sourceUrl, content_type: "research", created_at: 1,
    });
    db.documents.push({
      id: "blank-historical-document", episode_id: "blank-historical-episode",
      owner_user_id: "alice", title: "", title_origin: "generated",
      source_url: sourceUrl, created_at: 1,
    });
    db.entry_snapshots.push({
      id: "blank-historical-snapshot", entry_id: "blank-title-source",
      episode_id: "blank-historical-episode", content: "Historical body",
      tags: "[]", source: "api", created_at: 2, valid_from: null, valid_to: null,
    });

    const result = await callTool(
      buildMcpServer(makeTestEnv(db), ctx, humanActor("alice")),
      "restore",
      { entry_id: "blank-title-source", snapshot_id: "blank-historical-snapshot" },
    );
    const match = result.content[0].text.match(/New entry ID: ([0-9a-f-]+)/i);
    expect(match).not.toBeNull();
    const restored = db.entries.find((entry: any) => entry.id === match?.[1]);
    const document = db.documents.find((candidate: any) =>
      candidate.episode_id === restored?.current_episode_id);

    expect(document).toMatchObject({
      title: sourceUrl,
      title_origin: "generated",
      source_url: sourceUrl,
    });
  });

  it("bounds human MCP history with exact omission counts and recovery guidance", async () => {
    const secret = `ghp_${"x".repeat(36)}`;
    db.entries.push({
      id: "long-history", content: "Current", tags: "[]", visibility: "private",
      source: "api", created_at: 1, vector_ids: "[]", owner_user_id: "alice",
      current_episode_id: "episode-49", revision: 50, recorded_at: 50,
    });
    for (let index = 0; index < 50; index++) {
      db.episodes.push({
        id: `episode-${index}`, entry_id: "long-history", owner_user_id: "alice",
        mutation_kind: "update", parent_episode_id: index ? `episode-${index - 1}` : null,
        restored_from_snapshot_id: null, content_hash: "h".repeat(256),
        source: index === 49 ? `integration\nFORGED_HISTORY_SOURCE ${secret}` : `integration-${"s".repeat(300)}-${index}`,
        source_url: `https://example.test/${"u".repeat(500)}/${index}`,
        created_at: index,
      });
      db.entry_snapshots.push({
        id: `snapshot-${index}-${"z".repeat(80)}`, entry_id: "long-history", episode_id: `episode-${index}`,
        mutation_kind: "update", recorded_at: index, revision: index, created_at: index,
      });
    }

    const result = await callTool(buildMcpServer(makeTestEnv(db), ctx, humanActor("alice")), "history", {
      entry_id: "long-history",
    });
    const text = result.content[0].text;
    const history = JSON.parse(text);

    expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(4 * 1024);
    expect(history.truncated).toBe(true);
    expect(history.counts.episodes).toMatchObject({ total: 50 });
    expect(history.counts.snapshots).toMatchObject({ total: 50 });
    expect(history.counts.episodes.returned + history.counts.episodes.omitted).toBe(50);
    expect(history.counts.snapshots.returned + history.counts.snapshots.omitted).toBe(50);
    expect(history.guidance).toMatch(/stable snapshot IDs/i);
    expect(history.guidance).toMatch(/my_data/i);
    expect(history.episodes).toContainEqual(expect.objectContaining({ id: "episode-49" }));
    expect(text).toContain("snapshot-49-");
    expect(Object.keys(history.projection).sort()).toEqual([
      "current_episode_id",
      "recorded_at",
      "revision",
    ]);
    expect(text).not.toContain(secret);
    expect(text).not.toContain("FORGED_HISTORY_SOURCE");
  });

  it("compacts an oversized multibyte singleton without dropping the newest stable IDs", async () => {
    db.entries.push({
      id: "multibyte-history", content: "Current", tags: "[]", visibility: "private",
      source: "api", created_at: 1, vector_ids: "[]", owner_user_id: "alice",
      current_episode_id: "episode-newest", revision: 2, recorded_at: 2,
    });
    db.episodes.push({
      id: "episode-newest", entry_id: "multibyte-history", owner_user_id: "alice",
      mutation_kind: "update", parent_episode_id: "episode-old", restored_from_snapshot_id: null,
      content_hash: "🌿".repeat(2_000), source: "🌿".repeat(512), content_type: "research",
      source_url: `https://example.test/${"u".repeat(1_900)}`, created_at: 2,
    });
    db.documents.push({
      id: "document-newest", episode_id: "episode-newest", owner_user_id: "alice",
      title: "🌿".repeat(512), source_url: `https://example.test/${"u".repeat(1_900)}`,
    });
    db.entry_snapshots.push({
      id: "snapshot-newest", entry_id: "multibyte-history", episode_id: "episode-old",
      mutation_kind: "update", recorded_at: 1, revision: 1, created_at: 1,
    });

    const result = await callTool(buildMcpServer(makeTestEnv(db), ctx, humanActor("alice")), "history", {
      entry_id: "multibyte-history",
    });
    const text = result.content[0].text;
    const history = JSON.parse(text);

    expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(4 * 1024);
    expect(history.truncated).toBe(true);
    expect(history.counts.episodes).toEqual({ total: 1, returned: 1, omitted: 0 });
    expect(history.counts.snapshots).toEqual({ total: 1, returned: 1, omitted: 0 });
    expect(history.episodes).toContainEqual(expect.objectContaining({ id: "episode-newest" }));
    expect(history.snapshots).toContainEqual(expect.objectContaining({ id: "snapshot-newest" }));
    expect(history.guidance).toMatch(/stable snapshot IDs/i);
  });

  it("sanitizes visible legacy source labels in human list_recent output", async () => {
    const secret = `sk_live_${"q".repeat(24)}`;
    db.entries.push(
      {
        id: "alice-public-legacy", content: "Public legacy content", tags: "[]",
        visibility: "public", source: `integration\nFORGED_RECENT_SOURCE ${secret}`,
        created_at: 2, vector_ids: "[]", owner_user_id: "alice",
      },
      {
        id: "bob-owned", content: "Owned content", tags: '["private"]',
        visibility: "private", source: "owner-source-exact",
        created_at: 1, vector_ids: "[]", owner_user_id: "bob",
      },
    );

    const result = await callTool(buildMcpServer(makeTestEnv(db), ctx, humanActor("bob")), "list_recent", {
      n: 10,
    });
    const text = result.content[0].text;

    expect(text).toContain("Public legacy content");
    expect(text).toContain("owner-source-exact");
    expect(text).not.toContain(secret);
    expect(text).not.toContain("FORGED_RECENT_SOURCE");
  });

  it("does not expose snapshots from a public entry owned by another actor", async () => {
    db.entries.push({
      id: "history", content: "public current value", tags: "[]",
      source: "api", created_at: 1, vector_ids: "[]", owner_user_id: "bob",
    });
    db.entry_snapshots.push({
      id: "secret-snapshot", entry_id: "history", content: "historical secret",
      tags: "[]", source: "api", created_at: 1,
    });
    const server = buildMcpServer(makeTestEnv(db), ctx, humanActor("alice"));

    const result = await callTool(server, "restore", {
      entry_id: "history",
      snapshot_id: "secret-snapshot",
    });

    expect(result.content[0].text).toBe("No snapshot found for entry history.");
    expect(JSON.stringify(result)).not.toContain("historical secret");
  });

  it("requires visible endpoints and rejects public-private links", async () => {
    db.entries.push(
      { id: "public", content: "public", tags: "[]", source: "api", created_at: 1, vector_ids: "[]", owner_user_id: "alice" },
      { id: "private", content: "private", tags: JSON.stringify(["private"]), source: "api", created_at: 1, vector_ids: "[]", owner_user_id: "alice" },
      { id: "hidden", content: "hidden", tags: JSON.stringify(["private"]), source: "api", created_at: 1, vector_ids: "[]", owner_user_id: "bob" },
    );
    const server = buildMcpServer(makeTestEnv(db), ctx, humanActor("alice"));

    const boundary = await callTool(server, "link", { source_id: "public", target_id: "private", type: "relates_to" });
    const hidden = await callTool(server, "link", { source_id: "public", target_id: "hidden", type: "relates_to" });
    db.entries = db.entries.filter((entry: any) => entry.id !== "hidden");
    const missing = await callTool(server, "link", { source_id: "public", target_id: "hidden", type: "relates_to" });

    expect(boundary.content[0].text).toContain("private and public visibility");
    expect(hidden).toEqual(missing);
    expect(db.edges).toHaveLength(0);
  });
});
