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

export function sanitizeBoundedMetadataForOutput(
  value: unknown,
  maxCodePoints: number,
): string | null {
  if (typeof value !== "string" || !value) return null;
  if (Array.from(value).length > maxCodePoints) return null;
  return detectHighConfidenceSecret(value) ? null : value;
}

function sanitizeSourceUrlForOutput(value: unknown): string | null {
  const bounded = sanitizeBoundedMetadataForOutput(value, SOURCE_URL_MAX_CODE_POINTS);
  if (!bounded || bounded !== bounded.trim()) return null;
  try {
    const parsed = new URL(bounded);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (parsed.username || parsed.password) return null;
    return bounded;
  } catch {
    return null;
  }
}

export function sanitizeSourceMetadataForOutput(
  sourceTitle: unknown,
  sourceUrl: unknown,
): { sourceTitle: string | null; sourceUrl: string | null } {
  return {
    sourceTitle: sanitizeBoundedMetadataForOutput(sourceTitle, SOURCE_TITLE_MAX_CODE_POINTS),
    sourceUrl: sanitizeSourceUrlForOutput(sourceUrl),
  };
}
