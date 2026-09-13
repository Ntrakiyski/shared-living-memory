/**
 * recall-eligibility.test.ts
 *
 * G5 (second half) + Section 7.1: the shared eligibility gate must exclude
 * legacy-deprecated entries AND epistemic superseded/retracted entries from
 * normal recall and from graph traversal, while terminal states are never
 * revived. The legacy-deprecated half is already covered elsewhere; this file
 * covers the epistemic axis and pins the gate's exact contract.
 */

import { describe, expect, it, beforeEach } from "vitest";
import { expandGraph, isRecallEligible } from "../../src/testing";
import { makeTestEnv, makeTestDb } from "../helpers/make-env";
import type { Env } from "../../src/testing";
import { D1Mock } from "../helpers/d1-mock";

function edge(source_id: string, target_id: string, weight = 0.5, type = "relates_to") {
  return {
    id: `${source_id}-${target_id}`, source_id, target_id, type, weight,
    provenance: "inferred", metadata: "{}", created_at: 1, updated_at: 1,
  };
}

function publicEntry(id: string, epistemicStatus: string, tags: string[] = []) {
  return {
    id,
    content: id,
    tags: JSON.stringify(tags),
    source: "api",
    created_at: 1,
    vector_ids: "[]",
    owner_user_id: "u1",
    visibility: "public",
    epistemic_status: epistemicStatus,
  };
}

describe("shared recall eligibility gate", () => {
  it("excludes legacy-deprecated and terminal epistemic states", () => {
    // Excluded: legacy deprecated.
    expect(isRecallEligible(["work", "status:deprecated"], "canonical")).toBe(false);
    // Excluded: epistemic terminal states, whatever the legacy tag says.
    expect(isRecallEligible(["work"], "superseded")).toBe(false);
    expect(isRecallEligible(["work", "status:canonical"], "superseded")).toBe(false);
    expect(isRecallEligible(["work"], "retracted")).toBe(false);
  });

  it("includes every state that is still recallable", () => {
    for (const status of ["candidate", "reviewed", "canonical", "qualified", "stale"]) {
      expect({ status, eligible: isRecallEligible(["work"], status) })
        .toEqual({ status, eligible: true });
    }
    // An entry with no legacy tag and no epistemic value is treated as the
    // stored default rather than being silently dropped.
    expect(isRecallEligible(["work"], null)).toBe(true);
    expect(isRecallEligible(["work"], undefined)).toBe(true);
    expect(isRecallEligible(["work"], "canonical")).toBe(true);
  });
});

describe("graph traversal honours the epistemic axis", () => {
  let env: Env;
  let db: D1Mock;

  beforeEach(() => {
    db = makeTestDb();
    env = makeTestEnv(db);
  });

  function seed(): void {
    db.entries.push(
      publicEntry("a", "canonical"),
      publicEntry("b", "superseded"),
      publicEntry("c", "retracted"),
      publicEntry("d", "candidate"),
      publicEntry("e", "stale"),
      publicEntry("f", "deprecated-check", ["status:deprecated"]),
    );
    db.edges.push(
      edge("a", "b", 0.9),
      edge("a", "c", 0.9),
      edge("a", "d", 0.9),
      edge("a", "e", 0.9),
      edge("a", "f", 0.9),
    );
  }

  it("never traverses into superseded or retracted neighbors", async () => {
    seed();
    const reached = (await expandGraph(["a"], { hops: 1 }, env)).map((node) => node.id).sort();
    expect(reached).not.toContain("b");
    expect(reached).not.toContain("c");
  });

  it("still traverses into candidate, stale and canonical neighbors", async () => {
    seed();
    const reached = (await expandGraph(["a"], { hops: 1 }, env)).map((node) => node.id).sort();
    expect(reached).toContain("d");
    expect(reached).toContain("e");
  });

  it("does not traverse into a legacy-deprecated neighbor", async () => {
    seed();
    const reached = (await expandGraph(["a"], { hops: 1 }, env)).map((node) => node.id);
    expect(reached).not.toContain("f");
  });

  it("does not reach a terminal node through a multi-hop path", async () => {
    db.entries.push(publicEntry("a", "canonical"), publicEntry("mid", "reviewed"), publicEntry("terminal", "retracted"));
    db.edges.push(edge("a", "mid", 0.9), edge("mid", "terminal", 0.9));
    const reached = (await expandGraph(["a"], { hops: 2 }, env)).map((node) => node.id);
    expect(reached).toContain("mid");
    expect(reached).not.toContain("terminal");
  });
});
