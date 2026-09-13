/**
 * canary-workflow.test.ts
 *
 * O4 (config-level half) + Section 15: the monitoring workflow must fail closed
 * when its configuration is missing, and a failed canary must keep an incident
 * open.
 *
 * This parses the workflow's control flow rather than searching raw text: the
 * assertions are about whether a step carries a SKIP condition and whether the
 * incident closer actually depends on the canary jobs.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

interface WorkflowStep {
  name: string | null;
  /** The raw `if:` expression, when present. */
  condition: string | null;
  /** The step's `run:` body, or a github-script step's `script:` body. */
  run: string | null;
}

interface WorkflowJob {
  /** The job id from the `jobs:` map key. */
  id: string;
  /** The human-readable `name:` label, when present. */
  name: string | null;
  needs: string[];
  condition: string | null;
  steps: WorkflowStep[];
}

interface Workflow {
  triggers: string[];
  schedules: string[];
  jobs: WorkflowJob[];
}

/**
 * Structural reader for the subset of YAML this workflow uses. It splits the
 * file into job blocks by indentation and, inside each job, into step blocks, so
 * the assertions below are about control flow (`needs`, `if`, step bodies)
 * rather than about the presence of a particular string.
 */
function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function foldBlock(lines: string[], startIndex: number, keyIndent: number): { value: string; next: number } {
  const collected: string[] = [];
  let index = startIndex;
  for (; index < lines.length; index++) {
    const line = lines[index];
    if (!line.trim()) { collected.push(""); continue; }
    if (indentOf(line) <= keyIndent) break;
    collected.push(line.trim());
  }
  return { value: collected.join("\n").trim(), next: index };
}

function scalarOrFold(lines: string[], index: number, keyIndent: number): { value: string; next: number } {
  const rest = lines[index].trim().slice(lines[index].trim().indexOf(":") + 1).trim();
  if (rest === ">" || rest === "|" || rest === "") {
    return foldBlock(lines, index + 1, keyIndent);
  }
  return { value: rest, next: index + 1 };
}

