import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const indexHtml = readFileSync(resolve(process.cwd(), "public/index.html"), "utf8");

describe("web recall chat grounding", () => {
  it("no longer serializes recall passages into a client-supplied chat context", () => {
    expect(indexHtml).not.toContain("function formatRecallPassageForContext(");
    expect(indexHtml).not.toContain("const memories = JSON.stringify({");
    expect(indexHtml).not.toContain("body: JSON.stringify({ query, memories })");
  });

  it("grounds the chat answer server-side by sending only the query", () => {
    expect(indexHtml).toContain("body: JSON.stringify({ query })");
  });
});
