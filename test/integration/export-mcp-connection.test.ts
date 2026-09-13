import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  buildConnectionFile,
  buildMcpUrl,
  loadSecret,
  main,
  normalizeBaseUrl,
  parseArgs,
  verifyWhoami,
  writeConnectionFile,
} from "../../scripts/export-mcp-connection.mjs";

const TEST_KEY = "slm_test.fake-secret-key-value";

const WHOAMI_DATA = {
  principal: { id: "usr_alice", name: "alice", kind: "human" },
  credential_type: "personal_api_key",
  auth_method: "personal_api_key",
  owner: null,
  role: "member",
  scopes: [],
  capabilities: { read_public: true, read_owner_private: true },
  tool_profile: "full",
  effective_tools: [],
  default_visibility: "private",
  deployment: {
    id: "slm-fractals-test",
    environment: "test",
    canonical_url: "https://memory.example.test",
    release_id: "abc123",
    write_mode: "enabled",
  },
  human_presence_verified: false,
};

function whoamiFetch(overrides: Record<string, unknown> = {}) {
  return vi.fn(async (_url: string, _init: RequestInit) => ({
    status: 200,
    ok: true,
    json: async () => ({
      ok: true,
      data: WHOAMI_DATA,
      request_id: "req-1",
      warnings: [],
    }),
    ...overrides,
  }));
}

let tmpRoot: string;

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "slm-export-"));
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function tmpOut(name: string): string {
  return path.join(tmpRoot, name);
}

describe("normalizeBaseUrl", () => {
  it("rejects userinfo, query, fragment, relative and non-https non-local URLs", () => {
    expect(() => normalizeBaseUrl("https://user:pass@host.example/path"))
      .toThrow(/userinfo/);
    expect(() => normalizeBaseUrl("https://host.example/path?x=1"))
      .toThrow(/query/);
    expect(() => normalizeBaseUrl("https://host.example/path#frag"))
      .toThrow(/fragment/);
    expect(() => normalizeBaseUrl("host.example/path"))
      .toThrow(/absolute/);
    expect(() => normalizeBaseUrl("http://host.example"))
      .toThrow(/--local|plain HTTP/);
    expect(() => normalizeBaseUrl("ftp://host.example"))
      .toThrow(/https/);
  });

  it("allows plain HTTP only for localhost hosts with the --local exception", () => {
    expect(normalizeBaseUrl("http://localhost:8787", { allowLocalHttp: true }))
      .toBe("http://localhost:8787");
    expect(normalizeBaseUrl("http://127.0.0.1:8787", { allowLocalHttp: true }))
      .toBe("http://127.0.0.1:8787");
    expect(normalizeBaseUrl("http://[::1]:8787", { allowLocalHttp: true }))
      .toBe("http://[::1]:8787");
  });

  it("rejects plain HTTP for localhost without --local and for non-local hosts with --local", () => {
    expect(() => normalizeBaseUrl("http://localhost:8787"))
      .toThrow(/--local/);
    expect(() => normalizeBaseUrl("http://example.com", { allowLocalHttp: true }))
      .toThrow(/localhost/);
    expect(() => normalizeBaseUrl("http://192.168.1.2", { allowLocalHttp: true }))
      .toThrow(/localhost/);
  });

  it("accepts https for any host regardless of --local", () => {
    expect(normalizeBaseUrl("https://localhost:8787"))
      .toBe("https://localhost:8787");
    expect(normalizeBaseUrl("https://host.example"))
      .toBe("https://host.example");
  });

  it("trims trailing slashes and appends /mcp exactly once", () => {
    expect(normalizeBaseUrl("https://host.example/")).toBe("https://host.example");
    expect(normalizeBaseUrl("https://host.example/base/")).toBe("https://host.example/base");
    expect(normalizeBaseUrl("https://host.example/base///")).toBe("https://host.example/base");

    expect(buildMcpUrl("https://host.example")).toBe("https://host.example/mcp");
    expect(buildMcpUrl("https://host.example/base")).toBe("https://host.example/base/mcp");
    // Already-/mcp must not become /mcp/mcp.
    expect(buildMcpUrl("https://host.example/base/mcp")).toBe("https://host.example/base/mcp");

    const alreadyMcp = normalizeBaseUrl("https://host.example/base/mcp");
    expect(alreadyMcp).toBe("https://host.example/base/mcp");
    expect(buildMcpUrl(alreadyMcp)).toBe("https://host.example/base/mcp");
  });
});

