#!/usr/bin/env node
/**
 * Remote MCP protocol smoke test (read-only discovery + full staging lifecycle).
 *
 * Discovery mode (--discovery-only): initialize → whoami → tools/list. This is
 * the authenticated, read-only production canary and is the ONLY mode permitted
 * against a production origin.
 *
 * Full mode (default): initialize → tools/list → whoami → private remember →
 * recall → permanent forget. This writes and deletes, so it refuses production
 * and requires a staging URL.
 *
 * Authenticates a dedicated monitoring principal via a personal API key
 * (SLM_USER_KEY, injected from a secret — never argv). Never prints the key.
 *
 * Usage:
 *   SLM_URL=https://staging.example.test SLM_USER_KEY=<key> node scripts/mcp-protocol-smoke.mjs
 *   SLM_URL=https://prod... SLM_USER_KEY=<key> node scripts/mcp-protocol-smoke.mjs --discovery-only
 */

import { readFileSync } from "node:fs";

const SLM_URL = process.env.SLM_URL?.replace(/\/$/, "");
const SLM_USER_KEY = process.env.SLM_KEY_FILE
  ? readFileSync(process.env.SLM_KEY_FILE, "utf8").trim()
  : process.env.SLM_USER_KEY;
const EXPECTED_DEPLOYMENT_ID = process.env.SLM_EXPECTED_DEPLOYMENT_ID;
const DISCOVERY_ONLY = process.argv.includes("--discovery-only")
  || /^(1|true)$/i.test(process.env.MCP_DISCOVERY_ONLY ?? "");

const PRODUCTION_ORIGINS = [
  "https://shared-living-memory.nikolay-trakiyski.workers.dev",
  "https://memory.fractals-solutions.com",
];

function originOf(raw) {
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

function isProduction(raw) {
  const origin = originOf(raw);
  if (!origin) return false;
  const configured = process.env.SLM_PRODUCTION_URL;
  const configuredOrigin = configured ? originOf(configured) : null;
  const denylist = new Set([...PRODUCTION_ORIGINS, ...(configuredOrigin ? [configuredOrigin] : [])]);
  return denylist.has(origin);
}

if (!SLM_URL || !SLM_USER_KEY || !EXPECTED_DEPLOYMENT_ID) {
  console.error("SLM_URL, a protected key file or secret environment key, and SLM_EXPECTED_DEPLOYMENT_ID are required.");
  process.exit(1);
}

if (!/^slm_/.test(SLM_USER_KEY)) {
  console.error("SLM_USER_KEY must be a personal API key starting with slm_.");
  process.exit(2);
}

if (isProduction(SLM_URL) && !DISCOVERY_ONLY) {
  console.error("This script refuses the production hostname for the full (write) lifecycle. Provide a staging URL or run --discovery-only.");
  process.exit(3);
}

const destination = new URL(SLM_URL);
if (destination.username || destination.password || destination.search || destination.hash
    || (destination.protocol !== "https:" && !(destination.protocol === "http:"
      && ["127.0.0.1", "localhost", "[::1]"].includes(destination.hostname)))) {
  console.error("A credential-free HTTPS destination is required (HTTP is local-only).");
  process.exit(2);
}

const headers = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
  Authorization: `Bearer ${SLM_USER_KEY}`,
};

