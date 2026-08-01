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
