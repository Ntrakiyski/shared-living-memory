import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it } from "vitest";

async function discovery(failure?: "tool" | "http" | "deployment" | "redirect" | "rpc-id", sse = false) {
  const requests: string[] = [];
  let origin = "";
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const rpc = JSON.parse(raw);
    requests.push(rpc.method);
    let result: unknown;
    if (rpc.method === "initialize") result = { serverInfo: { name: "fixture", version: "1.1.0" } };
    else if (rpc.method === "tools/list") result = { tools: ["whoami", "remember", "recall", "forget"].map(name => ({ name })) };
    else {
      expect(rpc.params.name).toBe("whoami");
      result = failure === "tool" ? {
        isError: true,
        structuredContent: { ok: false, error: { code: "storage_unavailable" } },
        content: [{ type: "text", text: "Unable to resolve principal: private SQL and slm_do_not_log.secret" }],
      } : {
        structuredContent: { ok: true, data: {
          principal: { id: "monitor", name: "monitor", kind: "human" },
          deployment: { id: failure === "deployment" ? "wrong-installation" : "slm-test", canonical_url: origin, release_id: "fixture-sha" },
        } },
      };
      if (failure === "http") res.statusCode = 503;
      if (failure === "redirect") {
        res.statusCode = 307;
        res.setHeader("Location", "http://127.0.0.1:1/steal");
      }
    }
    const payload = JSON.stringify({ jsonrpc: "2.0", id: failure === "rpc-id" ? "unrelated-request" : rpc.id, result });
    if (sse) {
      res.setHeader("Content-Type", "text/event-stream");
      res.write('event: message\r\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\r\n\r\n');
      res.end(`event: message\r\ndata: ${payload}\r\n\r\n`);
    } else {
      res.setHeader("Content-Type", "application/json");
      res.end(payload);
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const child = spawn(process.execPath, ["scripts/mcp-protocol-smoke.mjs", "--discovery-only"], {
      env: { ...process.env, SLM_URL: origin, SLM_USER_KEY: "slm_fixture.secret", SLM_EXPECTED_DEPLOYMENT_ID: "slm-test", SLM_KEY_FILE: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { output += chunk; });
    const [exitCode] = await once(child, "exit");
    return { exitCode, output, requests };
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

describe("production MCP discovery CLI", () => {
  it("executes only authenticated identity/discovery and passes a valid envelope", async () => {
    const result = await discovery();
    expect(result.exitCode).toBe(0);
    expect(result.requests).toEqual(["initialize", "tools/list", "tools/call"]);
  });

  it.each(["tool", "http", "deployment", "redirect", "rpc-id"] as const)("fails closed on %s without echoing response bodies", async failure => {
    const result = await discovery(failure);
    expect(result.exitCode).not.toBe(0);
    expect(result.output).not.toContain("discovery (whoami + tools/list) passed");
    expect(result.output).not.toContain("private SQL");
    expect(result.output).not.toContain("slm_do_not_log");
  });

  it("accepts an SSE response after progress notifications", async () => {
    const result = await discovery(undefined, true);
    expect(result.exitCode).toBe(0);
    expect(result.requests).toEqual(["initialize", "tools/list", "tools/call"]);
  });

  it("rejects tool errors delivered through SSE", async () => {
    const result = await discovery("tool", true);
    expect(result.exitCode).not.toBe(0);
    expect(result.output).not.toContain("slm_do_not_log");
  });
});
