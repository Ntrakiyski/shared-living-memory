import { readFileSync } from "node:fs";
import { readVerifiedStage } from "./check-staging-bindings.mjs";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const EXIT = {
  config: 2,
  users: 10,
  capture: 11,
  privacy: 12,
  public: 13,
  semanticZero: 14,
  semanticMissing: 15,
  semanticUnavailable: 16,
  duplicate: 17,
  cleanup: 18,
};
const productionOrigin = "https://shared-living-memory.nikolay-trakiyski.workers.dev";
export const REQUEST_TIMEOUT_MS = 10_000;

class CanaryFailure extends Error {
  constructor(code, exitCode, details = {}) {
    super(code);
    this.code = code;
    this.exitCode = exitCode;
    this.details = details;
  }
}

let baseUrl;
let adminKey;

export function buildCanaryScenario(suffix) {
  return {
    contents: {
      alicePrivate: `Canary ${suffix}: A crimson ledger rests beneath the attic floorboards.`,
      bobPrivate: `Canary ${suffix}: A cobalt folder is sealed inside the basement cabinet.`,
      alicePublic: `Canary ${suffix}: The records handbook recommends guarded storage for accounting volumes.`,
      semantic: `Canary ${suffix}: A rehearsal creature adores softly glowing amber illumination.`,
    },
    probes: [
      {
        name: "alice-own-private",
        actor: "alice",
        query: "Where is her hidden financial notebook concealed?",
        expected: "alicePrivate",
        forbidden: ["bobPrivate"],
      },
      {
        name: "bob-own-private",
        actor: "bob",
        query: "Where does he conceal the blue document binder?",
        expected: "bobPrivate",
        forbidden: ["alicePrivate"],
      },
      {
        name: "bob-public-privacy-decoy",
        actor: "bob",
        query: "What guidance is shared about protecting financial books?",
        expected: "alicePublic",
        forbidden: ["alicePrivate"],
      },
      {
        name: "alice-semantic",
        actor: "alice",
        query: "Which colour temperature is favored by the staging mascot?",
        expected: "semantic",
        forbidden: [],
      },
    ],
  };
}

export async function fetchWithTimeout(
  fetchImpl,
  input,
  init = {},
  timeoutMs = REQUEST_TIMEOUT_MS,
  consume = async response => response,
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(input, { ...init, redirect: "error", signal: controller.signal });
    return await consume(response);
  } finally {
    clearTimeout(timeout);
  }
}

