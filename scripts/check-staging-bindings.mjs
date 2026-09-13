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
 * steps use authenticated Cloudflare control-plane reads and account whoami.
 * A saved manifest is reverified against both before every destructive run.
 *
 * Usage:
 *   SLM_ENVIRONMENT=staging \
 *   SLM_URL=https://staging.example.test \
 *   SLM_EXPECTED_DEPLOYMENT_ID=slm-fractals-staging \
 *   SLM_KEY_FILE=/path/to/monitoring.key \
 *   node scripts/check-staging-bindings.mjs
 */

import { readFileSync, writeFileSync, constants, openSync, fstatSync, closeSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  STAGING_ENVIRONMENT,
  STAGING_DEPLOYMENT_ID,
  PRODUCTION_DEPLOYMENT_ID,
  parseStrictUrl,
  isProductionOrigin,
  readKeyFile,
  validateStageManifest,
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
  const stripped = stripJsoncComments(text);
  let out = "", inString = false;
  for (let i = 0; i < stripped.length; i++) {
    const c = stripped[i];
    if (inString && c === "\\") { out += c + stripped[++i]; continue; }
    if (c === '"') inString = !inString;
    if (!inString && c === "," && /^\s*[}\]]/.test(stripped.slice(i + 1))) continue;
    out += c;
  }
  return JSON.parse(out);
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
      account_id: v?.account_id ?? slice.account_id ?? null,
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

// The transport is injectable only by import, so tests can use loopback servers
// without adding a CLI bypass for production safety checks.
export function requireCheck(condition, code) {
  if (!condition) throw new Error(code);
}

export async function requestText(fetchImpl, url, init = {}, timeoutMs = 60_000) {
  const response = await fetchImpl(url, {
    ...init, redirect: "manual", signal: AbortSignal.timeout(timeoutMs),
  });
  requireCheck(response.status < 300 || response.status >= 400, "redirect_refused");
  const body = await response.text(); // Includes complete SSE, not first token.
  return { response, body };
}

export function writePrivateJson(path, value) {
  const fd = openSync(resolve(path), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, JSON.stringify(value, null, 2) + "\n"); }
  finally { closeSync(fd); }
}

export function readPrivateJson(path) {
  const fd = openSync(resolve(path), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    requireCheck(stat.isFile() && (stat.mode & 0o077) === 0, "manifest_permissions");
    return JSON.parse(readFileSync(fd, "utf8"));
  } finally { closeSync(fd); }
}

