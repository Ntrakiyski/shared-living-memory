/**
 * release-version.test.ts
 *
 * The release specification fixes the version at 1.1.0 and requires package.json,
 * the root version in package-lock.json and the MCP server version to be updated
 * together, without upgrading any dependency.
 *
 * This pins all three so a partial bump fails loudly instead of shipping a
 * mismatched version to clients.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { SLM_RELEASE_VERSION } from "../../src/config";
import { MCP_ONBOARDING_MARKDOWN } from "../../src/mcp-onboarding";

const RELEASE = "1.1.0";

function json(...segments: string[]): Record<string, unknown> {
  return JSON.parse(readFileSync(join(process.cwd(), ...segments), "utf8"));
}

const pkg = json("package.json");
const lock = json("package-lock.json") as {
  version?: string;
  packages?: Record<string, { version?: string }>;
};

describe("release version", () => {
  it("is 1.1.0 everywhere it is declared", () => {
    expect({ pkg: pkg.version }).toEqual({ pkg: RELEASE });
    expect({ lockRoot: lock.version }).toEqual({ lockRoot: RELEASE });
    expect({ lockPackage: lock.packages?.[""]?.version }).toEqual({ lockPackage: RELEASE });
    expect({ config: SLM_RELEASE_VERSION }).toEqual({ config: RELEASE });
  });

  it("does not announce the previous release in onboarding content", () => {
    expect(MCP_ONBOARDING_MARKDOWN).not.toMatch(/\b1\.0\.0\b/);
  });

  it("keeps the dependency set unchanged by the release", () => {
    // The specification forbids upgrading dependencies as part of this release,
    // so the declared ranges stay exactly as reviewed.
    expect(pkg.dependencies).toEqual({
      "@cloudflare/workers-oauth-provider": "^0.7.0",
      "@modelcontextprotocol/sdk": "^1.0.0",
      agents: "^0.12.4",
      zod: "^4.0.0",
    });
    expect(pkg.devDependencies).toEqual({
      "@types/node": "^25.9.1",
      "@vitest/coverage-v8": "^4.1.7",
      typescript: "^5.5.0",
      vitest: "^4.1.7",
      wrangler: "^4.101.0",
    });
  });
});
