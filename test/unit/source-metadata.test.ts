import { describe, expect, it } from "vitest";

import {
  sanitizeBoundedMetadataForOutput,
  sanitizeSourceMetadataForOutput,
} from "../../src/source-metadata";

describe("source metadata output policy", () => {
  it.each([
    ...Array.from({ length: 32 }, (_, code) => String.fromCharCode(code)),
    "\u007f",
    "\u2028",
    "\u2029",
  ])("rejects control-bearing scalar metadata U+%s", (control) => {
    const value = `safe${control}forged`;
    expect(sanitizeBoundedMetadataForOutput(value, 512)).toBeNull();
  });

  it("sanitizes public source labels and keeps ordinary values byte-identical", () => {
    const safe = sanitizeSourceMetadataForOutput({
      source: "legacy integration / exact",
      sourceTitle: "Exact source title",
      sourceUrl: "https://example.test/Exact?x=One#Two",
    }, "team_public");
    const unsafe = sanitizeSourceMetadataForOutput({
      source: `ghp_${"a".repeat(36)}\nforged`,
      sourceTitle: "title\tforged",
      sourceUrl: "https://user:password@example.test/source",
    }, "team_public");

    expect(safe).toEqual({
      source: "legacy integration / exact",
      sourceTitle: "Exact source title",
      sourceUrl: "https://example.test/Exact?x=One#Two",
    });
    expect(unsafe).toEqual({ source: null, sourceTitle: null, sourceUrl: null });
  });

  it.each([
    "10.1000/182",
    "doi:10.1000/182",
    "urn:isbn:9780141036144",
    "zotero://select/library/items/ABCD1234",
  ])("preserves a safe owner-authorized citation URI exactly: %s", (sourceUrl) => {
    expect(sanitizeSourceMetadataForOutput({ sourceUrl }, "owner_mcp").sourceUrl).toBe(sourceUrl);
    expect(sanitizeSourceMetadataForOutput({ sourceUrl }, "team_public").sourceUrl).toBeNull();
  });

  it.each([
    "javascript:alert(1)",
    "data:text/plain,forged",
    "file:///etc/passwd",
    "vbscript:msgbox(1)",
    "zotero://user:password@library/items/secret",
    "https://user:password@example.test/source",
  ])("rejects dangerous or credential-bearing owner citation URI: %s", (sourceUrl) => {
    expect(sanitizeSourceMetadataForOutput({ sourceUrl }, "owner_mcp").sourceUrl).toBeNull();
  });
});
