/**
 * mcp.ts — MCP server definition and tools/list sanitization.
 *
 * Purpose: Register all MCP tools (remember, recall, forget, link, etc.) and
 *          sanitize tools/list responses so strict clients (e.g. OpenAI Codex)
 *          don't reject unknown fields like `execution`.
 *
 * Input:   Env bindings, ExecutionContext, and a verified userId for mandatory
 *          per-actor scoping.
 *
 * Output:  McpServer instance with all tools registered; helper functions to
 *          detect and strip `execution` metadata from tools/list responses.
 *
 * Logic:   buildMcpServer creates an agents/mcp McpServer and registers each
 *          tool with its input schema (zod) and handler. The sanitization
 *          helpers intercept POST requests whose JSON-RPC method is
 *          "tools/list" and strip the `execution` field from every tool in
 *          the response payload.
 */

import {
  ACTION_PROPOSAL_STATUSES,
  ACTION_TYPES,
  PROPOSAL_RISK_LEVELS,
  type ActionType,
  type ActionProposal,
  type ActorContext,
  type Env,
  type ServiceActorContext,
  type ProposalRiskLevel,
} from "./types";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  CaptureRejectedError,
  SOURCE_TITLE_MAX_CODE_POINTS,
  appendToEntry,
  captureEntry,
} from "./ingest";
import {
  sanitizeBoundedMetadataForOutput,
  sanitizeSourceMetadataForOutput,
} from "./source-metadata";
import {
  commitEntryVersion,
  EntryVersionError,
  loadOwnedRestoreSnapshot,
} from "./entry-version-service";
import { recallEntries, renderRecallText } from "./recall";
import type { RecallMatch } from "./recall";
import { reinforceOwnedEntry } from "./reinforcement";
import { applyStatus } from "./lifecycle";
import { eraseEntryArtifacts } from "./erasure";
import { buildEntryFilterQuery, getStatus, withKind, withStatus, buildVisibilityClause } from "./tags";
import { createEdge, deleteEdge, getConnections, EDGE_TYPES, isValidEdgeType, edgeLabel } from "./graph";
import { EPISTEMIC_STATUS_VALUES, isValidTransition, VALID_EPISTEMIC_TRANSITIONS, type EpistemicStatus } from "./types";
import { isManagedMirror, mirrorEditError } from "./integrations-mirror";
import { MEMORY_KIND_VALUES, KIND_VALUES, type MemoryKind, type MemoryStatus, STATUS_VALUES } from "./types";
import { VECTORIZE_FIX_HINT, TOOL_AUTONOMY } from "./config";
import { startRun, endRun, logToolCall } from "./audit";
import { isValidMcpActorId } from "./auth";
import { captureServicePrivateDraft } from "./operator-memory";
import {
  createActionProposal,
  executeApprovedProposal,
  listActionProposals,
  reviewActionProposal,
} from "./action-proposals";

import { decideOperatorAction, requireAllowedDecision } from "./operator-policy";
import { verifyServiceActor } from "./service-actor";
import { withMandatoryAudit, MandatoryAuditError } from "./mandatory-audit";
import { MCP_ONBOARDING_MARKDOWN, MCP_ONBOARDING_RESOURCE_URI } from "./mcp-onboarding";
import { submitRecallFeedback } from "./recall-events";

// ─── MCP Server ───────────────────────────────────────────────────────────────

interface McpEntryAccessRow {
  id: string;
  tags: string;
  owner_user_id: string;
  visibility: "private" | "public";
}

function versionErrorText(error: unknown): string {
  if (!(error instanceof EntryVersionError)) return "Memory update failed.";
  if (error.code === "not_found" || error.code === "not_owner") return "Memory not found.";
  if (error.code === "revision_conflict") return "Memory changed while you were editing it. Recall it again and retry.";
  if (error.code === "vector_stage_failed") return "Memory update failed because vector storage is unavailable.";
  return error.code === "invalid_input" ? error.message : "Memory update could not be committed.";
}

function isMcpEntryVisible(row: McpEntryAccessRow, userId: string): boolean {
  if (row.owner_user_id === userId) return true;
  return row.visibility === "public";
}

async function getMcpEntryAccessRow(id: string, env: Env): Promise<McpEntryAccessRow | null> {
  return await env.DB.prepare(
    `SELECT id, tags, owner_user_id, visibility FROM entries WHERE id = ?`,
  ).bind(id).first() as McpEntryAccessRow | null;
}

async function getVisibleMcpEntry(
  id: string,
  userId: string,
  env: Env,
): Promise<McpEntryAccessRow | null> {
  const row = await getMcpEntryAccessRow(id, env);
  return row && isMcpEntryVisible(row, userId) ? row : null;
}

async function getOwnedMcpEntry(
  id: string,
  userId: string,
  env: Env,
): Promise<McpEntryAccessRow | null> {
  const row = await getMcpEntryAccessRow(id, env);
  return row?.owner_user_id === userId ? row : null;
}

async function isActiveMcpAdmin(actor: ActorContext, env: Env): Promise<boolean> {
  if (actor.kind !== "human") return false;
  const row = await env.DB.prepare(
    `SELECT role FROM users WHERE id = ? AND status = 'active'`,
  ).bind(actor.userId).first<{ role: string }>();
  return row?.role === "admin";
}

function hasMcpPrivateVisibility(row: McpEntryAccessRow): boolean | null {
  return row.visibility === "private" ? true : row.visibility === "public" ? false : null;
}

// About one thousand ordinary-language tokens, with a hard UTF-8 byte bound.
const MCP_HISTORY_MAX_BYTES = 4 * 1024;
const MCP_HISTORY_GUIDANCE = "Use stable snapshot IDs with restore. For complete authenticated history, export /export?mode=my_data.";

interface McpHistoryRowCount {
  total: number;
  returned: number;
  omitted: number;
}

interface McpHistoryPayload {
  projection: Record<string, unknown>;
  episodes: Record<string, unknown>[];
  snapshots: Record<string, unknown>[];
  truncated: boolean;
  counts: {
    episodes: McpHistoryRowCount;
    snapshots: McpHistoryRowCount;
  };
  guidance: string;
}

interface LoadedMcpHistory {
  projection: Record<string, unknown>;
  episodes: Record<string, unknown>[];
  snapshots: Record<string, unknown>[];
  episodeTotal: number;
  snapshotTotal: number;
}

async function loadOwnedMcpHistory(
  env: Env,
  ownerUserId: string,
  entryId: string,
): Promise<LoadedMcpHistory | null> {
  const projection = await env.DB.prepare(
    `SELECT current_episode_id, revision, recorded_at
     FROM entries WHERE id = ? AND owner_user_id = ?`,
  ).bind(entryId, ownerUserId).first<Record<string, unknown>>();
  if (!projection) return null;

  const [episodeResult, snapshotResult] = await Promise.all([
    env.DB.prepare(
      `SELECT ep.id, ep.mutation_kind, ep.parent_episode_id,
              ep.restored_from_snapshot_id, ep.content_hash, ep.source,
              ep.content_type, d.title AS source_title,
              COALESCE(d.source_url, ep.source_url) AS source_url,
              ep.created_at, COUNT(*) OVER() AS total_count
       FROM episodes ep
       LEFT JOIN documents d
         ON d.episode_id = ep.id
        AND (d.owner_user_id = ep.owner_user_id OR d.owner_user_id = '')
       WHERE ep.entry_id = ? AND ep.owner_user_id = ?
       ORDER BY ep.created_at DESC, ep.id DESC LIMIT 50`,
    ).bind(entryId, ownerUserId).all<Record<string, unknown>>(),
    env.DB.prepare(
      `SELECT s.id, s.episode_id, s.mutation_kind, s.recorded_at,
              s.revision, s.created_at, COUNT(*) OVER() AS total_count
       FROM entry_snapshots s
       JOIN entries parent
         ON parent.id = s.entry_id AND parent.owner_user_id = ?
       WHERE s.entry_id = ?
       ORDER BY s.created_at DESC, s.id DESC LIMIT 50`,
    ).bind(ownerUserId, entryId).all<Record<string, unknown>>(),
  ]);

  const episodeTotal = Number(episodeResult.results[0]?.total_count ?? 0);
  const snapshotTotal = Number(snapshotResult.results[0]?.total_count ?? 0);
  const episodes = episodeResult.results.map((row) => {
    const {
      source: safeSource,
      sourceTitle: safeSourceTitle,
      sourceUrl: safeSourceUrl,
    } = sanitizeSourceMetadataForOutput({
      source: row.source,
      sourceTitle: row.source_title,
      sourceUrl: row.source_url,
    }, "owner_mcp");
    const { total_count: _totalCount, ...metadata } = row;
    return {
      ...metadata,
      source: safeSource,
      source_title: safeSourceTitle,
      source_url: safeSourceUrl,
      content_type: sanitizeBoundedMetadataForOutput(
        row.content_type,
        SOURCE_TITLE_MAX_CODE_POINTS,
      ),
    };
  });
  const snapshots = snapshotResult.results.map(({ total_count: _totalCount, ...row }) => row);
  return { projection, episodes, snapshots, episodeTotal, snapshotTotal };
}

