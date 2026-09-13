#!/usr/bin/env node
/**
 * staging-agent-load.mjs — staging load / latency / concurrency harness (WP9).
 *
 * Drives the Shared Living Memory MCP surface over HTTP with Node stdlib only.
 * It is destructive-by-scope (writes + forgets) and therefore refuses to run
 * against production and refuses any origin that does not match a verified
 * staging manifest. It never accepts a key on argv.
 *
 * Safety invariants implemented here:
 *   - Verified stage manifest + protected key files (never argv keys).
 *   - Disposable, per-run tagged fixtures; created IDs recorded in a mode-0600
 *     cleanup manifest. Cleanup deletes ONLY the recorded IDs (never a broad
 *     tag query), requires explicit confirmation, and performs final receipt
 *     checks.
 *   - Strict URL parsing (rejects embedded credentials and fragments) and
 *     cross-origin redirect refusal.
 *   - Client retry policy: at most three retries (500/1000/2000 ms + <=250 ms
 *     jitter) for reads and keyed captures ONLY. A larger valid Retry-After is
 *     honoured, bounded to 30000 ms. Unkeyed remember/append/update/forget are
 *     never auto-retried.
 *
 * The pure helpers are exported so `test/unit/staging-scripts.test.ts` can
 * exercise the safety logic without spawning a process or touching the network.
 *
 * Usage (all remote steps require a real, verified staging deployment):
 *   SLM_URL=https://staging.example.test \
 *   SLM_KEY_FILE=/path/to/monitoring.key \
 *   SLM_MANIFEST_FILE=/path/to/stage-manifest.json \
 *   node scripts/staging-agent-load.mjs --confirm-cleanup
 */

import { readFileSync, writeFileSync, chmodSync, mkdirSync, openSync, closeSync, fstatSync, fsyncSync, constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { readVerifiedStage, cloudflareClient, writePrivateJson, requestText } from "./check-staging-bindings.mjs";

// ─── Denylist / identity constants ───────────────────────────────────────────
// Production origins that must never receive a destructive request. Kept in one
// place; extra production origins may be supplied via SLM_PRODUCTION_URL.
export const PRODUCTION_ORIGINS = [
  "https://shared-living-memory.nikolay-trakiyski.workers.dev",
  "https://memory.fractals-solutions.com",
];

export const STAGING_ENVIRONMENT = "staging";
export const STAGING_DEPLOYMENT_ID = "slm-fractals-staging";
export const PRODUCTION_DEPLOYMENT_ID = "slm-fractals-production";

// ─── Retry policy ─────────────────────────────────────────────────────────────
export const RETRY_DELAYS_MS = [500, 1000, 2000];
export const RETRY_JITTER_MS = 250;
export const RETRY_AFTER_MAX_MS = 30_000;

const READ_TOOLS = new Set([
  "recall",
  "list_recent",
  "passages",
  "history",
  "connections",
  "list_action_proposals",
  "list-proposals",
  "list_edge_proposals",
  "whoami",
]);

const UNKEYED_WRITE_TOOLS = new Set([
  "append",
  "update",
  "set_status",
  "set_epistemic_status",
  "link",
  "unlink",
  "propose_edge",
  "approve-proposal",
  "reject-proposal",
  "approve_edge_proposal",
  "reject_edge_proposal",
  "restore",
  "create_action_proposal",
  "review_action_proposal",
  "execute_approved_action",
]);

/**
 * Classify a tool invocation so the retry policy can decide whether an
 * automatic retry is allowed. Unknown tools default to a non-retryable kind.
 *
 * @param {string} toolName
 * @param {object} [args]
 * @returns {string} one of "read" | "keyed-capture" | "unkeyed-remember" |
 *                   "unkeyed-write" | "forget" | "other"
 */
export function classifyToolKind(toolName, args = {}) {
  const name = String(toolName ?? "");
  if (name === "remember") {
    return isKeyedCapture(args) ? "keyed-capture" : "unkeyed-remember";
  }
  if (name === "remember_batch") return "keyed-capture";
  if (name === "forget") return "forget";
  if (READ_TOOLS.has(name)) return "read";
  if (UNKEYED_WRITE_TOOLS.has(name)) return "unkeyed-write";
  return "other";
}

/**
 * @param {object} [args]
 * @returns {boolean}
 */
export function isKeyedCapture(args = {}) {
  const key = args?.idempotency_key;
  return typeof key === "string" && key.trim().length > 0;
}

/** Only reads and keyed captures may be retried automatically.
 * @param {string} kind
 * @returns {boolean}
 */
export function isRetryableKind(kind) {
  return kind === "read" || kind === "keyed-capture";
}

/** Maximum automatic retries for a kind (3 for retryable, 0 otherwise).
 * @param {string} kind
 * @returns {number}
 */
export function maxRetries(kind) {
  return isRetryableKind(kind) ? RETRY_DELAYS_MS.length : 0;
}

/**
 * Delay in ms for a given retry attempt (attemptIndex is 0-based: 0 = first
 * retry). A larger valid Retry-After is honoured, bounded to 30000 ms. Returns
 * null once the three-retry budget is exhausted.
 *
 * @param {number} attemptIndex
 * @param {number|null} [retryAfterMs]
 * @returns {number|null}
 */
export function retryDelayMs(attemptIndex, retryAfterMs = null) {
  if (!Number.isInteger(attemptIndex) || attemptIndex < 0 || attemptIndex >= RETRY_DELAYS_MS.length) {
    return null;
  }
  let delayMs = RETRY_DELAYS_MS[attemptIndex];
  if (typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) && retryAfterMs > delayMs) {
    delayMs = Math.min(retryAfterMs, RETRY_AFTER_MAX_MS);
  }
  return delayMs;
}

