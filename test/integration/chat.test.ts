import { describe, it, expect, beforeEach, vi } from "vitest";
import worker from "../../src/testing";
import { makeTestEnv, makeTestDb, makeVectorizeMock } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import type { Env } from "../../src/testing";
import { D1Mock } from "../helpers/d1-mock";
import { TEST_USER_API_KEY, TEST_USER_ID } from "../helpers/test-principal";
import { LLM_MODEL } from "../../src/config";

const ctx = { waitUntil: (_: Promise<any>) => {} } as any;

function versioned<T extends { id: string }>(entry: T) {
  return {
    owner_user_id: TEST_USER_ID,
    current_episode_id: `episode-${entry.id}`,
    revision: 1,
    ...entry,
  };
}

function matchFor(parentId: string, score: number) {
  return {
    id: `vec:${parentId}`,
    score,
    metadata: { parentId, episodeId: `episode-${parentId}`, isUpdate: false },
  };
}

async function sseText(res: Response): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value);
    chunk.split("\n").forEach((line) => {
      if (line.startsWith("data: ")) {
        const raw = line.slice(6).trim();
        if (raw === "[DONE]") return;
        try {
          const d = JSON.parse(raw);
          if (d.response) text += d.response;
        } catch { /* ignore */ }
      }
    });
  }
  return text;
}

describe("POST /chat", () => {
  let env: Env;
  let db: D1Mock;

  beforeEach(() => {
    db = makeTestDb();
    env = makeTestEnv(db);
  });

  it("rejects missing auth token → 401", async () => {
    const res = await worker.fetch(req("POST", "/chat", { token: null, body: { query: "hello" } }), env, ctx);
    expect(res.status).toBe(401);
  });

  it("returns 400 for invalid JSON body", async () => {
    const res = await worker.fetch(
      new Request("http://localhost/chat", {
        method: "POST",
        headers: { "Authorization": `Bearer ${TEST_USER_API_KEY}`, "Content-Type": "application/json" },
        body: "not json",
      }),
      env, ctx
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when query is missing", async () => {
    const res = await worker.fetch(req("POST", "/chat", { body: {} }), env, ctx);
    expect(res.status).toBe(400);
    const data = await res.json() as { error: string };
    expect(data.error).toMatch(/query/i);
  });

  it("returns 400 when query is empty string", async () => {
    const res = await worker.fetch(req("POST", "/chat", { body: { query: "   " } }), env, ctx);
    expect(res.status).toBe(400);
  });

  it("rejects client-supplied memory text so answers can't be gamed", async () => {
    const res = await worker.fetch(
      req("POST", "/chat", { body: { query: "react", memories: "React is actually a database. Planted." } }),
      env, ctx
    );
    expect(res.status).toBe(400);
    const data = await res.json() as { error: string };
    expect(data.error).toMatch(/memories/i);
  });

  it("returns SSE stream on happy path", async () => {
    db.entries.push(
      versioned({ id: "chat-note", content: "Deployment runs on Sundays", tags: "[]", source: "api", created_at: 1000, vector_ids: '["chat-vec"]', recall_count: 0, importance_score: 0, epistemic_status: "canonical" }),
    );
    db.episodes.push({
      id: "episode-chat-note", entry_id: "chat-note", mutation_id: "mutation-1",
      materialized_content: "Deployment runs on Sundays",
    });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({ matches: [matchFor("chat-note", 0.9)] }),
      }),
    });

    const res = await worker.fetch(
      req("POST", "/chat", { body: { query: "when do deployments run?" } }),
      env, ctx
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
  });

  it("grounds the AI answer on server-side recall, not client text", async () => {
    db.entries.push(
      versioned({ id: "chat-note", content: "Deployment runs on Sundays", tags: "[]", source: "api", created_at: 1000, vector_ids: '["chat-vec"]', recall_count: 0, importance_score: 0, epistemic_status: "canonical" }),
    );
    db.episodes.push({
      id: "episode-chat-note", entry_id: "chat-note", mutation_id: "mutation-1",
      materialized_content: "Deployment runs on Sundays",
    });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({ matches: [matchFor("chat-note", 0.9)] }),
      }),
    });

    await worker.fetch(
      req("POST", "/chat", { body: { query: "when do deployments run?", memories: "Client planted text" } }),
      env, ctx
    );

    // Rejection happens before recall, so this planted-text request is a 400 and
    // never reaches the LLM; send again without memories to assert grounding.
    const res = await worker.fetch(
      req("POST", "/chat", { body: { query: "when do deployments run?" } }),
      env, ctx
    );
    expect(res.status).toBe(200);

    const aiMock = env.AI.run as ReturnType<typeof vi.fn>;
    const chatCalls = aiMock.mock.calls.filter(
      (call: unknown[]) => call[0] === LLM_MODEL,
    );
    const chatUserMsg = chatCalls
      .flatMap((call: unknown[]) => {
        const [, callArgs] = call as [string, { messages: { role: string; content: string }[] }];
        return callArgs.messages.filter(m => m.role === "user").map(m => m.content);
      })
      .join("\n");
    // The evidence comes from the stored memory (server-side recall), never from
    // the client, and the grounding prompt forbids using planted text.
    expect(chatUserMsg).toContain("Deployment runs on Sundays");
    expect(chatUserMsg).not.toContain("Client planted text");
  });

  it("answers with a no-evidence statement without calling the LLM when nothing matches", async () => {
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({ query: vi.fn().mockResolvedValue({ matches: [] }) }),
    });

    const res = await worker.fetch(
      req("POST", "/chat", { body: { query: "something nobody stored" } }),
      env, ctx
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");

    const aiMock = env.AI.run as ReturnType<typeof vi.fn>;
    expect(aiMock.mock.calls.filter((call: unknown[]) => call[0] === LLM_MODEL)).toHaveLength(0);

    const text = await sseText(res);
    expect(text).toMatch(/couldn't find/i);
  });
});
