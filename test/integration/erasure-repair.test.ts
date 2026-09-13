import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { finalizeErasureReceipt, flagPendingErasures } from "../../src/erasure";
import { drainVectorCleanupQueue } from "../../src/vector-cleanup";
import type { Env } from "../../src/types";
import { SqliteD1 } from "../helpers/sqlite-d1";

describe("durable erasure receipt repair", () => {
  let db: SqliteD1;
  let env: Env;
  let vectors: Set<string>;

  beforeEach(() => {
    db = new SqliteD1();
    vectors = new Set();
    env = {
      DB: db as unknown as D1Database,
      VECTORIZE: { deleteByIds: vi.fn(async (ids: string[]) => {
        ids.forEach(id => vectors.delete(id));
        return { mutationId: "deleted", ids, count: ids.length };
      }) },
    } as unknown as Env;
  });

  afterEach(() => { vi.restoreAllMocks(); db.close(); });

  function receipt(status = "pending_cleanup", operation = "operation", entry = "entry") {
    db.sqlite.prepare(`INSERT INTO erasure_receipts
      (operation_id, entry_id, owner_user_id, actor_user_id, vector_count, status, created_at, updated_at)
      VALUES (?, ?, 'owner', 'owner', 1, ?, 0, 0)`).run(operation, entry, status);
  }

  function queue(id: string, operation = "operation", entry = "entry") {
    vectors.add(id);
    db.sqlite.prepare(`INSERT INTO vector_cleanup_queue (id, vector_ids, reason, created_at, updated_at)
      VALUES (?, ?, ?, 0, 0)`).run(id, JSON.stringify([id]), `erasure:${operation}:${entry}`);
  }

  function status(operation = "operation") {
    return db.one<{ status: string; completed_at: number | null }>(
      "SELECT status, completed_at FROM erasure_receipts WHERE operation_id = ?", operation,
    );
  }

  it("finishes a queued receipt even when the alert sweep marks it stale during deletion", async () => {
    receipt(); queue("vector");
    vi.mocked(env.VECTORIZE.deleteByIds).mockImplementation(async ids => {
      await flagPendingErasures(env, { now: 700_000 });
      expect(status().status).toBe("stale");
      ids.forEach(id => vectors.delete(id));
      return { mutationId: "deleted", ids, count: ids.length };
    });

    expect(await drainVectorCleanupQueue(env)).toMatchObject({ deleted: 1, remaining: 0 });
    expect(vectors.size).toBe(0);
    expect(status()).toMatchObject({ status: "complete", completed_at: expect.any(Number) });
  });

  it.each(["pending_cleanup", "stale"])("repairs a %s receipt whose cleanup queue was already removed", async state => {
    receipt(state);
    expect(await drainVectorCleanupQueue(env)).toMatchObject({ processed: 0, remaining: 0 });
    expect(status().status).toBe("complete");
    expect(env.VECTORIZE.deleteByIds).not.toHaveBeenCalled();
  });

  it("retries receipt finalization on a later empty drain after a database failure", async () => {
    receipt(); queue("vector");
    const prepare = db.prepare.bind(db);
    let failCompletion = true;
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(db, "prepare").mockImplementation(sql => {
      const statement = prepare(sql);
      if (!sql.includes("UPDATE erasure_receipts") || !sql.includes("SET status = 'complete'")) return statement;
      const bind = statement.bind.bind(statement);
      statement.bind = (...values: unknown[]) => {
        const bound = bind(...values);
        const run = bound.run.bind(bound);
        bound.run = async () => {
          if (failCompletion) throw new Error("receipt update temporarily unavailable");
          return run();
        };
        return bound;
      };
      return statement;
    });

    await drainVectorCleanupQueue(env);
    expect(db.count("vector_cleanup_queue")).toBe(0);
    expect(status().status).toBe("pending_cleanup");
    failCompletion = false;
    await drainVectorCleanupQueue(env);
    expect(status().status).toBe("complete");
    expect(env.VECTORIZE.deleteByIds).toHaveBeenCalledTimes(1);
  });

  it("cannot complete before every operation queue row is removed", async () => {
    receipt(); queue("vector-a"); queue("vector-b");
    expect(await finalizeErasureReceipt(env, "operation", 100)).toBe(false);
    await drainVectorCleanupQueue(env, 1);
    expect(status().status).toBe("pending_cleanup");
    expect(vectors.size).toBe(1);
    await drainVectorCleanupQueue(env, 1);
    expect(status().status).toBe("complete");
    expect(vectors.size).toBe(0);
  });

  it("does not complete while remote deletion fails or the entry projection still exists", async () => {
    receipt("stale"); queue("vector");
    vi.mocked(env.VECTORIZE.deleteByIds).mockRejectedValue(new Error("remote deletion unavailable"));
    await drainVectorCleanupQueue(env);
    expect(status().status).toBe("stale");
    expect(db.count("vector_cleanup_queue")).toBe(1);

    receipt("pending_cleanup", "incomplete-erasure", "live-entry");
    db.sqlite.prepare("INSERT INTO entries (id, content, created_at) VALUES ('live-entry', 'Still present', 0)").run();
    expect(await finalizeErasureReceipt(env, "incomplete-erasure", 100)).toBe(false);
    await drainVectorCleanupQueue(env);
    expect(status("incomplete-erasure").status).toBe("pending_cleanup");
  });

  it("bounds receipt repair and leaves capture-stage intents and completed timestamps untouched", async () => {
    receipt("stale", "first"); receipt("pending_cleanup", "second");
    receipt("complete", "already-complete");
    db.sqlite.prepare("UPDATE erasure_receipts SET completed_at = 50 WHERE operation_id = 'already-complete'").run();
    db.sqlite.prepare(`INSERT INTO vector_cleanup_queue
      (id, vector_ids, reason, created_at, updated_at, kind)
      VALUES ('stage', '["in-flight-vector"]', 'capture-stage', 0, 0, 'capture_stage')`).run();

    await drainVectorCleanupQueue(env, 1);
    expect(status("first").status).toBe("complete");
    expect(status("second").status).toBe("pending_cleanup");
    await drainVectorCleanupQueue(env, 1);
    expect(status("second").status).toBe("complete");
    expect(status("already-complete").completed_at).toBe(50);
    expect(db.count("vector_cleanup_queue")).toBe(1);
    expect(env.VECTORIZE.deleteByIds).not.toHaveBeenCalled();
  });

  it("does not emit a stale alert when repair wins after the sweep selected the receipt", async () => {
    receipt();
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation(sql => {
      const statement = prepare(sql);
      if (!sql.includes("SET status = 'stale'")) return statement;
      const bind = statement.bind.bind(statement);
      statement.bind = (...values: unknown[]) => {
        const bound = bind(...values);
        const run = bound.run.bind(bound);
        bound.run = async () => {
          await finalizeErasureReceipt(env, "operation", 700_000);
          return run();
        };
        return bound;
      };
      return statement;
    });

    expect(await flagPendingErasures(env, { now: 700_000 })).toBe(0);
    expect(status().status).toBe("complete");
    expect(db.count("security_events")).toBe(0);
  });
});
