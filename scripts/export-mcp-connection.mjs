#!/usr/bin/env node
/**
 * export-mcp-connection.mjs — Canonical MCP client configuration exporter for
 * Shared Living Memory (release 1.1, work package WP8 / Section 6.2).
 *
 * Writes a standard `mcpServers` configuration plus non-secret SLM metadata
 * identifying `username`, `principal_id`, `deployment_id` and the canonical URL.
 * The API key travels ONLY inside the emitted `Authorization: Bearer <key>`
 * header: it is never accepted as a command-line argument, never logged, and
 * never echoed to stdout.
 *
 * Usage:
 *   node scripts/export-mcp-connection.mjs \
 *     --url https://shared-living-memory.example.dev \
 *     --profile capture \
 *     --out ~/.config/shared-living-memory/mcp.json \
 *     --key-file ~/.secrets/slm-key
 *
 *   # or pipe the key on stdin (never both):
 *   printf '%s' "$SLM_KEY" | node scripts/export-mcp-connection.mjs \
 *     --url https://shared-living-memory.example.dev --out ~/mcp.json
 *
 * Local plain-HTTP dev server (localhost only, requires --local):
 *   node scripts/export-mcp-connection.mjs \
 *     --url http://localhost:8787 --local --out ./mcp.json --key-file ./dev.key
 */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const PROFILES = ["capture", "review", "full"];
const SERVER_NAME = "shared-living-memory";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

// ─── CLI parsing ──────────────────────────────────────────────────────────────

/**
 * Parse the connection exporter's argv. Returns { url, profile, out, keyFile,
 * local }. Throws an Error with a clear message on any invalid input — including
 * any attempt to smuggle the API key through a positional argument or `--key`.
 */
export function parseArgs(argv) {
  const args = { url: null, profile: "full", out: null, keyFile: null, local: false };
  const seen = new Set();

  let i = 0;
  while (i < argv.length) {
    const token = argv[i];

    if (token === "--url" || token === "--profile" || token === "--out" || token === "--key-file") {
      if (seen.has(token)) throw new Error(`Duplicate flag: ${token}`);
      const value = argv[i + 1];
      if (value === undefined || value === "" || value.startsWith("--")) {
        throw new Error(`Missing value for ${token}`);
      }
      seen.add(token);
      if (token === "--url") args.url = value;
      else if (token === "--profile") args.profile = value;
      else if (token === "--out") args.out = value;
      else args.keyFile = value;
      i += 2;
      continue;
    }

    if (token === "--local") {
      if (seen.has(token)) throw new Error(`Duplicate flag: ${token}`);
      seen.add(token);
      args.local = true;
      i += 1;
      continue;
    }

    if (token === "--key" || token === "-k" || token.startsWith("--key=")) {
      throw new Error(
        "Refusing to accept the API key as a command-line argument. " +
        "Provide it via --key-file <path> or pipe it on stdin.",
      );
    }

    if (token.startsWith("--")) {
      throw new Error(`Unknown flag: ${token}`);
    }

    // The script takes no positional arguments. A bare token here is the classic
    // way a key would leak onto the command line, so reject it explicitly.
    throw new Error(
      `Unexpected argument "${token}". The API key must come from --key-file <path> or stdin, never argv.`,
    );
  }

  if (!args.url) throw new Error("Missing required flag: --url");
  if (!args.out) throw new Error("Missing required flag: --out");
  if (!PROFILES.includes(args.profile)) {
    throw new Error(`Invalid --profile "${args.profile}". Expected one of: capture, review, full.`);
  }
  return args;
}

// ─── URL normalization ────────────────────────────────────────────────────────

/**
 * Validate and normalize a base URL. Returns the base URL with no trailing
 * slash and no `/mcp` appended (use buildMcpUrl for that). Rules from Section
 * 6.2: absolute HTTPS, no userinfo/query/fragment, plain HTTP only for literal
 * localhost hosts and only when allowLocalHttp is set.
 */
