/**
 * testing.ts — Test-only export surface.
 *
 * Cloudflare treats named exports from the configured Worker entry module as
 * runtime entrypoints. Keep this barrel separate from `src/index.ts` so tests
 * can reach domain helpers without publishing them to workerd.
 */

export { default } from "./index";

export type {
  Env,
  RecallMatch,
  CaptureResult,
  Episode,
  EntrySnapshot,
  Passage,
  Document,
  DocumentSection,
  EpistemicStatus,
} from "./types";
export {
  MemoryKind,
  MemoryStatus,
  KIND_VALUES,
  MEMORY_KIND_VALUES,
  STATUS_VALUES,
  STATUS_PREFIX,
  KIND_PREFIX,
  EPISTEMIC_STATUS_VALUES,
  isValidTransition,
  VALID_EPISTEMIC_TRANSITIONS,
} from "./types";

export {
  CORS_HEADERS,
  COMPRESSION_MIN_AGE_MS,
  EDGE_INFER_THRESHOLD,
  EDGE_INFER_MAX,
  DIGEST_MAX_TOKENS,
  EMBEDDING_MODEL,
  VECTORIZE_GET_BY_IDS_BATCH,
  GRAPH_HOP_DECAY,
  GRAPH_MAX_HOPS,
  VECTORIZE_TOP_K_MULTIPLIER,
  KEYWORD_CANDIDATE_LIMIT,
  RRF_K,
  INSIGHT_MAX_TOKENS,
  PATTERN_MAX_TOKENS,
  TAG_BOOST_MAX,
  CONTRADICTION_IMPORTANCE_STEP,
  VECTORIZE_FIX_HINT,
  SMART_MERGE_MAX_TOKENS,
  DUPLICATE_FLAG_THRESHOLD,
  DUPLICATE_BLOCK_THRESHOLD,
  CANDIDATE_SCORE_THRESHOLD,
  CONTRADICTION_MAX_TOKENS,
  CLASSIFY_MAX_TOKENS,
  LLM_MODEL,
  CHUNK_MAX_CHARS,
  D1_MAX_BOUND_PARAMS,
  TAG_BOOST_STEP,
  COMPRESSION_IMPORTANCE_THRESHOLD,
  COMPRESSION_MIN_RECALL,
  compressionEligibilitySql,
  RETENTION_HALF_LIFE_DAYS,
  STALENESS_THRESHOLD_DAYS,
  STALENESS_CONFIDENCE_THRESHOLD,
  STALENESS_RECALL_PENALTY,
  TOOL_AUTONOMY,
} from "./config";
export type { AutonomyLevel } from "./config";

export {
  escapeLikePattern,
  readStreamText,
  embed,
  chunkText,
  getHalfLifeMs,
  cosineSim,
  tokenizeQuery,
  getRetentionScore,
} from "./helpers";

export {
  getStatus,
  withStatus,
  getKind,
  withKind,
  buildVisibilityClause,
  buildEntryFilterQuery,
} from "./tags";

export { hmacKey, generateApiKey, requireAuthAsync, resolveUser } from "./auth";

export {
  initializeDatabase,
  _resetDbReady,
  checkVectorizeHealth,
  VECTORIZE_INDEX_NAME,
  VectorizeHealth,
  getSystemUserId,
  getDbReady,
  setDbReady,
} from "./db";

export {
  EDGE_TYPES,
  PROVENANCE_VALUES,
  isValidEdgeType,
  isSymmetric,
  edgeLabel,
  allowedKindsFor,
  createEdge,
  deleteEdge,
  expandGraph,
  inferEdgesOnWrite,
  GraphNeighbor,
  Connection,
  getConnections,
  getEdgeHistory,
  GraphNode,
  GraphView,
  buildGraph,
  restoreEdgeVersion,
  neighborsFromVectorQuery,
  filterVisibleIds,
} from "./graph";

export { classifyEntry, extractHashtags, inferQueryTags } from "./classification";

export {
  MergeAction,
  getDuplicateCheckSample,
  checkDuplicateAndContradiction,
} from "./duplicates";

export {
  queryVisibleVectors,
  vectorMatchParentId,
} from "./vector-access";
export type {
  ScopedVectorMatch,
  VectorEntryScope,
  VisibleVectorQueryOptions,
  VisibleVectorQueryResult,
} from "./vector-access";

export {
  reindexAllVectors,
  captureEntry,
  createPassagesForEntry,
  createSnapshot,
} from "./ingest";

export {
  ForgetResult,
  forgetEntry,
  deprecateEntry,
  applyStatus,
  synthesizeDigest,
  compressTag,
  synthesizeInsight,
  derivePattern,
  runNightlyCompression,
  runGraphPass,
  detectStaleness,
  detectCrossUserContradictions,
} from "./lifecycle";

export {
  VectorizeMatch,
  RecallSearchResult,
  rerankWithTimeDecay,
  parseTimePhrase,
  renderRecallText,
  rrfFuse,
  recallEntries,
} from "./recall";

export {
  buildMcpServer,
  isMcpToolsListRequest,
  removeToolExecutionMetadata,
  sanitizeToolsListResponse,
} from "./mcp";

export { apiHandler } from "./api-handler";
export { defaultHandler } from "./routes";
export { runScheduledIntegrationSync } from "./integrations-mirror";

export {
  startRun,
  endRun,
  logToolCall,
  getToolUsageStats,
  getActiveUserCount,
  getRecentRuns,
  getRunEvents,
  getTotalRunCount,
} from "./audit";
export type { AgentRun, ToolCallRecord } from "./audit";

export {
  checkToolAutonomy,
  getToolLevel,
  getAutonomyMap,
  getAutonomyStats,
} from "./autonomy";
export type { GateResult } from "./autonomy";

export {
  commitEntryVersion,
  EntryVersionError,
  EntryVersionValidationError,
  EntryVersionNotFoundError,
  EntryVersionOwnershipError,
  EntryVersionRevisionConflictError,
  EntryVersionVectorStageError,
  EntryVersionCommitError,
} from "./entry-version-service";

export { drainVectorCleanupQueue } from "./vector-cleanup";
export type { VectorCleanupResult } from "./vector-cleanup";
export {
  stageOverlapAwarenessIntent,
  discardOverlapAwarenessIntent,
  reconcileOverlapAwarenessIntent,
  reconcilePendingOverlapAwareness,
  listAwarenessEvents,
  markAwarenessEventRead,
} from "./awareness-events";
export type {
  CommitEntryVersionInput,
  CommitEntryVersionResult,
  EntryVersionErrorCode,
  VersionedMutationKind,
} from "./entry-version-service";

export {
  INTEGRATION_PROVIDERS,
  getProvider,
  loadIntegration,
  saveIntegration,
  deleteIntegration,
  integrationStatus,
} from "./integrations";
export type { IntegrationRecord, MirrorStore } from "./integrations";
