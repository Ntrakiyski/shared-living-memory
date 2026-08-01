/**
 * Read-boundary sanitization for stored source metadata.
 *
 * Legacy and integration rows can predate capture validation, so public
 * surfaces must validate their scalar citation metadata without rewriting the
 * immutable stored artifact.
 */

import {
  SOURCE_TITLE_MAX_CODE_POINTS,
  SOURCE_URL_MAX_CODE_POINTS,
  detectHighConfidenceSecret,
} from "./ingest";

export const SOURCE_LABEL_MAX_CODE_POINTS = 512;

export type SourceMetadataOutputContext = "team_public" | "owner_mcp";

export interface SourceMetadataForOutput {
  source?: unknown;
  sourceTitle?: unknown;
  sourceUrl?: unknown;
}

export interface SanitizedSourceMetadata {
  source: string | null;
  sourceTitle: string | null;
  sourceUrl: string | null;
}

const FORBIDDEN_OUTPUT_CONTROL = /[\u0000-\u001f\u007f\u2028\u2029]/u;
const FORBIDDEN_OWNER_URI_SCHEMES = new Set([
  "about:",
  "blob:",
  "data:",
  "file:",
  "javascript:",
  "vbscript:",
]);
const BARE_DOI = /^10\.\d{4,9}\/\S+$/iu;

export function sanitizeBoundedMetadataForOutput(
  value: unknown,
  maxCodePoints: number,
): string | null {
  if (typeof value !== "string" || !value) return null;
  if (Array.from(value).length > maxCodePoints) return null;
  if (FORBIDDEN_OUTPUT_CONTROL.test(value)) return null;
  return detectHighConfidenceSecret(value) ? null : value;
}

function sanitizeSourceUrlForOutput(
  value: unknown,
  context: SourceMetadataOutputContext,
): string | null {
  const bounded = sanitizeBoundedMetadataForOutput(value, SOURCE_URL_MAX_CODE_POINTS);
  if (!bounded || /\s/u.test(bounded)) return null;
  if (context === "owner_mcp" && BARE_DOI.test(bounded)) return bounded;

  try {
    const parsed = new URL(bounded);
    if (parsed.username || parsed.password) return null;
    if (context === "team_public") {
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
      if (!/^https?:\/\//iu.test(bounded)) return null;
    } else if (FORBIDDEN_OWNER_URI_SCHEMES.has(parsed.protocol.toLowerCase())) {
      return null;
    }
    return bounded;
  } catch {
    return null;
  }
}

export function sanitizeSourceMetadataForOutput(
  metadata: SourceMetadataForOutput,
  context: SourceMetadataOutputContext,
): SanitizedSourceMetadata {
  return {
    source: sanitizeBoundedMetadataForOutput(metadata.source, SOURCE_LABEL_MAX_CODE_POINTS),
    sourceTitle: sanitizeBoundedMetadataForOutput(
      metadata.sourceTitle,
      SOURCE_TITLE_MAX_CODE_POINTS,
    ),
    sourceUrl: sanitizeSourceUrlForOutput(metadata.sourceUrl, context),
  };
}
