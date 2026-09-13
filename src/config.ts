/**
 * config.ts — Application-wide constants and configuration.
 *
 * Purpose: Centralize all magic numbers, thresholds, model names, and tunables
 * so changing a value is a one-line edit with no code search.
 *
 * Input: None (pure module-level declarations).
 * Output: Exported constants and one pure function (compressionEligibilitySql).
 * Logic: Threshold definitions, vectorize limits, RRF params, graph caps,
 *         chunking limits, token budgets, and the SQL fragment for compression eligibility.
 */

// ─── CORS ─────────────────────────────────────────────────────────────────────

export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept, X-Shared-Living-Memory-User, X-Shared-Living-Memory-User-Key, X-SLM-Tool-Profile",
};

export const TOOL_PROFILE_HEADER = "X-SLM-Tool-Profile";

// ─── Tool profiles (Section 5.2) ─────────────────────────────────────────────
// Profiles restrict the CURRENT connection's exposed and callable tool set.
// They are convenience subsets, NOT a reduction in the underlying credential's
// privileges: the key holder can select `full` on another connection. Server
// authorization is therefore still enforced on every tool invocation.

export const TOOL_PROFILES = ["capture", "review", "full"] as const;
export type ToolProfile = (typeof TOOL_PROFILES)[number];

export function isToolProfile(value: unknown): value is ToolProfile {
  return typeof value === "string" && (TOOL_PROFILES as readonly string[]).includes(value);
}

/** Exactly 10 tools for both personal and service capture connections. */
const CAPTURE_PROFILE_TOOLS = [
  "whoami",
  "remember",
  "remember_batch",
  "recall",
  "list_recent",
  "passages",
  "history",
  "connections",
  "create_action_proposal",
  "list_action_proposals",
] as const;

/** Exactly 16 tools: the capture set plus direct curation. */
const REVIEW_PROFILE_TOOLS = [
  ...CAPTURE_PROFILE_TOOLS,
  "append",
  "update",
  "set_status",
  "set_epistemic_status",
  "review_action_proposal",
  "execute_approved_action",
] as const;

/**
 * The full personal inventory: the 24 pre-existing tools plus whoami,
 * remember_batch and the three edge-proposal aliases. Asserted exactly by the
 * profile inventory test so a newly registered tool cannot drift silently.
 */
export const PERSONAL_FULL_TOOLS = [
  "whoami",
  "remember",
  "remember_batch",
  "append",
  "update",
  "set_status",
  "set_epistemic_status",
  "recall",
  "reinforce",
  "list_recent",
  "forget",
  "link",
  "unlink",
  "connections",
  "passages",
  "history",
  "restore",
  "propose_edge",
  "list-proposals",
  "approve-proposal",
  "reject-proposal",
  "create_action_proposal",
  "list_action_proposals",
  "review_action_proposal",
  "execute_approved_action",
  "rate_recall",
  "list_edge_proposals",
  "approve_edge_proposal",
  "reject_edge_proposal",
] as const;

/** Tools the service branch actually implements. */
export const SERVICE_TOOLS = [
  "whoami",
  "remember",
  "recall",
  "list_recent",
  "connections",
  "history",
  "create_action_proposal",
  "list_action_proposals",
  "execute_approved_action",
] as const;

/**
 * The registered tool set for a request: the profile subset intersected with
 * what the principal's branch actually implements.
 */
export function toolsRegisteredForProfile(
  profile: ToolProfile,
  kind: "human" | "service" | "system",
): string[] {
  if (kind !== "human") {
    return SERVICE_TOOLS.filter((tool) => profileAllowsTool(profile, tool));
  }
  if (profile === "full") return [...PERSONAL_FULL_TOOLS];
  return [...PERSONAL_PROFILE_TOOLS[profile]];
}

