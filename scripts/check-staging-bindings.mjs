#!/usr/bin/env node
/**
 * check-staging-bindings.mjs — staging isolation preflight (WP9 / spec §13).
 *
 * Compares BOTH the effective local Wrangler configuration AND the deployed
 * staging version's control-plane binding metadata against production. Rejects
 * any shared D1 database id, shared KV namespace id, shared Vectorize index
 * name/account pair, the production script name, or the production deployment
 * id. Requires environment=staging and a matching expected stage
 * origin/deployment id taken from an authenticated whoami response. Missing or
 * unknown fields fail closed — a healthy /ready or a hostname substring is
 * explicitly NOT sufficient proof.
 *
 * Production binding ids present in the top-level (non-environment) section of
 * wrangler.jsonc are the denylist baseline.
 *
 * Pure helpers are exported for `test/unit/staging-scripts.test.ts`. Remote
 * steps (deployed control-plane metadata, authenticated whoami) require
 * Cloudflare credentials that are not present in this environment.
 *
 * Usage:
 *   SLM_ENVIRONMENT=staging \
 *   SLM_URL=https://staging.example.test \
 *   SLM_EXPECTED_DEPLOYMENT_ID=slm-fractals-staging \
 *   SLM_KEY_FILE=/path/to/monitoring.key \
 *   node scripts/check-staging-bindings.mjs
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  STAGING_ENVIRONMENT,
  STAGING_DEPLOYMENT_ID,
  PRODUCTION_DEPLOYMENT_ID,
  parseStrictUrl,
  isProductionOrigin,
} from "./staging-agent-load.mjs";

// ─── JSONC handling (stdlib only) ────────────────────────────────────────────

/** Remove // and block comments while preserving string contents and newlines.
 * @param {string} text
 * @returns {string}
 */
export function stripJsoncComments(text) {
  let out = "";
  let inString = false;
  let inBlock = false;
  let inLine = false;
  let quote = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (inBlock) {
      if (c === "*" && next === "/") {
        inBlock = false;
        i++;
      } else if (c === "\n") {
        out += "\n";
      }
      continue;
    }
    if (inLine) {
      if (c === "\n") {
        inLine = false;
        out += "\n";
      }
      continue;
    }
    if (inString) {
      out += c;
      if (c === "\\" && next !== undefined) {
        out += next;
        i++;
      } else if (c === quote) {
        inString = false;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      inString = true;
      quote = c;
      out += c;
      continue;
    }
    if (c === "/" && next === "/") {
      inLine = true;
      i++;
      continue;
    }
    if (c === "/" && next === "*") {
      inBlock = true;
      i++;
      continue;
    }
    out += c;
  }
  return out;
}

/** Parse JSONC text into an object, removing trailing commas outside strings.
 * @param {string} text
 * @returns {any}
 */
export function parseJsonc(text) {
  const stripped = stripJsoncComments(text).replace(/,\s*([}\]])/g, "$1");
  return JSON.parse(stripped);
}

// ─── Bindings snapshot / comparison ──────────────────────────────────────────

/**
 * @typedef {{ binding: (string|null), database_id: (string|null) }} D1Binding
 * @typedef {{ binding: (string|null), id: (string|null) }} KvBinding
 * @typedef {{ binding: (string|null), index_name: (string|null), account_id: (string|null) }} VectorizeBinding
 * @typedef {{
 *   script_name: (string|null),
 *   deployment_id: (string|null),
 *   d1_databases: D1Binding[],
 *   kv_namespaces: KvBinding[],
 *   vectorize: VectorizeBinding[]
 * }} BindingsSnapshot
 * @typedef {{ type: string, detail: string }} BindingViolation
 */

/**
 * Normalize a wrangler config slice (top-level or an environment block) into a
 * canonical bindings snapshot.
 *
 * @param {object} [slice]
 * @param {{ scriptName?: (string|null), deploymentId?: (string|null) }} [options]
 * @returns {BindingsSnapshot}
 */
export function collectBindings(slice = {}, { scriptName = null, deploymentId = null } = {}) {
  return {
    script_name: scriptName ?? slice.name ?? null,
    deployment_id: deploymentId ?? slice.vars?.SLM_DEPLOYMENT_ID ?? null,
    d1_databases: (slice.d1_databases ?? []).map(d => ({
      binding: d?.binding ?? null,
      database_id: d?.database_id ?? null,
    })),
    kv_namespaces: (slice.kv_namespaces ?? []).map(k => ({
      binding: k?.binding ?? null,
      id: k?.id ?? null,
    })),
    vectorize: (slice.vectorize ?? []).map(v => ({
      binding: v?.binding ?? null,
      index_name: v?.index_name ?? null,
      account_id: v?.account_id ?? null,
    })),
  };
}

/** Build the production denylist baseline from the top-level wrangler config.
 * @param {object} [config]
 * @param {{ productionDeploymentId?: string }} [options]
 * @returns {BindingsSnapshot}
 */