function renderBoundedMcpHistory(history: LoadedMcpHistory): string {
  let projection = { ...history.projection };
  let episodes = [...history.episodes];
  let snapshots = [...history.snapshots];
  const encoder = new TextEncoder();
  let metadataCompacted = false;
  let minimalRows = false;
  let compactSerialization = false;

  while (true) {
    const counts = {
      episodes: {
        total: history.episodeTotal,
        returned: episodes.length,
        omitted: Math.max(0, history.episodeTotal - episodes.length),
      },
      snapshots: {
        total: history.snapshotTotal,
        returned: snapshots.length,
        omitted: Math.max(0, history.snapshotTotal - snapshots.length),
      },
    };
    const payload: McpHistoryPayload = {
      projection,
      episodes,
      snapshots,
      truncated: metadataCompacted
        || counts.episodes.omitted > 0
        || counts.snapshots.omitted > 0,
      counts,
      guidance: MCP_HISTORY_GUIDANCE,
    };
    const rendered = compactSerialization
      ? JSON.stringify(payload)
      : JSON.stringify(payload, null, 2);
    if (encoder.encode(rendered).byteLength <= MCP_HISTORY_MAX_BYTES) return rendered;

    const canDropEpisode = episodes.length > 1;
    const canDropSnapshot = snapshots.length > 1;
    if (canDropEpisode || canDropSnapshot) {
      if (!canDropEpisode) {
        snapshots.pop();
        continue;
      }
      if (!canDropSnapshot) {
        episodes.pop();
        continue;
      }
    }

    if (!canDropEpisode && !canDropSnapshot) {
      if (!metadataCompacted) {
        episodes = episodes.map((row) => ({
          id: row.id,
          mutation_kind: row.mutation_kind,
          parent_episode_id: row.parent_episode_id,
          restored_from_snapshot_id: row.restored_from_snapshot_id,
          created_at: row.created_at,
        }));
        metadataCompacted = true;
        continue;
      }
      if (!minimalRows) {
        episodes = episodes.map((row) => ({ id: row.id }));
        snapshots = snapshots.map((row) => ({ id: row.id }));
        projection = {
          current_episode_id: projection.current_episode_id,
          revision: projection.revision,
          recorded_at: projection.recorded_at,
        };
        minimalRows = true;
        continue;
      }
      if (!compactSerialization) {
        compactSerialization = true;
        continue;
      }

      // Stable IDs and recovery guidance are the non-negotiable history
      // contract. UUID-sized identifiers keep this terminal form far below
      // the byte ceiling even when every optional field was pathological.
      const terminal = JSON.stringify(payload);
      if (encoder.encode(terminal).byteLength <= MCP_HISTORY_MAX_BYTES) return terminal;
      throw new Error("MCP history stable identifiers exceed the 4 KiB response limit");
    }

    const oldestEpisode = episodes[episodes.length - 1];
    const oldestSnapshot = snapshots[snapshots.length - 1];
    if (!oldestEpisode) {
      snapshots.pop();
      continue;
    }
    if (!oldestSnapshot) {
      episodes.pop();
      continue;
    }

    const episodeCreatedAt = Number(oldestEpisode.created_at ?? Number.POSITIVE_INFINITY);
    const snapshotCreatedAt = Number(oldestSnapshot.created_at ?? Number.POSITIVE_INFINITY);
    if (episodeCreatedAt < snapshotCreatedAt) {
      episodes.pop();
    } else if (snapshotCreatedAt < episodeCreatedAt) {
      snapshots.pop();
    } else {
      const episodeBytes = encoder.encode(JSON.stringify(oldestEpisode)).byteLength;
      const snapshotBytes = encoder.encode(JSON.stringify(oldestSnapshot)).byteLength;
      if (episodeBytes >= snapshotBytes) episodes.pop();
      else snapshots.pop();
    }
  }
}

