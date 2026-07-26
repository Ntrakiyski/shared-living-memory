import { describe, expect, it } from "vitest";

import { buildMcpServer } from "../../src/mcp";
import { MCP_ONBOARDING_RESOURCE_URI } from "../../src/mcp-onboarding";
import { makeTestEnv } from "../helpers/make-env";
import type { HumanActorContext } from "../../src/types";

const ctx = {
  waitUntil: (_: Promise<any>) => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

const humanActor = (userId: string): HumanActorContext => ({
  kind: "human" as const,
  actorId: userId,
  userId,
  role: "member" as const,
  authMethod: "test",
  scopes: new Set(),
});

describe("MCP resources", () => {
  it("exposes onboarding guidance as a read-only markdown resource", () => {
    const server = buildMcpServer(makeTestEnv(), ctx, humanActor("alice"));
    const resource = (server as any)._registeredResources[MCP_ONBOARDING_RESOURCE_URI];

    expect(resource).toBeDefined();
    expect(resource.name).toBe("shared-living-memory-mcp-onboarding");
    expect(resource.metadata.mimeType).toBe("text/markdown");

    const result = resource.readCallback(new URL(MCP_ONBOARDING_RESOURCE_URI), {});
    expect(result.contents[0]).toMatchObject({
      uri: MCP_ONBOARDING_RESOURCE_URI,
      mimeType: "text/markdown",
    });
    expect(result.contents[0].text).toContain("npx skills add https://github.com/Ntrakiyski/shared-living-memory");
    expect(result.contents[0].text).toContain("shared-living-memory-mcp-knowledgebase");
    expect(result.contents[0].text).toContain("https://shared-living-memory.nikolay-trakiyski.workers.dev/");
    expect(result.contents[0].text).toContain("workspace key");
    expect(result.contents[0].text).toContain("YOUR-WORKSPACE-KEY");
    expect(result.contents[0].text).toContain("X-Shared-Living-Memory-User-Key");
    expect(result.contents[0].text).not.toContain("deployment key");
    expect(result.contents[0].text).not.toContain("YOUR-DEPLOYMENT-TOKEN");
  });
});