async function request(path, { method = "GET", body, user } = {}) {
  return fetchWithTimeout(
    fetch,
    new URL(path, baseUrl),
    {
      method,
      headers: {
        Authorization: `Bearer ${user?.key ?? adminKey}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    REQUEST_TIMEOUT_MS,
    async response => {
      let data;
      try {
        data = await response.json();
      } catch {
        data = null;
      }
      return { response, data };
    },
  );
}

async function createUser(username) {
  const { response, data } = await request("/api/users", { method: "POST", body: { username } });
  if (response.status !== 201 || !data?.key) {
    throw new CanaryFailure("CANARY_USER_CREATE_FAILED", EXIT.users, { status: response.status });
  }
  return { username, key: data.key };
}

async function capture(user, content, visibility) {
  const clientItemId = crypto.randomUUID();
  const { response, data } = await request("/capture/batch", {
    method: "POST",
    user,
    body: { items: [{
      client_item_id: clientItemId, idempotency_key: `semantic-canary:${clientItemId}`,
      content, visibility, tags: ["system:semantic-canary"],
    }] },
  });
  const item = data?.data?.items?.[0];
  const receipt = item?.data?.receipt;
  if (!response.ok || data?.ok !== true || !Array.isArray(data.data?.items) || data.data.items.length !== 1
      || item.client_item_id !== clientItemId || item.status !== "created"
      || item.data?.outcome !== "created" || item.data.capture_mode !== "create_only"
      || typeof receipt?.entry_id !== "string" || !receipt.entry_id
      || typeof receipt.episode_id !== "string" || !receipt.episode_id) {
    throw new CanaryFailure("CANARY_CAPTURE_FAILED", EXIT.capture, { status: response.status });
  }
  return receipt.entry_id;
}

async function eraseCreatedEntry(user, id) {
  const { response, data } = await request("/forget", {
    method: "POST", user, body: { id, confirm_entry_id: id },
  });
  if (!response.ok || data?.ok !== true || data.id !== id || data.retry === true
      || !["complete", "pending_cleanup"].includes(data.erasure_status)
      || typeof data.operation_id !== "string" || !data.operation_id) {
    throw new CanaryFailure("CANARY_CLEANUP_FAILED", EXIT.cleanup);
  }
  const status = await request(`/erasure-status?operation_id=${encodeURIComponent(data.operation_id)}`, { user });
  const receipt = status.data?.erasure;
  if (!status.response.ok || status.data?.ok !== true || receipt?.operationId !== data.operation_id
      || receipt.entryId !== id || receipt.status !== "complete") {
    throw new CanaryFailure("CANARY_CLEANUP_FAILED", EXIT.cleanup);
  }
}

async function recall(user, query) {
  const { response, data } = await request(`/recall?query=${encodeURIComponent(query)}&topK=20`, { user });
  if (!response.ok || !data?.ok) {
    throw new CanaryFailure("CANARY_RECALL_FAILED", EXIT.semanticUnavailable, { status: response.status });
  }
  if (data.semantic_unavailable) {
    throw new CanaryFailure("CANARY_SEMANTIC_UNAVAILABLE", EXIT.semanticUnavailable);
  }
  return data.results ?? [];
}

async function pollFor(user, query, expectedId) {
  let results = [];
  for (let attempt = 0; attempt < 8; attempt++) {
    results = await recall(user, query);
    if (results.some(result => result.id === expectedId)) return results;
    if (attempt < 7) await delay(1500);
  }
  if (results.length === 0) {
    throw new CanaryFailure("CANARY_SEMANTIC_ZERO_RESULTS", EXIT.semanticZero, { match_count: 0 });
  }
  throw new CanaryFailure("CANARY_SEMANTIC_TARGET_MISSING", EXIT.semanticMissing, {
    match_count: results.length,
  });
}

function configure() {
  const rawBaseUrl = process.env.SLM_BASE_URL?.trim();
  adminKey = process.env.SLM_ADMIN_KEY_FILE
    ? readFileSync(process.env.SLM_ADMIN_KEY_FILE, "utf8").trim()
    : process.env.SLM_ADMIN_KEY?.trim();
  if (!rawBaseUrl || !adminKey) {
    console.error("CANARY_CONFIG_MISSING");
    process.exit(EXIT.config);
  }

  try {
    baseUrl = new URL(rawBaseUrl);
  } catch {
    console.error("CANARY_URL_INVALID");
    process.exit(EXIT.config);
  }
  const configuredProduction = process.env.SLM_PRODUCTION_URL?.trim();
  let configuredProductionOrigin;
  try {
    configuredProductionOrigin = configuredProduction
      ? new URL(configuredProduction).origin
      : undefined;
  } catch {
    console.error("CANARY_PRODUCTION_URL_INVALID");
    process.exit(EXIT.config);
  }
  const forbiddenOrigins = new Set([
    new URL(productionOrigin).origin,
    "https://memory.fractals-solutions.com",
    ...(configuredProductionOrigin ? [configuredProductionOrigin] : []),
  ]);
  if (forbiddenOrigins.has(baseUrl.origin)) {
    console.error("CANARY_PRODUCTION_REFUSED");
    process.exit(EXIT.config);
  }
  if (baseUrl.pathname !== "/" || baseUrl.search || baseUrl.hash || baseUrl.username || baseUrl.password
      || (baseUrl.protocol !== "https:" && !(baseUrl.protocol === "http:"
        && ["127.0.0.1", "localhost", "[::1]"].includes(baseUrl.hostname)))) {
    throw new CanaryFailure("CANARY_URL_INVALID", EXIT.config);
  }
}

export async function main() {
  configure();
  await readVerifiedStage({ env: { ...process.env, SLM_URL: baseUrl.origin } });
  const suffix = `${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 6)}`;
  const scenario = buildCanaryScenario(suffix);
  const { contents, probes } = scenario;
  const created = [];
  let primaryFailure;

  try {
    const alice = await createUser(`canary_a_${suffix}`.slice(0, 32));
    const bob = await createUser(`canary_b_${suffix}`.slice(0, 32));
    const actors = { alice, bob };
    const ids = {};
    ids.alicePrivate = await capture(alice, contents.alicePrivate, "private");
    created.push([alice, ids.alicePrivate]);
    ids.bobPrivate = await capture(bob, contents.bobPrivate, "private");
    created.push([bob, ids.bobPrivate]);
    ids.alicePublic = await capture(alice, contents.alicePublic, "public");
    created.push([alice, ids.alicePublic]);
    ids.semantic = await capture(alice, contents.semantic, "private");
    created.push([alice, ids.semantic]);

    for (const probe of probes) {
      let results;
      try {
        results = await pollFor(actors[probe.actor], probe.query, ids[probe.expected]);
      } catch (error) {
        if (probe.name !== "bob-public-privacy-decoy"
            || (error instanceof CanaryFailure && error.code === "CANARY_SEMANTIC_UNAVAILABLE")) {
          throw error;
        }
        throw new CanaryFailure("CANARY_PUBLIC_MISSING", EXIT.public, error.details);
      }
      if (probe.forbidden.some(key => results.some(result => result.id === ids[key]))) {
        throw new CanaryFailure("CANARY_OTHER_PRIVATE_VISIBLE", EXIT.privacy);
      }
    }

    const duplicate = await request("/capture", {
      method: "POST",
      user: alice,
      body: { content: contents.semantic, visibility: "private", tags: ["system:semantic-canary"] },
    });
    if (duplicate.response.status !== 409
        || duplicate.data?.action !== "blocked_duplicate"
        || duplicate.data?.match_id !== ids.semantic) {
      // If duplicate suppression itself fails, a positively identified new
      // capture is ours to erase. A merge/replay never authorizes another ID.
      if (duplicate.response.ok && duplicate.data?.ok === true
          && ["stored", "stored_separately"].includes(duplicate.data.action)
          && typeof duplicate.data.id === "string"
          && !created.some(([, id]) => id === duplicate.data.id)) {
        created.push([alice, duplicate.data.id]);
      }
      throw new CanaryFailure("CANARY_DUPLICATE_NOT_BLOCKED", EXIT.duplicate, {
        status: duplicate.response.status,
      });
    }
  } catch (error) {
    primaryFailure = error instanceof CanaryFailure
      ? error
      : new CanaryFailure("CANARY_REQUEST_FAILED", EXIT.semanticUnavailable);
  } finally {
    let cleanupFailed = false;
    for (const [user, id] of created.reverse()) {
      try {
        await eraseCreatedEntry(user, id);
      } catch {
        cleanupFailed = true;
      }
    }
    if (cleanupFailed) {
      primaryFailure ??= new CanaryFailure("CANARY_CLEANUP_FAILED", EXIT.cleanup);
      primaryFailure.details.cleanup_failed = true;
    }
  }

  if (primaryFailure) {
    throw primaryFailure;
  }
  console.log(JSON.stringify({ ok: true, code: "CANARY_OK", checks: probes.length + 1 }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch(error => {
    console.error(JSON.stringify({
      ok: false, code: error instanceof CanaryFailure ? error.code : "CANARY_CONFIG_FAILED",
      ...(error instanceof CanaryFailure && error.details.cleanup_failed ? { cleanup_failed: true } : {}),
    }));
    process.exitCode = error instanceof CanaryFailure ? error.exitCode : EXIT.config;
  });
}