/** Add up to RETRY_JITTER_MS of jitter to a base delay. rand is injectable.
 * @param {number} delayMs
 * @param {function} [rand]
 * @returns {number}
 */
export function applyJitter(delayMs, rand = Math.random) {
  return delayMs + Math.floor(rand() * (RETRY_JITTER_MS + 1));
}

/** Extract a bounded Retry-After (seconds) from headers, or null.
 * @param {object} [headers]
 * @returns {number|null}
 */
export function parseRetryAfterMs(headers = {}) {
  const raw = (headers["retry-after"] ?? headers["Retry-After"])?.toString?.();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) {
    const seconds = Number.parseInt(raw, 10);
    return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
  }
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) return null;
  return Math.max(0, parsed - Date.now());
}

// ─── Strict URL / origin handling ────────────────────────────────────────────

/**
 * Parse a destination URL exactly. Rejects: missing/invalid URLs, non-http(s)
 * schemes, embedded credentials (userinfo), and fragments.
 *
 * @param {string} raw
 * @returns {{ url: (URL|null), errors: string[] }}
 */
export function parseStrictUrl(raw) {
  const errors = [];
  if (typeof raw !== "string" || raw.trim() === "") {
    return { url: null, errors: ["url_missing"] };
  }
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    return { url: null, errors: ["url_invalid"] };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") errors.push("url_scheme");
  if (url.username || url.password) errors.push("url_credentials");
  if (url.hash) errors.push("url_fragment");
  return { url, errors };
}

/** True when `origin` is a known production origin (plus any extras).
 * @param {string} origin
 * @param {string[]} [extraOrigins]
 * @returns {boolean}
 */
export function isProductionOrigin(origin, extraOrigins = []) {
  const normalized = new Set(
    [...PRODUCTION_ORIGINS, ...extraOrigins].map(value => {
      try {
        return new URL(value).origin;
      } catch {
        return value;
      }
    }),
  );
  return normalized.has(origin);
}

/** True when a redirect Location resolves to a different origin.
 * @param {string} origin
 * @param {string} location
 * @returns {boolean}
 */
export function isCrossOriginRedirect(origin, location) {
  try {
    return new URL(location, origin).origin !== origin;
  } catch {
    return true;
  }
}

/**
 * Pre-write origin gate: parse the URL strictly, refuse known production
 * origins, and refuse any origin not equal to the verified manifest origin.
 *
 * @param {string} rawUrl
 * @param {{ manifestOrigin?: string, productionOrigins?: string[] }} [options]
 * @returns {{ ok: boolean, origin: (string|null), errors: string[] }}
 */
export function preflightUrl(rawUrl, { manifestOrigin, productionOrigins = PRODUCTION_ORIGINS } = {}) {
  const { url, errors } = parseStrictUrl(rawUrl);
  const out = { ok: false, origin: null, errors: [...errors] };
  if (!url) return out;
  out.origin = url.origin;
  if (isProductionOrigin(url.origin, productionOrigins)) out.errors.push("production_origin_refused");
  if (manifestOrigin && url.origin !== manifestOrigin) out.errors.push("origin_not_in_manifest");
  out.ok = out.errors.length === 0;
  return out;
}

// ─── Stage manifest ───────────────────────────────────────────────────────────

/** Validate a verified stage manifest (fail closed on missing fields).
 * @param {object} manifest
 * @param {{ expectedDeploymentId?: string, expectedOrigin?: string }} [options]
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateStageManifest(manifest, { expectedDeploymentId = STAGING_DEPLOYMENT_ID, expectedOrigin } = {}) {
  const errors = [];
  if (!manifest || typeof manifest !== "object") return { ok: false, errors: ["manifest_missing"] };
  if (typeof manifest.environment !== "string" || !manifest.environment) errors.push("manifest_environment_missing");
  else if (manifest.environment !== STAGING_ENVIRONMENT) errors.push("manifest_environment_not_staging");
  if (typeof manifest.deployment_id !== "string" || !manifest.deployment_id) errors.push("manifest_deployment_id_missing");
  else if (expectedDeploymentId && manifest.deployment_id !== expectedDeploymentId) errors.push("manifest_deployment_id_mismatch");
  if (typeof manifest.origin !== "string" || !manifest.origin) errors.push("manifest_origin_missing");
  else if (expectedOrigin && manifest.origin !== expectedOrigin) errors.push("manifest_origin_mismatch");
  return { ok: errors.length === 0, errors };
}

// ─── Cleanup manifest (mode 0600) ────────────────────────────────────────────

/** Write the cleanup manifest as JSON with mode 0600, exclusive create.
 * @param {string} manifestPath
 * @param {object[]} records
 * @returns {{ path: string, count: number }}
 */
export function writeCleanupManifest(manifestPath, records) {
  const payload = JSON.stringify(
    {
      generated_at: new Date().toISOString(),
      note: "Cleanup is scoped to exactly these known ids from this run; never delete by broad tag.",
      ids: records,
    },
    null,
    2,
  );
  mkdirSync(dirname(resolve(manifestPath)), { recursive: true });
  writeFileSync(manifestPath, payload, { encoding: "utf8", mode: 0o600, flag: "wx" });
  chmodSync(manifestPath, 0o600);
  return { path: manifestPath, count: records.length };
}