export const PERSONAL_PROFILE_TOOLS: Record<ToolProfile, readonly string[]> = {
  capture: CAPTURE_PROFILE_TOOLS,
  review: REVIEW_PROFILE_TOOLS,
  // The full profile exposes everything the server registers (24 pre-existing
  // tools plus whoami, remember_batch and the three edge-proposal aliases),
  // so a newly registered tool is never silently missing from full.
  full: [],
};

/**
 * Full-profile aliases for legacy edge proposals. The alias answers with the
 * same handler function as its canonical name; the old names remain only in the
 * full profile.
 */
export const EDGE_TOOL_ALIASES: Record<string, string> = {
  "list-proposals": "list_edge_proposals",
  "approve-proposal": "approve_edge_proposal",
  "reject-proposal": "reject_edge_proposal",
};

/**
 * Whether the request profile exposes/callable-includes a tool. Full allows the
 * whole registry; capture and review are explicit allowlists so tools/list and
 * tools/call can never disagree.
 */
export function profileAllowsTool(profile: ToolProfile, toolName: string): boolean {
  if (profile === "full") return true;
  return PERSONAL_PROFILE_TOOLS[profile].includes(toolName);
}

export function graceMs(env: { VECTORIZE_GRACE_MS?: string }): number {
  return parseInt(env.VECTORIZE_GRACE_MS ?? "300000", 10) || 300000;
}

// ─── Model constants ──────────────────────────────────────────────────────────

export const LLM_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";
export const EMBEDDING_MODEL = "@cf/baai/bge-small-en-v1.5";

// ─── Thresholds ───────────────────────────────────────────────────────────────

export const DUPLICATE_BLOCK_THRESHOLD = 0.95;
export const DUPLICATE_FLAG_THRESHOLD = 0.85;
export const CANDIDATE_SCORE_THRESHOLD = 0.45;
export const TAG_BOOST_STEP = 0.15;
export const TAG_BOOST_MAX = 1.5;
// Each net contradiction (win or loss) shifts a memory's effective importance by
// log1p(|net|) * this step, clamped to the [1,5] importance band. Tunable.
export const CONTRADICTION_IMPORTANCE_STEP = 1.0;

// ─── Compression eligibility ──────────────────────────────────────────────────
// An entry is eligible for nightly digest compression only if it's low-importance,
// not proven-useful by recall, and not a contradiction survivor. Strictly more
// protective than the old `importance_score < 4` filter — it can only exempt MORE.
export const COMPRESSION_IMPORTANCE_THRESHOLD = 4;   // importance >= this → protected
export const COMPRESSION_MIN_RECALL = 2;             // recalled >= this many times → protected
export const COMPRESSION_MIN_AGE_MS = 60 * 86400000; // entries with fewer than COMPRESSION_MIN_RECALL recalls protected until this old (60 days)

// Returns a SQL boolean fragment for "this entry is eligible for compression".
// Contains one age-cutoff placeholder, plus an owner placeholder when ownerUserId
// is provided. A user-triggered digest is a mutation, so visibility is not enough:
// only entries owned by that caller may be compressed.
// columnPrefix: "" for bare columns (compressTag), "entries." for json_each-joined queries.
export function compressionEligibilitySql(columnPrefix = "", ownerUserId?: string): string {
  const p = columnPrefix;
  let sql = `(${p}importance_score IS NULL OR ${p}importance_score < ${COMPRESSION_IMPORTANCE_THRESHOLD})
      AND (${p}recall_count = 0 OR (${p}recall_count < ${COMPRESSION_MIN_RECALL} AND ${p}created_at < ?))
      AND (${p}contradiction_wins IS NULL OR ${p}contradiction_wins = 0)`;
  if (ownerUserId) {
    sql += ` AND ${p}owner_user_id = ?`;
  }
  return sql;
}

// ─── Chunking constants ───────────────────────────────────────────────────────

export const CHUNK_MAX_CHARS = 1600;
export const CHUNK_OVERLAP_CHARS = 200;

// ─── Token limits ─────────────────────────────────────────────────────────────