describe("parseArgs", () => {
  it("defaults profile to full", () => {
    const args = parseArgs([
      "--url", "https://host.example",
      "--out", "/tmp/out.json",
    ]);
    expect(args.profile).toBe("full");
    expect(args.url).toBe("https://host.example");
    expect(args.out).toBe("/tmp/out.json");
    expect(args.keyFile).toBeNull();
    expect(args.local).toBe(false);
  });

  it("rejects a key supplied in argv via --key or a positional", () => {
    expect(() => parseArgs(["--key", "secret", "--url", "https://h", "--out", "/x"]))
      .toThrow(/command-line argument/);
    expect(() => parseArgs(["--url", "https://h", "--out", "/x", "some-secret"]))
      .toThrow(/argv/);
    expect(() => parseArgs(["--key=secret", "--url", "https://h", "--out", "/x"]))
      .toThrow(/command-line argument/);
  });

  it("rejects invalid profile values", () => {
    expect(() => parseArgs([
      "--url", "https://host.example", "--out", "/x", "--profile", "admin",
    ])).toThrow(/capture, review, full/);
  });

  it("rejects duplicate and unknown flags", () => {
    expect(() => parseArgs([
      "--url", "https://a", "--url", "https://b", "--out", "/x",
    ])).toThrow(/Duplicate/);
    expect(() => parseArgs(["--bogus", "--url", "https://a", "--out", "/x"]))
      .toThrow(/Unknown flag/);
  });
});

describe("loadSecret", () => {
  it("rejects both --key-file and a stdin secret together", async () => {
    await expect(loadSecret({ keyFile: "/tmp/whatever.key", stdinText: "secret-on-stdin" }))
      .rejects.toThrow(/EITHER/);
  });

  it("rejects when neither source is supplied", async () => {
    await expect(loadSecret({ keyFile: null, stdinText: null }))
      .rejects.toThrow(/No API key/);
    await expect(loadSecret({ keyFile: null, stdinText: "   " }))
      .rejects.toThrow(/No API key/);
  });

  it("reads and trims a key from stdin", async () => {
    await expect(loadSecret({ keyFile: null, stdinText: `  ${TEST_KEY}  \n` }))
      .resolves.toBe(TEST_KEY);
  });

  it("reads and trims a key from a file", async () => {
    const keyFile = tmpOut("key-file.txt");
    fs.writeFileSync(keyFile, `\n${TEST_KEY}\n`);
    await expect(loadSecret({ keyFile, stdinText: null }))
      .resolves.toBe(TEST_KEY);
  });

  it("rejects a missing key file", async () => {
    await expect(loadSecret({ keyFile: tmpOut("does-not-exist.key"), stdinText: null }))
      .rejects.toThrow(/not found/);
  });
});