export function buildMcpServer(env: Env, ctx: ExecutionContext, actor: ActorContext): McpServer {
  const userId = actor.kind === "human"
    ? actor.userId
    : actor.kind === "service" ? actor.ownerUserId : actor.systemId;
  if (!isValidMcpActorId(userId)
      || !isValidMcpActorId(actor.actorId)
      || actor.kind === "human" && actor.actorId !== actor.userId
      || actor.kind === "service" && actor.actorId !== actor.serviceIdentityId) {
    throw new Error("A verified, scoped MCP actor is required");
  }

  const server = new McpServer({ name: "shared-living-memory", version: "1.0.0" });

  server.registerResource(
    "shared-living-memory-mcp-onboarding",
    MCP_ONBOARDING_RESOURCE_URI,
    {
      title: "Shared Living Memory MCP Onboarding",
      description: "Read this first after connecting Shared Living Memory MCP. Explains which MCP-use skills to install from skills.sh and how agents should start using the tools.",
      mimeType: "text/markdown",
    },
    (uri) => ({
      contents: [{
        uri: uri.toString(),
        mimeType: "text/markdown",
        text: MCP_ONBOARDING_MARKDOWN,
      }],
    }),
  );

  if (actor.kind === "service") {
    const serviceActor = actor;
    const safe = <I extends Record<string, unknown>>(
      handler: (input: I) => Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }>,
    ) => async (input: I) => {
      try {
        return await handler(input);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Governed operator request failed.";
        return { isError: true, content: [{ type: "text" as const, text: `Error: ${message}` }] };
      }
    };

    async function governedRead<T>(
      operation: "memory.read" | "proposal.read",
      redactedRequest: Record<string, unknown>,
      read: () => Promise<T>,
      summarize: (value: T) => Record<string, unknown>,
      targetIds: readonly string[] = [],
    ): Promise<T> {
      const verified = await verifyServiceActor(env, serviceActor);
      const decision = decideOperatorAction({
        actor: verified.actor,
        operation,
        autonomyProfile: verified.autonomyProfile,
      });
      requireAllowedDecision(decision);
      return withMandatoryAudit(env, {
        actor: verified.actor,
        subjectUserId: verified.ownerUserId,
        operation,
        decision,
        targetIds,
        redactedRequest,
      }, read, summarize);
    }

    server.registerTool(
      "remember",
      {
        description: "Capture a private draft candidate. This is the operator's only direct memory write; it never merges, promotes, deprecates, or publishes.",
        inputSchema: {
          content: z.string().describe("Content to capture as a private draft candidate"),
          tags: z.array(z.string()).optional(),
          source: z.string().optional(),
          idempotency_key: z.string().optional().describe("Stable retry key"),
        },
      },
      safe(async ({ content, tags, source, idempotency_key }) => {
        const result = await captureServicePrivateDraft(env, {
          actor: serviceActor,
          content,
          tags,
          source,
          idempotencyKey: idempotency_key,
        });
        return { content: [{ type: "text", text: `Stored private draft candidate ${result.entryId} at revision ${result.revision}.` }] };
      }),
    );

    server.registerTool(
      "recall",
      {
        description: "Read-only semantic and temporal recall over memory visible to the service owner.",
        inputSchema: {
          query: z.string(),
          topK: z.number().int().min(1).max(20).default(5),
          tag: z.string().optional(),
          after: z.number().int().optional(),
          before: z.number().int().optional(),
          kind: z.enum([...KIND_VALUES] as [string, ...string[]]).optional(),
          hops: z.number().int().min(0).max(3).default(0),
          as_of: z.number().int().optional(),
          known_at: z.number().int().optional(),
        },
      },
      safe(async ({ query, topK, tag, after, before, kind, hops, as_of, known_at }) => {
        const result = await governedRead(
          "memory.read",
          { queryLength: query.length, topK, hasTag: Boolean(tag), hops, temporal: as_of != null || known_at != null },
          () => recallEntries({
            query, topK, tag, after, before,
            kind: kind as MemoryKind | undefined,
            hops, userId, asOf: as_of, knownAt: known_at,
          }, env, ctx),
          (value) => ({ matchCount: value.matches.length, semanticUnavailable: value.semanticUnavailable }),
        );
        const notice = result.semanticUnavailable
          ? `Semantic search unavailable; keyword results only. ${VECTORIZE_FIX_HINT}\n\n`
          : "";
        const text = result.matches.length
          ? renderRecallText(result.matches, result.insight, userId)
          : "Nothing found matching that query.";
        return { content: [{ type: "text", text: notice + text }] };
      }),
    );

    server.registerTool(
      "list_recent",
      {
        description: "List recent memory visible to the service owner without mutating recall state.",
        inputSchema: {
          n: z.number().int().min(1).max(50).default(10),
          tag: z.string().optional(),
          after: z.number().int().optional(),
          before: z.number().int().optional(),
        },
      },
      safe(async ({ n, tag, after, before }) => {
        const rows = await governedRead(
          "memory.read",
          { limit: n, hasTag: Boolean(tag), temporal: after != null || before != null },
          async () => {
            const { sql, bindings } = buildEntryFilterQuery({ n, tag, after, before, userId });
            const { results } = await env.DB.prepare(sql).bind(...bindings).all();
            return results as Record<string, any>[];
          },
          (value) => ({ resultCount: value.length }),
        );
        const text = rows.length
          ? rows.map((row, index) => `${index + 1}. ID: ${row.id}\n${row.content}`).join("\n\n")
          : "No entries found.";
        return { content: [{ type: "text", text }] };
      }),
    );

    server.registerTool(
      "connections",
      {
        description: "Read the one-hop knowledge graph around a visible memory.",
        inputSchema: {
          id: z.string(),
          type: z.enum(Object.keys(EDGE_TYPES) as [string, ...string[]]).optional(),
        },
      },
      safe(async ({ id, type }) => {
        const connections = await governedRead(
          "memory.read",
          { entryId: id, edgeType: type ?? null },
          async () => await getVisibleMcpEntry(id, userId, env)
            ? getConnections(id, type, env, userId)
            : [],
          (value) => ({ connectionCount: value.length }),
          [id],
        );
        const text = connections.length
          ? connections.map((item) => `- (${item.label}) ${item.id}: ${item.content.slice(0, 160)}`).join("\n")
          : `No connections found for ${id}.`;
        return { content: [{ type: "text", text }] };
      }),
    );

    server.registerTool(
      "history",
      {
        description: "Read immutable episodes and snapshots for a memory owned by the service owner.",
        inputSchema: { entry_id: z.string() },
      },
      safe(async ({ entry_id }) => {
        const history = await governedRead(
          "memory.read",
          { entryId: entry_id, projection: "history" },
          () => loadOwnedMcpHistory(env, userId, entry_id),
          (value) => ({
            found: value !== null,
            episodeCount: value?.episodeTotal ?? 0,
            snapshotCount: value?.snapshotTotal ?? 0,
          }),
          [entry_id],
        );
        return {
          content: [{
            type: "text",
            text: history ? renderBoundedMcpHistory(history) : `No history found for entry ${entry_id}.`,
          }],
        };
      }),
    );

    server.registerTool(
      "create_action_proposal",
      {
        description: "Propose a governed memory or graph action for explicit human review.",
        inputSchema: {
          action_type: z.enum([...ACTION_TYPES] as [string, ...string[]]),
          payload_json: z.string().describe("JSON object containing the proposed action payload"),
          target_ids: z.array(z.string()).optional(),
          expected_revision: z.number().int().min(0).optional(),
          visibility_scope: z.enum(["private", "team"]).default("private"),
          risk_level: z.enum([...PROPOSAL_RISK_LEVELS] as [string, ...string[]]).default("medium"),
          reason: z.string(),
          idempotency_key: z.string(),
          expires_at: z.number().int().optional(),
        },
      },
      safe(async ({ action_type, payload_json, target_ids, expected_revision, visibility_scope, risk_level, reason, idempotency_key, expires_at }) => {
        let payload: unknown;
        try { payload = JSON.parse(payload_json); } catch { throw new Error("payload_json must be valid JSON."); }
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("payload_json must contain a JSON object.");
        const proposal = await createActionProposal(env, {
          actor: serviceActor,
          actionType: action_type as ActionType,
          payload: payload as Record<string, unknown>,
          targetIds: target_ids,
          expectedRevision: expected_revision,
          visibilityScope: visibility_scope,
          riskLevel: risk_level as ProposalRiskLevel,
          reason,
          idempotencyKey: idempotency_key,
          expiresAt: expires_at,
        });
        return { content: [{ type: "text", text: JSON.stringify(proposal, null, 2) }] };
      }),
    );

    server.registerTool(
      "list_action_proposals",
      {
        description: "List action proposals visible to this service identity.",
        inputSchema: {
          statuses: z.array(z.enum([...ACTION_PROPOSAL_STATUSES] as [string, ...string[]])).optional(),
          limit: z.number().int().min(1).max(100).default(50),
        },
      },
      safe(async ({ statuses, limit }) => {
        const proposals = await governedRead(
          "proposal.read",
          { statuses: statuses ?? ["pending"], limit },
          () => listActionProposals(env, { actor: serviceActor, statuses: statuses as ActionProposal["status"][] | undefined, limit }),
          (value) => ({ proposalCount: value.length }),
        );
        return { content: [{ type: "text", text: JSON.stringify(proposals, null, 2) }] };
      }),
    );

    server.registerTool(
      "execute_approved_action",
      {
        description: "Execute an already human-approved proposal. Requires explicit execute-approved scopes.",
        inputSchema: { proposal_id: z.string() },
      },
      safe(async ({ proposal_id }) => {
        const result = await executeApprovedProposal(env, { actor: serviceActor, proposalId: proposal_id });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }),
    );

    return server;
  }

  // Audit state: one run per MCP session, lazily created on first tool call.
  let runId: string | null = null;
  let toolCount = 0;

  /**
   * Wrap a tool handler with audit logging. Creates a run on first call,
   * logs each tool call with timing and error info, ends run on completion.
   */
  function audited<I extends Record<string, unknown>>(
    toolName: string,
    handler: (input: I, extra: any) => any,
  ): (input: I, extra: any) => any {
    return async (input: I, extra: any) => {
      if (!runId) runId = await startRun(env, userId);
      toolCount++;
      const t0 = Date.now();
      let error: string | undefined;
      let result: { content: { type: string; text: string }[] };
      try {
        result = await handler(input, extra);
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
        result = { content: [{ type: "text", text: `Error: ${error}` }] };
      }
      const durationMs = Date.now() - t0;
      // Audit shape and outcome only. Tool arguments/results routinely contain
      // memory content and may contain credentials supplied by mistake.
      const inputShape = { fields: Object.keys(input).sort() };
      ctx.waitUntil(logToolCall(env, runId, toolName, inputShape, null, durationMs, error ? "tool_error" : undefined).catch(() => {}));
      if (runId) ctx.waitUntil(endRun(env, runId, toolCount).catch(() => {}));
      return result;
    };
  }

  // ── remember ────────────────────────────────────────────────────────────
  server.registerTool(
    "remember",
    {
      description: "Store an idea, task, or note in your shared living memory. Call this automatically whenever the user shares context, goals, decisions, or preferences.",
      inputSchema: {
        content: z.string().describe("The idea, task, or note to store"),
        tags: z.array(z.string()).optional().describe("Optional tags for filtering"),
        source: z.string().optional().describe("Origin: phone, browser, voice, claude"),
        source_url: z.string().optional().describe("Optional source URL recorded with the memory"),
        source_title: z.string().optional().describe("Optional source title recorded with the memory"),
        visibility: z.enum(["private", "public"]).default("private").describe("Who can see the memory; omitted is private"),
      },
    },
    audited("remember", async ({ content, tags, source, source_url, source_title, visibility }) => {
      let result;
      try {
        result = await captureEntry(content, tags ?? [], source ?? "claude", env, ctx, userId, {
          sourceUrl: source_url,
          sourceTitle: source_title,
          visibility,
        });
      } catch (error) {
        if (!(error instanceof CaptureRejectedError)) throw error;
        if (error.code === "secret_detected") {
          console.warn("capture rejected", { detector: error.detector, actor_id: userId });
        }
        return { isError: true, content: [{ type: "text" as const, text: `Not stored: ${error.code}.` }] };
      }
      if (result.status === "blocked") {
        return { content: [{ type: "text", text: `Duplicate detected (${(result.score * 100).toFixed(0)}% match) — not stored. Existing entry ID: ${result.matchId}` }] };
      }
      const visibilityText = ` (visibility: ${result.visibility})`;
      if (result.status === "contradiction") {
        return { content: [{ type: "text", text: `Stored. ID: ${result.id}${visibilityText} — resolved contradiction with entry ${result.resolvedConflict}${result.reason ? `: ${result.reason}` : ""}.` }] };
      }
      if (result.status === "contradiction_protected") {
        return { content: [{ type: "text", text: `Stored as draft (ID: ${result.id}, visibility: ${result.visibility}) — conflicts with a canonical memory (${result.canonicalId}), which was kept${result.reason ? `: ${result.reason}` : ""}.` }] };
      }
      if (result.status === "replaced") {
        return { content: [{ type: "text", text: `Memory updated — new content replaced outdated entry (ID: ${result.id}, visibility: ${result.visibility}).` }] };
      }
      if (result.status === "merged") {
        return { content: [{ type: "text", text: `Memories merged — combined into existing entry (ID: ${result.id}, visibility: ${result.visibility}).` }] };
      }
      if (result.status === "flagged") {
        return { content: [{ type: "text", text: `Stored with ID: ${result.id}${visibilityText} — note: similar entry exists (${(result.score * 100).toFixed(0)}% match, ID: ${result.matchId}). Tagged as duplicate-candidate.` }] };
      }
      return { content: [{ type: "text", text: `Stored. ID: ${result.id}${visibilityText}` }] };
    })
  );

  // ── append ───────────────────────────────────────────────────────────────
  server.registerTool(
    "append",
    {
      description: "Append new information to an existing entry in your shared living memory. Use when something has changed or been updated — preserves the original and adds the update with a timestamp. Get the entry ID from recall or list_recent first.",
      inputSchema: {
        id: z.string().describe("Entry ID to append to — from recall or list_recent"),
        addition: z.string().describe("The new information to add to the existing entry"),
      },
    },
    audited("append", async ({ id, addition }) => {
      const row = await env.DB.prepare(
        `SELECT id, content, tags, source, owner_user_id FROM entries WHERE id = ?`
      ).bind(id).first() as Record<string, any> | null;

      if (!row) {
        return {
          content: [{ type: "text", text: `No entry found with ID: ${id}` }],
        };
      }

      if (userId && row.owner_user_id && row.owner_user_id !== userId && row.owner_user_id !== "") {
        return { content: [{ type: "text", text: `No entry found with ID: ${id}` }] };
      }

      const existingContent = row.content as string;
      const tags: string[] = JSON.parse(row.tags ?? "[]");
      const source = row.source as string;
      const a = addition.trim();

      if (!a) {
        return {
          content: [{ type: "text", text: "Addition cannot be empty." }],
        };
      }

      if (await isManagedMirror(id, source, userId, env)) {
        return { content: [{ type: "text", text: mirrorEditError(source) }] };
      }

      try {
        await appendToEntry(env, id, existingContent, a, tags, source, userId, ctx);
      } catch (e) {
        console.error("Append failed:", e);
        return {
          content: [{ type: "text", text: `Append failed: ${(e as Error).message}` }],
        };
      }

      return {
        content: [{
          type: "text",
          text: `Appended to entry ${id}. The original content is preserved and your update has been added with today's date.`,
        }],
      };
    })
  );

  // ── update ───────────────────────────────────────────────────────────────
  server.registerTool(
    "update",
    {
      description: "Replace the full content of an existing memory. Use when information has changed entirely — a preference reversed, a decision overturned, or content is outdated. Use append instead if you're adding new information rather than replacing. Get the entry ID from recall or list_recent first.",
      inputSchema: {
        id: z.string().describe("Entry ID to update — from recall or list_recent"),
        content: z.string().describe("The new content to replace the existing entry with"),
      },
    },
    audited("update", async ({ id, content }) => {
      const newContent = content.trim();
      if (!newContent) {
        return { content: [{ type: "text", text: "Content cannot be empty." }] };
      }

      const row = await env.DB.prepare(
        `SELECT content, tags, source, owner_user_id, revision,
                valid_from, valid_to, epistemic_status
         FROM entries WHERE id = ?`
      ).bind(id).first() as Record<string, any> | null;

      if (!row) {
        return { content: [{ type: "text", text: `No entry found with ID: ${id}` }] };
      }

      if (userId && row.owner_user_id && row.owner_user_id !== userId && row.owner_user_id !== "") {
        return { content: [{ type: "text", text: `No entry found with ID: ${id}` }] };
      }

      if (await isManagedMirror(id, row.source as string, userId, env)) {
        return { content: [{ type: "text", text: mirrorEditError(row.source as string) }] };
      }

      const tags: string[] = JSON.parse(row.tags ?? "[]").filter((t: string) => t !== "rolled-up");
      const source = row.source as string;
      const existingOwnerId = row.owner_user_id as string;

      try {
        const committed = await commitEntryVersion({
          kind: "update",
          actorUserId: existingOwnerId || userId,
          entryId: id,
          expectedRevision: Number(row.revision ?? 0),
          rawContent: content,
          materializedContent: newContent,
          tags,
          source,
          validFrom: row.valid_from as number | null,
          validTo: row.valid_to as number | null,
          epistemicStatus: row.epistemic_status,
        }, env);
        return {
          content: [{ type: "text", text: `Updated entry ${id} as revision ${committed.revision}. Re-embedded as ${committed.vectorIds.length} vector(s).` }],
        };
      } catch (e) {
        console.error("Versioned MCP update failed:", e);
        return { isError: true, content: [{ type: "text", text: versionErrorText(e) }] };
      }
    })
  );

  // ── set_status ─────────────────────────────────────────────────────────────
  server.registerTool(
    "set_status",
    {
      description: "Set a memory's lifecycle status. 'canonical' = confirmed/authoritative (protected from auto-overwrite), 'draft' = tentative, 'deprecated' = no longer accurate (removed from recall, kept for audit). Get the entry ID from recall or list_recent first.",
      inputSchema: {
        id: z.string().describe("Entry ID — from recall or list_recent"),
        status: z.enum([...STATUS_VALUES] as [string, ...string[]]).describe("canonical | draft | deprecated"),
      },
    },
    audited("set_status", async ({ id, status }) => {
      if (userId) {
        const row = await env.DB.prepare(`SELECT owner_user_id FROM entries WHERE id = ?`).bind(id).first() as { owner_user_id: string } | null;
        if (row && row.owner_user_id && row.owner_user_id !== userId && row.owner_user_id !== "") {
          return { content: [{ type: "text", text: `No entry found with ID: ${id}` }] };
        }
      }
      const ok = await applyStatus(id, status as MemoryStatus, env, userId);
      if (!ok) return { content: [{ type: "text", text: `No entry found with ID: ${id}` }] };
      return { content: [{ type: "text", text: status === "deprecated" ? `Entry ${id} deprecated — removed from recall, kept for audit.` : `Entry ${id} marked ${status}.` }] };
    })
  );

  // ── set_epistemic_status ──────────────────────────────────────────────────
  server.registerTool(
    "set_epistemic_status",
    {
      description: "Transition an entry's epistemic lifecycle state. Validates transitions — returns error with valid next states if transition is invalid. States: candidate → reviewed → canonical → qualified → superseded → retracted.",
      inputSchema: {
        entry_id: z.string().describe("Entry ID from recall or list_recent"),
        new_status: z.enum([...EPISTEMIC_STATUS_VALUES] as [string, ...string[]]).describe("New epistemic status"),
      },
    },
    audited("set_epistemic_status", async ({ entry_id, new_status }) => {
      const entry = await env.DB.prepare(
        `SELECT content, tags, source, owner_user_id, revision,
                valid_from, valid_to, epistemic_status
         FROM entries WHERE id = ?`,
      ).bind(entry_id).first() as Record<string, any> | null;
      if (!entry) return { content: [{ type: "text", text: `No entry found with ID: ${entry_id}` }] };
      if (entry.owner_user_id !== userId) {
        return { content: [{ type: "text", text: `No entry found with ID: ${entry_id}` }] };
      }
      const currentStatus = (entry.epistemic_status ?? "canonical") as EpistemicStatus;
      if (!isValidTransition(currentStatus, new_status as EpistemicStatus)) {
        const validNext = VALID_EPISTEMIC_TRANSITIONS[currentStatus] ?? [];
        return { content: [{ type: "text", text: `Invalid transition: ${currentStatus} → ${new_status}. Valid next states: ${validNext.length ? validNext.join(", ") : "(none — terminal state)"}` }] };
      }
      try {
        const committed = await commitEntryVersion({
          kind: "status",
          actorUserId: userId,
          entryId: entry_id,
          expectedRevision: Number(entry.revision ?? 0),
          rawContent: `epistemic:${new_status}`,
          materializedContent: entry.content as string,
          tags: JSON.parse(entry.tags ?? "[]"),
          source: entry.source as string,
          validFrom: entry.valid_from as number | null,
          validTo: entry.valid_to as number | null,
          epistemicStatus: new_status as EpistemicStatus,
        }, env);
        return { content: [{ type: "text", text: `Entry ${entry_id} transitioned: ${currentStatus} → ${new_status} (revision ${committed.revision}).` }] };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: versionErrorText(error) }] };
      }
    })
  );

  // ── recall ───────────────────────────────────────────────────────────────
  server.registerTool(
    "recall",
    {
      description: "Recall: semantically search your shared living memory for relevant notes and context. Call recall automatically at the start of every conversation and every 3-4 messages.",
      inputSchema: {
        query: z.string().describe("Natural language search query"),
        topK: z.number().int().min(1).max(20).default(5).describe("Number of results"),
        tag: z.string().optional().describe("Filter by a specific tag"),
        after: z.number().int().optional().describe("Only return entries after this Unix ms timestamp"),
        before: z.number().int().optional().describe("Only return entries before this Unix ms timestamp"),
        kind: z.enum([...KIND_VALUES] as [string, ...string[]]).optional().describe("Filter to episodic (events) or semantic (facts/knowledge)"),
        hops: z.number().int().min(0).max(3).default(0).describe("Graph expansion depth: 0 = direct matches only (default); 1–2 also surfaces related memories linked in the graph"),
        as_of: z.number().int().optional().describe("Unix millisecond timestamp — when the fact was true (valid time)"),
        known_at: z.number().int().optional().describe("Unix millisecond timestamp — reconstruct what the team knew then (knowledge time)"),
      },
    },
    audited("recall", async ({ query, topK, tag, after, before, kind, hops, as_of, known_at }) => {
      const { matches, insight, semanticUnavailable, proposed_edges } = await recallEntries({ query, topK, tag, after, before, kind: kind as MemoryKind | undefined, hops, userId, asOf: as_of, knownAt: known_at }, env, ctx);

      const notice = semanticUnavailable
        ? `Note: semantic search is unavailable because the Vectorize index is missing, so these are keyword matches only. Fix: ${VECTORIZE_FIX_HINT}.\n\n`
        : "";

      if (!matches.length) {
        return { content: [{ type: "text", text: notice + "Nothing found matching that query." }] };
      }

      let text = notice + renderRecallText(matches, insight, userId);
      if (proposed_edges.length) {
        text += `\n\n⚠️ **Contradictions detected** (${proposed_edges.length}):\n` +
          proposed_edges.map(pe => `  • ${pe.source_id} vs ${pe.target_id} — ${pe.reason}`).join("\n") +
          `\n\nUse \`list-proposals\` to review, or \`approve-proposal\` / \`reject-proposal\` to act.`;
      }
      return { content: [{ type: "text", text }] };
    })
  );

  // ── reinforce ────────────────────────────────────────────────────────────
  // Explicit human retention signal. Service actors return before this block,
  // and the owner predicate in reinforceOwnedEntry prevents cross-user use.
  if (actor.kind === "human") {
    server.registerTool(
      "reinforce",
      {
        description: "Explicitly reinforce one memory you own so it remains salient. Use only when the user asks to reinforce or keep that memory important. Every invocation increments the reinforcement count once; recall itself never does this.",
        inputSchema: {
          id: z.string().describe("Owned entry ID from recall or list_recent"),
        },
      },
      audited("reinforce", async ({ id }) => {
        const state = await reinforceOwnedEntry(id, actor.userId, env);
        if (!state) {
          return { content: [{ type: "text", text: `No entry found with ID: ${id}` }] };
        }
        return {
          content: [{
            type: "text",
            text: `Reinforced entry ${state.entryId} once. Reinforcement count: ${state.recallCount}; retention score reset to ${state.retentionScore.toFixed(1)}.`,
          }],
        };
      }),
    );
  }

  // ── list_recent ──────────────────────────────────────────────────────────
  server.registerTool(
    "list_recent",
    {
      description: "list_recent: List the most recent entries by date from your shared living memory. Use when you need to browse recent entries or find an entry ID. Not the same as recall — returns entries by time, not by meaning.",
      inputSchema: {
        n: z.number().int().min(1).max(50).default(10),
        tag: z.string().optional(),
        after: z.number().int().optional().describe("Only return entries after this Unix ms timestamp"),
        before: z.number().int().optional().describe("Only return entries before this Unix ms timestamp"),
      },
    },
    audited("list_recent", async ({ n, tag, after, before }) => {
      const { sql, bindings } = buildEntryFilterQuery({ n, tag, after, before, userId });
      const { results } = await env.DB.prepare(sql).bind(...bindings).all();

      if (!results.length) {
        return { content: [{ type: "text", text: "No entries found." }] };
      }

      const text = (results as Record<string, any>[]).map((row, i) => {
        const { source: safeSource } = sanitizeSourceMetadataForOutput({
          source: row.source,
        }, row.owner_user_id === userId ? "owner_mcp" : "team_public");
        const date = new Date(row.created_at as number).toLocaleDateString();
        const tags: string[] = JSON.parse(row.tags ?? "[]");
        const tagStr = tags.length ? ` · ${tags.join(", ")}` : "";
        const sourceStr = safeSource ? ` · ${safeSource}` : "";
        return `${i + 1}. [${date}${sourceStr}${tagStr}]\nID: ${row.id as string}\n${row.content}`;
      }).join("\n\n");

      return { content: [{ type: "text", text }] };
    })
  );

  // ── forget ───────────────────────────────────────────────────────────────
  // Permanent deletion is a compliance/erasure operation routed through the
  // mandatory-audit envelope (intent persisted before mutation). It is NOT the
  // ordinary correction path — agents must prefer deprecation via set_status.
  server.registerTool(
    "forget",
    {
      description: "Permanently delete an entry from your shared living memory by ID. This is a compliance/erasure operation, not a correction: prefer `set_status` with `status: deprecated` for ordinary mistakes, and never invoke permanent deletion implicitly. Only call `forget` when the user explicitly asks to delete something forever. Confirm the entry ID with recall or list_recent first, then pass it again as confirm_entry_id. This action cannot be undone.",
      inputSchema: {
        id: z.string().describe("Entry ID from recall or list_recent"),
        confirm_entry_id: z.string().describe("Must exactly match `id` to confirm permanent deletion"),
      },
    },
    async ({ id, confirm_entry_id }) => {
      if (confirm_entry_id !== id) {
        return { content: [{ type: "text", text: "confirm_entry_id must match id to confirm permanent deletion. This action cannot be undone." }] };
      }
      if (userId) {
        const row = await env.DB.prepare(`SELECT owner_user_id FROM entries WHERE id = ?`).bind(id).first() as { owner_user_id: string } | null;
        if (row && row.owner_user_id && row.owner_user_id !== userId && row.owner_user_id !== "") {
          return { content: [{ type: "text", text: `No entry found with ID: ${id}` }] };
        }
      }
      const decision = decideOperatorAction({ actor, operation: "entry.forget", autonomyProfile: "human-reviewed" });
      try {
        const result = await withMandatoryAudit(
          env,
          {
            actor,
            subjectUserId: userId,
            operation: "entry.forget",
            decision,
            targetIds: [id],
            redactedRequest: { entry_id: id, permanent_delete: true },
          },
          () => eraseEntryArtifacts(id, actor, env),
          (value) => value.status === "not_found" ? null : {
            erasure_status: value.status,
            operation_id: value.operationId,
            vector_count: value.vectorCount,
          },
        );
        if (result.status === "not_found") {
          return { content: [{ type: "text", text: `No entry found with ID: ${id}` }] };
        }
        if (result.status === "pending_cleanup") {
          return { content: [{ type: "text", text: `Permanent deletion committed for entry ${id}; ${result.vectorCount} vector(s) queued for remote cleanup (operation ${result.operationId}). Do not retry — the repair schedule finishes it.` }] };
        }
        return { content: [{ type: "text", text: `Permanently deleted entry ${id} and ${result.vectorCount} vector(s)` }] };
      } catch (error) {
        // A committed non-idempotent mutation must never be reported as failed.
        if (error instanceof MandatoryAuditError && error.stage === "succeeded") {
          return { content: [{ type: "text", text: `Permanent deletion committed for entry ${id} but audit finalization is pending reconciliation. Do not retry.` }] };
        }
        throw error;
      }
    });

  // ── link ─────────────────────────────────────────────────────────────────
  server.registerTool(
    "link",
    {
      description: "Create an explicit relationship link between two memories by ID (e.g. connect a decision to its outcome). Get the IDs from recall or list_recent first.",
      inputSchema: {
        source_id: z.string().describe("Source entry ID"),
        target_id: z.string().describe("Target entry ID"),
        type: z.enum(Object.keys(EDGE_TYPES) as [string, ...string[]]).default("relates_to").describe("Relationship type"),
      },
    },
    audited("link", async ({ source_id, target_id, type }) => {
      const endpointRows: McpEntryAccessRow[] = [];
      for (const id of [source_id, target_id]) {
        const row = await getVisibleMcpEntry(id, userId, env);
        if (!row) {
          return { content: [{ type: "text", text: `Entry not found: ${id}` }] };
        }
        endpointRows.push(row);
      }
      const sourcePrivate = hasMcpPrivateVisibility(endpointRows[0]);
      const targetPrivate = hasMcpPrivateVisibility(endpointRows[1]);
      if (sourcePrivate === null || targetPrivate === null || sourcePrivate !== targetPrivate) {
        return { content: [{ type: "text", text: "Cannot link entries across private and public visibility." }] };
      }
      const edge = await createEdge(source_id, target_id, type, {
        provenance: "explicit",
        weight: 1.0,
        actorKind: "human",
        actorId: userId,
        mutationKind: "explicit-link",
      }, env);
      if (!edge) return { content: [{ type: "text", text: "Unable to create a link between those entries." }] };
      return { content: [{ type: "text", text: `Linked ${edge.source_id} → ${edge.target_id} (${edgeLabel(edge.type)}).` }] };
    })
  );

  // ── unlink ───────────────────────────────────────────────────────────────
  server.registerTool(
    "unlink",
    {
      description: "Remove a relationship link between two memories by ID. Use when a link is incorrect or no longer relevant. Get the IDs from recall or connections first.",
      inputSchema: {
        source_id: z.string().describe("Source entry ID"),
        target_id: z.string().describe("Target entry ID"),
        type: z.enum(Object.keys(EDGE_TYPES) as [string, ...string[]]).optional().describe("Only remove this relationship type; omit to remove all links between the pair"),
      },
    },
    audited("unlink", async ({ source_id, target_id, type }) => {
      for (const id of [source_id, target_id]) {
        if (!await getVisibleMcpEntry(id, userId, env)) {
          return { content: [{ type: "text", text: `Entry not found: ${id}` }] };
        }
      }
      const deleted = await deleteEdge(source_id, target_id, type, env, {
        actorKind: "human",
        actorId: userId,
        mutationKind: "explicit-remove",
      });
      if (!deleted) return { content: [{ type: "text", text: "No link found between those entries." }] };
      return { content: [{ type: "text", text: `Removed ${deleted} link(s) between ${source_id} and ${target_id}.` }] };
    })
  );

  // ── connections ──────────────────────────────────────────────────────────
  server.registerTool(
    "connections",
    {
      description: "List the memories directly linked to a given entry (its 1-hop neighbors in the relationship graph). Get the entry ID from recall or list_recent first.",
      inputSchema: {
        id: z.string().describe("Entry ID from recall or list_recent"),
        type: z.enum(Object.keys(EDGE_TYPES) as [string, ...string[]]).optional().describe("Filter to a single relationship type"),
      },
    },
    audited("connections", async ({ id, type }) => {
      if (!await getVisibleMcpEntry(id, userId, env)) {
        return { content: [{ type: "text", text: `No connections found for ${id}.` }] };
      }
      const connections = await getConnections(id, type, env, userId);
      if (!connections.length) {
        return { content: [{ type: "text", text: `No connections found for ${id}.` }] };
      }
      const text = connections
        .map(c => `- (${c.label}) ${c.id}: ${c.content.slice(0, 120)} [confidence: ${(c.confidence * 100).toFixed(0)}%]`)
        .join("\n");
      return { content: [{ type: "text", text }] };
    })
  );

  // ── passages ──────────────────────────────────────────────────────────────
  server.registerTool(
    "passages",
    {
      description: "List evidence passages for an entry. Passages are source text chunks linked to entries for citation-level recall. Get the entry ID from recall or list_recent first.",
      inputSchema: {
        entry_id: z.string().describe("Entry ID from recall or list_recent"),
      },
    },
    audited("passages", async ({ entry_id }) => {
      if (!await getVisibleMcpEntry(entry_id, userId, env)) {
        return { content: [{ type: "text", text: `No passages found for entry ${entry_id}.` }] };
      }
      const projection = await env.DB.prepare(
        `SELECT current_episode_id, owner_user_id FROM entries WHERE id = ?`,
      ).bind(entry_id).first<{ current_episode_id: string | null; owner_user_id: string }>();
      if (!projection?.current_episode_id) {
        return { content: [{ type: "text", text: `No current citation passages found for entry ${entry_id}.` }] };
      }
      const { results } = await env.DB.prepare(
        `SELECT p.id, p.content, p.section, p.page, p.page_end,
                p.start_offset, p.end_offset, p.created_at,
                d.title AS document_title, d.source_url
         FROM passages p
         LEFT JOIN documents d
           ON d.id = p.document_id
          AND d.episode_id = p.episode_id
          AND (d.owner_user_id = ? OR d.owner_user_id = '')
         WHERE p.entry_id = ? AND p.episode_id = ?
         ORDER BY p.start_offset, p.id LIMIT 10`
      ).bind(projection.owner_user_id, entry_id, projection.current_episode_id).all() as { results: { id: string; content: string; section: string | null; page: number | null; page_end: number | null; start_offset: number | null; end_offset: number | null; created_at: number; document_title: string | null; source_url: string | null }[] };
      if (!results.length) return { content: [{ type: "text", text: `No passages found for entry ${entry_id}.` }] };
      const text = results.map((r, i) => {
        const { sourceTitle: safeTitle, sourceUrl: safeSourceUrl } = sanitizeSourceMetadataForOutput({
          sourceTitle: r.document_title,
          sourceUrl: r.source_url,
        }, projection.owner_user_id === userId ? "owner_mcp" : "team_public");
        const safeSection = sanitizeBoundedMetadataForOutput(r.section, SOURCE_TITLE_MAX_CODE_POINTS);
        const citation = {
          ...(safeTitle ? { title: safeTitle } : {}),
          ...(safeSection ? { section: safeSection } : {}),
          ...(r.page != null ? { page: r.page } : {}),
          ...(r.page_end != null ? { pageEnd: r.page_end } : {}),
          ...(r.start_offset != null ? { startOffset: r.start_offset } : {}),
          ...(r.end_offset != null ? { endOffset: r.end_offset } : {}),
          ...(safeSourceUrl ? { url: safeSourceUrl } : {}),
        };
        const excerpt = r.content.length > 300 ? `${r.content.slice(0, 297)}...` : r.content;
        return `${i + 1}. ${JSON.stringify(citation)}\n${JSON.stringify(excerpt)}`;
      }).join("\n\n");
      return { content: [{ type: "text", text: `Passages for ${entry_id}:\n\n${text}` }] };
    })
  );

  // ── history ──────────────────────────────────────────────────────────────
  server.registerTool(
    "history",
    {
      description: "List an owned memory's immutable revisions and rollback snapshots. Use a snapshot ID with restore.",
      inputSchema: {
        entry_id: z.string().describe("Entry ID from recall or list_recent"),
      },
    },
    audited("history", async ({ entry_id }) => {
      const history = await loadOwnedMcpHistory(env, userId, entry_id);
      if (!history) {
        return { content: [{ type: "text", text: `No history found for entry ${entry_id}.` }] };
      }
      return {
        content: [{ type: "text", text: renderBoundedMcpHistory(history) }],
      };
    }),
  );

  // ── restore ──────────────────────────────────────────────────────────────
  server.registerTool(
    "restore",
    {
      description: "Restore a previous version of an entry from its most recent snapshot. Creates a NEW entry with the snapshot content (never in-place rollback) to preserve full history.",
      inputSchema: {
        entry_id: z.string().describe("The ID of the entry to restore from"),
        snapshot_id: z.string().optional().describe("Optional specific snapshot ID; if omitted, restores the most recent snapshot"),
      },
    },
    audited("restore", async ({ entry_id, snapshot_id }) => {
      const snapshot = await loadOwnedRestoreSnapshot(env, userId, entry_id, snapshot_id);

      if (!snapshot) {
        return { content: [{ type: "text", text: `No snapshot found for entry ${entry_id}.` }] };
      }

      const snapContent = (snapshot.content as string) ?? "";
      const snapTagsRaw = snapshot.tags as string | null;
      let snapTags: string[] = [];
      try { snapTags = snapTagsRaw ? JSON.parse(snapTagsRaw) : []; } catch { snapTags = []; }
      const restoredTags = snapTags.filter((t: string) => !t.startsWith("status:"));
      restoredTags.push("restored");

      try {
        const result = await commitEntryVersion({
          kind: "restore",
          actorUserId: userId,
          forceCreate: true,
          restoredFromSnapshotId: snapshot.id as string,
          rawContent: snapContent,
          materializedContent: snapContent,
          tags: [...new Set(restoredTags)],
          source: (snapshot.source as string) ?? "restore",
          sourceUrl: (snapshot.source_url as string | null) ?? null,
          contentType: (snapshot.content_type as string) ?? "text",
          title: snapshot.source_title ?? undefined,
          titleOrigin: snapshot.source_title_origin ?? undefined,
          validFrom: (snapshot.valid_from as number | null) ?? null,
          validTo: (snapshot.valid_to as number | null) ?? null,
          epistemicStatus: "candidate",
        }, env);
        return { content: [{ type: "text", text: `Restored. New entry ID: ${result.entryId} — revision ${result.revision}, based on snapshot ${snapshot.id} from ${new Date(snapshot.created_at as number).toISOString()}.` }] };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: versionErrorText(error) }] };
      }
    })
  );

  // ── propose_edge ──────────────────────────────────────────────────────
  server.registerTool(
    "propose_edge",
    {
      description: "Propose a new relationship between two entries. Creates a pending edge proposal that requires human approval. Use for contradictions, clarifications, or other relationships you're not certain about.",
      inputSchema: {
        source_id: z.string().describe("Source entry ID"),
        target_id: z.string().describe("Target entry ID"),
        type: z.enum(Object.keys(EDGE_TYPES) as [string, ...string[]]).default("contradicts").describe("Relationship type"),
        reason: z.string().optional().describe("Why this link should exist"),
      },
    },
    audited("propose_edge", async ({ source_id, target_id, type, reason }) => {
      const trimmedSource = source_id.trim();
      const trimmedTarget = target_id.trim();
      if (!trimmedSource || !trimmedTarget) return { content: [{ type: "text", text: "source_id and target_id are required." }] };

      const endpointRows: McpEntryAccessRow[] = [];
      for (const id of [trimmedSource, trimmedTarget]) {
        const row = await getVisibleMcpEntry(id, userId, env);
        if (!row) return { content: [{ type: "text", text: `Entry not found: ${id}` }] };
        endpointRows.push(row);
      }
      const sourcePrivate = hasMcpPrivateVisibility(endpointRows[0]);
      const targetPrivate = hasMcpPrivateVisibility(endpointRows[1]);
      if (sourcePrivate === null || targetPrivate === null || sourcePrivate !== targetPrivate) {
        return { content: [{ type: "text", text: "Cannot propose a link across private and public visibility." }] };
      }

      // Dedup check
      const existing = await env.DB.prepare(
        `SELECT id, source_id, target_id, type, reason, proposed_by, status, created_at FROM edge_proposals WHERE source_id = ? AND target_id = ? AND type = ? AND status = 'pending'`
      ).bind(trimmedSource, trimmedTarget, type).first() as Record<string, any> | null;

      if (existing) return { content: [{ type: "text", text: `Existing pending proposal found: ${existing.id}. No duplicate created.` }] };

      const proposalId = crypto.randomUUID();
      const now = Date.now();
      await env.DB.prepare(
        `INSERT INTO edge_proposals (id, source_id, target_id, type, reason, proposed_by, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`
      ).bind(proposalId, trimmedSource, trimmedTarget, type, reason ?? "", userId, now).run();

      return { content: [{ type: "text", text: `Proposal ${proposalId} created: ${trimmedSource} —[${type}]→ ${trimmedTarget}. Reason: ${reason ?? "(none)"}. Awaiting human approval.` }] };
    })
  );

  // ── list-proposals ───────────────────────────────────────────────────
  server.registerTool(
    "list-proposals",
    {
      description: "List pending edge proposals awaiting human approval.",
      inputSchema: {},
    },
    audited("list-proposals", async () => {
      const vis = userId ? buildVisibilityClause(userId) : null;
      let sql = `SELECT id, source_id, target_id, type, reason, proposed_by, status, created_at FROM edge_proposals WHERE status = 'pending'`;
      const bindings: any[] = [];

      if (vis) {
        sql += ` AND EXISTS (SELECT 1 FROM entries e1 WHERE e1.id = edge_proposals.source_id AND ${vis.sql})`;
        sql += ` AND EXISTS (SELECT 1 FROM entries e2 WHERE e2.id = edge_proposals.target_id AND ${vis.sql})`;
        bindings.push(...vis.bind, ...vis.bind);
      }
      sql += ` ORDER BY created_at DESC`;

      const { results } = await env.DB.prepare(sql).bind(...bindings).all();
      if (!results.length) return { content: [{ type: "text", text: "No pending proposals." }] };

      const text = (results as Record<string, any>[]).map(r => {
        const date = new Date(r.created_at as number).toISOString().split("T")[0];
        return `- ${r.id}: ${r.source_id} —[${r.type}]→ ${r.target_id} (by ${r.proposed_by})\n  Reason: ${r.reason || "(none)"} [${date}]`;
      }).join("\n");

      return { content: [{ type: "text", text }] };
    })
  );

  // ── approve-proposal ─────────────────────────────────────────────────
  server.registerTool(
    "approve-proposal",
    {
      description: "Approve a pending edge proposal, creating the relationship edge in the graph. Requires an active administrator.",
      inputSchema: {
        proposal_id: z.string().describe("The proposal ID from list-proposals"),
      },
    },
    audited("approve-proposal", async ({ proposal_id }) => {
      if (!await isActiveMcpAdmin(actor, env)) {
        return { isError: true, content: [{ type: "text", text: "Administrator role required." }] };
      }
      const proposal = await env.DB.prepare(
        `SELECT id, source_id, target_id, type, reason, proposed_by, status, created_at FROM edge_proposals WHERE id = ?`
      ).bind(proposal_id).first() as Record<string, any> | null;

      if (!proposal) return { content: [{ type: "text", text: `Proposal not found: ${proposal_id}` }] };
      const endpointRows: McpEntryAccessRow[] = [];
      for (const id of [proposal.source_id as string, proposal.target_id as string]) {
        const row = await getVisibleMcpEntry(id, userId, env);
        if (!row) return { content: [{ type: "text", text: `Proposal not found: ${proposal_id}` }] };
        endpointRows.push(row);
      }
      if (proposal.status !== "pending") return { content: [{ type: "text", text: `Proposal is already ${proposal.status}.` }] };

      const sourcePrivate = hasMcpPrivateVisibility(endpointRows[0]);
      const targetPrivate = hasMcpPrivateVisibility(endpointRows[1]);
      if (sourcePrivate === null || targetPrivate === null || sourcePrivate !== targetPrivate) {
        return { content: [{ type: "text", text: `Proposal could not be approved: ${proposal_id}` }] };
      }

      const now = Date.now();
      const reserved = await env.DB.prepare(
        `UPDATE edge_proposals SET status = 'executing', resolved_by = ?
         WHERE id = ? AND status = 'pending'`,
      ).bind(userId, proposal_id).run();
      if ((reserved.meta.changes ?? 0) !== 1) {
        return { isError: true, content: [{ type: "text", text: `Proposal was resolved concurrently: ${proposal_id}` }] };
      }
      try {
        const edge = await createEdge(proposal.source_id, proposal.target_id, proposal.type, {
          provenance: "system",
          confidence: 1.0,
          actorKind: "human",
          actorId: userId,
          mutationKind: "proposal-publish",
          mutationId: `legacy-edge-proposal:${proposal_id}`,
        }, env);
        if (!edge) throw new Error("edge rejected");
        const completed = await env.DB.prepare(
          `UPDATE edge_proposals
           SET status = 'approved', resolved_at = ?, resolved_by = ?
           WHERE id = ? AND status = 'executing' AND resolved_by = ?`,
        ).bind(now, userId, proposal_id, userId).run();
        if ((completed.meta.changes ?? 0) !== 1) throw new Error("reservation lost");
      } catch {
        await env.DB.prepare(
          `UPDATE edge_proposals SET status = 'pending', resolved_by = NULL
           WHERE id = ? AND status = 'executing' AND resolved_by = ?`,
        ).bind(proposal_id, userId).run();
        return { isError: true, content: [{ type: "text", text: `Proposal could not be approved: ${proposal_id}` }] };
      }

      return { content: [{ type: "text", text: `Approved proposal ${proposal_id}: ${proposal.source_id} —[${proposal.type}]→ ${proposal.target_id}. Edge created.` }] };
    })
  );

  // ── reject-proposal ──────────────────────────────────────────────────
  server.registerTool(
    "reject-proposal",
    {
      description: "Reject a pending edge proposal, dismissing it without creating an edge. Requires an active administrator.",
      inputSchema: {
        proposal_id: z.string().describe("The proposal ID from list-proposals"),
      },
    },
    audited("reject-proposal", async ({ proposal_id }) => {
      if (!await isActiveMcpAdmin(actor, env)) {
        return { isError: true, content: [{ type: "text", text: "Administrator role required." }] };
      }
      const proposal = await env.DB.prepare(
        `SELECT id, source_id, target_id, type, reason, proposed_by, status, created_at FROM edge_proposals WHERE id = ?`
      ).bind(proposal_id).first() as Record<string, any> | null;

      if (!proposal) return { content: [{ type: "text", text: `Proposal not found: ${proposal_id}` }] };
      for (const id of [proposal.source_id as string, proposal.target_id as string]) {
        if (!await getVisibleMcpEntry(id, userId, env)) {
          return { content: [{ type: "text", text: `Proposal not found: ${proposal_id}` }] };
        }
      }
      if (proposal.status !== "pending") return { content: [{ type: "text", text: `Proposal is already ${proposal.status}.` }] };

      const now = Date.now();
      const rejected = await env.DB.prepare(
        `UPDATE edge_proposals
         SET status = 'rejected', resolved_at = ?, resolved_by = ?
         WHERE id = ? AND status = 'pending'`,
      ).bind(now, userId, proposal_id).run();
      if ((rejected.meta.changes ?? 0) !== 1) {
        return { isError: true, content: [{ type: "text", text: `Proposal was resolved concurrently: ${proposal_id}` }] };
      }

      return { content: [{ type: "text", text: `Rejected proposal ${proposal_id}: ${proposal.source_id} —[${proposal.type}]→ ${proposal.target_id}.` }] };
    })
  );

  if (actor.kind === "human") {
    const governedTool = <I extends Record<string, unknown>>(
      handler: (input: I) => Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }>,
    ) => async (input: I) => {
      try {
        return await handler(input);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Governed proposal request failed.";
        return { isError: true, content: [{ type: "text" as const, text: `Error: ${message}` }] };
      }
    };

    server.registerTool(
      "create_action_proposal",
      {
        description: "Create a governed action proposal with explicit payload, risk, preconditions, and retry identity.",
        inputSchema: {
          action_type: z.enum([...ACTION_TYPES] as [string, ...string[]]),
          payload_json: z.string().describe("JSON object containing the proposed action payload"),
          target_ids: z.array(z.string()).optional(),
          expected_revision: z.number().int().min(0).optional(),
          visibility_scope: z.enum(["private", "team"]).default("private"),
          risk_level: z.enum([...PROPOSAL_RISK_LEVELS] as [string, ...string[]]).default("medium"),
          reason: z.string(),
          idempotency_key: z.string(),
          expires_at: z.number().int().optional(),
        },
      },
      governedTool(async ({ action_type, payload_json, target_ids, expected_revision, visibility_scope, risk_level, reason, idempotency_key, expires_at }) => {
        let payload: unknown;
        try { payload = JSON.parse(payload_json); } catch { throw new Error("payload_json must be valid JSON."); }
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("payload_json must contain a JSON object.");
        const proposal = await createActionProposal(env, {
          actor,
          actionType: action_type as ActionType,
          payload: payload as Record<string, unknown>,
          targetIds: target_ids,
          expectedRevision: expected_revision,
          visibilityScope: visibility_scope,
          riskLevel: risk_level as ProposalRiskLevel,
          reason,
          idempotencyKey: idempotency_key,
          expiresAt: expires_at,
        });
        return { content: [{ type: "text", text: JSON.stringify(proposal, null, 2) }] };
      }),
    );

    server.registerTool(
      "list_action_proposals",
      {
        description: "List governed action proposals visible to this team member.",
        inputSchema: {
          statuses: z.array(z.enum([...ACTION_PROPOSAL_STATUSES] as [string, ...string[]])).optional(),
          limit: z.number().int().min(1).max(100).default(50),
        },
      },
      governedTool(async ({ statuses, limit }) => {
        const proposals = await listActionProposals(env, { actor, statuses: statuses as ActionProposal["status"][] | undefined, limit });
        return { content: [{ type: "text", text: JSON.stringify(proposals, null, 2) }] };
      }),
    );

    server.registerTool(
      "review_action_proposal",
      {
        description: "Approve or reject a visible governed action proposal. Service identities cannot use this tool.",
        inputSchema: {
          proposal_id: z.string(),
          decision: z.enum(["approve", "reject"]),
          reason: z.string(),
        },
      },
      governedTool(async ({ proposal_id, decision, reason }) => {
        const proposal = await reviewActionProposal(env, {
          actor,
          proposalId: proposal_id,
          decision,
          reason,
        });
        return { content: [{ type: "text", text: JSON.stringify(proposal, null, 2) }] };
      }),
    );

    server.registerTool(
      "execute_approved_action",
      {
        description: "Execute an explicitly human-approved governed action proposal.",
        inputSchema: { proposal_id: z.string() },
      },
      governedTool(async ({ proposal_id }) => {
        const result = await executeApprovedProposal(env, { actor, proposalId: proposal_id });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }),
    );

    // ── rate_recall ───────────────────────────────────────────────────────
    server.registerTool(
      "rate_recall",
      {
        description: "Rate a recall result as helpful or not_helpful with an optional reason code. Feedback is analytics-only — it does not change future recall behavior during the pilot.",
        inputSchema: {
          recall_event_id: z.string().describe("Recall event ID returned by the recall tool in its response metadata"),
          rating: z.enum(["helpful", "not_helpful"]).describe("Whether the recall result was useful"),
          reason: z.enum(["irrelevant", "missing", "stale", "conflicting", "unsupported", "too_much", "other"]).default("other").describe("Reason code when rating is not_helpful"),
        },
      },
      async ({ recall_event_id, rating, reason }) => {
        const ok = await submitRecallFeedback(env, { recallEventId: recall_event_id, userId: userId!, rating, reason });
        if (!ok) return { content: [{ type: "text", text: "Could not record feedback." }], isError: true };
        return { content: [{ type: "text", text: `Feedback recorded: ${rating}` }] };
      },
    );
  }

  return server;
}

