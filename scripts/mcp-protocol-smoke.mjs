#!/usr/bin/env node
/**
 * Remote-staging MCP protocol smoke test.
 *
 * Requires a staging-only user/key via env vars. Refuses production hostnames.
 * Tests: initialize → tools/list → private remember → recall → permanent forget.
 * Never invokes Workers AI or Vectorize directly — proves HTTP/auth/D1 contracts.
 *
 * Usage:
 *   SLM_URL=https://staging.example.test SLM_USER_KEY=slm_xxx.yyy node scripts/mcp-protocol-smoke.mjs
 */

const SLM_URL = process.env.SLM_URL?.replace(/\/$/, "");
const SLM_USER_KEY = process.env.SLM_USER_KEY;

if (!SLM_URL || !SLM_USER_KEY) {
  console.error("SLM_URL and SLM_USER_KEY env vars are required.");
  process.exit(1);
}

if (!/^slm_/.test(SLM_USER_KEY)) {
  console.error("SLM_USER_KEY must be a personal API key starting with slm_.");
  process.exit(2);
}

if (/shared-living-memory\.nikolay-trakiyski\.workers\.dev/i.test(SLM_URL)) {
  console.error("This script refuses the production hostname. Provide a staging URL.");
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
  console.log(`MCP protocol smoke — ${SLM_URL}`);
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
    console.log(`(${tools.length} tools)`);
  });

  await step("remember (private)", async () => {
    const { result } = await toolCall("remember", {
      content: `Smoke-test entry created at ${new Date().toISOString()}. This is temporary.`,
      tags: ["smoke-test", "private", "temporary"],
      source: "mcp-protocol-smoke",
      visibility: "private",
    });
    const lines = result.content?.[0]?.text?.split("\n") || [];
    entryId = lines.find((l) => l.startsWith("ID: "))?.slice(4)?.trim();
    if (!entryId) throw new Error("Could not extract entry ID from remember response");
  });

  await step("recall", async () => {
    const { result } = await toolCall("recall", { query: "smoke-test temporary" });
    const text = result.content?.map((c) => c.text).join("\n") || "";
    if (text.includes(entryId)) {
      recallId = text.match(/ID:\s*(\S+)/)?.[1];
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