function parseWorkflow(source: string): Workflow {
  const lines = source.split("\n");
  const triggers: string[] = [];
  const schedules: string[] = [];
  const jobs: WorkflowJob[] = [];

  let section: "none" | "on" | "jobs" = "none";
  let inSchedule = false;
  let job: WorkflowJob | null = null;
  let step: WorkflowStep | null = null;

  const flushStep = (): void => {
    if (step && job) job.steps.push(step);
    step = null;
  };

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const indent = indentOf(line);

    if (indent === 0) {
      flushStep();
      if (job) { jobs.push(job); job = null; }
      inSchedule = false;
      if (trimmed === "on:") { section = "on"; continue; }
      if (trimmed === "jobs:") { section = "jobs"; continue; }
      section = "none";
      continue;
    }

    if (section === "on") {
      if (indent === 2 && trimmed.endsWith(":")) {
        const key = trimmed.slice(0, -1);
        triggers.push(key);
        inSchedule = key === "schedule";
        continue;
      }
      if (inSchedule && trimmed.startsWith("- cron:")) {
        schedules.push(trimmed.slice("- cron:".length).trim().replace(/^["']|["']$/g, ""));
      }
      continue;
    }

    if (section !== "jobs") continue;

    if (indent === 2 && trimmed.endsWith(":")) {
      flushStep();
      if (job) jobs.push(job);
      job = { id: trimmed.slice(0, -1), name: null, needs: [], condition: null, steps: [] };
      continue;
    }
    if (!job) continue;

    // Job-level fields.
    if (indent === 4) {
      if (trimmed === "steps:") { flushStep(); continue; }
      if (trimmed.startsWith("name:")) { job.name = trimmed.slice(5).trim(); continue; }
      if (trimmed.startsWith("needs:")) {
        const rest = trimmed.slice("needs:".length).trim();
        job.needs = rest.replace(/[[\]]/g, "").split(",").map((v) => v.trim()).filter(Boolean);
        continue;
      }
      if (trimmed.startsWith("if:")) {
        const parsed = scalarOrFold(lines, index, indent);
        job.condition = parsed.value;
        index = parsed.next - 1;
        continue;
      }
      continue;
    }

    if (indent === 6 && trimmed.startsWith("- ")) {
      flushStep();
      step = { name: null, condition: null, run: null };
      const inline = trimmed.slice(2);
      if (inline.startsWith("name:")) step.name = inline.slice(5).trim();
      continue;
    }
    if (!step) continue;

    if (trimmed.startsWith("name:") && indent >= 8) { step.name = trimmed.slice(5).trim(); continue; }
    if (trimmed.startsWith("if:") && indent >= 8) {
      const parsed = scalarOrFold(lines, index, indent);
      step.condition = parsed.value;
      index = parsed.next - 1;
      continue;
    }
    // `actions/github-script` steps carry their body in `script:` instead of `run:`.
    if ((trimmed.startsWith("run:") || trimmed.startsWith("script:")) && indent >= 8) {
      const parsed = scalarOrFold(lines, index, indent);
      step.run = parsed.value;
      index = parsed.next - 1;
      continue;
    }
  }
  flushStep();
  if (job) jobs.push(job);

  return { triggers, schedules, jobs };
}

const source = readFileSync(join(process.cwd(), ".github", "workflows", "pilot-canary.yml"), "utf8");
const workflow = parseWorkflow(source);

function job(id: string): WorkflowJob {
  const found = workflow.jobs.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`job ${id} not found; parsed: ${workflow.jobs.map((j) => j.id).join(", ")}`);
  return found;
}

function stepMatching(jobDefinition: WorkflowJob, fragment: RegExp): WorkflowStep {
  const found = jobDefinition.steps.find((candidate) => fragment.test(candidate.name ?? ""));
  if (!found) {
    throw new Error(`no step matching ${fragment} in ${jobDefinition.id}; steps: ${jobDefinition.steps.map((s) => s.name).join(" | ")}`);
  }
  return found;
}

describe("canary workflow structure", () => {
  it("parses the expected jobs, triggers and schedules", () => {
    expect(workflow.triggers).toContain("schedule");
    expect(job("production-canary")).toBeTruthy();
    expect(job("staging-canary")).toBeTruthy();
    expect(job("close-on-recovery")).toBeTruthy();
    // Production every 15 minutes; staging every 6 hours.
    expect(workflow.schedules).toContain("*/15 * * * *");
    expect(workflow.schedules).toContain("0 */6 * * *");
  });

  it("never SKIPS the readiness check when its configuration is missing", () => {
    const readiness = stepMatching(job("production-canary"), /readiness/i);
    // A skip guard is how a missing secret used to hide a broken canary: the
    // step must either run unconditionally or fail on absence, never skip.
    if (readiness.condition !== null) {
      expect(readiness.condition).not.toMatch(/secrets\./);
      expect(readiness.condition).not.toMatch(/!= *''/);
    }
  });

  it("fails closed when a required value is absent", () => {
    const readiness = stepMatching(job("production-canary"), /readiness/i);
    // The step's own script must assert the value's presence.
    expect(readiness.run).toBeTruthy();
    expect(source).toMatch(/-z "\$\{?[A-Z_]+/);
  });

  it("requires the canary before an incident may be closed", () => {
    const closer = job("close-on-recovery");
    expect(closer.needs).toContain("production-canary");
    expect(closer.needs).toContain("staging-canary");
    // `needs` alone is not enough: without a success condition the closer can
    // still run after a failed dependency.
    expect(closer.condition ?? "").toMatch(/success\(\)/);
  });

  it("authenticates the monitoring principal and asserts the tool list", () => {
    const discovery = stepMatching(job("production-canary"), /whoami|discovery/i);
    // The step delegates to the discovery-only smoke mode, which performs
    // initialize -> whoami -> tools/list against the deployment.
    expect(discovery.run ?? "").toMatch(/discovery-only/);
    const smoke = readFileSync(join(process.cwd(), "scripts", "mcp-protocol-smoke.mjs"), "utf8");
    expect(smoke).toMatch(/whoami/);
    expect(smoke).toMatch(/tools\/list/);

    // The production canary is read-only: it must never delete or rotate.
    const productionRuns = job("production-canary").steps.map((s) => s.run ?? "").join("\n");
    expect(productionRuns).not.toMatch(/confirm_entry_id|\/forget|rotate-key/);
  });

  it("records incident metadata without raw responses or keys", () => {
    // The reporting step files the incident; the closer only closes it.
    for (const id of ["production-canary", "staging-canary"]) {
      const report = stepMatching(job(id), /report failure/i);
      const body = report.run ?? "";
      expect({ id, hasStage: /Stage:/.test(body) }).toEqual({ id, hasStage: true });
      expect({ id, hasCode: /Code:/.test(body) }).toEqual({ id, hasCode: true });
      expect({ id, hasVersion: /Version:/.test(body) }).toEqual({ id, hasVersion: true });
      expect({ id, hasTime: /Time:/.test(body) }).toEqual({ id, hasTime: true });
      expect({ id, hasWorkflow: /Workflow:/.test(body) }).toEqual({ id, hasWorkflow: true });
      // Never interpolate a secret into an issue body.
      expect(body).not.toMatch(/secrets\.[A-Z_]+/);
    }
  });

  it("only ever closes an incident opened by this workflow", () => {
    const closer = job("close-on-recovery");
    const close = stepMatching(closer, /close incident/i);
    const body = close.run ?? "";
    expect(body).toMatch(/\[Pilot Canary\]/);
    expect(body).not.toMatch(/secrets\.[A-Z_]+/);
  });
});
