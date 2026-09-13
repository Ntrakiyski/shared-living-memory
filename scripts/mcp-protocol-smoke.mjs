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

const SLM_URL = process.env.SLM_URL?.replace(/\/$/, "");
const SLM_USER_KEY = process.env.SLM_USER_KEY;
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

if (!SLM_URL || !SLM_USER_KEY) {
  console.error("SLM_URL and SLM_USER_KEY env vars are required.");
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

const headers = {
  "Content-Type": "application/json",
  Authorization: `Bearer ${SLM_USER_KEY}`,
};

const id = () => `smoke-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// --- MCP transport helpers -------------------------------------------------

async function mcp(method, params) {
  const res = await fetch(`${SLM_URL}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: id(), method, params }),
  });
  const data = await res.json();
  if (data.error) throw new Error(`${method} failed: ${JSON.stringify(data.error)}`);
  return data.result;
}

async function toolCall(toolName, args) {
  const result = await mcp("tools/call", { name: toolName, arguments: args });
  const text = result.content?.map((c) => c.text).join("\n") || JSON.stringify(result);
  return { text, result };
}

// --- Steps -----------------------------------------------------------------

let entryId;
let recallId;
let failed = false;

async function step(label, fn) {
  try {
    process.stdout.write(`  ${label}... `);
    await fn();
    console.log("OK");
  } catch (e) {
    console.log(`FAIL: ${e.message}`);
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
    const structured = result?.structuredContent;
    if (structured?.principal && structured?.deployment) return;
    // Fall back to the readable text for compatibility.
    const text = result?.content?.map((c) => c.text).join("\n") || "";
    if (!text.includes("principal")) throw new Error("whoami response missing principal identity");
  });

  if (DISCOVERY_ONLY) {
    console.log();
    console.log(failed ? "DISCOVERY FAILED — one or more steps did not pass." : "MCP discovery (whoami + tools/list) passed.");
    process.exit(failed ? 1 : 0);
  }

  await step("remember (private)", async () => {
    const { result } = await toolCall("remember", {
      content: `Smoke-test entry created at ${new Date().toISOString()}. This is temporary.`,
      tags: ["smoke-test", "private", "temporary"],
      source: "mcp-protocol-smoke",
      visibility: "private",
    });
    const structured = result?.structuredContent;
    if (structured?.data?.entry?.entry_id) {
      entryId = structured.data.entry.entry_id;
    }
    if (!entryId) {
      const lines = result.content?.[0]?.text?.split("\n") || [];
      entryId = lines.find((l) => l.startsWith("ID: "))?.slice(4)?.trim();
    }
    if (!entryId) throw new Error("Could not extract entry ID from remember response");
  });

  await step("recall", async () => {
    const { result } = await toolCall("recall", { query: "smoke-test temporary" });
    const structured = result?.structuredContent;
    if (structured?.data?.matches?.some((m) => m.entry?.entry_id === entryId)) {
      recallId = entryId;
    }
    if (!recallId) {
      const text = result.content?.map((c) => c.text).join("\n") || "";
      if (text.includes(entryId)) {
        recallId = text.match(/ID:\s*(\S+)/)?.[1];
      }
    }
    if (!recallId) throw new Error("Smoke entry not found in recall results");
  });

  await step("forget (confirm_entry_id)", async () => {
    const { result } = await toolCall("forget", { id: entryId, confirm_entry_id: entryId });
    const text = result.content?.[0]?.text || "";
    if (!text.includes("deleted") && !text.includes("pending_cleanup")) {
      throw new Error(`Unexpected forget response: ${text.slice(0, 100)}`);
    }
  });

  console.log();
  if (failed) {
    console.log("SMOKE FAILED — one or more steps did not pass.");
    process.exit(1);
  }
  console.log("MCP protocol smoke passed.");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