/** Read an existing cleanup manifest back (used for confirmation + receipt checks).
 * @param {string} manifestPath
 * @returns {object[]}
 */
export function loadCleanupManifest(manifestPath) {
  const parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
  return Array.isArray(parsed?.ids) ? parsed.ids : [];
}

// ─── MCP response parsing (JSON + SSE) ───────────────────────────────────────

/** Split an SSE body into `{event, data}` records.
 * @param {string} text
 * @returns {Array<{ event: string, data: string }>}
 */
export function parseSseStream(text) {
  const records = [];
  let event = "message", data = [];
  for (const line of String(text ?? "").replace(/\r\n/g, "\n").split("\n")) {
    if (!line) {
      if (data.length) records.push({ event, data: data.join("\n") });
      event = "message"; data = [];
    } else if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
  }
  if (data.length) records.push({ event, data: data.join("\n") });
  return records;
}

/**
 * @typedef {{
 *   httpStatus: number,
 *   httpOk: boolean,
 *   sse: boolean,
 *   messages: any[],
 *   jsonrpcError: any,
 *   toolIsError: boolean
 * }} ParsedMcpResponse
 */

/**
 * Normalize an MCP HTTP response, asserting HTTP status, JSON-RPC error and
 * tool `isError` separately (never conflated).
 *
 * @param {number} status
 * @param {string} bodyText
 * @param {string} [contentType]
 * @returns {ParsedMcpResponse}
 */
export function parseMcpResponse(status, bodyText, contentType = "application/json") {
  const result = {
    httpStatus: status,
    httpOk: status >= 200 && status < 300,
    sse: /text\/event-stream/.test(String(contentType ?? "")),
    messages: [],
    jsonrpcError: null,
    toolIsError: false,
  };
  if (result.sse) {
    for (const record of parseSseStream(bodyText)) {
      try {
        result.messages.push(JSON.parse(record.data));
      } catch {
        // Ignore keepalive/comment records; JSON-RPC payloads are parsed below.
      }
    }
  } else {
    try {
      result.messages.push(JSON.parse(bodyText));
    } catch {
      // Non-JSON body: httpOk already captures transport success/failure.
    }
  }
  for (const message of result.messages) {
    if (message && typeof message === "object" && message.error) result.jsonrpcError = message.error;
    if (message && typeof message === "object" && message.result
        && typeof message.result === "object" && message.result.isError === true) {
      result.toolIsError = true;
    }
  }
  return result;
}

// ─── Timing ───────────────────────────────────────────────────────────────────

/** Nearest-rank percentile over an already-sorted numeric array.
 * @param {number[]} sortedSamples
 * @param {number} percentile
 * @returns {number|null}
 */
export function computePercentile(sortedSamples, percentile) {
  if (!sortedSamples.length) return null;
  const rank = Math.ceil((percentile / 100) * sortedSamples.length);
  return sortedSamples[Math.min(rank, sortedSamples.length) - 1];
}

/** @param {number[]} sortedSamples @returns {number|null} */
export function p50(sortedSamples) {
  return computePercentile(sortedSamples, 50);
}

/** @param {number[]} sortedSamples @returns {number|null} */
export function p95(sortedSamples) {
  return computePercentile(sortedSamples, 95);
}

// ─── Fixture generation ───────────────────────────────────────────────────────

/** Generate `count` disposable keyed-capture fixture specs with fixed content.
 * @param {number} count
 * @param {{ contentBytes?: number, runId?: string, ownerIndex?: number }} [options]
 * @returns {object[]}
 */
export function buildFixtureSpecs(count, { contentBytes = 1024, runId = "slm-load", ownerIndex = 0 } = {}) {
  const unit = "x".repeat(8);
  const content = (unit.repeat(Math.ceil(contentBytes / unit.length)) + " slm-load-fixture").slice(0, contentBytes);
  const specs = [];
  for (let i = 0; i < count; i++) {
    specs.push({
      idempotency_key: `${runId}-owner${ownerIndex}-${i}`,
      content,
      tags: ["slm-load-fixture", `run:${runId}`],
      visibility: "private",
    });
  }
  return specs;
}

// ─── Protected key handling ──────────────────────────────────────────────────

/** Read a protected key file; never accept a key from argv.
 * @param {string} keyFilePath
 * @returns {{ ok: boolean, key: (string|null), errors: string[] }}
 */
export function readKeyFile(keyFilePath) {
  if (!keyFilePath) return { ok: false, key: null, errors: ["key_file_missing"] };
  let fd;
  try {
    fd = openSync(keyFilePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) {
      return { ok: false, key: null, errors: ["key_file_permissions"] };
    }
    const key = readFileSync(fd, "utf8").trim();
    if (!key || /[\r\n]/.test(key)) return { ok: false, key: null, errors: ["key_file_invalid"] };
    return { ok: true, key, errors: [] };
  } catch { return { ok: false, key: null, errors: ["key_file_unreadable"] }; }
  finally { if (fd !== undefined) closeSync(fd); }
}

// ─── Finite HTTP runner ────────────────────────────────────────────────────

export const LOAD_GATES = Object.freeze({
  concurrency: [1, 4, 8], repetitions: 3, writes: 100, writeWarmups: 10,
  latencyConcurrency: 4, latencyWarmups: 10, latencySamples: 100,
  rawP95Ms: 3000, generatedP95Ms: 10000,
});

class RequestFailure extends Error {
  constructor(code, { retryable = false, httpStatus = null, toolError = false, retryAfter = null } = {}) {
    super(code); Object.assign(this, { code, retryable, httpStatus, toolError, retryAfter });
  }
}

