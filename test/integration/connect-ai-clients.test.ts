/**
 * connect-ai-clients.test.ts
 *
 * Section 6.2: the client setup script must lead with the personal API key,
 * label the OAuth flow as legacy, accept the key only from a protected file or
 * stdin (never an argument), and keep exactly one `/mcp` suffix.
 *
 * Exercised by running the real script through bash. Only the paths that do not
 * touch the network or the user's dotfiles are used.
 */

import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const SCRIPT = join(process.cwd(), "scripts", "connect-ai-clients.sh");
const SENTINEL_KEY = "slm_syntheticprincipal.synthetic-secret-value";

interface Run {
  status: number;
  stdout: string;
  stderr: string;
}

function run(args: string[], input?: string): Run {
  try {
    const stdout = execFileSync("bash", [SCRIPT, ...args], {
      encoding: "utf8",
      input: input ?? "",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return {
      status: failure.status ?? 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    };
  }
}

const tempDirs: string[] = [];
function tempFile(name: string, contents: string, mode?: number): string {
  const dir = mkdtempSync(join(tmpdir(), "slm-connect-"));
  tempDirs.push(dir);
  const path = join(dir, name);
  writeFileSync(path, contents, "utf8");
  if (mode !== undefined) chmodSync(path, mode);
  return path;
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("client setup script", () => {
  it("is valid bash", () => {
    const result = run(["--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("PERSONAL API KEY");
    expect(result.stdout).toContain("--oauth");
    expect(result.stdout).toContain("Legacy");
  });

  it("leads with the personal key and labels OAuth as legacy in --print-only", () => {
    const result = run(["https://memory.example.test", "--print-only"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Auth: personal API key");
    // Codex gets environment indirection so the key never lands in its config.
    expect(result.stdout).toContain("--bearer-token-env-var SHARED_LIVING_MEMORY_API_KEY");
    // Claude Code is told to store the header, as it has no env indirection.
    expect(result.stdout).toContain('--header "Authorization: Bearer <personal-api-key>"');
    // The secure exporter is offered as the mode-0600 alternative.
    expect(result.stdout).toContain("scripts/export-mcp-connection.mjs");
  });

  it("preserves a tool profile as an explicit header", () => {
    const result = run(["https://memory.example.test", "--print-only", "--profile", "capture"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Tool profile: capture");
    expect(result.stdout).toContain("X-SLM-Tool-Profile: capture");
  });

  it("rejects an invalid profile before doing anything", () => {
    const result = run(["https://memory.example.test", "--profile", "admin"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--profile must be capture, review or full");
  });

  it("appends exactly one /mcp, never two", () => {
    for (const url of [
      "https://memory.example.test",
      "https://memory.example.test/",
      "https://memory.example.test/mcp",
    ]) {
      const result = run([url, "--print-only"]);
      expect({ url, status: result.status }).toEqual({ url, status: 0 });
      expect({ url, endpoint: result.stdout.match(/MCP endpoint: (\S+)/)?.[1] })
        .toEqual({ url, endpoint: "https://memory.example.test/mcp" });
      expect(result.stdout).not.toContain("/mcp/mcp");
    }
  });

  it("rejects a non-http scheme and unknown options", () => {
    expect(run(["ftp://memory.example.test"]).status).toBe(1);
    const unknown = run(["https://memory.example.test", "--nope"]);
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain("unknown option");
  });

  it("never echoes the key, and never accepts one as an argument", () => {
    // An argument that looks like a key is treated as an unexpected extra
    // argument, not read as a secret.
    const asArgument = run(["https://memory.example.test", SENTINEL_KEY]);
    expect(asArgument.status).toBe(1);
    expect(asArgument.stderr).toContain("unexpected extra argument");
    // The refusal never echoes the offending value, because it could be a key.
    expect(asArgument.stderr).not.toContain(SENTINEL_KEY);
    expect(asArgument.stdout).not.toContain(SENTINEL_KEY);
    const fromStdin = run(["https://memory.example.test", "--print-only"], SENTINEL_KEY);
    expect(fromStdin.stdout).not.toContain(SENTINEL_KEY);
    expect(fromStdin.stderr).not.toContain(SENTINEL_KEY);
  });

  it("refuses a missing key file without echoing anything secret", () => {
    const missing = join(tmpdir(), "slm-connect-does-not-exist", "key");
    const missingRun = run(["https://memory.example.test", "--key-file", missing]);
    expect(missingRun.status).toBe(1);
    expect(missingRun.stderr).toContain("key file not found");
    expect(missingRun.stdout).not.toContain(SENTINEL_KEY);
  });

  it("warns about an over-permissive readable key file before using it", () => {
    const worldReadable = tempFile("key", SENTINEL_KEY, 0o644);

    // Run with a PATH that has the core utilities the script needs but neither
    // client CLI, so the guard is exercised without touching the real Claude
    // Code or Codex configuration.
    const binDir = mkdtempSync(join(tmpdir(), "slm-bin-"));
    tempDirs.push(binDir);
    for (const tool of ["sed", "stat", "tr", "curl", "grep", "touch", "mkdir", "dirname", "awk"]) {
      try {
        const real = execFileSync("bash", ["-c", `command -v ${tool}`], { encoding: "utf8" }).trim();
        if (real) symlinkSync(real, join(binDir, tool));
      } catch {
        // A missing optional tool simply is not linked.
      }
    }
    const bashPath = execFileSync("bash", ["-c", "command -v bash"], { encoding: "utf8" }).trim();
    const guarded = execFileSync("bash", ["-c",
      `PATH="${binDir}" HOME="${binDir}" "${bashPath}" "${SCRIPT}" https://memory.example.test --key-file "${worldReadable}" 2>&1 || true`,
    ], { encoding: "utf8" });

    expect(guarded).toContain("600 is recommended");
    // Neither the key nor the header that carries it is ever printed.
    expect(guarded).not.toContain(SENTINEL_KEY);
    expect(guarded).not.toContain("Authorization: Bearer slm_");
  });
});