describe("verifyWhoami", () => {
  it("sends Bearer auth with redirect: manual and verifies identity", async () => {
    const fetchMock = whoamiFetch();
    const data = await verifyWhoami("https://host.example", TEST_KEY, fetchMock);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://host.example/api/whoami");
    expect(init.redirect).toBe("manual");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TEST_KEY}`);
    expect(data.principal.name).toBe("alice");
    expect(data.deployment.id).toBe("slm-fractals-test");
  });

  it("rejects a cross-origin redirect before following it", async () => {
    const fetchMock = whoamiFetch({ status: 302, ok: false });
    await expect(verifyWhoami("https://host.example", TEST_KEY, fetchMock))
      .rejects.toThrow(/redirect/);
  });

  it("rejects unauthenticated (401) and unavailable (500) responses", async () => {
    const unauth = whoamiFetch({ status: 401, ok: false });
    await expect(verifyWhoami("https://host.example", TEST_KEY, unauth))
      .rejects.toThrow(/Authentication failed/);

    const down = whoamiFetch({ status: 500, ok: false });
    await expect(verifyWhoami("https://host.example", TEST_KEY, down))
      .rejects.toThrow(/unavailable/);
  });

  it("rejects a whoami response missing principal or deployment identity", async () => {
    const fetchMock = vi.fn(async () => ({
      status: 200,
      ok: true,
      json: async () => ({ ok: true, data: { principal: null, deployment: {} }, request_id: "r", warnings: [] }),
    }));
    await expect(verifyWhoami("https://host.example", TEST_KEY, fetchMock))
      .rejects.toThrow(/principal/);
  });
});

describe("buildConnectionFile", () => {
  it("emits whoami-derived metadata and the Authorization header", () => {
    const config = buildConnectionFile("https://host.example/base", TEST_KEY, "full", WHOAMI_DATA);

    expect(config.mcpServers["shared-living-memory"].url)
      .toBe("https://host.example/base/mcp");
    expect(config.mcpServers["shared-living-memory"].headers.Authorization)
      .toBe(`Bearer ${TEST_KEY}`);
    expect(config.mcpServers["shared-living-memory"].headers["X-SLM-Tool-Profile"])
      .toBeUndefined();

    expect(config.sharedLivingMemory).toEqual({
      username: "alice",
      principal_id: "usr_alice",
      deployment_id: "slm-fractals-test",
      canonical_url: "https://memory.example.test",
    });
  });

  it("persists the profile header only for reduced profiles", () => {
    const capture = buildConnectionFile("https://host.example", TEST_KEY, "capture", WHOAMI_DATA);
    expect(capture.mcpServers["shared-living-memory"].headers["X-SLM-Tool-Profile"])
      .toBe("capture");

    const review = buildConnectionFile("https://host.example", TEST_KEY, "review", WHOAMI_DATA);
    expect(review.mcpServers["shared-living-memory"].headers["X-SLM-Tool-Profile"])
      .toBe("review");

    const full = buildConnectionFile("https://host.example", TEST_KEY, "full", WHOAMI_DATA);
    expect(full.mcpServers["shared-living-memory"].headers["X-SLM-Tool-Profile"])
      .toBeUndefined();
  });

  it("never exposes the raw key outside the Authorization header", () => {
    const config = buildConnectionFile("https://host.example", TEST_KEY, "capture", WHOAMI_DATA);
    const serialized = JSON.stringify(config);
    const occurrences = serialized.split(TEST_KEY).length - 1;
    expect(occurrences).toBe(1);
    expect(serialized).toContain(`"Authorization":"Bearer ${TEST_KEY}"`);
  });
});

describe("writeConnectionFile", () => {
  it("writes with mode 0600 and creates a new parent directory with mode 0700", () => {
    const outPath = tmpOut(`fresh-${Date.now()}/nested/mcp.json`);
    const written = writeConnectionFile(outPath, { mcpServers: {} });

    expect(written).toBe(outPath);
    const mode = fs.statSync(outPath).mode & 0o777;
    expect(mode).toBe(0o600);
    // The newly-created parent directory must be owner-only.
    const dirMode = fs.statSync(path.dirname(outPath)).mode & 0o777;
    expect(dirMode).toBe(0o700);
  });

  it("does not chmod an existing parent directory", () => {
    const parent = tmpOut(`existing-dir-${Date.now()}`);
    fs.mkdirSync(parent, { recursive: true });
    fs.chmodSync(parent, 0o755);

    const outPath = path.join(parent, "mcp.json");
    writeConnectionFile(outPath, { mcpServers: {} });

    expect(fs.statSync(parent).mode & 0o777).toBe(0o755);
  });

  it("rejects an existing file", () => {
    const outPath = tmpOut("existing.json");
    fs.writeFileSync(outPath, "already here");
    expect(() => writeConnectionFile(outPath, { mcpServers: {} }))
      .toThrow(/overwrite/);
  });

  it("rejects a symlink output", () => {
    const target = tmpOut("real-target.json");
    fs.writeFileSync(target, "target");
    const link = tmpOut("link.json");
    fs.symlinkSync(target, link);
    expect(() => writeConnectionFile(link, { mcpServers: {} }))
      .toThrow(/symbolic link/);
  });
});

describe("main", () => {
  it("writes a config, reports the path and identity, and never prints the key", async () => {
    const fetchMock = whoamiFetch();
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const outPath = tmpOut(`main-${Date.now()}.json`);
    const keyFile = tmpOut("main.key");
    fs.writeFileSync(keyFile, TEST_KEY);

    const result = await main([
      "--url", "https://host.example/base",
      "--out", outPath,
      "--profile", "capture",
      "--key-file", keyFile,
    ], {
      fetchImpl: fetchMock,
      stdinText: null,
      stdout,
      stderr,
    });

    expect(result.ok).toBe(true);
    expect(result.path).toBe(outPath);

    const onDisk = JSON.parse(fs.readFileSync(outPath, "utf8"));
    expect(onDisk.mcpServers["shared-living-memory"].headers.Authorization)
      .toBe(`Bearer ${TEST_KEY}`);
    expect(onDisk.sharedLivingMemory.username).toBe("alice");

    const stdoutText = stdout.write.mock.calls.map((c) => c[0]).join("");
    const stderrText = stderr.write.mock.calls.map((c) => c[0]).join("");
    expect(stdoutText).toContain(outPath);
    expect(stdoutText).toContain("alice");
    expect(stdoutText).not.toContain(TEST_KEY);
    expect(stderrText).not.toContain(TEST_KEY);
  });

  it("fails without writing a file when whoami is unauthenticated", async () => {
    const fetchMock = whoamiFetch({ status: 401, ok: false });
    const outPath = tmpOut(`unauth-${Date.now()}.json`);
    const stderr = { write: vi.fn() };

    const result = await main([
      "--url", "https://host.example",
      "--out", outPath,
    ], {
      fetchImpl: fetchMock,
      stdinText: TEST_KEY,
      stdout: { write: vi.fn() },
      stderr,
    });

    expect(result.ok).toBe(false);
    expect(fs.existsSync(outPath)).toBe(false);
    expect(stderr.write.mock.calls.map((c) => c[0]).join(""))
      .toContain("Authentication failed");
  });

  it("rejects both --key-file and a stdin secret via main", async () => {
    const result = await main([
      "--url", "https://host.example",
      "--out", tmpOut("both.json"),
      "--key-file", tmpOut("main.key"),
    ], {
      fetchImpl: whoamiFetch(),
      stdinText: TEST_KEY,
      stdout: { write: vi.fn() },
      stderr: { write: vi.fn() },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("EITHER");
  });
});
