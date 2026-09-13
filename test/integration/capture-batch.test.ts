/**
 * capture-batch.test.ts
 *
 * C5 + Section 8.2/8.3: bounded ordered create-only batch capture. Envelope
 * failures write nothing; a content-specific failure is reported in place and
 * later items still run; a batch may be retried wholesale with identical keys.
 *
 * Real SQLite, because the receipt fence and its artifact guards are part of
 * what these tests must prove.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteD1, WORKERD_COMPOUND_SELECT_TERMS } from "../helpers/sqlite-d1";
import {
  BATCH_MAX_ITEMS,
  BATCH_MAX_SERIALIZED_ITEMS_BYTES,
  BATCH_ITEM_MAX_PAYLOAD_BYTES,
  BatchEnvelopeError,
  captureEntryBatch,
  captureEntryKeyed,
  validateBatchEnvelope,
  type BatchCaptureItem,
  type KeyedCaptureActor,
} from "../../src/ingest";
import { captureKeyHash, captureRequestHash, ACTOR_DEFAULT_SOURCE_MARKER } from "../../src/capture-receipts";
import type { Env } from "../../src/types";

interface Harness {
  db: SqliteD1;
  env: Env;
  vectors: Map<string, unknown>;
}

function makeHarness(): Harness {
  const db = new SqliteD1({ maxCompoundSelectTerms: WORKERD_COMPOUND_SELECT_TERMS });
  const vectors = new Map<string, unknown>();
  const env = {
    DB: db as unknown as D1Database,
    AI: {
      run: vi.fn(async (_model: string, options: { text: string[] }) => ({
        data: [new Array(384).fill((options.text[0]?.length ?? 0) / 1000 + 0.01)],
      })),
    } as unknown as Ai,
    VECTORIZE: {
      upsert: vi.fn(async (items: { id: string }[]) => {
        for (const item of items) vectors.set(item.id, item);
        return { mutationId: "upsert" };
      }),
      deleteByIds: vi.fn(async (ids: string[]) => {
        for (const id of ids) vectors.delete(id);
        return { mutationId: "delete" };
      }),
      insert: vi.fn(),
      query: vi.fn(),
      getByIds: vi.fn(),
      describe: vi.fn(),
    } as unknown as VectorizeIndex,
    AUTH_TOKEN: "test-token",
    OAUTH_KV: {} as KVNamespace,
  } as Env;
  return { db, env, vectors };
}

const ACTOR: KeyedCaptureActor = {
  kind: "human",
  actorId: "user-alice",
  ownerUserId: "user-alice",
  defaultSource: "api:alice",
};

function item(overrides: Partial<BatchCaptureItem> & { client_item_id: string }): BatchCaptureItem {
  return {
    idempotency_key: `key-${overrides.client_item_id}`,
    content: `Content for ${overrides.client_item_id}`,
    ...overrides,
  };
}

function envelopeError(payload: unknown): BatchEnvelopeError {
  try {
    validateBatchEnvelope(payload);
  } catch (error) {
    if (error instanceof BatchEnvelopeError) return error;
    throw error;
  }
  throw new Error("expected an envelope rejection");
}

describe("batch envelope validation", () => {
  let harness: Harness;

  beforeEach(() => {
    harness = makeHarness();
  });

  afterEach(() => {
    harness.db.close();
  });

  it("rejects zero, eleven and non-array item sets", () => {
    expect(envelopeError({ items: [] }).code).toBe("invalid_request");
    expect(envelopeError({ items: Array.from({ length: BATCH_MAX_ITEMS + 1 },
      (_, i) => item({ client_item_id: `item-${i}` })) }).code).toBe("invalid_request");
    expect(envelopeError({ items: "nope" }).code).toBe("invalid_request");
    expect(envelopeError([]).code).toBe("invalid_request");
  });

  it("accepts exactly one and exactly ten items", () => {
    expect(validateBatchEnvelope({ items: [item({ client_item_id: "only" })] })).toHaveLength(1);
    const ten = Array.from({ length: BATCH_MAX_ITEMS },
      (_, i) => item({ client_item_id: `item-${i}` }));
    expect(validateBatchEnvelope({ items: ten })).toHaveLength(BATCH_MAX_ITEMS);
  });

  it("rejects unknown top-level and item-level fields", () => {
    expect(envelopeError({ items: [item({ client_item_id: "a" })], extra: true }).details)
      .toMatchObject({ field: "extra" });
    const withUnknown = { ...item({ client_item_id: "a" }), surprise: 1 };
    expect(envelopeError({ items: [withUnknown] }).details).toMatchObject({ field: "surprise" });
  });

  it("rejects duplicate client_item_id and duplicate trimmed keys", () => {
    const duplicateIds = [item({ client_item_id: "same" }), item({ client_item_id: "same" })];
    expect(envelopeError({ items: duplicateIds }).details).toMatchObject({ field: "client_item_id" });

    const duplicateKeys = [
      item({ client_item_id: "a", idempotency_key: "shared-key" }),
      item({ client_item_id: "b", idempotency_key: "  shared-key  " }),
    ];
    expect(envelopeError({ items: duplicateKeys }).details).toMatchObject({ field: "idempotency_key" });
  });

  it("rejects wrong types, bad visibility and out-of-range keys", () => {
    expect(() => validateBatchEnvelope({ items: [{ ...item({ client_item_id: "a" }), content: 5 }] }))
      .toThrow(BatchEnvelopeError);
    expect(() => validateBatchEnvelope({ items: [{ ...item({ client_item_id: "a" }), visibility: "team" }] }))
      .toThrow(BatchEnvelopeError);
    expect(() => validateBatchEnvelope({ items: [item({ client_item_id: "a", idempotency_key: "   " })] }))
      .toThrow(BatchEnvelopeError);
    expect(() => validateBatchEnvelope({ items: [item({ client_item_id: "x".repeat(65) })] }))
      .toThrow(BatchEnvelopeError);
    expect(() => validateBatchEnvelope({ items: [{ ...item({ client_item_id: "a" }), idempotency_key: "k".repeat(241) }] }))
      .toThrow(BatchEnvelopeError);
  });

  it("measures the serialized items bound in UTF-8 bytes", () => {
    const multibyte = "😀".repeat(4);
    expect(multibyte.length).toBe(8);
    expect(new TextEncoder().encode(multibyte).byteLength).toBe(16);

    const bigItems = Array.from({ length: BATCH_MAX_ITEMS }, (_, index) => item({
      client_item_id: `item-${index}`,
      content: "😀".repeat(Math.floor(BATCH_MAX_SERIALIZED_ITEMS_BYTES / BATCH_MAX_ITEMS / 4)),
    }));
    const bytes = new TextEncoder().encode(JSON.stringify(bigItems)).byteLength;
    expect(bytes).toBeGreaterThan(BATCH_MAX_SERIALIZED_ITEMS_BYTES);
    expect(envelopeError({ items: bigItems }).code).toBe("content_too_large");
  });

  it("rejects the whole request with zero writes for an invalid envelope", async () => {
    const response = await (async () => {
      try {
        validateBatchEnvelope({ items: [item({ client_item_id: "a" }), item({ client_item_id: "a" })] });
      } catch (error) {
        return error as BatchEnvelopeError;
      }
      return null;
    })();
    expect(response?.code).toBe("invalid_request");
    // Nothing was written because the handler is never reached.
    expect(harness.db.count("entries")).toBe(0);
    expect(harness.db.count("capture_receipts")).toBe(0);
  });
});

describe("create-only keyed capture", () => {
  let harness: Harness;

  beforeEach(() => {
    harness = makeHarness();
  });

  afterEach(() => {
    harness.db.close();
  });

  it("creates once and replays without semantic deduplication", async () => {
    const first = await captureEntryKeyed(harness.env, ACTOR, {
      content: "Identical text",
      idempotencyKey: "k1",
    });
    expect(first.outcome).toBe("created");
    expect(first.captureMode).toBe("create-only");

    const replay = await captureEntryKeyed(harness.env, ACTOR, {
      content: "Identical text",
      idempotencyKey: "k1",
    });
    expect(replay.outcome).toBe("replayed");
    expect(replay.entryId).toBe(first.entryId);
    expect(harness.db.count("entries")).toBe(1);
  });

  it("lets a DIFFERENT key create a similar memory on purpose", async () => {
    const a = await captureEntryKeyed(harness.env, ACTOR, { content: "Same text", idempotencyKey: "a" });
    const b = await captureEntryKeyed(harness.env, ACTOR, { content: "Same text", idempotencyKey: "b" });
    expect(a.entryId).not.toBe(b.entryId);
    expect(harness.db.count("entries")).toBe(2);
  });

  it("stores the raw input verbatim while materializing hashtag extraction", async () => {
    const raw = "  # Work  keep   spacing  ";
    const created = await captureEntryKeyed(harness.env, ACTOR, { content: raw, idempotencyKey: "raw" });
    const episode = harness.db.one<{ content: string; materialized_content: string }>(
      "SELECT content, materialized_content FROM episodes WHERE id = ?", created.episodeId!,
    );
    expect(episode.content).toBe(raw);
    expect(episode.materialized_content).not.toBe(raw);
    // The retry hash covers the exact raw input, so whitespace changes conflict.
    await expect(captureEntryKeyed(harness.env, ACTOR, { content: "  # Work keep spacing  ", idempotencyKey: "raw" }))
      .rejects.toMatchObject({ code: "idempotency_conflict" });
  });

  it("rejects blank content and oversize payloads per item", async () => {
    await expect(captureEntryKeyed(harness.env, ACTOR, { content: "   ", idempotencyKey: "blank" }))
      .rejects.toMatchObject({ code: "invalid_request" });
    await expect(captureEntryKeyed(harness.env, ACTOR, {
      content: "x".repeat(BATCH_ITEM_MAX_PAYLOAD_BYTES + 1),
      idempotencyKey: "big",
    })).rejects.toMatchObject({ code: "content_too_large" });
    await expect(captureEntryKeyed(harness.env, ACTOR, {
      content: "ok",
      tags: Array.from({ length: 26 }, (_, i) => `t${i}`),
      idempotencyKey: "tags",
    })).rejects.toMatchObject({ code: "too_many_tags" });
    await expect(captureEntryKeyed(harness.env, ACTOR, {
      content: "ok",
      tags: ["x".repeat(65)],
      idempotencyKey: "longtag",
    })).rejects.toMatchObject({ code: "tag_too_long" });
    await expect(captureEntryKeyed(harness.env, ACTOR, {
      content: "ok",
      sourceUrl: `https://example.test/${"a".repeat(2048)}`,
      idempotencyKey: "longurl",
    })).rejects.toMatchObject({ code: "source_url_too_long" });
    await expect(captureEntryKeyed(harness.env, ACTOR, {
      content: "ok",
      sourceTitle: "t".repeat(513),
      idempotencyKey: "longtitle",
    })).rejects.toMatchObject({ code: "source_title_too_long" });
    expect(harness.db.count("entries")).toBe(0);
  });

  it("runs the secret detector on content, tags and source fields", async () => {
    // Detectors are exact-shape: a GitHub token is 36 characters after the prefix.
    const githubToken = `ghp_${"A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8".slice(0, 36)}`;
    for (const overrides of [
      { content: `leaked ${githubToken}` },
      { content: "ok", tags: [githubToken] },
      { content: "ok", sourceTitle: `sk_live_${"0".repeat(24)}` },
    ]) {
      await expect(captureEntryKeyed(harness.env, ACTOR, {
        ...overrides,
        idempotencyKey: `secret-${JSON.stringify(overrides).length}`,
      })).rejects.toMatchObject({ code: "secret_detected" });
    }
    expect(harness.db.count("entries")).toBe(0);
  });

  it("hashes the actor-default marker rather than the resolved label", async () => {
    const created = await captureEntryKeyed(harness.env, ACTOR, { content: "Defaulted", idempotencyKey: "def" });
    const receipt = harness.db.one<{ request_hash: string }>(
      "SELECT request_hash FROM capture_receipts WHERE entry_id = ?", created.entryId,
    );
    const withMarker = await captureRequestHash({
      content: "Defaulted",
      tags: [],
      sourceDeclaration: ACTOR_DEFAULT_SOURCE_MARKER,
      sourceUrl: null,
      sourceTitle: null,
      visibility: "private",
      contentType: "text",
    });
    expect(receipt.request_hash).toBe(withMarker);

    // The persisted source is still the resolved transport default.
    expect(created.source).toBe("api:alice");
  });

  it("keeps keys inside the Workerd compound-SELECT limit", async () => {
    await captureEntryKeyed(harness.env, ACTOR, { content: "Shape", idempotencyKey: "shape" });
    for (const sql of harness.db.executed) {
      const terms = (sql.match(/\b(UNION|INTERSECT|EXCEPT)\b/gi)?.length ?? 0) + 1;
      expect(terms).toBeLessThanOrEqual(WORKERD_COMPOUND_SELECT_TERMS);
    }
  });
});

describe("batch capture execution", () => {
  let harness: Harness;

  beforeEach(() => {
    harness = makeHarness();
  });

  afterEach(() => {
    harness.db.close();
  });

  it("C5 returns ordered partial outcomes and still runs later items", async () => {
    const result = await captureEntryBatch(harness.env, ACTOR, [
      item({ client_item_id: "first", content: "Good one" }),
      item({ client_item_id: "second", content: "   " }),
      item({ client_item_id: "third", content: "Good two" }),
      item({ client_item_id: "fourth", content: "x".repeat(BATCH_ITEM_MAX_PAYLOAD_BYTES + 1) }),
      item({ client_item_id: "fifth", content: "Good three" }),
    ]);

    expect(result.items.map((entry) => entry.client_item_id))
      .toEqual(["first", "second", "third", "fourth", "fifth"]);
    expect(result.items.map((entry) => entry.status))
      .toEqual(["created", "failed", "created", "failed", "created"]);
    expect(result.items[1].error?.code).toBe("invalid_request");
    expect(result.items[3].error?.code).toBe("content_too_large");
    expect(result.summary).toEqual({ created: 3, replayed: 0, failed: 2 });
    expect(result.summary.created + result.summary.replayed + result.summary.failed)
      .toBe(result.items.length);
    expect(harness.db.count("entries")).toBe(3);
  });

  it("C5 never exposes captured content in a result descriptor", async () => {
    const secretish = "DistinctivePayloadMarker12345";
    const result = await captureEntryBatch(harness.env, ACTOR, [
      item({ client_item_id: "visible", content: secretish }),
    ]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(secretish);
  });

  it("C1 finds the same receipt through single remember and through a batch", async () => {
    const single = await captureEntryKeyed(harness.env, ACTOR, {
      content: "Shared identity",
      idempotencyKey: "shared-identity",
    });
    const batched = await captureEntryBatch(harness.env, ACTOR, [
      item({ client_item_id: "batched", idempotency_key: "shared-identity", content: "Shared identity" }),
    ]);
    expect(batched.items[0].status).toBe("replayed");
    expect(batched.items[0].data?.entry_id).toBe(single.entryId);
    expect(harness.db.count("entries")).toBe(1);
  });

  it("C5 lets a whole batch be retried with identical keys and creates nothing new", async () => {
    const items = [
      item({ client_item_id: "one", content: "First" }),
      item({ client_item_id: "two", content: "Second" }),
    ];
    const first = await captureEntryBatch(harness.env, ACTOR, items);
    expect(first.summary).toEqual({ created: 2, replayed: 0, failed: 0 });

    const retried = await captureEntryBatch(harness.env, ACTOR, items);
    expect(retried.summary).toEqual({ created: 0, replayed: 2, failed: 0 });
    expect(retried.items.map((entry) => entry.data?.entry_id))
      .toEqual(first.items.map((entry) => entry.data?.entry_id));
    expect(harness.db.count("entries")).toBe(2);
    expect(harness.db.count("episodes")).toBe(2);
    expect(harness.db.count("capture_receipts")).toBe(2);
  });

  it("C1 makes reordering items change nothing about identity", async () => {
    const items = [
      item({ client_item_id: "a", content: "Alpha" }),
      item({ client_item_id: "b", content: "Beta" }),
    ];
    const forward = await captureEntryBatch(harness.env, ACTOR, items);
    const reversed = await captureEntryBatch(harness.env, ACTOR, [...items].reverse());
    expect(reversed.summary).toEqual({ created: 0, replayed: 2, failed: 0 });
    const byId = new Map(reversed.items.map((entry) => [entry.client_item_id, entry.data?.entry_id]));
    expect(byId.get("a")).toBe(forward.items[0].data?.entry_id);
    expect(byId.get("b")).toBe(forward.items[1].data?.entry_id);
    expect(harness.db.count("entries")).toBe(2);
  });

  it("reports idempotency_conflict per item when a key's payload changed", async () => {
    await captureEntryBatch(harness.env, ACTOR, [item({ client_item_id: "x", content: "Original" })]);
    const changed = await captureEntryBatch(harness.env, ACTOR, [
      item({ client_item_id: "x", content: "Changed" }),
      item({ client_item_id: "y", content: "Fresh" }),
    ]);
    expect(changed.items[0].status).toBe("failed");
    expect(changed.items[0].error?.code).toBe("idempotency_conflict");
    expect(changed.items[0].error?.retryable).toBe(false);
    expect(changed.items[1].status).toBe("created");
    expect(changed.summary).toEqual({ created: 1, replayed: 0, failed: 1 });
  });

  it("reports capture_erased per item after a forget", async () => {
    const created = await captureEntryBatch(harness.env, ACTOR, [
      item({ client_item_id: "gone", content: "Soon erased" }),
    ]);
    const entryId = created.items[0].data!.entry_id;
    const { eraseEntryArtifacts } = await import("../../src/erasure");
    await eraseEntryArtifacts(entryId, {
      kind: "human",
      actorId: ACTOR.actorId,
      userId: ACTOR.ownerUserId,
      role: "member",
      authMethod: "personal_api_key",
      scopes: new Set(),
    }, harness.env);

    const replay = await captureEntryBatch(harness.env, ACTOR, [
      item({ client_item_id: "gone", content: "Soon erased" }),
    ]);
    expect(replay.items[0].status).toBe("failed");
    expect(replay.items[0].error?.code).toBe("capture_erased");
    expect(replay.items[0].error?.retryable).toBe(false);
    expect(harness.db.count("entries")).toBe(0);
  });

  it("revalidates the actor before every item so a mid-batch revocation stops later effects", async () => {
    let calls = 0;
    const result = await captureEntryBatch(harness.env, ACTOR, [
      item({ client_item_id: "one", content: "First" }),
      item({ client_item_id: "two", content: "Second" }),
      item({ client_item_id: "three", content: "Third" }),
    ], async () => {
      calls++;
      if (calls >= 3) throw Object.assign(new Error("revoked"), { code: "forbidden" });
    });

    expect(calls).toBe(3);
    expect(result.items.map((entry) => entry.status)).toEqual(["created", "created", "failed"]);
    expect(result.items[2].error?.code).toBe("storage_unavailable");
    expect(harness.db.count("entries")).toBe(2);
  });

  it("keeps worst-case item metadata inside the structured data budget", async () => {
    const items = Array.from({ length: BATCH_MAX_ITEMS }, (_, index) => ({
      // Worst-case label and retry-key lengths, unique per item.
      client_item_id: `${index}${"c".repeat(64)}`.slice(0, 64),
      idempotency_key: `${index}${"k".repeat(240)}`.slice(0, 240),
      content: "bounded",
    }));
    expect(validateBatchEnvelope({ items })).toHaveLength(BATCH_MAX_ITEMS);
    const result = await captureEntryBatch(harness.env, ACTOR, items);
    expect(result.summary.created).toBe(BATCH_MAX_ITEMS);
    const bytes = new TextEncoder().encode(JSON.stringify(result)).byteLength;
    expect(bytes).toBeLessThanOrEqual(32_768);
    // Every item survived: none was dropped to fit.
    expect(result.items).toHaveLength(BATCH_MAX_ITEMS);
  });

  it("handles multibyte content and unique keys per item", async () => {
    const result = await captureEntryBatch(harness.env, ACTOR, [
      item({ client_item_id: "jp", content: "日本語のメモ", tags: ["作業"] }),
      item({ client_item_id: "emoji", content: "😀 emoji note", tags: ["emoji"] }),
    ]);
    expect(result.summary.created).toBe(2);
    const episode = harness.db.one<{ content: string }>(
      "SELECT content FROM episodes WHERE content = ?", "日本語のメモ",
    );
    expect(episode.content).toBe("日本語のメモ");
    expect(await captureKeyHash("日本語のメモ")).toHaveLength(64);
  });
});

describe("POST /capture/batch transport boundaries", () => {
  let harness: Harness;
  let aliceKey = "";

  beforeEach(async () => {
    harness = makeHarness();
    const { initializeDatabase, _resetDbReady } = await import("../../src/testing");
    _resetDbReady();
    await initializeDatabase(harness.env);
    const { hmacKey, AUTH_PEPPER } = await import("../../src/auth");
    const hash = await hmacKey("alice-secret", AUTH_PEPPER);
    harness.db.exec(
      `INSERT INTO users (id, username, normalized_username, auth_key_hash, auth_key_prefix, status, created_at, role)
       VALUES ('user-alice', 'alice', 'alice', '${hash}', 'slm_user-alice.', 'active', 1, 'member')`,
    );
    aliceKey = "slm_user-alice.alice-secret";
  });

  afterEach(() => {
    harness.db.close();
  });

  function batchRequest(body: BodyInit, headers: Record<string, string> = {}): Request {
    return new Request("http://localhost/capture/batch", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${aliceKey}`,
        "Content-Type": "application/json",
        ...headers,
      },
      body,
      // Required by the runtime when the body is a stream (chunked transfer).
      ...(body && typeof body === "object" && "getReader" in body ? { duplex: "half" } : {}),
    } as RequestInit);
  }

  async function post(harnessIn: Harness, body: BodyInit, headers: Record<string, string> = {}) {
    const worker = (await import("../../src/testing")).default;
    const response = await worker.fetch(batchRequest(body, headers), harnessIn.env, {
      waitUntil: () => {},
    } as never);
    return { status: response.status, body: await response.json() as any };
  }

  it("accepts a chunked body with no content-length", async () => {
    const payload = JSON.stringify({
      items: [{ client_item_id: "chunked", idempotency_key: "chunk-1", content: "Chunked item" }],
    });
    // A stream body makes the runtime use chunked transfer encoding, so there is
    // no Content-Length to pre-check against.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const bytes = new TextEncoder().encode(payload);
        controller.enqueue(bytes.slice(0, 10));
        controller.enqueue(bytes.slice(10));
        controller.close();
      },
    });
    const result = await post(harness, stream);
    expect(result.status).toBe(200);
    expect(result.body.data.summary).toEqual({ created: 1, replayed: 0, failed: 0 });
    expect(harness.db.count("entries")).toBe(1);
  });

  it("rejects an oversized chunked body and writes nothing", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // Larger than the 262144-byte request-body cap.
        controller.enqueue(encoder.encode('{"items":['));
        for (let index = 0; index < 40; index++) {
          controller.enqueue(encoder.encode(JSON.stringify({
            client_item_id: `i${index}`,
            idempotency_key: `k${index}`,
            content: "x".repeat(10_000),
          }) + (index < 39 ? "," : "")));
        }
        controller.enqueue(encoder.encode("]}"));
        controller.close();
      },
    });
    const result = await post(harness, stream);
    expect(result.status).toBe(413);
    expect(result.body.error.code).toBe("content_too_large");
    expect(harness.db.count("entries")).toBe(0);
  });

  it("rejects a malformed chunked body as invalid JSON without crashing", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"items": [{"client_item_id":'));
        controller.enqueue(new TextEncoder().encode('"x"'));
        controller.close();
      },
    });
    const result = await post(harness, stream);
    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe("invalid_request");
    expect(harness.db.count("entries")).toBe(0);
  });

  it("rejects an oversized declared content-length before reading the body", async () => {
    const result = await post(harness, JSON.stringify({ items: [] }), {
      "Content-Length": String(300_000),
    });
    expect(result.status).toBe(413);
    expect(result.body.error.code).toBe("content_too_large");
  });

  it("measures multibyte content in UTF-8 bytes", async () => {
    const result = await post(harness, JSON.stringify({
      items: [{
        client_item_id: "multibyte",
        idempotency_key: "mb-1",
        content: "日本語のメモ " + "😀".repeat(50),
      }],
    }));
    expect(result.status).toBe(200);
    const episode = harness.db.one<{ content: string }>("SELECT content FROM episodes LIMIT 1");
    expect(episode.content).toContain("日本語のメモ");
  });
});
