/**
 * runbook-contract.test.ts
 *
 * Section 16.1/16.2: the operator runbook is part of the release contract. It
 * must describe the maintenance mode and a recovery procedure that is compatible
 * with capture receipts — never a downgrade to a pre-receipt writer, and never a
 * D1 wipe or a Vectorize-only rebuild.
 *
 * This asserts the documented procedure's properties, not its prose: the
 * forbidden operations must be absent and the required safety steps present.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const runbook = readFileSync(
  join(process.cwd(), "docs", "team-pilot", "operator-runbook.md"),
  "utf8",
);

/** The recovery section only, so unrelated prose cannot satisfy or break a rule. */
function section(title: string): string {
  const start = runbook.indexOf(`## ${title}`);
  if (start < 0) throw new Error(`section not found: ${title}`);
  const rest = runbook.slice(start + title.length);
  const next = rest.indexOf("\n## ");
  return next < 0 ? rest : rest.slice(0, next);
}

const recovery = section("Recovery");
const maintenance = section("Incident: enable read-only maintenance");
const monitoring = section("Health monitoring");

describe("runbook documents the maintenance contract", () => {
  it("names the write-mode variable and the read-only readiness status", () => {
    expect(maintenance).toContain("SLM_WRITE_MODE=read-only");
    expect(maintenance).toContain("maintenance_read_only");
  });

  it("states that reads keep working and that the mutation-bearing digest is refused", () => {
    expect(maintenance).toMatch(/read tools keep working/i);
    expect(maintenance).toContain("/digest");
    expect(maintenance).toMatch(/refused|refuse/i);
  });

  it("names the deep guard so operators know background jobs cannot bypass it", () => {
    expect(maintenance).toContain("commitEntryVersion");
    expect(maintenance).toContain("eraseEntryArtifacts");
  });
});

describe("runbook recovery is compatible with capture receipts", () => {
  it("never designates a rollback to an older writer", () => {
    // `wrangler rollback` moves to a previous deployment, which may predate
    // capture receipts and erased-key tombstones.
    expect(recovery).not.toMatch(/wrangler rollback/);
    expect(recovery).toMatch(/never a downgrade/i);
  });

  it("never instructs a destructive database operation", () => {
    // D1 is the authority. No recovery step may drop, truncate or bulk-delete.
    expect(recovery).not.toMatch(/DROP\s+TABLE/i);
    expect(recovery).not.toMatch(/DELETE\s+FROM/i);
    expect(recovery).not.toMatch(/TRUNCATE/i);
    expect(recovery).not.toMatch(/d1\s+(delete|execute).*--remote/i);
    expect(recovery).not.toMatch(/clear (the )?(entries|tables|database)/i);
    // And it must say so explicitly, so an operator does not improvise one.
    expect(recovery).toMatch(/never wipe D1/i);
    expect(recovery).toMatch(/n?ever rebuild authority from Vectorize/i);
  });

  it("requires in-flight work to drain before any restore", () => {
    expect(recovery).toMatch(/in-flight/i);
    expect(recovery).toMatch(/blocks a restore/i);
  });

  it("preserves erased-key tombstones and accepted receipts across recovery", () => {
    expect(recovery).toContain("capture_receipts");
    expect(recovery).toContain("capture_erased");
    expect(recovery).toMatch(/remain authoritative/i);
  });

  it("verifies the four established principals instead of forcing a rotation", () => {
    expect(recovery).toMatch(/Jarvis, researcher, engineer and clients/);
    expect(recovery).toMatch(/must not rotate, re-export/i);
  });

  it("ends by resuming writes only after readiness returns to ready", () => {
    expect(recovery).toMatch(/SLM_WRITE_MODE=enabled/);
    expect(recovery).toMatch(/200 ready/);
  });

  it("documents the fail-closed readiness behavior in monitoring", () => {
    expect(monitoring).toContain("missing_configuration");
    expect(monitoring).toMatch(/fail-closed/i);
  });
});