export function cloudflareClient(env, fetchImpl = fetch) {
  const account = env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const token = env.CLOUDFLARE_API_TOKEN_FILE
    ? readKeyFile(env.CLOUDFLARE_API_TOKEN_FILE).key : env.CLOUDFLARE_API_TOKEN?.trim();
  requireCheck(/^[a-f0-9]{32}$/i.test(account ?? "") && token, "cloudflare_credentials_required");
  return async (path, body) => {
    const { response, body: text } = await requestText(fetchImpl,
      `https://api.cloudflare.com/client/v4/accounts/${account}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    let json;
    try { json = JSON.parse(text); } catch { throw new Error("cloudflare_invalid_json"); }
    requireCheck(response.ok && json?.success === true && json.result != null, "cloudflare_request_failed");
    return json.result;
  };
}

function validIdentifier(value) {
  return typeof value === "string" && value.length > 0 && !/REPLACE_|PLACEHOLDER/i.test(value);
}

function validateSnapshot(snapshot) {
  requireCheck(failClosedMissing(snapshot).length === 0, "bindings_missing");
  for (const binding of snapshot.d1_databases) {
    requireCheck(validIdentifier(binding.binding) && /^[a-f0-9-]{36}$/i.test(binding.database_id), "d1_binding_invalid");
  }
  for (const binding of snapshot.kv_namespaces) {
    requireCheck(validIdentifier(binding.binding) && /^[a-f0-9]{32}$/i.test(binding.id), "kv_binding_invalid");
  }
  for (const binding of snapshot.vectorize) {
    requireCheck(validIdentifier(binding.binding) && validIdentifier(binding.index_name)
      && /^[a-f0-9]{32}$/i.test(binding.account_id), "vectorize_binding_invalid");
  }
  requireCheck(snapshot.d1_databases.some(b => b.binding === "DB")
    && snapshot.kv_namespaces.some(b => b.binding === "OAUTH_KV")
    && snapshot.vectorize.some(b => b.binding === "VECTORIZE"), "required_binding_names_missing");
}

function sortedBindings(snapshot) {
  return JSON.stringify({
    ...snapshot,
    d1_databases: [...snapshot.d1_databases].sort((a, b) => a.binding.localeCompare(b.binding)),
    kv_namespaces: [...snapshot.kv_namespaces].sort((a, b) => a.binding.localeCompare(b.binding)),
    vectorize: [...snapshot.vectorize].sort((a, b) => a.binding.localeCompare(b.binding)),
  });
}

export async function effectiveBindings(configPath, account) {
  const { unstable_readConfig, experimental_readRawConfig } = await import("wrangler");
  const { rawConfig } = experimental_readRawConfig({ config: configPath });
  requireCheck(rawConfig.envs === undefined && rawConfig.env?.staging, "staging_environment_missing");
  // Require explicit declarations even for fields Wrangler would inherit.
  for (const name of ["d1_databases", "kv_namespaces", "vectorize", "vars", "assets", "ai"]) {
    requireCheck(Object.hasOwn(rawConfig.env.staging, name), `staging_${name}_missing`);
  }
  const productionConfig = unstable_readConfig({ config: configPath }, { hideWarnings: true });
  const stagingConfig = unstable_readConfig({ config: configPath, env: "staging" }, { hideWarnings: true });
  requireCheck(!stagingConfig.account_id || stagingConfig.account_id === account, "account_mismatch");
  const production = buildDenylist({ ...productionConfig, account_id: productionConfig.account_id || account });
  const staging = collectBindings({ ...stagingConfig, account_id: account });
  validateSnapshot(production);
  validateSnapshot(staging);
  requireCheck(compareBindings(staging, production).length === 0, "production_binding_refused");
  return { staging, production, vars: stagingConfig.vars };
}

export async function verifyStaging({ env = process.env, fetchImpl = fetch } = {}) {
  const expectedId = env.SLM_EXPECTED_DEPLOYMENT_ID?.trim();
  const expectedRelease = env.SLM_EXPECTED_RELEASE_ID?.trim();
  requireCheck(/^[a-f0-9]{40}$/i.test(expectedRelease || ""), "expected_release_required");
  requireCheck(env.SLM_ENVIRONMENT === "staging" && expectedId, "staging_identity_required");
  const { url, errors } = parseStrictUrl(env.SLM_URL);
  requireCheck(url && errors.length === 0 && url.protocol === "https:"
    && url.pathname === "/" && !url.search, "staging_origin_invalid");
  requireCheck(!isProductionOrigin(url.origin, env.SLM_PRODUCTION_URL ? [env.SLM_PRODUCTION_URL] : []), "production_origin_refused");
  const key = readKeyFile(env.SLM_KEY_FILE);
  requireCheck(key.ok, key.errors.join(","));
  const cf = cloudflareClient(env, fetchImpl);
  const account = env.CLOUDFLARE_ACCOUNT_ID.trim();
  const local = await effectiveBindings(resolve(env.SLM_WRANGLER_FILE || "wrangler.jsonc"), account);
  // Release SHA is supplied to wrangler deploy --var, avoiding a tracked self-reference.
  local.vars.SLM_RELEASE_ID = expectedRelease;
  requireCheck(local.staging.deployment_id === expectedId && local.vars.SLM_ENVIRONMENT === "staging"
    && local.vars.SLM_PUBLIC_BASE_URL === url.origin && local.vars.SLM_WRITE_MODE === "enabled"
    && validIdentifier(local.vars.SLM_RELEASE_ID), "local_deployment_mismatch");

  const script = encodeURIComponent(local.staging.script_name);
  const deployments = await cf(`/workers/scripts/${script}/deployments`);
  const active = deployments?.deployments?.[0];
  requireCheck(active?.versions?.length === 1 && active.versions[0].percentage === 100,
    "staging_requires_one_active_version");
  const versionId = active.versions[0].version_id;
  requireCheck(validIdentifier(versionId), "worker_version_missing");
  const version = await cf(`/workers/scripts/${script}/versions/${encodeURIComponent(versionId)}`);
  requireCheck(version?.id === versionId && Array.isArray(version.resources?.bindings), "deployed_bindings_missing");
  const bindings = version.resources.bindings;
  const vars = Object.fromEntries(bindings.filter(b => b.type === "plain_text").map(b => [b.name, b.text]));
  const deployed = collectBindings({
    name: local.staging.script_name, vars, account_id: account,
    d1_databases: bindings.filter(b => b.type === "d1").map(b => ({ binding: b.name, database_id: b.id })),
    kv_namespaces: bindings.filter(b => b.type === "kv_namespace").map(b => ({ binding: b.name, id: b.namespace_id })),
    vectorize: bindings.filter(b => b.type === "vectorize").map(b => ({ binding: b.name, index_name: b.index_name })),
  });
  validateSnapshot(deployed);
  requireCheck(compareBindings(deployed, local.production).length === 0, "production_binding_refused");
  requireCheck(sortedBindings(deployed) === sortedBindings(local.staging), "local_deployed_bindings_mismatch");
  for (const field of ["SLM_DEPLOYMENT_ID", "SLM_ENVIRONMENT", "SLM_PUBLIC_BASE_URL", "SLM_RELEASE_ID", "SLM_WRITE_MODE"]) {
    requireCheck(vars[field] === local.vars[field], "deployed_vars_mismatch");
  }

  const { response, body } = await requestText(fetchImpl, `${url.origin}/api/whoami`, {
    headers: { Authorization: `Bearer ${key.key}` },
  });
  let envelope;
  try { envelope = JSON.parse(body); } catch { throw new Error("whoami_invalid_json"); }
  const identity = envelope?.data;
  requireCheck(response.ok && envelope?.ok === true && identity?.principal?.id
    && identity.credential_type === "personal_api_key", "whoami_failed");
  const check = validateWhoami(identity, { expectedDeploymentId: expectedId, expectedOrigin: url.origin });
  requireCheck(check.ok && identity.deployment.release_id === vars.SLM_RELEASE_ID
    && identity.deployment.write_mode === "enabled", "whoami_deployment_mismatch");
  // Recheck deployment after identity lookup so an intervening rollout fails.
  const current = await cf(`/workers/scripts/${script}/deployments`);
  requireCheck(JSON.stringify(current.deployments?.[0]?.versions) === JSON.stringify(active.versions), "deployment_changed_during_preflight");
  return {
    schema_version: 1, verified_at: new Date().toISOString(),
    origin: url.origin, environment: "staging", deployment_id: expectedId,
    release_id: vars.SLM_RELEASE_ID, worker_version_id: versionId,
    account_id: account, script_name: local.staging.script_name,
    bindings: deployed, production_bindings: local.production,
  };
}

function proofFingerprint(manifest) {
  const { verified_at, ...proof } = manifest;
  return createHash("sha256").update(JSON.stringify(proof)).digest("hex");
}

export async function readVerifiedStage({ env = process.env, fetchImpl = fetch } = {}) {
  requireCheck(env.SLM_MANIFEST_FILE, "manifest_file_required");
  const saved = readPrivateJson(env.SLM_MANIFEST_FILE);
  requireCheck(validateStageManifest(saved, { expectedDeploymentId: env.SLM_EXPECTED_DEPLOYMENT_ID }).ok,
    "manifest_invalid");
  const verified = await verifyStaging({ env, fetchImpl });
  requireCheck(proofFingerprint(saved) === proofFingerprint(verified), "manifest_stale_or_changed");
  return verified;
}

export async function runPreflight({ env = process.env, argv = process.argv.slice(2), fetchImpl = fetch } = {}) {
  if (argv.includes("--help")) {
    console.log("SLM_ENVIRONMENT=staging SLM_URL=<origin> SLM_EXPECTED_DEPLOYMENT_ID=<id> SLM_EXPECTED_RELEASE_ID=<40hex SHA> SLM_KEY_FILE=<0600 file> CLOUDFLARE_ACCOUNT_ID=<id> CLOUDFLARE_API_TOKEN=<token> SLM_MANIFEST_FILE=<new file> node scripts/check-staging-bindings.mjs [--wrangler <config>]");
    return;
  }
  const options = { ...env };
  for (let i = 0; i < argv.length; i++) {
    const field = { "--wrangler": "SLM_WRANGLER_FILE", "--key-file": "SLM_KEY_FILE", "--manifest": "SLM_MANIFEST_FILE" }[argv[i]];
    requireCheck(field && argv[i + 1] && !argv[i + 1].startsWith("--"), "invalid_argument");
    options[field] = argv[++i];
  }
  requireCheck(options.SLM_MANIFEST_FILE, "manifest_file_required");
  const verified = await verifyStaging({ env: options, fetchImpl });
  writePrivateJson(options.SLM_MANIFEST_FILE, verified);
  console.log(JSON.stringify({ ok: true, deployment_id: verified.deployment_id, worker_version_id: verified.worker_version_id }));
  return verified;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await runPreflight(); }
  catch (error) {
    // Never print upstream bodies, network diagnostics or credentials.
    console.error(`STAGING_BINDINGS_FAILED: ${/^[a-z0-9_,]+$/.test(error.message) ? error.message : "request_or_configuration_failed"}`);
    process.exitCode = 1;
  }
}