export function buildDenylist(config = {}, { productionDeploymentId = PRODUCTION_DEPLOYMENT_ID } = {}) {
  return collectBindings(config, {
    scriptName: config?.name ?? null,
    deploymentId: config?.vars?.SLM_DEPLOYMENT_ID ?? productionDeploymentId,
  });
}

/**
 * @param {(string|null|undefined)} a
 * @param {(string|null|undefined)} b
 * @returns {boolean}
 */
function vectorizeAccountOverlaps(a, b) {
  // Same name only counts as a shared resource when the account pair matches.
  // An unknown account on either side fails closed (treated as overlapping).
  if (!a || !b) return true;
  return a === b;
}

/**
 * Compare staging bindings against the production denylist.
 *
 * @param {BindingsSnapshot} staging
 * @param {BindingsSnapshot} production
 * @returns {BindingViolation[]}
 */
export function compareBindings(staging, production) {
  const violations = [];
  const stagingBindings = staging ?? {};
  const prod = production ?? {};

  const prodD1 = new Set((prod.d1_databases ?? []).map(d => d?.database_id).filter(Boolean));
  for (const d of stagingBindings.d1_databases ?? []) {
    if (d?.database_id && prodD1.has(d.database_id)) {
      violations.push({ type: "shared_d1_id", detail: d.database_id });
    }
  }

  const prodKv = new Set((prod.kv_namespaces ?? []).map(k => k?.id).filter(Boolean));
  for (const k of stagingBindings.kv_namespaces ?? []) {
    if (k?.id && prodKv.has(k.id)) {
      violations.push({ type: "shared_kv_id", detail: k.id });
    }
  }

  for (const v of stagingBindings.vectorize ?? []) {
    for (const p of prod.vectorize ?? []) {
      if (v?.index_name && v.index_name === p?.index_name && vectorizeAccountOverlaps(v.account_id, p.account_id)) {
        violations.push({ type: "shared_vectorize_index", detail: v.index_name });
      }
    }
  }

  if (stagingBindings.script_name && stagingBindings.script_name === prod.script_name) {
    violations.push({ type: "production_script_name", detail: stagingBindings.script_name });
  }
  if (stagingBindings.deployment_id && stagingBindings.deployment_id === prod.deployment_id) {
    violations.push({ type: "production_deployment_id", detail: stagingBindings.deployment_id });
  }
  return violations;
}

/**
 * Fail-closed field check: a staging configuration MUST explicitly declare a
 * script name, deployment id, at least one D1 database id, at least one KV
 * namespace id, and at least one Vectorize index name (no production
 * inheritance).
 *
 * @param {BindingsSnapshot} bindings
 * @returns {string[]}
 */
export function failClosedMissing(bindings) {
  const missing = [];
  if (!bindings?.script_name) missing.push("script_name");
  if (!bindings?.deployment_id) missing.push("deployment_id");
  const d1 = bindings?.d1_databases ?? [];
  if (!d1.length || d1.some(d => !d?.database_id)) missing.push("d1_database_id");
  const kv = bindings?.kv_namespaces ?? [];
  if (!kv.length || kv.some(k => !k?.id)) missing.push("kv_namespace_id");
  const vectorize = bindings?.vectorize ?? [];
  if (!vectorize.length || vectorize.some(v => !v?.index_name)) missing.push("vectorize_index_name");
  return missing;
}

// ─── whoami validation ───────────────────────────────────────────────────────