export function normalizeBaseUrl(input, { allowLocalHttp = false } = {}) {
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error(`Invalid --url "${input}": must be an absolute URL.`);
  }

  if (url.username !== "" || url.password !== "") {
    throw new Error("Invalid --url: userinfo (username/password) is not allowed.");
  }
  if (url.search !== "") {
    throw new Error("Invalid --url: query strings are not allowed.");
  }
  if (url.hash !== "") {
    throw new Error("Invalid --url: fragments are not allowed.");
  }

  if (url.protocol === "http:") {
    const rawHost = url.hostname; // IPv6 literals arrive as "[::1]"
    const host = rawHost.startsWith("[") && rawHost.endsWith("]")
      ? rawHost.slice(1, -1)
      : rawHost;
    if (!allowLocalHttp) {
      throw new Error(
        `Invalid --url: plain HTTP requires the --local flag and a localhost host (got ${input}).`,
      );
    }
    if (!LOCAL_HOSTS.has(host)) {
      throw new Error(
        `Invalid --url: plain HTTP is only allowed for localhost/127.0.0.1/::1 with --local (got ${input}).`,
      );
    }
  } else if (url.protocol !== "https:") {
    throw new Error(`Invalid --url: only https:// is supported (got ${input}).`);
  }

  // Trim trailing slash(es), preserving any verified base-path prefix. url.origin
  // excludes path/userinfo/query/fragment, so it is safe to concatenate onto.
  const basePath = url.pathname.replace(/\/+$/, "");
  return url.origin + basePath;
}

/**
 * Append `/mcp` exactly once to a normalized base URL. A base URL that already
 * ends in `/mcp` (e.g. `https://host/base/mcp`) is returned unchanged rather
 * than becoming `/mcp/mcp`.
 */
export function buildMcpUrl(baseUrl) {
  if (baseUrl.endsWith("/mcp")) return baseUrl;
  return baseUrl + "/mcp";
}

// ─── Secret resolution ────────────────────────────────────────────────────────