function safeCode(code) {
  return typeof code === "string" && /^[a-z0-9_]+$/.test(code) ? code : "request_failed";
}

function assertGate(condition, code) {
  if (!condition) throw new Error(code);
}

async function parallel(count, concurrency, fn) {
  let next = 0;
  const results = new Array(count);
  // Settle every dispatched request before cleanup; an early rejection must
  // never race still-running writes against deletion.
  await Promise.all(Array.from({ length: Math.min(count, concurrency) }, async (_, worker) => {
    while (next < count) {
      const index = next++;
      try { results[index] = await fn(index, worker); }
      catch (error) { results[index] = { ok: false, error: safeCode(error.message) }; }
    }
  }));
  return results;
}

export function summarizeTimings(samples) {
  const sorted = field => samples.map(s => s[field]).filter(Number.isFinite).sort((a, b) => a - b);
  return {
    requests: samples.length, accepted: samples.filter(s => s.ok).length,
    retry_count: samples.reduce((n, s) => n + (s.retries || 0), 0),
    http_errors: samples.reduce((n, s) => n + (s.httpErrors || 0), 0),
    tool_errors: samples.reduce((n, s) => n + (s.toolErrors || 0), 0),
    transport_errors: samples.reduce((n, s) => n + (s.transportErrors || 0), 0),
    p50_ms: p50(sorted("durationMs")), p95_ms: p95(sorted("durationMs")),
    first_attempt_p50_ms: p50(sorted("firstAttemptMs")), first_attempt_p95_ms: p95(sorted("firstAttemptMs")),
    errors: samples.filter(s => !s.ok).map(s => safeCode(s.error)),
    samples: samples.map(s => ({ ok: s.ok, error: s.ok ? null : safeCode(s.error),
      duration_ms: s.durationMs ?? null, first_attempt_ms: s.firstAttemptMs ?? null, retries: s.retries || 0 })),
  };
}

export function createLoadClient({ origin, key, fetchImpl = fetch, sleep = async ms => { await delay(ms); } }) {
  let session;
  const headers = () => ({
    Authorization: `Bearer ${key}`, "Content-Type": "application/json",
    Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2024-11-05",
    ...(session ? { "Mcp-Session-Id": session } : {}),
  });

  async function timed(kind, action) {
    const start = performance.now();
    let firstAttemptMs, retries = 0, httpErrors = 0, toolErrors = 0, transportErrors = 0;
    while (true) {
      const attemptStart = performance.now();
      try {
        const value = await action();
        firstAttemptMs ??= performance.now() - attemptStart;
        return { ok: true, value, durationMs: performance.now() - start, firstAttemptMs,
          retries, httpErrors, toolErrors, transportErrors };
      } catch (error) {
        firstAttemptMs ??= performance.now() - attemptStart;
        const known = error instanceof RequestFailure;
        if (known && error.httpStatus && error.httpStatus >= 400) httpErrors++;
        if (known && error.toolError) toolErrors++;
        if (!known) transportErrors++;
        const retryable = known ? error.retryable : true;
        const retryAfter = known ? error.retryAfter : null;
        if (!retryable || retries >= maxRetries(kind) || retryAfter > RETRY_AFTER_MAX_MS) {
          return { ok: false, error: safeCode(known ? error.code : "transport_error"),
            durationMs: performance.now() - start, firstAttemptMs, retries, httpErrors, toolErrors, transportErrors };
        }
        await sleep(applyJitter(retryDelayMs(retries++, retryAfter)));
      }
    }
  }

  async function request(path, body) {
    let result;
    try { result = await requestText(fetchImpl, `${origin}${path}`, {
      method: body === undefined ? "GET" : "POST", headers: headers(),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }); } catch (error) {
      if (error.message === "redirect_refused") throw new RequestFailure("redirect_refused");
      throw error;
    }
    if (!result.response.ok) throw new RequestFailure(`http_${result.response.status}`, {
      httpStatus: result.response.status, retryable: [429, 500, 502, 503, 504].includes(result.response.status),
      retryAfter: parseRetryAfterMs(Object.fromEntries(result.response.headers)),
    });
    if (result.response.headers.get("mcp-session-id")) session = result.response.headers.get("mcp-session-id");
    return result;
  }

  async function rpc(method, params, loseResponse = false) {
    const id = randomUUID();
    const { response, body } = await request("/mcp", { jsonrpc: "2.0", id, method, params });
    const parsed = parseMcpResponse(response.status, body, response.headers.get("content-type"));
    const message = parsed.messages.find(m => m?.id === id && m.jsonrpc === "2.0");
    if (!message || (!Object.hasOwn(message, "result") && !message.error)) {
      throw new RequestFailure("mcp_invalid_response");
    }
    if (message.error) throw new RequestFailure("jsonrpc_error");
    const result = message.result;
    if (result?.isError === true || result?.structuredContent?.ok === false) {
      const error = result.structuredContent?.error;
      throw new RequestFailure(safeCode(error?.code || "tool_error"), {
        retryable: error?.retryable === true, toolError: true,
        retryAfter: parseRetryAfterMs(Object.fromEntries(response.headers)),
      });
    }
    if (loseResponse) throw new Error("simulated_response_loss");
    return result;
  }

  return {
    initialize: () => timed("read", async () => {
      const result = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {},
        clientInfo: { name: "slm-staging-load", version: "1.1.0" } });
      if (!result?.serverInfo?.version) throw new RequestFailure("initialize_invalid");
      return result.serverInfo;
    }),
    tool: (name, args = {}, { loseResponse = false } = {}) => {
      let lose = loseResponse;
      return timed(classifyToolKind(name, args), async () => {
        const discard = lose; lose = false;
        const result = await rpc("tools/call", { name, arguments: args }, discard);
        if (result?.structuredContent?.ok !== true || !result.structuredContent.data) {
          throw new RequestFailure("tool_envelope_missing");
        }
        const data = result.structuredContent.data;
        if (name === "remember_batch") {
          if (!Array.isArray(data.items) || data.items.length !== args.items.length) {
            throw new RequestFailure("batch_result_invalid");
          }
          const failure = data.items.find(item => item.status === "failed");
          if (failure) throw new RequestFailure(safeCode(failure.error?.code), {
            retryable: failure.error?.retryable === true, toolError: true,
          });
        }
        return data;
      });
    },
    rest: (path, body, kind = "read") => timed(kind, async () => {
      const { body: text } = await request(path, body);
      let json;
      try { json = JSON.parse(text); } catch { throw new RequestFailure("rest_invalid_json"); }
      if (json?.ok === false) throw new RequestFailure(safeCode(json.error?.code || "rest_error"));
      return json;
    }),
    chat: query => timed("read", async () => {
      const { response, body } = await request("/chat", { query });
      if (!/text\/event-stream/.test(response.headers.get("content-type") || "")) throw new RequestFailure("chat_not_sse");
      const events = parseSseStream(body);
      if (!events.some(e => e.data === "[DONE]")) throw new RequestFailure("chat_stream_incomplete");
      let answer = "";
      for (const event of events) {
        if (event.data === "[DONE]") continue;
        let data;
        try { data = JSON.parse(event.data); } catch { throw new RequestFailure("chat_invalid_sse"); }
        if (data.error || data.errors || event.event === "error") throw new RequestFailure("chat_stream_error");
        answer += data.response ?? data.choices?.[0]?.delta?.content ?? "";
      }
      if (!answer.trim() || !/\[Source \d+\]/.test(answer)) throw new RequestFailure("chat_grounding_missing");
      return { complete: true, answer_bytes: Buffer.byteLength(answer) };
    }),
  };
}