const id = () => `smoke-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// --- MCP transport helpers -------------------------------------------------

async function readRpcResponse(response, requestId) {
  if (!response.headers.get("Content-Type")?.includes("text/event-stream")) {
    return response.json();
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) throw new Error("MCP stream ended without its response");
      bytes += value.byteLength;
      if (bytes > 1_048_576) throw new Error("MCP response exceeded the smoke budget");
      pending += decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = /\r?\n\r?\n/.exec(pending))) {
        const event = pending.slice(0, boundary.index);
        pending = pending.slice(boundary.index + boundary[0].length);
        const data = event.split(/\r?\n/).filter(line => line.startsWith("data:"))
          .map(line => line.slice(5).replace(/^ /, "")).join("\n");
        if (!data) continue;
        const message = JSON.parse(data);
        if (message.id === requestId) return message;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

async function mcp(method, params) {
  const requestId = id();
  const res = await fetch(`${SLM_URL}/mcp`, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }),
  });
  if (!res.ok) throw new Error("MCP transport failed");
  const data = await readRpcResponse(res, requestId);
  if (data.jsonrpc !== "2.0" || data.id !== requestId || data.error || !data.result) {
    throw new Error("MCP protocol failed");
  }
  return data.result;
}

async function toolCall(toolName, args) {
  const result = await mcp("tools/call", { name: toolName, arguments: args });
  if (result.isError === true || result.structuredContent?.ok === false) {
    throw new Error("MCP tool failed");
  }
  const text = result.content?.map((c) => c.text).join("\n") || "";
  return { text, result };
}

// --- Steps -----------------------------------------------------------------

let entryId;
let principalId;
let captureArgs;
let failed = false;

async function step(label, fn) {
  try {
    process.stdout.write(`  ${label}... `);
    await fn();
    console.log("OK");
  } catch (e) {
    // Provider errors may contain memory bodies or credentials. Log only the stage.
    console.log("FAIL");
    failed = true;
  }
}

(async () => {
  console.log(`MCP protocol smoke — ${SLM_URL}${DISCOVERY_ONLY ? " (discovery-only)" : ""}`);
  console.log();

  await step("initialize", async () => {
    const info = await mcp("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "smoke-test", version: "1.0.0" },
    });
    if (!info.serverInfo) throw new Error("No serverInfo in initialize response");
  });

  await step("tools/list", async () => {
    const { tools } = await mcp("tools/list", {});
    const names = tools.map((t) => t.name);
    if (!names.includes("remember")) throw new Error("remember tool missing");
    if (!names.includes("recall")) throw new Error("recall tool missing");
    if (!names.includes("forget")) throw new Error("forget tool missing");
    if (!names.includes("whoami")) throw new Error("whoami tool missing");
    console.log(`(${tools.length} tools)`);
  });

  await step("whoami", async () => {
    const { result } = await toolCall("whoami", {});
    const envelope = result?.structuredContent;
    const identity = envelope?.data;
    if (envelope?.ok !== true || !identity?.principal?.id || !identity.principal.name
      || !["human", "service"].includes(identity.principal.kind)
      || identity.deployment?.id !== EXPECTED_DEPLOYMENT_ID
      || identity.deployment?.canonical_url?.replace(/\/$/, "") !== SLM_URL
      || typeof identity.deployment?.release_id !== "string" || !identity.deployment.release_id) {
      throw new Error("whoami did not verify the expected identity and deployment");
    }
    principalId = identity.principal.id;
    if (!DISCOVERY_ONLY && identity.deployment.environment !== "staging") {
      throw new Error("Full lifecycle requires verified staging");
    }
  });

  if (DISCOVERY_ONLY) {
    console.log();
    console.log(failed ? "DISCOVERY FAILED — one or more steps did not pass." : "MCP discovery (whoami + tools/list) passed.");
    process.exit(failed ? 1 : 0);
  }

  if (failed) process.exit(1);

  // Identity and a hostname alone cannot prove storage isolation. Re-read
  // authenticated control-plane bindings before any staging write.
  const { readVerifiedStage, cloudflareClient } = await import("./check-staging-bindings.mjs");
  const stage = await readVerifiedStage({ env: process.env });
  const cf = cloudflareClient(process.env);

  await step("remember (private)", async () => {
    captureArgs = {
      content: `Smoke-test entry ${id()} created at ${new Date().toISOString()}. This is temporary.`,
      idempotency_key: id(),
      tags: ["smoke-test", "private", "temporary"],
      source: "mcp-protocol-smoke",
      visibility: "private",
    };
    const { result } = await toolCall("remember", captureArgs);
    const envelope = result?.structuredContent;
    const capture = envelope?.data;
    if (capture?.outcome === "created" && typeof capture.receipt?.entry_id === "string") {
      entryId = capture.receipt.entry_id;
    }
    if (envelope?.ok !== true || capture?.outcome !== "created"
        || !capture.entry?.entry_id || capture.receipt?.entry_id !== capture.entry.entry_id) {
      throw new Error("Capture did not return a new attributable entry and receipt");
    }
    entryId = capture.entry.entry_id;
  });

  if (!entryId) process.exit(1);

  await step("recall", async () => {
    for (let attempt = 0; attempt < 8; attempt++) {
      const { result } = await toolCall("recall", { query: captureArgs.content, include_insight: false });
      const envelope = result?.structuredContent;
      if (envelope?.ok !== true || envelope.data?.semantic_available !== true) {
        throw new Error("Semantic recall unavailable");
      }
      if (envelope.data.matches?.some((match) => match.entry?.entry_id === entryId)) return;
      if (attempt < 7) await new Promise(resolve => setTimeout(resolve, 1500));
    }
    throw new Error("Smoke entry not found through semantic recall");
  });

  await step("forget (confirmed entry, receipt and erased retry)", async () => {
    await toolCall("forget", { id: entryId, confirm_entry_id: entryId });
    const databaseId = stage.bindings.d1_databases.find(binding => binding.binding === "DB").database_id;
    const result = await cf(`/d1/database/${databaseId}/query`, {
      sql: `SELECT er.operation_id, er.status,
        (SELECT COUNT(*) FROM entries WHERE id = ?) AS surviving_entries,
        (SELECT COUNT(*) FROM capture_receipts WHERE entry_id = ? AND state = 'erased') AS tombstones
        FROM erasure_receipts er WHERE er.entry_id = ? AND er.owner_user_id = ?`,
      params: [entryId, entryId, entryId, principalId],
    });
    const row = result[0]?.results?.[0];
    if (result[0]?.success !== true || !row?.operation_id || row.status !== "complete"
      || row.surviving_entries !== 0 || row.tombstones !== 1) {
      throw new Error("Erasure completion could not be verified; do not retry deletion");
    }
    const retry = await mcp("tools/call", { name: "remember", arguments: captureArgs });
    if (retry.isError !== true || retry.structuredContent?.error?.code !== "capture_erased") {
      throw new Error("Erased capture replay must remain erased");
    }
  });

  console.log();
  if (failed) {
    console.log("SMOKE FAILED — one or more steps did not pass.");
    process.exit(1);
  }
  console.log("MCP protocol smoke passed.");
})().catch((e) => {
  console.error("MCP smoke failed unexpectedly; no response body logged.");
  process.exit(1);
});