async function readKeyFile(filePath) {
  let raw;
  try {
    raw = await fs.promises.readFile(filePath, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") {
      throw new Error(`Key file not found: ${filePath}`);
    }
    throw new Error(`Could not read key file ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return raw.trim();
}

/**
 * Resolve the API key from exactly one of --key-file or stdin. `stdinText` is
 * the full stdin content (null/undefined when no secret was piped). Rejects when
 * both sources carry a secret, and when neither does.
 */
export async function loadSecret({ keyFile, stdinText }) {
  const hasStdin = typeof stdinText === "string" && stdinText.trim() !== "";
  if (keyFile && hasStdin) {
    throw new Error("Provide the API key via EITHER --key-file or stdin, not both.");
  }
  if (keyFile) {
    const value = await readKeyFile(keyFile);
    if (!value) throw new Error(`Key file ${keyFile} is empty.`);
    return value;
  }
  if (hasStdin) {
    return stdinText.trim();
  }
  throw new Error("No API key provided. Use --key-file <path> or pipe the key on stdin.");
}

// ─── whoami verification ──────────────────────────────────────────────────────

/**
 * Call GET <base>/api/whoami with the Bearer key and verify the returned
 * identity. Redirects are never followed (redirect: "manual"), so a 3xx is a
 * hard failure before any Authorization header could be replayed cross-origin.
 * Returns the whoami `data` object.
 *
 * @param {string} baseUrl
 * @param {string} key
 * @param {any} [fetchImpl]
 * @returns {Promise<any>}
 */
export async function verifyWhoami(baseUrl, key, fetchImpl = globalThis.fetch) {
  const whoamiUrl = `${baseUrl}/api/whoami`;

  let res;
  try {
    res = await fetchImpl(whoamiUrl, {
      method: "GET",
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      redirect: "manual",
    });
  } catch (err) {
    throw new Error(`whoami request failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (res.status >= 300 && res.status < 400) {
    throw new Error(`Refusing to follow redirect from /api/whoami (HTTP ${res.status}).`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error("Authentication failed: the deployment rejected the API key at /api/whoami.");
  }
  if (!res.ok) {
    throw new Error(`/api/whoami is unavailable (HTTP ${res.status}).`);
  }

  let body;
  try {
    body = await res.json();
  } catch {
    throw new Error("Invalid /api/whoami response: expected JSON.");
  }

  if (body && typeof body === "object" && body.ok === false) {
    throw new Error("Authentication failed: /api/whoami reported an unsuccessful identity.");
  }

  // whoami uses the shared result envelope { ok, data, request_id, warnings }.
  // Accept either the enveloped shape or a bare data object.
  const data = body && typeof body === "object" && body.data && typeof body.data === "object"
    ? body.data
    : body;

  const principal = data && typeof data === "object" ? data.principal : null;
  const deployment = data && typeof data === "object" ? data.deployment : null;
  if (!principal || typeof principal !== "object" || !principal.id || !principal.name) {
    throw new Error("Invalid /api/whoami response: missing verified principal identity.");
  }
  if (!deployment || typeof deployment !== "object" || !deployment.id) {
    throw new Error("Invalid /api/whoami response: missing deployment identity.");
  }

  return data;
}

// ─── Connection file construction ─────────────────────────────────────────────

/**
 * Build the connection file object from the normalized base URL, key, profile
 * and verified whoami data. Reduced profiles persist `X-SLM-Tool-Profile`; the
 * default `full` profile omits it. The key appears only inside the MCP server
 * entry's Authorization header.
 */
export function buildConnectionFile(baseUrl, key, profile, whoamiData) {
  const principal = whoamiData.principal;
  const deployment = whoamiData.deployment;

  /** @type {Record<string, string>} */
  const headers = { Authorization: `Bearer ${key}` };
  if (profile !== "full") {
    headers["X-SLM-Tool-Profile"] = profile;
  }

  return {
    mcpServers: {
      [SERVER_NAME]: {
        url: buildMcpUrl(baseUrl),
        headers,
      },
    },
    sharedLivingMemory: {
      username: principal.name,
      principal_id: principal.id,
      deployment_id: deployment.id,
      canonical_url: deployment.canonical_url ?? baseUrl,
    },
  };
}

// ─── Safe output ──────────────────────────────────────────────────────────────

/**
 * Write the config to outPath with exclusive create, mode 0600. Creates the
 * parent directory with mode 0700 only when it is newly made; an existing
 * directory is never chmodded. Symlinks and existing files are rejected, and on
 * POSIX the resulting mode must be 0600 or the write is rolled back and fails.
 */
export function writeConnectionFile(outPath, config) {
  const resolved = path.resolve(outPath);
  const parent = path.dirname(resolved);

  if (!fs.existsSync(parent)) {
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  }
  // An existing parent directory is deliberately left untouched.

  // Reject a symlink or an existing target before opening.
  let existing = null;
  try {
    existing = fs.lstatSync(resolved);
  } catch (err) {
    if (!err || err.code !== "ENOENT") throw err;
  }
  if (existing) {
    if (existing.isSymbolicLink()) {
      throw new Error(`Refusing to write ${outPath}: it is a symbolic link.`);
    }
    throw new Error(`Refusing to overwrite existing file: ${outPath}`);
  }

  let fd;
  try {
    fd = fs.openSync(resolved, "wx", 0o600);
  } catch (err) {
    if (err && err.code === "EEXIST") {
      throw new Error(`Refusing to overwrite existing file: ${outPath}`);
    }
    throw err;
  }

  try {
    fs.writeFileSync(fd, JSON.stringify(config, null, 2) + "\n", "utf8");
  } finally {
    fs.closeSync(fd);
  }

  // On POSIX verify the resulting mode is exactly 0600; roll back on mismatch.
  if (process.platform !== "win32") {
    const mode = fs.statSync(resolved).mode & 0o777;
    if (mode !== 0o600) {
      try { fs.unlinkSync(resolved); } catch { /* best-effort rollback */ }
      throw new Error(`Output file mode is ${mode.toString(8)} (expected 600).`);
    }
  }

  return resolved;
}

// ─── Reporting and entrypoint ─────────────────────────────────────────────────

export function summarizeIdentity(whoamiData, profile) {
  const principal = whoamiData.principal;
  const deployment = whoamiData.deployment;
  const canonical = deployment.canonical_url ? ` (${deployment.canonical_url})` : "";
  return `principal ${principal.name} (principal_id=${principal.id}), deployment ${deployment.id}${canonical}, profile ${profile}`;
}

async function readStdinIfPiped() {
  if (process.stdin.isTTY) return null;
  let data = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

/**
 * Orchestrates the export. `opts` exists for testability: `fetchImpl`, injected
 * `stdinText`, and `stdout`/`stderr` writers. Returns { ok, path, identity } or
 * { ok: false, error } — it never calls process.exit and never prints the key.
 */
export async function main(argv = process.argv.slice(2), opts = {}) {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const out = opts.stdout ?? process.stdout;
  const errOut = opts.stderr ?? process.stderr;

  try {
    const args = parseArgs(argv);
    const stdinText = opts.stdinText !== undefined ? opts.stdinText : await readStdinIfPiped();
    const key = await loadSecret({ keyFile: args.keyFile, stdinText });
    const baseUrl = normalizeBaseUrl(args.url, { allowLocalHttp: args.local });
    const whoamiData = await verifyWhoami(baseUrl, key, fetchImpl);
    const config = buildConnectionFile(baseUrl, key, args.profile, whoamiData);
    const outPath = writeConnectionFile(args.out, config);
    const identity = summarizeIdentity(whoamiData, args.profile);

    out.write(`Wrote connection file: ${outPath}\n`);
    out.write(`Verified identity: ${identity}\n`);
    return { ok: true, path: outPath, identity };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    errOut.write(`Error: ${message}\n`);
    return { ok: false, error: message };
  }
}

// Run only when executed directly (not when imported by the test suite).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await main();
  process.exitCode = result.ok ? 0 : 1;
}
