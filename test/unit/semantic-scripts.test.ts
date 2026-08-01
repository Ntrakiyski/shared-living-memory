import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const projectRoot = resolve(import.meta.dirname, "../..");
const canaryScript = resolve(projectRoot, "scripts/staging-semantic-canary.mjs");
const indexScript = resolve(projectRoot, "scripts/assert-vector-metadata-indexes.mjs");

function run(script: string, env: Record<string, string> = {}, input?: string) {
  return spawnSync(process.execPath, [script], {
    cwd: projectRoot,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", ...env } as unknown as NodeJS.ProcessEnv,
    input,
  });
}

function inspectCanaryExport(expression: string) {
  return spawnSync(process.execPath, [
    "--input-type=module",
    "--eval",
    `import * as canary from ${JSON.stringify(pathToFileURL(canaryScript).href)}; console.log(JSON.stringify(${expression}));`,
  ], {
    cwd: projectRoot,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "" } as unknown as NodeJS.ProcessEnv,
  });
}

function meaningfulTokens(value: string): Set<string> {
  return new Set(value.toLowerCase().match(/[a-z]+/g)?.filter(token => token.length >= 4) ?? []);
}

describe("semantic deployment scripts", () => {
  it("requires an explicit staging URL and admin key", () => {
    const result = run(canaryScript);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("CANARY_CONFIG_MISSING");
  });

  it("refuses the production deployment", () => {
    const result = run(canaryScript, {
      SLM_BASE_URL: "https://shared-living-memory.nikolay-trakiyski.workers.dev",
      SLM_ADMIN_KEY: "not-a-real-key",
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("CANARY_PRODUCTION_REFUSED");
    expect(result.stderr).not.toContain("not-a-real-key");
  });

  it("refuses a configured production alias and rejects malformed production configuration", () => {
    const alias = run(canaryScript, {
      SLM_BASE_URL: "https://memory.example.test/staging-path",
      SLM_PRODUCTION_URL: "https://memory.example.test/production-path",
      SLM_ADMIN_KEY: "not-a-real-key",
    });
    expect(alias.status).toBe(2);
    expect(alias.stderr).toContain("CANARY_PRODUCTION_REFUSED");

    const malformed = run(canaryScript, {
      SLM_BASE_URL: "https://staging.example.test",
      SLM_PRODUCTION_URL: "not a URL",
      SLM_ADMIN_KEY: "not-a-real-key",
    });
    expect(malformed.status).toBe(2);
    expect(malformed.stderr).toContain("CANARY_PRODUCTION_URL_INVALID");
  });

  it("uses personal bearer auth and registers partial captures for cleanup", () => {
    const source = readFileSync(canaryScript, "utf8");
    expect(source).toContain("Authorization: `Bearer ${user?.key ?? adminKey}`");
    expect(source).not.toContain("X-Shared-Living-Memory-User");

    const firstCapture = source.indexOf("ids.alicePrivate = await capture");
    const firstRegistration = source.indexOf("created.push([alice, ids.alicePrivate])");
    const secondCapture = source.indexOf("ids.bobPrivate = await capture");
    expect(firstCapture).toBeGreaterThan(0);
    expect(firstRegistration).toBeGreaterThan(firstCapture);
    expect(secondCapture).toBeGreaterThan(firstRegistration);

  });

  it("defines four token-disjoint semantic probes including a public privacy decoy", () => {
    const inspected = inspectCanaryExport("canary.buildCanaryScenario('unit_test')");

    expect(inspected.status).toBe(0);
    const scenario = JSON.parse(inspected.stdout) as {
      contents: Record<string, string>;
      probes: Array<{
        name: string;
        actor: "alice" | "bob";
        query: string;
        expected: string;
        forbidden: string[];
      }>;
    };
    expect(Object.keys(scenario.contents)).toEqual([
      "alicePrivate",
      "bobPrivate",
      "alicePublic",
      "semantic",
    ]);
    expect(scenario.probes.map(probe => probe.name)).toEqual([
      "alice-own-private",
      "bob-own-private",
      "bob-public-privacy-decoy",
      "alice-semantic",
    ]);
    expect(scenario.probes.find(probe => probe.name === "bob-public-privacy-decoy")).toMatchObject({
      actor: "bob",
      expected: "alicePublic",
      forbidden: ["alicePrivate"],
    });
    for (const probe of scenario.probes) {
      const queryTokens = meaningfulTokens(probe.query);
      for (const target of [probe.expected, ...probe.forbidden]) {
        const targetTokens = meaningfulTokens(scenario.contents[target]);
        expect([...queryTokens].filter(token => targetTokens.has(token)), `${probe.name}:${target}`)
          .toEqual([]);
      }
    }
  });

  it("aborts every canary fetch after a fixed timeout", () => {
    const inspected = inspectCanaryExport(`await (async () => {
      const started = Date.now();
      let aborted = false;
      const hangingFetch = (_input, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("aborted"));
        });
      });
      try {
        await canary.fetchWithTimeout(hangingFetch, "https://staging.example.test", {}, 15);
      } catch {}
      return { aborted, elapsed: Date.now() - started };
    })()`);

    expect(inspected.status).toBe(0);
    const result = JSON.parse(inspected.stdout) as { aborted: boolean; elapsed: number };
    expect(result.aborted).toBe(true);
    expect(result.elapsed).toBeGreaterThanOrEqual(10);
    expect(result.elapsed).toBeLessThan(500);
  });

  it("keeps the canary timeout active through response-body decoding", () => {
    const inspected = inspectCanaryExport(`await (async () => {
      const started = Date.now();
      let aborted = false;
      const headersOnlyFetch = (_input, init) => Promise.resolve({
        json: () => new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("body aborted"));
          });
        }),
      });
      try {
        await canary.fetchWithTimeout(
          headersOnlyFetch,
          "https://staging.example.test",
          {},
          15,
          response => response.json(),
        );
      } catch {}
      return { aborted, elapsed: Date.now() - started };
    })()`);

    expect(inspected.status).toBe(0);
    const result = JSON.parse(inspected.stdout) as { aborted: boolean; elapsed: number };
    expect(result.aborted).toBe(true);
    expect(result.elapsed).toBeGreaterThanOrEqual(10);
    expect(result.elapsed).toBeLessThan(500);
  });

  it("accepts required metadata indexes and ignores extras", () => {
    const result = run(indexScript, {}, JSON.stringify({
      result: [
        { propertyName: "owner_user_id", indexType: "string" },
        { propertyName: "is_private", indexType: "boolean" },
        { propertyName: "extra", indexType: "string" },
      ],
    }));

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("VECTOR_METADATA_INDEXES_OK");
  });

  it("requires exact metadata property names from current Wrangler JSON", () => {
    const result = run(indexScript, {}, JSON.stringify({
      result: [
        { propertyName: "OWNER_USER_ID", indexType: "string" },
        { propertyName: "IS_PRIVATE", indexType: "boolean" },
      ],
    }));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "VECTOR_METADATA_INDEXES_INVALID:owner_user_id_missing,is_private_missing",
    );
  });

  it("fails metadata preflight with safe deterministic codes", () => {
    const result = run(indexScript, {}, JSON.stringify([
      { propertyName: "owner_user_id", type: "boolean" },
    ]));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "VECTOR_METADATA_INDEXES_INVALID:owner_user_id_type,is_private_missing",
    );
  });
});