/**
 * Validate an authenticated whoami response. Fails closed on missing or
 * mismatched deployment metadata. The deployment object has
 * { id, environment, canonical_url, release_id, write_mode }.
 *
 * @param {object} whoami
 * @param {{ expectedEnvironment?: string, expectedDeploymentId?: string, expectedOrigin?: string }} [options]
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateWhoami(whoami, { expectedEnvironment = STAGING_ENVIRONMENT, expectedDeploymentId = STAGING_DEPLOYMENT_ID, expectedOrigin } = {}) {
  const errors = [];
  if (!whoami || typeof whoami !== "object") {
    return { ok: false, errors: ["whoami_missing"] };
  }
  const deployment = whoami.deployment;
  if (!deployment || typeof deployment !== "object") {
    return { ok: false, errors: ["whoami_deployment_missing"] };
  }
  if (typeof deployment.id !== "string" || !deployment.id) errors.push("deployment_id_missing");
  else if (expectedDeploymentId && deployment.id !== expectedDeploymentId) errors.push("deployment_id_mismatch");
  if (typeof deployment.environment !== "string" || !deployment.environment) errors.push("environment_missing");
  else if (deployment.environment !== expectedEnvironment) errors.push("environment_not_staging");
  if (expectedOrigin) {
    if (typeof deployment.canonical_url !== "string" || !deployment.canonical_url) {
      errors.push("canonical_url_missing");
    } else {
      let origin;
      try {
        origin = new URL(deployment.canonical_url).origin;
      } catch {
        errors.push("canonical_url_invalid");
        origin = null;
      }
      if (origin && origin !== expectedOrigin) errors.push("canonical_url_origin_mismatch");
    }
  }
  return { ok: errors.length === 0, errors };
}

// ─── Config / CLI ─────────────────────────────────────────────────────────────

function fail(code, violations) {
  console.error(`STAGING_BINDINGS_${code}`);
  if (Array.isArray(violations) && violations.length) {
    console.error(JSON.stringify(violations));
  }
  process.exit(1);
}

function parseArgs(argv) {
  const args = { wranglerFile: null, deployedBindings: null, keyFile: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--wrangler") args.wranglerFile = argv[++i];
    else if (argv[i] === "--deployed-bindings") args.deployedBindings = argv[++i];
    else if (argv[i] === "--key-file") args.keyFile = argv[++i];
    else if (argv[i] === "--help") args.help = true;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("Usage: SLM_ENVIRONMENT=staging SLM_URL=<staging> SLM_EXPECTED_DEPLOYMENT_ID=<id> SLM_KEY_FILE=<file> node scripts/check-staging-bindings.mjs [--wrangler wrangler.jsonc] [--deployed-bindings deployed.json]");
    return;
  }

  const environment = process.env.SLM_ENVIRONMENT?.trim();
  const rawUrl = process.env.SLM_URL?.trim();
  const expectedDeploymentId = process.env.SLM_EXPECTED_DEPLOYMENT_ID?.trim() ?? STAGING_DEPLOYMENT_ID;
  const keyFilePath = args.keyFile ?? process.env.SLM_KEY_FILE;
  const wranglerFile = args.wranglerFile ?? process.env.SLM_WRANGLER_FILE ?? "wrangler.jsonc";

  if (environment !== STAGING_ENVIRONMENT) {
    fail("ENVIRONMENT", [{ type: "environment_required", detail: "SLM_ENVIRONMENT must be exactly 'staging'" }]);
  }
  if (!rawUrl) fail("CONFIG", [{ type: "url_required", detail: "SLM_URL is required" }]);
  if (!keyFilePath) fail("CONFIG", [{ type: "key_file_required", detail: "SLM_KEY_FILE is required" }]);

  // 1. Strict URL parse + refuse production origins (before any network use).
  const { url, errors: urlErrors } = parseStrictUrl(rawUrl);
  if (urlErrors.length) fail("URL", urlErrors.map(detail => ({ type: "url", detail })));
  if (isProductionOrigin(url.origin)) fail("URL", [{ type: "production_origin_refused", detail: url.origin }]);

  // 2. Local wrangler config: production denylist vs staging environment.
  let config;
  try {
    config = parseJsonc(readFileSync(resolve(wranglerFile), "utf8"));
  } catch (error) {
    fail("WRANGLER", [{ type: "wrangler_unreadable", detail: String(error.message ?? error) }]);
  }
  const denylist = buildDenylist(config);
  const stagingEnv = config?.envs?.[STAGING_ENVIRONMENT];
  if (!stagingEnv) {
    fail("WRANGLER", [{ type: "staging_environment_missing", detail: "wrangler.jsonc has no 'staging' environment" }]);
  }
  const localStaging = collectBindings(stagingEnv, {
    scriptName: stagingEnv.name ?? `${config.name}-staging`,
    deploymentId: expectedDeploymentId,
  });

  const missing = failClosedMissing(localStaging);
  if (missing.length) fail("WRANGLER", missing.map(detail => ({ type: "missing_field", detail })));

  const localViolations = compareBindings(localStaging, denylist);
  if (localViolations.length) fail("LOCAL_BINDINGS", localViolations);

  // 3. Deployed staging control-plane metadata (requires Cloudflare tooling).
  if (!args.deployedBindings) {
    // In a credentialed environment this step reads the deployed staging
    // version's bindings through authenticated Cloudflare tooling. Absent that
    // input we fail closed rather than silently skipping the comparison.
    fail("DEPLOYED_METADATA", [{ type: "deployed_metadata_unavailable", detail: "provide --deployed-bindings <json> produced by authenticated Cloudflare tooling" }]);
  }
  let deployed;
  try {
    deployed = JSON.parse(readFileSync(resolve(args.deployedBindings), "utf8"));
  } catch (error) {
    fail("DEPLOYED_METADATA", [{ type: "deployed_metadata_unreadable", detail: String(error.message ?? error) }]);
  }
  const deployedViolations = compareBindings(collectBindings(deployed, { scriptName: deployed?.script_name, deploymentId: deployed?.deployment_id }), denylist);
  if (deployedViolations.length) fail("DEPLOYED_BINDINGS", deployedViolations);

  // 4. Authenticated whoami (read-only) for origin/deployment proof.
  // Remote fetch requires a live staging deployment; implemented for a real run.
  fail("REMOTE_UNAVAILABLE", [{ type: "whoami_unavailable", detail: "authenticated whoami requires a live staging deployment (not present in this environment)" }]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
