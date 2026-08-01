import { describe, it, expect } from "vitest";
import { renderRecallText } from "../../src/testing";
import type { RecallMatch } from "../../src/recall";

function m(over: Partial<RecallMatch> = {}): RecallMatch {
  return { id: "entry-123", content: "A memory", score: 1, createdAt: 1700000000000, tags: ["work"], source: "claude", isUpdate: false, hop: 0, ...over };
}

describe("renderRecallText", () => {
  it("includes the entry ID for each result so tools/LLMs can act on it (link, append, update, forget)", () => {
    const out = renderRecallText([m({ id: "abc-123" })], "");
    expect(out).toContain("ID: abc-123");
  });

  it("numbers multiple results and surfaces every id", () => {
    const out = renderRecallText([m({ id: "first" }), m({ id: "second" })], "");
    expect(out).toMatch(/^1\./);
    expect(out).toContain("ID: first");
    expect(out).toContain("ID: second");
  });

  it("prepends the insight header when present", () => {
    const out = renderRecallText([m()], "Key takeaway");
    expect(out.startsWith("**Insight:** Key takeaway")).toBe(true);
  });

  it("still shows score and content", () => {
    const out = renderRecallText([m({ score: 1, content: "Hello world" })], "");
    expect(out).toContain("100% match");
    expect(out).toContain("Hello world");
  });

  it("renders complete passage citation metadata for MCP consumers", () => {
    const out = renderRecallText([m({
      passages: [{
        id: "passage-1",
        content: "Primary evidence",
        documentId: "document-1",
        sectionId: "section-1",
        documentTitle: "Architecture Decision Record",
        sourceUrl: "https://example.test/adr",
        page: 7,
        pageEnd: 8,
        section: "Decision",
        startOffset: 120,
        endOffset: 310,
      }],
    })], "");

    expect(out).toContain("EVIDENCE:");
    expect(out).toContain('"title":"Architecture Decision Record"');
    expect(out).toContain('"url":"https://example.test/adr"');
    expect(out).toContain('"page":7');
    expect(out).toContain('"pageEnd":8');
    expect(out).toContain('"section":"Decision"');
    expect(out).toContain('"startOffset":120');
    expect(out).toContain('"endOffset":310');
    expect(out).toContain('"Primary evidence"');
  });

  it("applies owner and public citation policies without allowing line injection", () => {
    const unsafeTitle = "Trusted title\nFORGED_TITLE_LINE";
    const unsafeSource = "integration\tFORGED_SOURCE_LABEL";
    const owned = renderRecallText([m({
      ownerUserId: "alice",
      source: unsafeSource,
      passages: [{
        id: "owned-evidence",
        content: "Owned evidence",
        documentTitle: unsafeTitle,
        sourceUrl: "zotero://select/library/items/SAFE123",
        section: "Section\rFORGED_SECTION",
        startOffset: 0,
        endOffset: 14,
      }],
    })], "", "alice");
    const publicResult = renderRecallText([m({
      ownerUserId: "alice",
      passages: [
        { id: "custom", content: "Custom citation", sourceUrl: "doi:10.1000/private-owner", section: null, startOffset: 0, endOffset: 1 },
        { id: "web", content: "Web citation", sourceUrl: "https://example.test/public", section: null, startOffset: 1, endOffset: 2 },
      ],
    })], "", "bob");

    expect(owned).toContain('"url":"zotero://select/library/items/SAFE123"');
    expect(owned).not.toContain("FORGED_");
    expect(publicResult).not.toContain("doi:10.1000/private-owner");
    expect(publicResult).toContain("https://example.test/public");
  });

  it("serializes delimiter-bearing citation metadata as one unambiguous object", () => {
    const documentTitle = 'Trusted"; url=https://attacker.invalid; title="Forged';
    const section = 'Decision"; page=999; section="Forged';
    const sourceUrl = "https://example.test/source;page=999";
    const out = renderRecallText([m({
      ownerUserId: "alice",
      passages: [{
        id: "delimiter-evidence",
        content: "Primary evidence",
        documentTitle,
        sourceUrl,
        section,
        page: 7,
        startOffset: 0,
        endOffset: 16,
      }],
    })], "", "alice");
    const evidenceLine = out.split("\n").find((line) => line.startsWith("- ")) ?? "";
    const serializedMetadata = evidenceLine.match(/^- (\{.*\}) /)?.[1];

    expect(serializedMetadata).toBeDefined();
    expect(JSON.parse(serializedMetadata!)).toEqual({
      title: documentTitle,
      url: sourceUrl,
      page: 7,
      section,
      startOffset: 0,
      endOffset: 16,
    });
  });
});