// A default-search benchmark must fail on contamination, never post-filter its
// results into an apparently successful fixture-only response.
export function validateRecallFixtures(data, ownerId, fixturesById) {
  if (data.semantic_available !== true) return "semantic_unavailable";
  if (!Array.isArray(data.matches) || data.matches.length === 0) return "semantic_matches_missing";
  for (const match of data.matches) {
    const fixture = fixturesById.get(match.entry?.entry_id);
    if (!fixture) return "unexpected_fixture";
    if (fixture.owner_id !== ownerId && fixture.spec.visibility !== "public") return "cross_owner_private_leak";
    if (match.entry.owner?.id !== fixture.owner_id || match.entry.visibility !== fixture.spec.visibility) {
      return "fixture_metadata_mismatch";
    }
    if (!Array.isArray(match.citations) || !match.citations.length) return "citations_missing";
  }
  return null;
}

function required(result, code) {
  assertGate(result.ok, code || result.error || "request_failed");
  return result.value;
}

export async function runLoad({ env = process.env, argv = process.argv.slice(2), fetchImpl = fetch } = {}) {
  if (argv.includes("--help")) {
    console.log("SLM_URL=<staging origin> SLM_EXPECTED_DEPLOYMENT_ID=<id> SLM_EXPECTED_RELEASE_ID=<40hex SHA> SLM_KEY_FILE=<0600 file> SLM_WRITER_KEY_FILES='[four protected paths]' SLM_MANIFEST_FILE=<verified file> node scripts/staging-agent-load.mjs --confirm-cleanup [--cleanup-manifest <new .jsonl file>] [--report <new .json file>]");
    return;
  }
  let confirmCleanup = false;
  let cleanupPath = env.SLM_CLEANUP_MANIFEST || resolve(`slm-load-${Date.now()}-cleanup.jsonl`);
  let reportPath = env.SLM_LOAD_REPORT || resolve(`slm-load-${Date.now()}-report.json`);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--confirm-cleanup") confirmCleanup = true;
    else if (argv[i] === "--cleanup-manifest" && argv[i + 1]) cleanupPath = argv[++i];
    else if (argv[i] === "--report" && argv[i + 1]) reportPath = argv[++i];
    else throw new Error("invalid_argument");
  }
  assertGate(confirmCleanup, "cleanup_confirmation_required");
  const manifest = await readVerifiedStage({ env, fetchImpl });
  let keyPaths;
  try { keyPaths = JSON.parse(env.SLM_WRITER_KEY_FILES || "null"); } catch { throw new Error("writer_key_files_invalid"); }
  assertGate(Array.isArray(keyPaths) && keyPaths.length === 4 && keyPaths.every(p => typeof p === "string"), "four_writer_key_files_required");
  const keys = keyPaths.map(path => { const key = readKeyFile(path); assertGate(key.ok, "writer_key_file_invalid"); return key.key; });
  assertGate(new Set(keys).size === 4, "four_distinct_keys_required");
  const clients = keys.map(key => createLoadClient({ origin: manifest.origin, key, fetchImpl }));
  const serverVersions = await Promise.all(clients.map(async client => required(await client.initialize())));
  const identities = await Promise.all(clients.map(async client => required(await client.tool("whoami"))));
  const ownerIds = identities.map(identity => identity.principal?.id);
  assertGate(ownerIds.every(id => typeof id === "string") && new Set(ownerIds).size === 4, "four_distinct_accounts_required");
  for (const identity of identities) {
    assertGate(identity.credential_type === "personal_api_key" && identity.tool_profile === "full"
      && identity.deployment?.id === manifest.deployment_id && identity.deployment.release_id === manifest.release_id
      && identity.deployment.environment === "staging" && identity.deployment.canonical_url === manifest.origin
      && identity.deployment.write_mode === "enabled", "writer_identity_mismatch");
  }

  const runId = randomUUID(), source = `slm-load:${runId}`;
  const records = new Map();
  const fd = openSync(resolve(cleanupPath), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  const journal = value => { writeFileSync(fd, JSON.stringify(value) + "\n"); fsyncSync(fd); };
  journal({ type: "run", run_id: runId, deployment_id: manifest.deployment_id, origin: manifest.origin, owners: ownerIds });
  const report = { schema_version: 1, raw_recall_workload: "default_recall", run_id: runId, started_at: new Date().toISOString(),
    deployment: manifest, server_versions: serverVersions,
    models: { embedding: "@cf/baai/bge-small-en-v1.5", generation: "@cf/meta/llama-4-scout-17b-16e-instruct" },
    limits: LOAD_GATES, scenarios: [], cleanup: { complete: 0, pending: 0, failed: 0 }, ok: false };
  const recordScenario = scenario => {
    report.scenarios.push(scenario);
    console.log(JSON.stringify({ stage: scenario.kind, concurrency: scenario.concurrency,
      repetition: scenario.repetition, mode: scenario.mode, workload: scenario.workload,
      accepted: scenario.measured?.accepted, p95_ms: scenario.measured?.p95_ms }));
  };
  const cf = cloudflareClient(env, fetchImpl);
  const databaseId = manifest.bindings.d1_databases.find(b => b.binding === "DB").database_id;
  const sql = async (query, params = []) => {
    const data = await cf(`/d1/database/${databaseId}/query`, { sql: query, params });
    assertGate(Array.isArray(data) && data.length === 1 && data[0].success === true && Array.isArray(data[0].results), "d1_verification_failed");
    return data[0].results;
  };

  function plan(label, owner, visibility = "private") {
    const idempotency_key = `${runId}-${label}`;
    const content = (`Staging reliability fixture ${label}. The amber lighthouse archives navigation decisions and safe harbor instructions. `
      + "This disposable memory supports a finite reliability measurement. ".repeat(24)).slice(0, 1024);
    const spec = { client_item_id: label.slice(-64), idempotency_key, content,
      tags: ["slm-load-fixture", `run:${runId}`], source, visibility,
      source_url: `https://example.test/slm-load/${runId}/${label}`, source_title: "Lighthouse reliability fixture" };
    const record = { label, owner, owner_id: ownerIds[owner], key_hash: createHash("sha256").update(idempotency_key).digest("hex"), spec };
    records.set(idempotency_key, record); journal({ type: "planned", ...record });
    return record;
  }

  async function capture(record, options) {
    const result = await clients[record.owner].tool("remember_batch", { items: [record.spec] }, options);
    if (result.ok) {
      const item = result.value.items[0], data = item.data, receipt = data?.receipt, entry = data?.entry;
      if (!["created", "replayed"].includes(item.status) || data?.outcome !== item.status || data?.capture_mode !== "create_only"
        || typeof receipt?.entry_id !== "string" || typeof receipt.episode_id !== "string"
        || !Number.isSafeInteger(receipt.revision)
        || (entry && (entry.entry_id !== receipt.entry_id || entry.owner?.id !== record.owner_id
          || entry.visibility !== record.spec.visibility || !Number.isSafeInteger(entry.revision)))) {
        return { ...result, ok: false, error: "capture_receipt_invalid" };
      }
      if (record.id && (record.id !== receipt.entry_id || record.episode_id !== receipt.episode_id)) {
        return { ...result, ok: false, error: "duplicate_retry_effect" };
      }
      Object.assign(record, { id: receipt.entry_id, episode_id: receipt.episode_id,
        committed_revision: receipt.revision, current_revision: entry?.revision ?? receipt.revision });
      journal({ type: "accepted", label: record.label, owner: record.owner, id: record.id, episode_id: record.episode_id, key_hash: record.key_hash });
    }
    return result;
  }

  async function authoritativeCheck(group) {
    const planned = [...group];
    const accepted = planned.filter(r => r.id);
    const rows = [];
    for (let offset = 0; offset < planned.length; offset += 90) {
      const chunk = planned.slice(offset, offset + 90);
      rows.push(...await sql(`SELECT c.actor_id, c.key_hash, c.entry_id, c.episode_id, c.revision, c.state,
        e.owner_user_id, e.current_episode_id, e.revision AS current_revision,
        (SELECT COUNT(*) FROM episodes p WHERE p.entry_id = c.entry_id) AS episode_count,
        (SELECT COUNT(*) FROM entry_snapshots s WHERE s.entry_id = c.entry_id) AS snapshot_count,
        (SELECT COUNT(*) FROM passages p WHERE p.episode_id = c.episode_id) AS passage_count,
        (SELECT COUNT(*) FROM documents d JOIN episodes p ON p.id = d.episode_id WHERE p.entry_id = c.entry_id) AS document_count
        FROM capture_receipts c LEFT JOIN entries e ON e.id = c.entry_id
        WHERE c.actor_kind = 'human' AND c.key_hash IN (${chunk.map(() => "?").join(",")})`, chunk.map(r => r.key_hash)));
    }
    for (const record of accepted) {
      const matches = rows.filter(r => r.key_hash === record.key_hash && r.actor_id === record.owner_id);
      assertGate(matches.length === 1, "receipt_count_mismatch");
      const row = matches[0];
      assertGate(row.entry_id === record.id && row.episode_id === record.episode_id && row.state === "committed"
        && row.owner_user_id === record.owner_id && row.current_revision >= row.revision
        && row.episode_count === row.current_revision && row.snapshot_count === row.current_revision - 1
        && row.document_count === row.episode_count && row.passage_count > 0, "partial_or_missing_provenance");
    }
    assertGate(new Set(accepted.map(r => r.id)).size === accepted.length, "duplicate_logical_writes");
    return { acknowledged: accepted.length, final_rows: rows.filter(r => r.owner_user_id).length,
      receipts: rows.length, duplicates: 0, lost_acknowledged: 0 };
  }

  let primaryError;
  try {
    for (const concurrency of LOAD_GATES.concurrency) {
      for (let repetition = 1; repetition <= LOAD_GATES.repetitions; repetition++) {
        const prefix = `c${concurrency}-r${repetition}`;
        const warm = Array.from({ length: LOAD_GATES.writeWarmups }, (_, i) => plan(`${prefix}-warm-${i}`, i % 4));
        const warmResults = await parallel(warm.length, concurrency, i => capture(warm[i]));
        const measured = Array.from({ length: LOAD_GATES.writes }, (_, i) => plan(`${prefix}-write-${i}`, i % 4));
        const results = await parallel(measured.length, concurrency, i => capture(measured[i]));
        const proof = await authoritativeCheck(measured);
        recordScenario({ kind: "independent_writes", concurrency, repetition,
          warmup: summarizeTimings(warmResults), measured: summarizeTimings(results), ...proof });
        // Eight writers may reject overload safely; unresolved writes must still
        // reconcile before cleanup and are recorded, never counted as accepted.
        assertGate(concurrency === 8 || warmResults.concat(results).every(r => r.ok), "supported_write_target_failed");
        assertGate(results.every(r => r.ok || ["http_429", "http_503", "http_504", "storage_unavailable", "dependency_unavailable", "capture_in_progress"].includes(r.error)), "write_correctness_failure");
      }
    }

    const race = plan("same-owner-revision", 0, "public"); required(await capture(race));
    const sameOwner = Array.from({ length: 4 }, () => createLoadClient({ origin: manifest.origin, key: keys[0], fetchImpl }));
    for (const client of sameOwner) required(await client.initialize());
    const edits = await Promise.all(sameOwner.map(client => client.tool("set_status", {
      id: race.id, status: "canonical", expected_revision: race.current_revision, reason: "Staging revision race fixture",
    })));
    assertGate(edits.filter(r => r.ok).length === 1 && edits.filter(r => r.error === "revision_conflict").length === 3,
      "revision_conflict_gate_failed");
    const crossOwner = await Promise.all(clients.slice(1).map(client => client.tool("set_status", {
      id: race.id, status: "deprecated", expected_revision: race.current_revision + 1,
    })));
    assertGate(crossOwner.every(r => !r.ok && r.error === "not_owner"), "cross_owner_edit_gate_failed");
    const raceProof = await authoritativeCheck([race]);
    const current = await sql("SELECT revision FROM entries WHERE id = ?", [race.id]);
    assertGate(current[0]?.revision === race.current_revision + 1, "revision_race_partial_write");
    recordScenario({ kind: "same_owner_revision", accepted: 1, conflicts: 3, cross_owner_denials: 3, ...raceProof });

    const repeated = plan("same-key", 0);
    const repeats = await Promise.all(Array.from({ length: 4 }, () => capture(repeated)));
    assertGate(repeats.every(r => r.ok), "same_key_failed");
    const lost = plan("lost-response", 1);
    const lossResult = await capture(lost, { loseResponse: true }); required(lossResult);
    assertGate(lossResult.retries >= 1, "lost_response_not_retried");
    const retryProof = await authoritativeCheck([repeated, lost]);
    recordScenario({ kind: "retry_identity", repeated_requests: 4, simulated_lost_responses: 1,
      retry_count: repeats.reduce((n, r) => n + r.retries, 0) + lossResult.retries, ...retryProof });

    const privateFixtures = await Promise.all(clients.map(async (_, owner) => {
      const record = plan(`privacy-${owner}`, owner); required(await capture(record)); return record;
    }));
    recordScenario({ kind: "four_independent_owners", accounts: 4, ...await authoritativeCheck(privateFixtures) });
    for (let owner = 0; owner < clients.length; owner++) {
      let cursor;
      const seenCursors = new Set(), seenEntries = new Set();
      do {
        assertGate(!seenCursors.has(cursor), "pagination_cycle");
        seenCursors.add(cursor);
        const page = required(await clients[owner].tool("list_recent", { n: 50, tag: `run:${runId}`, ...(cursor ? { cursor } : {}) }));
        assertGate(Array.isArray(page.entries), "list_result_invalid");
        for (const item of page.entries) {
          assertGate(item.entry_id && !seenEntries.has(item.entry_id), "pagination_duplicate");
          seenEntries.add(item.entry_id);
          assertGate(item.visibility === "public" || item.owner?.id === ownerIds[owner], "cross_owner_private_leak");
        }
        cursor = page.next_cursor;
      } while (cursor);
      const expected = [...records.values()].filter(r => r.id && (r.owner === owner || r.spec.visibility === "public"));
      assertGate(expected.every(r => seenEntries.has(r.id)), "browse_lost_acknowledged_write");
    }

    const query = "What does the amber lighthouse archive say about navigation decisions and safe harbor instructions?";
    const recallArgs = { query, topK: 5, include_insight: false };
    const fixturesById = new Map([...records.values()].filter(record => record.id).map(record => [record.id, record]));
    let prepared = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      const probe = required(await clients[0].tool("recall", recallArgs));
      const error = validateRecallFixtures(probe, ownerIds[0], fixturesById);
      assertGate(!error || error === "semantic_matches_missing", error);

      if (probe.matches?.some(m => m.entry?.owner?.id === ownerIds[0] && m.citations?.length)) { prepared = true; break; }
      await delay(1500);
    }
    assertGate(prepared, "semantic_fixture_not_indexed");
    for (const mode of ["raw", "generated"]) {
      const request = async i => {
        const owner = i % 4;
        if (mode === "generated") return clients[owner].chat(query);
        const result = await clients[owner].tool("recall", recallArgs);
        if (result.ok) {
          const error = validateRecallFixtures(result.value, ownerIds[owner], fixturesById);
          if (error) return { ...result, ok: false, error };
        }
        return result;
      };
      const warmup = await parallel(LOAD_GATES.latencyWarmups, 4, request);
      const measured = await parallel(LOAD_GATES.latencySamples, 4, request);
      const metrics = summarizeTimings(measured);
      recordScenario({ kind: "latency", mode, workload: mode === "raw" ? "default_recall" : "grounded_chat", warmup: summarizeTimings(warmup), measured: metrics });
      assertGate(warmup.concat(measured).every(r => r.ok), `${mode}_latency_request_failed`);
      assertGate(metrics.p95_ms <= (mode === "raw" ? LOAD_GATES.rawP95Ms : LOAD_GATES.generatedP95Ms), `${mode}_p95_exceeded`);
    }
    report.authoritative = await authoritativeCheck(records.values());
    const total = await sql("SELECT COUNT(*) AS count FROM entries WHERE source = ?", [source]);
    assertGate(total[0]?.count === [...records.values()].filter(r => r.id).length, "unacknowledged_or_duplicate_rows");
    await readVerifiedStage({ env, fetchImpl });
  } catch (error) { primaryError = safeCode(error.message); }
  finally {
    // Only accepted IDs, or receipts matching this run's pre-recorded retry
    // hashes and actors, may enter cleanup. Never delete a tag/source query.
    try {
      await readVerifiedStage({ env, fetchImpl });
      const cleanupRecords = [...records.values()];
      const cleanupResults = await parallel(cleanupRecords.length, 4, async index => {
        const record = cleanupRecords[index];
        if (!record.id) {
          const rows = await sql("SELECT entry_id, episode_id FROM capture_receipts WHERE actor_kind = 'human' AND actor_id = ? AND key_hash = ? AND state = 'committed'", [record.owner_id, record.key_hash]);
          if (rows.length === 1) {
            record.id = rows[0].entry_id; record.episode_id = rows[0].episode_id;
            journal({ type: "reconciled", label: record.label, owner: record.owner, id: record.id, key_hash: record.key_hash });
          }
        }
        if (!record.id) return;
        const result = await clients[record.owner].rest("/forget", { id: record.id, confirm_entry_id: record.id }, "forget");
        if (!result.ok || result.value.ok !== true || !result.value.operation_id) {
          report.cleanup.failed++; journal({ type: "cleanup_failed", id: record.id }); return;
        }
        const receipt = await clients[record.owner].rest(`/erasure-status?operation_id=${encodeURIComponent(result.value.operation_id)}`);
        const status = receipt.ok ? receipt.value.erasure?.status : null;
        if (status === "complete") report.cleanup.complete++;
        else if (status === "pending_cleanup") report.cleanup.pending++;
        else report.cleanup.failed++;
        journal({ type: "erasure", id: record.id, operation_id: result.value.operation_id, status: status || "unknown" });
        const rows = await sql("SELECT c.state, e.id AS surviving_entry FROM capture_receipts c LEFT JOIN entries e ON e.id = c.entry_id WHERE c.actor_kind = 'human' AND c.actor_id = ? AND c.key_hash = ?", [record.owner_id, record.key_hash]);
        if (rows.length !== 1 || rows[0].state !== "erased" || rows[0].surviving_entry != null) report.cleanup.failed++;
      });
      for (const [index, result] of cleanupResults.entries()) {
        if (result?.ok === false) {
          report.cleanup.failed++;
          journal({ type: "cleanup_failed", id: cleanupRecords[index].id ?? null, error: result.error });
        }
      }
    } catch (error) { report.cleanup.failed++; report.cleanup.error = safeCode(error.message); }
    closeSync(fd);
    report.completed_at = new Date().toISOString();
    report.error = primaryError || (report.cleanup.failed || report.cleanup.pending ? "cleanup_incomplete" : null);
    report.ok = !report.error;
    writePrivateJson(reportPath, report);
  }
  console.log(JSON.stringify({ ok: report.ok, report: reportPath, cleanup_manifest: cleanupPath,
    error: report.error, cleanup: report.cleanup }));
  assertGate(report.ok, report.error);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await runLoad(); }
  catch (error) { console.error(`STAGING_LOAD_FAILED: ${safeCode(error.message)}`); process.exitCode = 1; }
}
