import { describe, expect, it } from "vitest";
import { planVersionPassages } from "../../src/entry-version-service";

describe("canonical version passage planning", () => {
  it("splits plain text into overlapping canonical passage chunks", () => {
    const content = "A".repeat(3000);

    const { passages, sections } = planVersionPassages(content, "episode-1");

    expect(passages).toHaveLength(3);
    expect(sections).toEqual([]);
    expect(passages[0]).toMatchObject({
      content: "A".repeat(1500),
      section: null,
      startOffset: 0,
      endOffset: 1500,
    });
    expect(passages[1].startOffset).toBe(1100);
    expect(passages.every((passage) => passage.vectorId === `pv:${passage.id}`)).toBe(true);
  });

  it("plans section-aware chunks and parent hierarchy for markdown", () => {
    const content = [
      "# Introduction\n\n" + "X".repeat(1400),
      "## Methods\n\n" + "Y".repeat(1400),
      "## Results\n\n" + "Z".repeat(1400),
    ].join("\n");

    const { passages, sections } = planVersionPassages(content, "episode-2");

    expect(passages.map((passage) => passage.section)).toEqual(expect.arrayContaining([
      "Introduction",
      "Methods",
      "Results",
    ]));
    expect(sections.map((section) => section.title)).toEqual([
      "Introduction",
      "Methods",
      "Results",
    ]);
    expect(sections[1].parentId).toBe(sections[0].id);
    expect(sections[2].parentId).toBe(sections[0].id);
  });

  it("returns no passages or sections for empty content", () => {
    expect(planVersionPassages("", "episode-3")).toEqual({ passages: [], sections: [] });
  });

  it("plans one unsectioned passage for ordinary text", () => {
    const result = planVersionPassages("Just plain text with no headers.", "episode-4");

    expect(result.sections).toEqual([]);
    expect(result.passages).toHaveLength(1);
    expect(result.passages[0]).toMatchObject({ section: null, sectionId: null });
  });
});
