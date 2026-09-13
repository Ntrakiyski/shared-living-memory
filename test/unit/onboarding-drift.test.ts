/**
 * onboarding-drift.test.ts
 *
 * Section 12: "One source string/module owns in-product onboarding content; test
 * the generated/static counterpart for drift instead of maintaining contradictory
 * examples."
 *
 * `src/mcp-onboarding.ts` is the generated MCP resource an agent actually reads.
 * `docs/mcp-onboarding.md` is its static counterpart. They must state the same
 * facts about authentication, the legacy flow and the tool profiles — and the
 * other guides must not contradict them.
 *
 * These assertions are about the FACTS the documents state, so a rewrite in a
 * different style still passes while a contradictory claim does not.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MCP_ONBOARDING_MARKDOWN } from "../../src/mcp-onboarding";

function readDoc(...segments: string[]): string {
  return readFileSync(join(process.cwd(), ...segments), "utf8");
}

const staticOnboarding = readDoc("docs", "mcp-onboarding.md");
const readme = readDoc("README.md");
const agents = readDoc("AGENTS.md");
const skill = readDoc(".agents", "skills", "shared-living-memory-mcp-knowledgebase", "SKILL.md");
const participantGuide = readDoc("docs", "team-pilot", "participant-guide.md");
const currentState = readDoc("docs", "shared-knowledge-base", "CURRENT_STATE.md");

/** Every document an agent or participant may read when connecting. */
const allGuides: [string, string][] = [
  ["generated MCP resource", MCP_ONBOARDING_MARKDOWN],
  ["docs/mcp-onboarding.md", staticOnboarding],
  ["README.md", readme],
  ["AGENTS.md", agents],
  ["project agent skill", skill],
  ["participant guide", participantGuide],
  ["CURRENT_STATE.md", currentState],
];

describe("onboarding content does not drift", () => {
  it("states the personal Bearer key as the default everywhere", () => {
    for (const [name, text] of allGuides) {
      expect({ name, personalDefault: /personal (Bearer )?API key/i.test(text) })
        .toEqual({ name, personalDefault: true });
    }
  });

  it("never presents the workspace key as a normal sign-in credential", () => {
    // Proximity rule: in the window of text around each "workspace key" mention
    // that also talks about authenticating, the same window must frame it as
    // legacy, bootstrap-only or transport-only. A stray mention elsewhere in the
    // document cannot satisfy the check, and a rewrite in different prose still
    // can as long as the framing is present.
    const allowedFraming = /legacy|bootstrap|transport|first-admin|one-time|not a (user )?principal/i;
    const authTalk = /(sign ?in|log ?in|connect|authenticat|Bearer|api key)/i;
    const windowSize = 160;

    for (const [name, text] of allGuides) {
      // Fenced code blocks are examples, not prose claims, so they are removed
      // before the proximity scan. Otherwise a config snippet would count as
      // "auth talk" next to an unrelated sentence.
      const haystack = text
        .replace(/```[\s\S]*?```/g, " ")
        .replace(/\s+/g, " ");
      for (const match of haystack.matchAll(/workspace key/gi)) {
        const from = Math.max(0, (match.index ?? 0) - windowSize);
        const to = Math.min(haystack.length, (match.index ?? 0) + windowSize);
        const window = haystack.slice(from, to);
        if (!authTalk.test(window)) continue;
        // A secrecy instruction ("never store the workspace key") is not a claim
        // about how to authenticate, so it is out of scope.
        if (/(never|do not|don't|avoid) (store|log|remember|commit|share|paste)/i.test(window)) continue;
        expect({
          name,
          framed: allowedFraming.test(window),
          window: window.slice(0, 90),
        }).toMatchObject({ name, framed: true });
      }
    }
  });

  it("names the personal Bearer header at least once wherever auth is explained", () => {
    for (const [name, text] of allGuides) {
      if (!/Authorization/i.test(text)) continue;
      expect({ name, bearerPersonal: /Bearer .{0,30}(slm_|personal|your personal)/i.test(text) })
        .toEqual({ name, bearerPersonal: true });
    }
  });

  it("never claims the workspace key is a user principal or the only credential", () => {
    for (const [name, text] of allGuides) {
      expect({ name, claimsWorkspaceOnly: /only (credential|authentication|key)/i.test(text) })
        .toEqual({ name, claimsWorkspaceOnly: false });
      expect({ name, claimsAllRoutesWorkspace: /all routes require .{0,40}AUTH_TOKEN/i.test(text) })
        .toEqual({ name, claimsAllRoutesWorkspace: false });
    }
  });

  it("uses the same three profile names wherever profiles are described", () => {
    for (const [name, text] of allGuides) {
      if (!/X-SLM-Tool-Profile/.test(text)) continue;
      for (const profile of ["capture", "review", "full"]) {
        expect({ name, profile, present: text.includes(profile) })
          .toEqual({ name, profile, present: true });
      }
    }
  });

  it("does not re-introduce the retired single-file Worker description", () => {
    for (const [name, text] of allGuides) {
      expect({ name, singleFileClaim: /single-file worker/i.test(text) })
        .toEqual({ name, singleFileClaim: false });
    }
  });

  it("keeps the static onboarding document aligned with the generated resource", () => {
    // Both must carry the same install command and the same legacy header names.
    for (const needle of [
      "npx skills add https://github.com/Ntrakiyski/shared-living-memory",
      "X-Shared-Living-Memory-User-Key",
    ]) {
      expect({ needle, generated: MCP_ONBOARDING_MARKDOWN.includes(needle) })
        .toEqual({ needle, generated: true });
      expect({ needle, static: staticOnboarding.includes(needle) })
        .toEqual({ needle, static: true });
    }
  });

  it("documents the erased-key and retry-key behaviour in the participant guide", () => {
    // Participants are told their captures are create-only and that a deleted
    // memory is never silently recreated.
    expect(participantGuide).toMatch(/idempotency|retry key/i);
    expect(participantGuide).toMatch(/permanent|erase|delete/i);
  });
});
