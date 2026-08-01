import { describe, it, expect, vi } from "vitest";
import {
  assertVectorizeMetadataIndexes,
  checkVectorizeHealth,
  evaluateKnownSemanticCanary,
} from "../../src/testing";
import { makeTestEnv, makeTestDb, makeVectorizeMock } from "../helpers/make-env";

describe("checkVectorizeHealth", () => {
  it("returns ok with the index name and dimensions when describe() resolves", async () => {
    const env = makeTestEnv(makeTestDb(), {
      VECTORIZE: makeVectorizeMock({
        describe: vi.fn().mockResolvedValue({ dimensions: 384, metric: "cosine" }),
      }),
    });
    const health = await checkVectorizeHealth(env);
    expect(health.ok).toBe(true);
    expect(health.indexName).toBe("shared-living-memory-vectors");
    expect(health.dimensions).toBe(384);
  });

  it("reads dimensions from a beta-shaped config object", async () => {
    const env = makeTestEnv(makeTestDb(), {
      VECTORIZE: makeVectorizeMock({
        describe: vi.fn().mockResolvedValue({ config: { dimensions: 384, metric: "cosine" } }),
      }),
    });
    const health = await checkVectorizeHealth(env);
    expect(health.ok).toBe(true);
    expect(health.dimensions).toBe(384);
  });

  it("returns not-ok with the error message when describe() rejects", async () => {
    const env = makeTestEnv(makeTestDb(), {
      VECTORIZE: makeVectorizeMock({
        describe: vi.fn().mockRejectedValue(new Error("index not found")),
      }),
    });
    const health = await checkVectorizeHealth(env);
    expect(health.ok).toBe(false);
    expect(health.indexName).toBe("shared-living-memory-vectors");
    expect(health.error).toContain("index not found");
  });

  it("accepts Wrangler metadata-index JSON with both required indexed types", () => {
    const output = JSON.stringify([
      { propertyName: "extra", type: "string" },
      { property_name: "OWNER_USER_ID", indexType: "STRING" },
      { propertyName: "IS_PRIVATE", type: "BOOLEAN" },
    ]);

    expect(() => assertVectorizeMetadataIndexes(output)).not.toThrow();
  });

  it("reports safe missing and mismatched metadata-index codes", () => {
    const output = JSON.stringify([
      { propertyName: "owner_user_id", type: "boolean" },
    ]);

    expect(() => assertVectorizeMetadataIndexes(output)).toThrowError(
      "vector_metadata_indexes_invalid:owner_user_id_type,is_private_missing",
    );
  });

  it("treats zero filtered results for the known semantic target as readiness failure", () => {
    expect(evaluateKnownSemanticCanary([], "entry-canary")).toEqual({
      ok: false,
      code: "semantic_canary_zero_results",
      match_count: 0,
    });
  });

  it("accepts the known semantic target only when D1-authorized filtered results contain it", () => {
    expect(evaluateKnownSemanticCanary([
      { id: "vector-1", score: 0.9, metadata: { parentId: "entry-canary" } },
    ], "entry-canary")).toEqual({ ok: true, code: "ok", match_count: 1 });
  });
});