export const CLASSIFY_MAX_TOKENS = 80;
export const CONTRADICTION_MAX_TOKENS = 80;
export const SMART_MERGE_MAX_TOKENS = 250;
export const INSIGHT_MAX_TOKENS = 300;
export const PATTERN_MAX_TOKENS = 100;
export const DIGEST_MAX_TOKENS = 400;

// ─── Vectorize constants ──────────────────────────────────────────────────────

export const VECTORIZE_FIX_HINT =
  "run `npm run vectors:create` and `npm run vectors:indexes`, or grant the build token Vectorize Edit and redeploy";

export const VECTORIZE_TOP_K_MULTIPLIER = 3;
// getByIds batch size for tag-scoped recall — Vectorize rejects more than 20 IDs
// per call (VECTOR_GET_ERROR, code 40007)
export const VECTORIZE_GET_BY_IDS_BATCH = 20;
// D1 allows at most 100 bound parameters per query
export const D1_MAX_BOUND_PARAMS = 100;

// ─── Hybrid recall (keyword + semantic fusion) ─────────────────────────────────
export const RRF_K = 60;                    // Reciprocal Rank Fusion dampening constant
export const KEYWORD_CANDIDATE_LIMIT = 100; // max rows the LIKE keyword query scans
export const KEYWORD_MIN_TOKEN_LEN = 2;     // ignore 1-char tokens
export const KEYWORD_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "is", "are", "was", "were", "be", "been",
  "i", "me", "my", "we", "you", "it", "this", "that", "these", "those", "with", "about", "from", "at", "as", "by",
  "do", "did", "does", "what", "when", "where", "who", "whom", "how", "why", "which",
]);

// ─── Graph traversal ────────────────────────────────────────────────────────────

export const GRAPH_MAX_HOPS = 3;
export const GRAPH_FANOUT_CAP = 8;   // max edges followed per node per hop (strongest first)
export const GRAPH_MAX_NODES = 50;   // cap on total expanded nodes — bounds hub-node blowup
export const GRAPH_HOP_DECAY = 0.6;  // score multiplier per hop of graph distance (multi-hop recall)
// Each id binds twice per BFS query (source_id IN … OR target_id IN …), so batch
// well under the 100-bound-param limit.
export const EDGE_QUERY_BATCH = Math.floor(D1_MAX_BOUND_PARAMS / 2);

// ─── Edge inference on write ────────────────────────────────────────────────────
const EDGE_INFER_THRESHOLD = 0.78; // min cosine similarity to auto-link (was 0.55 — too loose, linked keyword-overlap noise)
const EDGE_INFER_MAX = 3;          // max inferred links per new entry
export { EDGE_INFER_THRESHOLD, EDGE_INFER_MAX };

// ─── Nightly graph maintenance (issue #16) ──────────────────────────────────────
export const GRAPH_PASS_BACKFILL_LIMIT = 25;          // unlinked entries to link per run
export const EDGE_PRUNE_WEIGHT = 0.3;                 // inferred edges weaker than this are prune candidates…
export const EDGE_PRUNE_MIN_AGE_MS = 7 * 24 * 60 * 60 * 1000; // …once they're at least a week old

// ─── Nightly integration sync ─────────────────────────────────────────────────
export const CRON_SYNC_MAX_BATCHES = 5;

// ─── Spaced repetition decay (Memory Pillar Phase 1) ────────────────────────
export const RETENTION_HALF_LIFE_DAYS = 30;

// ─── Staleness detection (Ticket 06) ────────────────────────────────────────
export const STALENESS_THRESHOLD_DAYS = 180;
export const STALENESS_CONFIDENCE_THRESHOLD = 0.5;
export const STALENESS_RECALL_PENALTY = 0.5;

// ─── Autonomy governance (Pillar 3 — Operator) ───────────────────────────────
export type AutonomyLevel = "automatic" | "gated" | "never";

