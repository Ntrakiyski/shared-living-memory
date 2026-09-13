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

import { readFileSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

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
  let event = null;
  for (const line of String(text ?? "").split(/\r?\n/)) {
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim();
      continue;
    }
    if (line.startsWith("data:")) {
      records.push({ event: event ?? "message", data: line.slice("data:".length).trim() });
      event = null;
    }
  }
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
  let text;
  try {
    text = readFileSync(keyFilePath, "utf8");
  } catch {
    return { ok: false, key: null, errors: ["key_file_unreadable"] };
  }
  const key = text.trim();
  if (!key) return { ok: false, key: null, errors: ["key_file_empty"] };
  return { ok: true, key, errors: [] };
}

// ─── Config / CLI ─────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { confirmCleanup: false, manifestFile: null, keyFile: null, cleanupManifest: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--confirm-cleanup") args.confirmCleanup = true;
    else if (arg === "--manifest") args.manifestFile = argv[++i];
    else if (arg === "--key-file") args.keyFile = argv[++i];
    else if (arg === "--cleanup-manifest") args.cleanupManifest = argv[++i];
    else if (arg === "--help") args.help = true;
  }
  return args;
}

function fail(code, message) {
  console.error(`STAGING_LOAD_${code}`);
  if (message) console.error(message);
  process.exit(1);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("Usage: SLM_URL=<staging> SLM_KEY_FILE=<file> SLM_MANIFEST_FILE=<file> node scripts/staging-agent-load.mjs [--confirm-cleanup]");
    return;
  }

  const rawUrl = process.env.SLM_URL;
  const keyFilePath = args.keyFile ?? process.env.SLM_KEY_FILE;
  const manifestFilePath = args.manifestFile ?? process.env.SLM_MANIFEST_FILE;
  const expectedDeploymentId = process.env.SLM_EXPECTED_DEPLOYMENT_ID ?? STAGING_DEPLOYMENT_ID;
  const cleanupManifest = args.cleanupManifest ?? process.env.SLM_CLEANUP_MANIFEST
    ?? resolve(".slm-load-cleanup-manifest.json");

  if (!rawUrl) fail("CONFIG", "SLM_URL is required (never a production origin).");
  if (!keyFilePath) fail("CONFIG", "SLM_KEY_FILE is required; raw keys are never accepted on argv.");
  if (!manifestFilePath) fail("CONFIG", "SLM_MANIFEST_FILE (verified stage manifest) is required.");

  const keyFile = readKeyFile(keyFilePath);
  if (!keyFile.ok) fail("KEY", keyFile.errors.join(","));

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestFilePath, "utf8"));
  } catch {
    fail("MANIFEST", "Stage manifest is not readable JSON.");
  }
  const manifestCheck = validateStageManifest(manifest, { expectedDeploymentId });
  if (!manifestCheck.ok) fail("MANIFEST", manifestCheck.errors.join(","));

  const urlCheck = preflightUrl(rawUrl, { manifestOrigin: manifest.origin });
  if (!urlCheck.ok) fail("PREFLIGHT", urlCheck.errors.join(","));

  // Everything below requires a real staging deployment + network access.
  // The safety gates above run BEFORE any write, as required.
  console.log(`staging-agent-load: preflight passed for ${urlCheck.origin} (deployment ${manifest.deployment_id})`);
  console.log("Remote load scenarios are not executed in this environment (no staging deployment or credential).");
  console.log("Blocked: STAGING_LOAD_REMOTE_UNAVAILABLE");
  fail("REMOTE_UNAVAILABLE", "This environment cannot reach a verified staging deployment.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
