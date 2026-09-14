import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEdge, deleteEdge, expandGraph, getConnections } from "../../src/graph";
import { recallEntries } from "../../src/recall";
import type { Env } from "../../src/types";
import { makeAIMock, makeKVMock, makeVectorizeMock } from "../helpers/make-env";
import { SqliteD1, type SqliteStatement } from "../helpers/sqlite-d1";

const OWNER = "graph-owner";

// D1 reports total changes including audit triggers; RETURNING contains only
// the affected edge rows. Run both against SQLite's actual schema and triggers.
class GraphD1 extends SqliteD1 {
  batchChanges: number[] = [];

  override async batch(statements: SqliteStatement[]): Promise<any[]> {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const results = [];
      for (const statement of statements) {
        const before = this.one<{ n: number }>("SELECT total_changes() AS n").n;
        const result = await statement.all();
        result.meta.changes = this.one<{ n: number }>("SELECT total_changes() AS n").n - before;
        this.batchChanges.push(result.meta.changes);
        results.push(result);
      }
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
}

describe("graph result contracts with real SQLite", () => {
  let db: GraphD1;
  let env: Env;
  let vectorQuery: ReturnType<typeof vi.fn<VectorizeIndex["query"]>>;
  let pending: Promise<unknown>[];
  let ctx: ExecutionContext;

  beforeEach(() => {
    db = new GraphD1();
    vectorQuery = vi.fn<VectorizeIndex["query"]>().mockResolvedValue({ matches: [], count: 0 });
    env = {
      DB: db as unknown as D1Database,
      VECTORIZE: makeVectorizeMock({ query: vectorQuery }),
      AI: makeAIMock(),
      OAUTH_KV: makeKVMock(),
      AUTH_TOKEN: "test-token",
    } as Env;
    pending = [];
    ctx = { waitUntil: (promise: Promise<unknown>) => { pending.push(promise); } } as ExecutionContext;
  });

  afterEach(async () => {
    await Promise.allSettled(pending);
    db.close();
  });

  function entry(id: string, options: { owner?: string; visibility?: string; tags?: string[]; status?: string } = {}) {
    db.sqlite.prepare(
      `INSERT INTO entries (id, content, tags, source, created_at, owner_user_id,
        visibility, current_episode_id, revision, epistemic_status)
       VALUES (?, ?, ?, 'test', ?, ?, ?, ?, 1, ?)`,
    ).run(id, `Memory ${id}`, JSON.stringify(options.tags ?? []), Date.now(), options.owner ?? OWNER,
      options.visibility ?? "private", `episode-${id}`, options.status ?? "canonical");
  }

  function legacyEdge(source: string, target: string) {
    db.sqlite.prepare(
      `INSERT INTO edges (id, source_id, target_id, type, weight, created_at, updated_at)
       VALUES (?, ?, ?, 'relates_to', 1, 1, 1)`,
    ).run(`${source}-${target}`, source, target);
  }

  function directMatches(count = 5) {
    const matches = Array.from({ length: count }, (_, index) => {
      const id = `direct-${index}`;
      entry(id);
      return { id: `vector-${id}`, score: 0.99 - index * 0.01,
        metadata: { parentId: id, episodeId: `episode-${id}`, owner_user_id: OWNER,
          is_private: true, created_at: Date.now(), tags: [] } };
    });
    vectorQuery.mockResolvedValue({ matches, count: matches.length });
  }

  const recall = (hops: number, topK = 5) => recallEntries({
    query: "quasar navigation", topK, hops, userId: OWNER, skipInsight: true,
  }, env, ctx);

  it.each([5, 20])("admits graph context at full topK=%i, preserving the best seed", async (topK) => {
    directMatches(topK);
    entry("neighbor");
    await createEdge("direct-0", "neighbor", "derives_from", {}, env);

    const withoutGraph = await recall(0, topK);
    expect(withoutGraph.matches.map(match => match.id)).toEqual(Array.from({ length: topK }, (_, i) => `direct-${i}`));
    const withGraph = await recall(1, topK);
    expect(withGraph.matches).toHaveLength(topK);
    expect(withGraph.matches[0].id).toBe("direct-0");
    expect(withGraph.matches).toEqual(expect.arrayContaining([expect.objectContaining({ id: "neighbor", hop: 1 })]));
  });

  it("uses requested depth within the shared budget and keeps topK=1 anchored", async () => {
    directMatches();
    entry("hop-1");
    entry("hop-2");
    await createEdge("direct-0", "hop-1", "derives_from", {}, env);
    await createEdge("hop-1", "hop-2", "follows", {}, env);

    const oneHop = await recall(1);
    expect(oneHop.matches.some(match => match.id === "hop-2")).toBe(false);
    const twoHops = await recall(2);
    expect(twoHops.matches).toHaveLength(5);
    expect(twoHops.matches.filter(match => match.hop).map(match => [match.id, match.hop])).toEqual([["hop-1", 1], ["hop-2", 2]]);
    expect((await recall(2, 1)).matches.map(match => match.id)).toEqual(["direct-0"]);
  });

  it("does not reserve empty graph slots for invisible or ineligible neighbors", async () => {
    directMatches();
    entry("hidden", { owner: "peer" });
    entry("deprecated", { tags: ["status:deprecated"] });
    entry("superseded", { status: "superseded" });
    for (const id of ["hidden", "deprecated", "superseded"]) legacyEdge("direct-0", id);

    const result = await recall(2);
    expect(result.matches.map(match => match.id)).toEqual(Array.from({ length: 5 }, (_, i) => `direct-${i}`));
  });

  it("fills sparse direct results from the graph without exceeding topK", async () => {
    directMatches(1);
    for (let index = 0; index < 6; index++) {
      entry(`graph-${index}`);
      await createEdge("direct-0", `graph-${index}`, "relates_to", { weight: 1 - index * 0.1 }, env);
    }

    const result = await recall(1);
    expect(result.matches.map(match => match.id)).toEqual(["direct-0", "graph-0", "graph-1", "graph-2", "graph-3"]);
    expect(result.matches.filter(match => match.hop === 1)).toHaveLength(4);
  });

  it("applies fanout to distinct authorized neighbors, excluding hidden and deprecated rows", async () => {
    for (const id of ["a", "b", "c", "d"]) entry(id);
    entry("hidden", { owner: "peer" });
    entry("deprecated", { tags: ["status:deprecated"] });
    legacyEdge("a", "hidden");
    legacyEdge("a", "deprecated");
    await createEdge("a", "b", "relates_to", { weight: 0.9 }, env);
    await createEdge("a", "b", "clarifies", { weight: 0.8 }, env);
    await createEdge("b", "a", "clarifies", { weight: 0.7 }, env);
    await createEdge("a", "c", "relates_to", { weight: 0.6 }, env);
    await createEdge("a", "d", "relates_to", { weight: 0.5 }, env);

    const neighbors = await expandGraph(["a"], { hops: 1, fanoutCap: 2 }, env, OWNER);
    expect(neighbors.map(neighbor => neighbor.id)).toEqual(["b", "c"]);
  });

  it("returns every relation for a pair and preserves both directed orientations", async () => {
    entry("a");
    entry("b");
    const symmetric = await createEdge("b", "a", "relates_to", { weight: 1 }, env);
    const outgoing = await createEdge("a", "b", "clarifies", { weight: 0.8 }, env);
    const incoming = await createEdge("b", "a", "clarifies", { weight: 0.7 }, env);
    await createEdge("a", "b", "relates_to", {}, env);

    expect(db.count("edges")).toBe(3);
    const fromA = await getConnections("a", undefined, env, OWNER);
    expect(fromA).toHaveLength(3);
    expect(fromA).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "b", edge_id: symmetric!.id, source_id: "a", target_id: "b", type: "relates_to", direction: "undirected" }),
      expect.objectContaining({ id: "b", edge_id: outgoing!.id, source_id: "a", target_id: "b", type: "clarifies", direction: "outbound" }),
      expect.objectContaining({ id: "b", edge_id: incoming!.id, source_id: "b", target_id: "a", type: "clarifies", direction: "inbound" }),
    ]));
    const fromB = await getConnections("b", "clarifies", env, OWNER);
    expect(fromB).toHaveLength(2);
    expect(fromB).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "a", edge_id: outgoing!.id, direction: "inbound" }),
      expect.objectContaining({ id: "a", edge_id: incoming!.id, direction: "outbound" }),
    ]));
  });

  it("filters edge type before the neighborhood cap and never exposes private endpoints", async () => {
    entry("a", { visibility: "public" });
    entry("hidden", { owner: "peer" });
    legacyEdge("a", "hidden");
    for (let index = 0; index < 9; index++) {
      const id = `neighbor-${index}`;
      entry(id, { visibility: "public" });
      await createEdge("a", id, "relates_to", { weight: 1 }, env);
    }
    await createEdge("neighbor-8", "a", "clarifies", { weight: 0.1 }, env);

    const filtered = await getConnections("a", "clarifies", env, OWNER);
    expect(filtered).toEqual([expect.objectContaining({ id: "neighbor-8", direction: "inbound" })]);
    const publicConnections = await getConnections("a", undefined, env);
    expect(publicConnections.some(connection => connection.id === "hidden")).toBe(false);
    expect(await getConnections("hidden", undefined, env, OWNER)).toEqual([]);
  });

  it("counts one canonical relation on unlink despite repeated links and ledger triggers", async () => {
    entry("a");
    entry("b");
    for (let index = 0; index < 3; index++) await createEdge("b", "a", "relates_to", {}, env);

    expect(await deleteEdge("b", "a", "relates_to", env)).toBe(1);
    expect(db.batchChanges).toEqual([2, 2]);
    expect(db.count("edges")).toBe(0);
    expect(db.one<{ n: number }>("SELECT COUNT(*) AS n FROM edge_versions WHERE is_deleted = 1").n).toBe(1);
    expect(await deleteEdge("a", "b", "relates_to", env)).toBe(0);
  });

  it("counts distinct directed relations and preserves unrelated pairs when unlinking", async () => {
    for (const id of ["a", "b", "c"]) entry(id);
    await createEdge("a", "b", "clarifies", {}, env);
    await createEdge("b", "a", "clarifies", {}, env);
    await createEdge("a", "b", "relates_to", {}, env);
    await createEdge("a", "c", "relates_to", {}, env);

    expect(await deleteEdge("a", "b", "clarifies", env)).toBe(2);
    expect(await deleteEdge("a", "b", undefined, env)).toBe(1);
    expect(db.all<{ target_id: string }>("SELECT target_id FROM edges")).toEqual([{ target_id: "c" }]);
  });
});
