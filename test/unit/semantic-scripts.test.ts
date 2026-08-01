import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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

  it("uses personal bearer auth, registers partial captures for cleanup, and avoids keyword overlap", () => {
    const source = readFileSync(canaryScript, "utf8");
    expect(source).toContain("Authorization: `Bearer ${user?.key ?? adminKey}`");
    expect(source).not.toContain("X-Shared-Living-Memory-User");

    const firstCapture = source.indexOf("ids.alicePrivate = await capture");
    const firstRegistration = source.indexOf("created.push([alice, ids.alicePrivate])");
    const secondCapture = source.indexOf("ids.bobPrivate = await capture");
    expect(firstCapture).toBeGreaterThan(0);
    expect(firstRegistration).toBeGreaterThan(firstCapture);
    expect(secondCapture).toBeGreaterThan(firstRegistration);

    const target = source.match(/semantic: `Canary \$\{suffix\}: ([^`]+)`/)?.[1] ?? "";
    const query = source.match(/pollFor\(alice, "([^"]+)", ids\.semantic\)/)?.[1] ?? "";
    const meaningfulTokens = (value: string) => new Set(
      value.toLowerCase().match(/[a-z]+/g)?.filter(token => token.length >= 4) ?? [],
    );
    const targetTokens = meaningfulTokens(target);
    const overlap = [...meaningfulTokens(query)].filter(token => targetTokens.has(token));
    expect(target).not.toBe("");
    expect(query).not.toBe("");
    expect(overlap).toEqual([]);
  });

  it("accepts required metadata indexes and ignores extras", () => {
    const result = run(indexScript, {}, JSON.stringify({
      indexes: [
        { propertyName: "owner_user_id", type: "string" },
        { propertyName: "is_private", type: "boolean" },
        { propertyName: "extra", type: "string" },
      ],
    }));

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("VECTOR_METADATA_INDEXES_OK");
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