// ─── MCP tools/list sanitization ──────────────────────────────────────────────
// Newer @modelcontextprotocol/sdk releases attach an `execution` (task-support)
// field to each tool definition in tools/list responses. Strict MCP clients —
// OpenAI Codex at the time of writing — reject the entire tool list when they
// see the unknown field, which breaks the connection outright. Strip it so any
// client can connect; the server doesn't use MCP task execution, so nothing is
// lost. Remove this shim if we ever adopt task execution or once strict clients
// tolerate unknown fields.
//
// Bug discovered, and fix originally authored, in the
// guoyingwei6/shared-living-memory-cloudflare fork (commit a3fa15f).

export async function isMcpToolsListRequest(request: Request): Promise<boolean> {
  if (request.method !== "POST") return false;
  try {
    const payload = await request.clone().json();
    return isRecord(payload) && payload.method === "tools/list";
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function removeToolExecutionMetadata(payload: unknown): unknown {
  if (!isRecord(payload) || !isRecord(payload.result) || !Array.isArray(payload.result.tools)) {
    return payload;
  }

  const tools = payload.result.tools.map(tool => {
    if (!isRecord(tool) || !("execution" in tool)) return tool;
    const { execution: _execution, ...toolWithoutExecution } = tool;
    return toolWithoutExecution;
  });

  return {
    ...payload,
    result: {
      ...payload.result,
      tools,
    },
  };
}

export async function sanitizeToolsListResponse(response: Response): Promise<Response> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json") && !contentType.includes("text/event-stream")) {
    return response;
  }

  const headers = new Headers(response.headers);
  headers.delete("content-length");

  if (contentType.includes("text/event-stream")) {
    const body = await response.text();
    const sanitized = body.split("\n").map(line => {
      if (!line.startsWith("data: ")) return line;
      try {
        return `data: ${JSON.stringify(removeToolExecutionMetadata(JSON.parse(line.slice(6))))}`;
      } catch {
        return line;
      }
    }).join("\n");

    return new Response(sanitized, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  try {
    const payload = await response.json();
    return new Response(JSON.stringify(removeToolExecutionMetadata(payload)), {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch {
    return response;
  }
}