// Default governance: which tools can the agent run without human approval?
export const TOOL_AUTONOMY: Record<string, AutonomyLevel> = {
  // Read-only — always safe
  recall:                  "automatic",
  list_recent:             "automatic",
  connections:             "automatic",
  passages:                "automatic",
  "list-proposals":        "automatic",
  // Write — gated (need human approval)
  remember:                "gated",
  append:                  "gated",
  update:                  "gated",
  set_status:              "gated",
  set_epistemic_status:    "gated",
  link:                    "gated",
  unlink:                  "gated",
  propose_edge:            "gated",
  "approve-proposal":      "gated",
  "reject-proposal":       "gated",
  restore:                 "gated",
  // Destructive — never autonomous
  forget:                  "never",
};

// ─── Maintenance write mode (Section 16.1) ───────────────────────────────────
// One shared predicate is enough: there is no maintenance service. In read-only
// mode the READ surface keeps working so operators can inspect state, but every
// application/admin/memory/governance/credential mutation is refused before any
// side effect.

export type WriteMode = "enabled" | "read-only" | "invalid";

export function readWriteMode(env: { SLM_WRITE_MODE?: string }): WriteMode {
  const value = typeof env.SLM_WRITE_MODE === "string" ? env.SLM_WRITE_MODE.trim() : "";
  if (value === "" || value === "enabled") return "enabled";
  if (value === "read-only") return "read-only";
  return "invalid";
}

export function isMaintenanceReadOnly(env: { SLM_WRITE_MODE?: string }): boolean {
  return readWriteMode(env) === "read-only";
}

/**
 * The fixed safe GET path set. This is an explicit allowlist, not a
 * method-based rule, because several GETs are not read-only: GET /digest calls
 * compressTag and is therefore deliberately absent.
 */
export const READ_ONLY_SAFE_GET_PATHS: ReadonlySet<string> = new Set([
  "/health",
  "/ready",
  "/api/bootstrap-status",
  "/api/whoami",
  "/api/me",
  "/api/users",
  "/api/service-identities",
  "/action-proposals",
  "/awareness-events",
  "/count",
  "/tags",
  "/stats",
  "/list",
  "/team-activity",
  "/edge-proposals",
  "/export",
  "/recall",
  "/erasure-status",
  "/pilot-metrics",
  "/connections",
  "/entry",
  "/graph",
  "/integrations",
]);

/** Safe parameterized GET paths, matched exactly. */
export const READ_ONLY_SAFE_GET_PATTERNS: readonly RegExp[] = [
  /^\/entries\/[^/]+\/history$/,
  /^\/entries\/[^/]+\/hierarchy$/,
  /^\/edges\/[^/]+\/history$/,
];

/** Static assets and the shared session/OAuth handlers stay available. */
function isReadOnlyStaticOrSession(pathname: string): boolean {
  if (pathname === "/" || pathname === "/index.html" || pathname === "/dashboard") return true;
  if (pathname.startsWith("/assets/")) return true;
  if (pathname === "/oauth/authorize") return true;
  if (pathname === "/login" || pathname === "/logout") return true;
  return false;
}

/**
 * Whether this request may proceed while writes are disabled. Everything not
 * explicitly listed is refused before it reaches a handler, so an unknown route
 * or an unexpected GET side effect can never mutate domain state in maintenance.
 */
export function isReadOnlySafeRequest(method: string, pathname: string): boolean {
  if (method === "OPTIONS") return true;
  if (isReadOnlyStaticOrSession(pathname)) return true;
  if (method !== "GET" && method !== "HEAD") return false;
  if (READ_ONLY_SAFE_GET_PATHS.has(pathname)) return true;
  return READ_ONLY_SAFE_GET_PATTERNS.some((pattern) => pattern.test(pathname));
}

/**
 * MCP tools callable while writes are disabled. `rate_recall` is excluded
 * because it writes recall telemetry; every mutation tool is excluded.
 */
export const READ_ONLY_SAFE_TOOLS: ReadonlySet<string> = new Set([
  "whoami",
  "recall",
  "list_recent",
  "passages",
  "history",
  "connections",
  "list_action_proposals",
  "list_edge_proposals",
  "list-proposals",
]);
