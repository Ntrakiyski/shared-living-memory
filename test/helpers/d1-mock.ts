import { COMPRESSION_IMPORTANCE_THRESHOLD, COMPRESSION_MIN_RECALL } from "../../src/testing";
import {
  TEST_USER_AUTH_HASH,
  TEST_USER_ID,
  TEST_USERNAME,
} from "./test-principal";

function extractValue(s: string, args: any[], index: number): string | undefined {
  if (args[index] !== undefined) return args[index] as string;
  const match = s.match(/'([^']+)'/);
  return match ? match[1] : undefined;
}

function parseTags(raw: unknown): string[] {
  try {
    const value = typeof raw === "string" ? JSON.parse(raw) : raw;
    return Array.isArray(value) ? value.filter((tag): tag is string => typeof tag === "string") : [];
  } catch {
    return [];
  }
}

function normalizeEntry(row: any): any {
  if (!row) return row;
  row.owner_user_id ??= "";
  row.valid_from ??= null;
  row.valid_to ??= null;
  row.recorded_at ??= row.created_at ?? null;
  row.epistemic_status ??= "canonical";
  row.current_episode_id ??= null;
  row.revision ??= 0;
  row.created_by_user_id ??= row.owner_user_id;
  row.visibility ??= parseTags(row.tags).includes("private") ? "private" : "public";
  row.vector_sync_pending ??= 0;
  row.updated_at ??= row.created_at ?? 0;
  row.vector_ids ??= "[]";
  row.recall_count ??= 0;
  row.importance_score ??= 0;
  row.contradiction_wins ??= 0;
  row.contradiction_losses ??= 0;
  row.last_recalled_at ??= null;
  return row;
}

function normalizeEdge(row: any): any {
  if (!row) return row;
  row.confidence ??= 1.0;
  row.revision ??= 1;
  row.last_actor_kind ??= "system";
  row.last_actor_id ??= "_migration";
  row.last_mutation_kind ??= "legacy";
  row.last_mutation_id ??= null;
  return row;
}

function recordEdgeVersion(
  db: D1Mock,
  edge: any,
  isDeleted = 0,
  revision = Number(normalizeEdge(edge).revision),
  recordedAt = edge.updated_at ?? Date.now(),
): void {
  const normalized = normalizeEdge(edge);
  if (db.edge_versions.some((row: any) =>
    row.edge_id === normalized.id && Number(row.revision) === Number(revision))) {
    return;
  }
  db.edge_versions.push({
    id: `edge-version:${normalized.id}:${revision}`,
    edge_id: normalized.id,
    source_id: normalized.source_id,
    target_id: normalized.target_id,
    type: normalized.type,
    weight: normalized.weight,
    provenance: normalized.provenance,
    metadata: normalized.metadata,
    confidence: normalized.confidence,
    edge_created_at: normalized.created_at,
    edge_updated_at: normalized.updated_at,
    revision,
    is_deleted: isDeleted,
    mutation_kind: normalized.last_mutation_kind,
    mutation_id: normalized.last_mutation_id,
    actor_kind: normalized.last_actor_kind,
    actor_id: normalized.last_actor_id,
    recorded_at: recordedAt,
  });
}

function guardedEntry(
  entries: any[],
  id: unknown,
  ownerUserId: unknown,
  revision: unknown,
  requireMissingEpisode = false,
): any | null {
  const row = entries.find((entry: any) => entry.id === id);
  if (!row) return null;
  normalizeEntry(row);
  if (row.owner_user_id !== ownerUserId || Number(row.revision) !== Number(revision)) return null;
  if (requireMissingEpisode && row.current_episode_id !== null) return null;
  return row;
}

export class D1Mock {
  entries: any[] = [];
  edges: any[] = [];
  edge_versions: any[] = [];
  users: any[] = [];
  episodes: any[] = [];
  passages: any[] = [];
  documents: any[] = [];
  document_sections: any[] = [];
  entry_snapshots: any[] = [];
  vector_cleanup_queue: any[] = [];
  edgeProposals: any[] = [];
  agentRuns: any[] = [];
  agentEvents: any[] = [];
  user_deactivations: any[] = [];
  service_identities: any[] = [];
  service_credentials: any[] = [];
  security_events: any[] = [];
  action_proposals: any[] = [];
  proposal_events: any[] = [];

  prepare(sql: string) {
    const s = sql.replace(/\s+/g, " ").trim();
    const db = this;

    const makeStmt = (args: any[]) => ({
      async run() {
        if (s.startsWith("INSERT INTO entries")) {
          if (s.includes("current_episode_id") && s.includes("created_by_user_id")) {
            const [
              id, content, tags, source, created_at, vector_ids, owner_user_id,
              valid_from, valid_to, recorded_at, epistemic_status,
              current_episode_id, revision, created_by_user_id, visibility,
              updated_at,
            ] = args;
            if (db.entries.some((entry: any) => entry.id === id)) {
              throw new Error("UNIQUE constraint failed: entries.id");
            }
            db.entries.push(normalizeEntry({
              id, content, tags, source, created_at, vector_ids, owner_user_id,
              valid_from, valid_to, recorded_at, epistemic_status,
              current_episode_id, revision, created_by_user_id, visibility,
              vector_sync_pending: 0, updated_at,
            }));
            return { meta: { changes: 1 } };
          }

          const [id, content, tags, source, created_at, vector_ids, owner_user_id, valid_from, recorded_at] = args;
          if (db.entries.some((entry: any) => entry.id === id)) {
            throw new Error("UNIQUE constraint failed: entries.id");
          }
          db.entries.push(normalizeEntry({
            id, content, tags, source, created_at, vector_ids,
            owner_user_id: owner_user_id ?? "",
            valid_from: valid_from ?? created_at ?? null,
            recorded_at: recorded_at ?? created_at ?? null,
            valid_to: null,
            epistemic_status: "canonical",
          }));
          return { meta: { changes: 1 } };
        }
        if (s.startsWith("INSERT INTO users")) {
          const [id, username, normalized_username, auth_key_hash, auth_key_prefix, created_at] = args;
          const existing = db.users.find((u: any) => u.normalized_username === normalized_username);
          if (existing) throw new Error("UNIQUE constraint failed");
          const statusMatch = s.match(/'(\w+)'/);
          const status = statusMatch ? statusMatch[1] : "active";
          db.users.push({ id, username, normalized_username, auth_key_hash, auth_key_prefix, status, created_at, last_used_at: null });
          return { meta: { changes: 1 } };
        }
        if (s.startsWith("UPDATE entries SET owner_user_id")) {
          const [owner_user_id] = args;
          let count = 0;
          for (const row of db.entries) {
            // SQLite's ALTER ... DEFAULT '' materializes the empty owner on
            // legacy rows. Direct test fixtures omit the property entirely,
            // so model both representations before the bootstrap backfill.
            if (row.owner_user_id === "" || row.owner_user_id == null) {
              row.owner_user_id = owner_user_id;
              count++;
            }
          }
          return { meta: { changes: count } };
        }
        if (s.startsWith("UPDATE entries SET vector_sync_pending = 1, updated_at = ?")) {
          const [updatedAt, id, ownerUserId] = args;
          const row = db.entries.find((entry: any) => entry.id === id);
          if (!row) return { meta: { changes: 0 } };
          normalizeEntry(row);
          const expectedVisibility = s.includes("visibility = 'private'")
            ? "private"
            : s.includes("visibility = ?") ? args[3] : null;
          const expectedRevision = s.includes("revision = ?") ? args[4] : null;
          if (row.owner_user_id !== ownerUserId
              || expectedVisibility && row.visibility !== expectedVisibility
              || expectedRevision != null && Number(row.revision) !== Number(expectedRevision)) {
            return { meta: { changes: 0 } };
          }
          row.vector_sync_pending = 1;
          row.updated_at = updatedAt;
          return { meta: { changes: 1 } };
        }
        if (s.startsWith("UPDATE entries SET visibility = ?, tags = ?, vector_sync_pending = 0")) {
          const [
            visibility, tags, revisionIncrement, shouldRecord, recordedAt,
            updatedAt, id, ownerUserId, expectedVisibility, expectedRevision,
          ] = args;
          const row = db.entries.find((entry: any) => entry.id === id);
          if (!row) return { meta: { changes: 0 } };
          normalizeEntry(row);
          if (row.owner_user_id !== ownerUserId
              || row.visibility !== expectedVisibility
              || Number(row.revision) !== Number(expectedRevision)
              || Number(row.vector_sync_pending) !== 1) {
            return { meta: { changes: 0 } };
          }
          row.visibility = visibility;
          row.tags = tags;
          row.vector_sync_pending = 0;
          row.revision = Number(row.revision) + Number(revisionIncrement);
          if (Number(shouldRecord) === 1) row.recorded_at = recordedAt;
          row.updated_at = updatedAt;
          return { meta: { changes: 1 } };
        }
        if (
          s.startsWith("UPDATE entries SET content = ?, tags = ?, source = ?, vector_ids = ?") &&
          s.includes("revision = revision + 1")
        ) {
          const [
            content, tags, source, vector_ids, valid_from, valid_to, recorded_at,
            epistemic_status, current_episode_id, updated_at,
            id, owner_user_id, revision,
          ] = args;
          const row = guardedEntry(db.entries, id, owner_user_id, revision);
          if (!row) return { meta: { changes: 0 } };
          Object.assign(row, {
            content,
            tags,
            source,
            vector_ids,
            valid_from,
            valid_to,
            recorded_at,
            epistemic_status,
            current_episode_id,
            revision: Number(row.revision) + 1,
            updated_at,
            vector_sync_pending: 0,
          });
          return { meta: { changes: 1 } };
        }
        if (s.startsWith("UPDATE entries SET vector_ids = '[]' WHERE id = ? AND revision = ?")) {
          const [id, revision] = args;
          const row = db.entries.find((entry: any) => entry.id === id);
          if (!row || Number(normalizeEntry(row).revision) !== Number(revision)) {
            return { meta: { changes: 0 } };
          }
          row.vector_ids = "[]";
          return { meta: { changes: 1 } };
        }
        if (s.startsWith("UPDATE entries SET content = ?, vector_ids")) {
          const [content, vector_ids, id] = args;
          const row = db.entries.find((e: any) => e.id === id);
          if (row) { row.content = content; row.vector_ids = vector_ids; }
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE entries SET content = ?, tags = ?, vector_ids")) {
          const [content, tags, vector_ids, id] = args;
          const row = db.entries.find((e: any) => e.id === id);
          if (row) { row.content = content; row.tags = tags; row.vector_ids = vector_ids; }
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE entries SET tags = ?, vector_ids")) {
          const [tags, vector_ids, id] = args;
          const row = db.entries.find((e: any) => e.id === id);
          if (row) { row.tags = tags; row.vector_ids = vector_ids; }
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE entries SET vector_ids")) {
          const [vector_ids, id] = args;
          const row = db.entries.find((e: any) => e.id === id);
          if (row) row.vector_ids = vector_ids;
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE entries SET tags = ? WHERE id")) {
          const [tags, id] = args;
          const row = db.entries.find((e: any) => e.id === id);
          if (row) row.tags = tags;
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE entries SET content = ?, tags")) {
          const [content, tags, id] = args;
          const row = db.entries.find((e: any) => e.id === id);
          if (row) { row.content = content; row.tags = tags; }
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE entries SET content")) {
          const [content, id] = args;
          const row = db.entries.find((e: any) => e.id === id);
          if (row) row.content = content;
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE entries SET tags = json_insert(tags, '$[#]', 'rolled-up'), content = content ||")) {
          const [addition, id] = args;
          const row = db.entries.find((e: any) => e.id === id);
          if (row) {
            const tags: string[] = JSON.parse(row.tags ?? "[]");
            if (!tags.includes("rolled-up")) tags.push("rolled-up");
            row.tags = JSON.stringify(tags);
            row.content = row.content + addition;
          }
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE entries SET tags = json_insert(tags, '$[#]'")) {
          const [tag, id] = args;
          const row = db.entries.find((e: any) => e.id === id);
          if (row) {
            const tags: string[] = JSON.parse(row.tags ?? "[]");
            if (!tags.includes(tag)) tags.push(tag);
            row.tags = JSON.stringify(tags);
          }
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE entries SET contradiction_wins = contradiction_wins + 1")) {
          const [id] = args;
          const row = db.entries.find((e: any) => e.id === id);
          if (row) row.contradiction_wins = (row.contradiction_wins ?? 0) + 1;
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE entries SET contradiction_losses = contradiction_losses + 1")) {
          const [id] = args;
          const row = db.entries.find((e: any) => e.id === id);
          if (row) row.contradiction_losses = (row.contradiction_losses ?? 0) + 1;
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE entries SET recall_count")) {
          const [value, id] = args;
          const row = db.entries.find((e: any) => e.id === id);
          if (row) {
            row.recall_count = (row.recall_count ?? 0) + 1;
            if (s.includes("last_recalled_at")) row.last_recalled_at = value;
          }
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE entries SET importance_score")) {
          const [score, id] = args;
          const row = db.entries.find((e: any) => e.id === id);
          if (row) row.importance_score = score;
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE entries SET epistemic_status")) {
          if (s.includes("WHERE valid_to IS NOT NULL")) {
            // detectStaleness: mark entries with valid_to set
            let changes = 0;
            for (const e of db.entries) {
              if (e.valid_to != null && e.epistemic_status !== "stale") {
                e.epistemic_status = "stale";
                changes++;
              }
            }
            return { meta: { changes } };
          }
          if (s.includes("WHERE id IN")) {
            // detectStaleness: mark entries with low-confidence incoming edges
            // The subquery selects target_id from edges where confidence < threshold
            const threshold = args[0] as number;
            const staleIds = new Set(
              db.edges
                .filter((e: any) => {
                  const meta = e.metadata ? JSON.parse(e.metadata) : {};
                  const conf = meta.confidence ?? e.weight;
                  return conf < threshold && conf > 0;
                })
                .map((e: any) => e.target_id)
            );
            let changes = 0;
            for (const e of db.entries) {
              if (staleIds.has(e.id) && e.epistemic_status !== "stale") {
                e.epistemic_status = "stale";
                changes++;
              }
            }
            return { meta: { changes } };
          }
          if (s.includes("WHERE created_at <")) {
            // detectStaleness: mark old entries with no recalls
            const cutoff = args[0] as number;
            let changes = 0;
            for (const e of db.entries) {
              if (e.created_at < cutoff && (e.recall_count ?? 0) === 0 && e.epistemic_status !== "stale") {
                e.epistemic_status = "stale";
                changes++;
              }
            }
            return { meta: { changes } };
          }
          // Generic epistemic_status update (e.g., POST /epistemic-status)
          const [newStatus, id] = args;
          const row = db.entries.find((e: any) => e.id === id);
          if (row) {
            row.epistemic_status = newStatus;
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        }
        if (s.startsWith("INSERT INTO agent_runs")) {
          const [id, userId, startedAt] = args;
          db.agentRuns.push({ id, user_id: userId, started_at: startedAt, completed_at: null, tool_count: 0 });
          return { meta: { changes: 1 } };
        }
        if (s.startsWith("INSERT INTO agent_events")) {
          const [id, runId, toolName, inputSummary, outputSummary, durationMs, error, createdAt] = args;
          db.agentEvents.push({ id, run_id: runId, tool_name: toolName, input_summary: inputSummary, output_summary: outputSummary, duration_ms: durationMs, error, created_at: createdAt });
          return { meta: { changes: 1 } };
        }
        if (s.startsWith("UPDATE agent_runs SET completed_at")) {
          const [completedAt, toolCount, id] = args;
          const row = db.agentRuns.find((r: any) => r.id === id);
          if (row) { row.completed_at = completedAt; row.tool_count = toolCount; }
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("DELETE FROM edge_proposals WHERE source_id")) {
          const [sourceId, targetId] = args;
          const before = db.edgeProposals.length;
          db.edgeProposals = db.edgeProposals.filter(
            (proposal: any) => proposal.source_id !== sourceId && proposal.target_id !== targetId
          );
          return { meta: { changes: before - db.edgeProposals.length } };
        }
        if (s.startsWith("DELETE FROM passages WHERE entry_id")) {
          const [entryId] = args;
          const before = db.passages.length;
          db.passages = db.passages.filter((passage: any) => passage.entry_id !== entryId);
          return { meta: { changes: before - db.passages.length } };
        }
        if (s.startsWith("DELETE FROM episodes WHERE entry_id")) {
          const [entryId] = args;
          const before = db.episodes.length;
          db.episodes = db.episodes.filter((episode: any) => episode.entry_id !== entryId);
          return { meta: { changes: before - db.episodes.length } };
        }
        if (s.startsWith("DELETE FROM entry_snapshots WHERE entry_id")) {
          const [entryId] = args;
          const before = db.entry_snapshots.length;
          db.entry_snapshots = db.entry_snapshots.filter((snapshot: any) => snapshot.entry_id !== entryId);
          return { meta: { changes: before - db.entry_snapshots.length } };
        }
        if (s.startsWith("DELETE FROM entries WHERE id")) {
          const [id] = args;
          const before = db.entries.length;
          db.entries = db.entries.filter((e: any) => e.id !== id);
          return { meta: { changes: before - db.entries.length } };
        }
        if (s.startsWith("INSERT INTO edges")) {
          if (s.includes("'restore'")) {
            const [
              id, source_id, target_id, type, weight, provenance, metadata,
              confidence, created_at, updated_at, revision, userId,
              mutationId,
            ] = args;
            const existing = db.edges.find((edge: any) =>
              edge.source_id === source_id && edge.target_id === target_id && edge.type === type);
            if (existing && existing.id !== id) return { meta: { changes: 0 } };
            if (existing) {
              normalizeEdge(existing);
              Object.assign(existing, {
                weight,
                provenance,
                metadata,
                confidence,
                updated_at,
                revision: Number(existing.revision) + 1,
                last_actor_kind: "human",
                last_actor_id: userId,
                last_mutation_kind: "restore",
                last_mutation_id: mutationId,
              });
              recordEdgeVersion(db, existing, 0, existing.revision, updated_at);
            } else {
              const edge = normalizeEdge({
                id, source_id, target_id, type, weight, provenance, metadata,
                confidence, created_at, updated_at, revision,
                last_actor_kind: "human",
                last_actor_id: userId,
                last_mutation_kind: "restore",
                last_mutation_id: mutationId,
              });
              db.edges.push(edge);
              recordEdgeVersion(db, edge, 0, edge.revision, updated_at);
            }
            return { meta: { changes: 1 } };
          }
          const [
            id, source_id, target_id, type, weight, provenance, metadata,
            confidence, created_at, updated_at, revision, last_actor_kind,
            last_actor_id, last_mutation_kind, last_mutation_id,
          ] = args;
          const existing = db.edges.find((e: any) => e.source_id === source_id && e.target_id === target_id && e.type === type);
          if (existing) {
            normalizeEdge(existing);
            existing.weight = Math.max(existing.weight, weight); // ON CONFLICT ... max(weight)
            const existingConfidence = existing.confidence ?? 1.0;
            existing.confidence = Math.max(existingConfidence, confidence);
            if (confidence >= existingConfidence) {
              existing.provenance = provenance;
              existing.metadata = metadata;
            }
            existing.updated_at = updated_at;
            existing.revision = Number(existing.revision) + 1;
            existing.last_actor_kind = last_actor_kind ?? "system";
            existing.last_actor_id = last_actor_id ?? "_legacy_graph_writer";
            existing.last_mutation_kind = last_mutation_kind ?? "explicit-upsert";
            existing.last_mutation_id = last_mutation_id ?? null;
            recordEdgeVersion(db, existing, 0, existing.revision, updated_at);
          } else {
            const edge = normalizeEdge({
              id, source_id, target_id, type, weight, provenance, metadata,
              confidence, created_at, updated_at,
              revision: revision ?? 1,
              last_actor_kind: last_actor_kind ?? "system",
              last_actor_id: last_actor_id ?? "_legacy_graph_writer",
              last_mutation_kind: last_mutation_kind ?? "explicit-upsert",
              last_mutation_id: last_mutation_id ?? null,
            });
            db.edges.push(edge);
            recordEdgeVersion(db, edge, 0, edge.revision, updated_at);
          }
          return { meta: { changes: 1 } };
        }
        if (s.startsWith("INSERT INTO episodes")) {
          if (s.includes("materialized_content") && s.includes("SELECT")) {
            if (s.includes("current_episode_id IS NULL")) {
              const [id, content_hash, mutation_id, entryId, ownerUserId, revision] = args;
              const entry = guardedEntry(db.entries, entryId, ownerUserId, revision, true);
              if (!entry) return { meta: { changes: 0 } };
              db.episodes.push({
                id,
                entry_id: entry.id,
                content: entry.content,
                content_type: "text",
                source: entry.source,
                created_at: entry.recorded_at ?? entry.created_at,
                materialized_content: entry.content,
                content_hash,
                mutation_id,
                mutation_kind: "legacy",
                parent_episode_id: null,
                restored_from_snapshot_id: null,
                owner_user_id: entry.owner_user_id,
                source_url: null,
              });
              return { meta: { changes: 1 } };
            }

            const [
              id, content, content_type, source, created_at,
              materialized_content, content_hash, mutation_id, mutation_kind,
              parent_episode_id, restored_from_snapshot_id, source_url,
              entryId, ownerUserId, revision,
            ] = args;
            const entry = guardedEntry(db.entries, entryId, ownerUserId, revision);
            if (!entry) return { meta: { changes: 0 } };
            db.episodes.push({
              id,
              entry_id: entry.id,
              content,
              content_type,
              source,
              created_at,
              materialized_content,
              content_hash,
              mutation_id,
              mutation_kind,
              parent_episode_id,
              restored_from_snapshot_id,
              owner_user_id: entry.owner_user_id,
              source_url,
            });
            return { meta: { changes: 1 } };
          }

          if (s.includes("materialized_content")) {
            const [
              id, entry_id, content, content_type, source, created_at,
              materialized_content, content_hash, mutation_id, mutation_kind,
              parent_episode_id, restored_from_snapshot_id, owner_user_id, source_url,
            ] = args;
            db.episodes.push({
              id, entry_id, content, content_type, source, created_at,
              materialized_content, content_hash, mutation_id, mutation_kind,
              parent_episode_id, restored_from_snapshot_id, owner_user_id, source_url,
            });
            return { meta: { changes: 1 } };
          }

          const [id, entry_id, content, content_type, source, created_at] = args;
          db.episodes.push({
            id, entry_id, content, content_type, source, created_at,
            materialized_content: content,
            content_hash: null,
            mutation_id: null,
            mutation_kind: "legacy",
            parent_episode_id: null,
            restored_from_snapshot_id: null,
            owner_user_id: db.entries.find((entry: any) => entry.id === entry_id)?.owner_user_id ?? "",
            source_url: null,
          });
          return { meta: { changes: 1 } };
        }
        if (s.startsWith("INSERT INTO passages")) {
          if (s.includes("document_id") && s.includes("section_id")) {
            const values = args.slice(0, 13);
            const [
              id, entry_id, episode_id, document_id, section_id, content,
              section, page, page_end, start_offset, end_offset, vector_ids, created_at,
            ] = values;
            if (s.includes("SELECT")) {
              const [guardId, ownerUserId, revision] = args.slice(13);
              if (!guardedEntry(db.entries, guardId, ownerUserId, revision)) {
                return { meta: { changes: 0 } };
              }
            }
            db.passages.push({
              id, entry_id, episode_id, document_id, section_id, content,
              section, page, page_end, start_offset, end_offset, vector_ids, created_at,
            });
            return { meta: { changes: 1 } };
          }

          const [id, entry_id, episode_id, content, section, start_offset, end_offset, vector_ids, created_at] = args;
          db.passages.push({
            id, entry_id, episode_id, document_id: null, section_id: null,
            content, section, page: null, page_end: null, start_offset,
            end_offset, vector_ids, created_at,
          });
          return { meta: { changes: 1 } };
        }
        if (s.startsWith("INSERT INTO documents")) {
          if (s.includes("episode_id") && s.includes("content_hash")) {
            if (s.includes("COALESCE(recorded_at, created_at)")) {
              const [
                id, title, source_url, content_type, episode_id, content_hash,
                version, guardId, guardOwner, revision,
              ] = args;
              const entry = guardedEntry(db.entries, guardId, guardOwner, revision, true);
              if (!entry) return { meta: { changes: 0 } };
              db.documents.push({
                id,
                title,
                source_url,
                content_type,
                created_at: entry.recorded_at ?? entry.created_at,
                episode_id,
                owner_user_id: entry.owner_user_id,
                content_hash,
                version,
                title_origin: "generated",
              });
              return { meta: { changes: 1 } };
            }

            const hasBoundTitleOrigin = s.includes("title_origin");
            const valueCount = hasBoundTitleOrigin ? 10 : 9;
            const values = args.slice(0, valueCount);
            const [
              id, title, source_url, content_type, created_at, episode_id,
              owner_user_id, content_hash, version,
            ] = values;
            const title_origin = hasBoundTitleOrigin ? values[9] : "generated";
            if (s.includes("SELECT")) {
              const [guardId, guardOwner, revision] = args.slice(valueCount);
              if (!guardedEntry(db.entries, guardId, guardOwner, revision)) {
                return { meta: { changes: 0 } };
              }
            }
            db.documents.push({
              id, title, source_url, content_type, created_at, episode_id,
              owner_user_id, content_hash, version, title_origin,
            });
            return { meta: { changes: 1 } };
          }

          const [id, title, source_url, content_type, created_at] = args;
          db.documents.push({ id, title, source_url, content_type, created_at, episode_id: null, owner_user_id: "", content_hash: null, version: null });
          return { meta: { changes: 1 } };
        }
        if (s.startsWith("INSERT INTO document_sections")) {
          if (s.includes("page_start") && s.includes("start_offset")) {
            const values = args.slice(0, 11);
            const [
              id, document_id, parent_section_id, title, level, order_index,
              created_at, page_start, page_end, start_offset, end_offset,
            ] = values;
            if (s.includes("SELECT")) {
              const [guardId, ownerUserId, revision] = args.slice(11);
              if (!guardedEntry(db.entries, guardId, ownerUserId, revision)) {
                return { meta: { changes: 0 } };
              }
            }
            db.document_sections.push({
              id, document_id, parent_section_id, title, level, order_index,
              created_at, page_start, page_end, start_offset, end_offset,
            });
            return { meta: { changes: 1 } };
          }

          const [id, document_id, parent_section_id, title, level, order_index, created_at] = args;
          db.document_sections.push({
            id, document_id, parent_section_id, title, level, order_index,
            created_at, page_start: null, page_end: null,
            start_offset: null, end_offset: null,
          });
          return { meta: { changes: 1 } };
        }
        if (s.startsWith("INSERT INTO entry_snapshots")) {
          if (s.includes("'visibility'") && s.includes("SELECT")) {
            const [id, createdAt, mutationId, entryId, ownerUserId, revision, visibility] = args;
            const entry = guardedEntry(db.entries, entryId, ownerUserId, revision);
            if (!entry || entry.visibility !== visibility) return { meta: { changes: 0 } };
            db.entry_snapshots.push({
              id,
              entry_id: entry.id,
              content: entry.content,
              tags: entry.tags,
              source: entry.source,
              created_at: createdAt,
              episode_id: entry.current_episode_id,
              mutation_id: mutationId,
              mutation_kind: "visibility",
              recorded_at: entry.recorded_at,
              valid_from: entry.valid_from,
              valid_to: entry.valid_to,
              epistemic_status: entry.epistemic_status,
              revision: entry.revision,
              visibility: entry.visibility,
            });
            return { meta: { changes: 1 } };
          }
          if (s.includes("episode_id") && s.includes("SELECT")) {
            const [
              id, created_at, baselineEpisodeId, mutation_id, mutation_kind,
              entryId, ownerUserId, revision,
            ] = args;
            const entry = guardedEntry(db.entries, entryId, ownerUserId, revision);
            if (!entry) return { meta: { changes: 0 } };
            db.entry_snapshots.push({
              id,
              entry_id: entry.id,
              content: entry.content,
              tags: entry.tags,
              source: entry.source,
              created_at,
              episode_id: entry.current_episode_id ?? baselineEpisodeId,
              mutation_id,
              mutation_kind,
              recorded_at: entry.recorded_at,
              valid_from: entry.valid_from,
              valid_to: entry.valid_to,
              epistemic_status: entry.epistemic_status,
              revision: entry.revision,
            });
            return { meta: { changes: 1 } };
          }

          const [id, entry_id, content, tags, source, created_at] = args;
          db.entry_snapshots.push({
            id, entry_id, content, tags, source, created_at,
            episode_id: null, mutation_id: null, mutation_kind: "legacy",
            recorded_at: created_at, valid_from: null, valid_to: null,
            epistemic_status: "canonical", revision: null,
          });
          return { meta: { changes: 1 } };
        }
        if (s.startsWith("INSERT INTO vector_cleanup_queue")) {
          const [id, vector_ids, reason, created_at, updated_at, entryId, ownerUserId, revision] = args;
          const entry = guardedEntry(db.entries, entryId, ownerUserId, revision);
          if (!entry) return { meta: { changes: 0 } };
          db.vector_cleanup_queue.push({
            id, vector_ids, reason, attempts: 0, last_error: null,
            created_at, updated_at,
          });
          return { meta: { changes: 1 } };
        }
        if (s.startsWith("DELETE FROM vector_cleanup_queue WHERE id")) {
          const id = args[0];
          const before = db.vector_cleanup_queue.length;
          db.vector_cleanup_queue = db.vector_cleanup_queue.filter((row: any) => row.id !== id);
          return { meta: { changes: before - db.vector_cleanup_queue.length } };
        }
        if (s.startsWith("UPDATE vector_cleanup_queue SET attempts = attempts + 1")) {
          const [last_error, updated_at, id] = args;
          const row = db.vector_cleanup_queue.find((item: any) => item.id === id);
          if (!row) return { meta: { changes: 0 } };
          row.attempts = Number(row.attempts ?? 0) + 1;
          row.last_error = last_error;
          row.updated_at = updated_at;
          return { meta: { changes: 1 } };
        }
        if (s.startsWith("UPDATE edges SET revision = revision + 1")) {
          const [updated_at, last_actor_kind, last_actor_id, last_mutation_kind, last_mutation_id, a, b, c, d, type] = args;
          let changes = 0;
          for (const edge of db.edges) {
            const pairMatch = (edge.source_id === a && edge.target_id === b) || (edge.source_id === c && edge.target_id === d);
            if (!pairMatch) continue;
            if (type && edge.type !== type) continue;
            normalizeEdge(edge);
            edge.revision = Number(edge.revision) + 1;
            edge.updated_at = updated_at;
            edge.last_actor_kind = last_actor_kind;
            edge.last_actor_id = last_actor_id;
            edge.last_mutation_kind = last_mutation_kind;
            edge.last_mutation_id = last_mutation_id;
            recordEdgeVersion(db, edge, 0, edge.revision, updated_at);
            changes++;
          }
          return { meta: { changes } };
        }
        if (s.startsWith("DELETE FROM edges WHERE ((source_id")) {
          // deleteEdge: order-agnostic pair delete, optional trailing type filter.
          const [a, b, c, d, type] = args;
          const before = db.edges.length;
          db.edges = db.edges.filter((e: any) => {
            const pairMatch = (e.source_id === a && e.target_id === b) || (e.source_id === c && e.target_id === d);
            if (!pairMatch) return true;
            if (type && e.type !== type) return true;
            normalizeEdge(e);
            recordEdgeVersion(db, e, 1, Number(e.revision) + 1, Date.now());
            return false;
          });
          return { meta: { changes: before - db.edges.length } };
        }
        if (s.startsWith("DELETE FROM edges WHERE source_id")) {
          // Cascade delete on forget: source_id = ? OR target_id = ? (both bound to the same id).
          const [sid, tid] = args;
          const before = db.edges.length;
          db.edges = db.edges.filter((e: any) => e.source_id !== sid && e.target_id !== tid);
          return { meta: { changes: before - db.edges.length } };
        }
        if (s.startsWith("DELETE FROM edges WHERE provenance")) {
          // runGraphPass prune: inferred edges below a weight, older than a cutoff.
          const [weight, age] = args;
          const before = db.edges.length;
          db.edges = db.edges.filter((e: any) => !(e.provenance === "inferred" && e.weight < weight && e.updated_at < age));
          return { meta: { changes: before - db.edges.length } };
        }
        if (s.startsWith("UPDATE users SET status")) {
          const userId = args[0] as string;
          const user = db.users.find((u: any) => u.id === userId);
          if (user) user.status = "inactive";
          return { meta: { changes: user ? 1 : 0 } };
        }
        if (s.startsWith("DELETE FROM entries WHERE owner_user_id") && s.includes("tags LIKE")) {
          const [ownerId] = args;
          const before = db.entries.length;
          db.entries = db.entries.filter((e: any) => !(e.owner_user_id === ownerId && (JSON.parse(e.tags ?? "[]") as string[]).includes("private")));
          return { meta: { changes: before - db.entries.length } };
        }
        // ─── Edge proposals (run) ───────────────────────────────────────
        if (s.startsWith("INSERT INTO edge_proposals")) {
          // Parse columns and values from SQL to handle both:
          //   VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)   — 7 args (MCP)
          //   VALUES (?, ?, ?, 'contradicts', ?, ?, 'pending', ?) — 6 args (lifecycle)
          const colMatch = s.match(/INSERT INTO edge_proposals \(([^)]+)\) VALUES \(([^)]+)\)/);
          if (colMatch) {
            const columns = colMatch[1].split(',').map((c: string) => c.trim());
            const values = colMatch[2].split(',').map((v: string) => v.trim());
            const proposal: any = {};
            let argIdx = 0;
            for (let i = 0; i < columns.length; i++) {
              if (values[i] === '?') {
                proposal[columns[i]] = args[argIdx++];
              } else {
                proposal[columns[i]] = values[i].replace(/^'|'$/g, '');
              }
            }
            proposal.status = proposal.status ?? "pending";
            db.edgeProposals.push(proposal);
            return { meta: { changes: 1 } };
          }
          // Fallback (shouldn't be reached)
          const [id, source_id, target_id, type, reason, proposed_by, _status, created_at] = args;
          db.edgeProposals.push({ id, source_id, target_id, type, reason, proposed_by, status: "pending", created_at });
          return { meta: { changes: 1 } };
        }
        if (s.startsWith("UPDATE edge_proposals SET status")) {
          if (s.startsWith("UPDATE edge_proposals SET status = 'executing'") && s.includes("status = 'pending'")) {
            const [resolvedBy, id] = args;
            const proposal = db.edgeProposals.find((row: any) => row.id === id && row.status === "pending");
            if (!proposal) return { meta: { changes: 0 } };
            proposal.status = "executing";
            proposal.resolved_by = resolvedBy;
            return { meta: { changes: 1 } };
          }
          if (s.includes("status = 'approved'") && s.includes("status = 'executing'")) {
            const [resolvedAt, resolvedBy, id, expectedResolver] = args;
            const proposal = db.edgeProposals.find((row: any) =>
              row.id === id && row.status === "executing" && row.resolved_by === expectedResolver);
            if (!proposal) return { meta: { changes: 0 } };
            proposal.status = "approved";
            proposal.resolved_at = resolvedAt;
            proposal.resolved_by = resolvedBy;
            return { meta: { changes: 1 } };
          }
          if (s.includes("status = 'pending'") && s.includes("status = 'executing'")) {
            const [id, expectedResolver] = args;
            const proposal = db.edgeProposals.find((row: any) =>
              row.id === id && row.status === "executing" && row.resolved_by === expectedResolver);
            if (!proposal) return { meta: { changes: 0 } };
            proposal.status = "pending";
            proposal.resolved_by = null;
            return { meta: { changes: 1 } };
          }
          if (s.includes("status = 'rejected'") && s.includes("status = 'pending'")) {
            const [resolvedAt, resolvedBy, id] = args;
            const proposal = db.edgeProposals.find((row: any) => row.id === id && row.status === "pending");
            if (!proposal) return { meta: { changes: 0 } };
            proposal.status = "rejected";
            proposal.resolved_at = resolvedAt;
            proposal.resolved_by = resolvedBy;
            return { meta: { changes: 1 } };
          }

          // Legacy MCP paths resolve directly without the REST reservation.
          const status = s.includes("'approved'") ? "approved" : "rejected";
          const [resolvedAt, id] = args;
          const proposal = db.edgeProposals.find((row: any) => row.id === id);
          if (proposal) {
            proposal.status = status;
            proposal.resolved_at = resolvedAt;
          }
          return { meta: { changes: proposal ? 1 : 0 } };
        }
        return { meta: {} };
      },
      async first() {
        if (s.includes("SELECT role FROM users WHERE id = ?") && s.includes("status = 'active'")) {
          const userId = args[0] as string;
          const user = db.users.find((row: any) => row.id === userId && row.status === "active");
          if (user) return { role: user.role ?? "member" };
          // The shared request helper authenticates this deterministic principal
          // without requiring every test to seed its users row. Model the
          // bootstrap administrator that a real migrated database provides.
          return userId === TEST_USER_ID ? { role: "admin" } : null;
        }
        if (s.includes("SELECT visibility, owner_user_id FROM entries WHERE id = ?")) {
          const row = db.entries.find((entry: any) => entry.id === args[0]);
          if (!row) return null;
          normalizeEntry(row);
          return { visibility: row.visibility, owner_user_id: row.owner_user_id };
        }
        if (s.startsWith("SELECT edge_id, revision FROM edge_versions")) {
          const [sourceId, targetId, type] = args;
          const row = db.edge_versions
            .filter((version: any) =>
              version.source_id === sourceId &&
              version.target_id === targetId &&
              version.type === type)
            .sort((a: any, b: any) =>
              (Number(b.revision) - Number(a.revision)) ||
              (Number(b.recorded_at) - Number(a.recorded_at)))[0];
          return row ? { edge_id: row.edge_id, revision: row.revision } : null;
        }
        if (s.includes("FROM edge_versions WHERE edge_id = ? AND revision = ?")) {
          const [edgeId, revision] = args;
          return db.edge_versions.find((version: any) =>
            version.edge_id === edgeId && Number(version.revision) === Number(revision)) ?? null;
        }
        if (s.includes("SELECT MAX(revision) AS revision FROM edge_versions WHERE edge_id = ?")) {
          const edgeId = args[0];
          const revisions = db.edge_versions
            .filter((version: any) => version.edge_id === edgeId)
            .map((version: any) => Number(version.revision));
          return { revision: revisions.length ? Math.max(...revisions) : null };
        }
        if (s.includes("SELECT id, revision FROM edges") && s.includes("WHERE source_id = ? AND target_id = ? AND type = ?")) {
          const [sourceId, targetId, type] = args;
          const row = db.edges.find((edge: any) =>
            edge.source_id === sourceId && edge.target_id === targetId && edge.type === type);
          if (!row) return null;
          normalizeEdge(row);
          return { id: row.id, revision: row.revision };
        }
        if (s.includes("SELECT id, source_id, target_id, type, revision FROM edges") && s.includes("WHERE source_id = ? AND target_id = ? AND type = ?")) {
          const [sourceId, targetId, type] = args;
          const row = db.edges.find((edge: any) =>
            edge.source_id === sourceId && edge.target_id === targetId && edge.type === type);
          if (!row) return null;
          normalizeEdge(row);
          return {
            id: row.id,
            source_id: row.source_id,
            target_id: row.target_id,
            type: row.type,
            revision: row.revision,
          };
        }
        if (s.includes("SELECT id, source_id, target_id, type, revision FROM edges WHERE id = ?")) {
          const row = db.edges.find((edge: any) => edge.id === args[0]);
          if (!row) return null;
          normalizeEdge(row);
          return {
            id: row.id,
            source_id: row.source_id,
            target_id: row.target_id,
            type: row.type,
            revision: row.revision,
          };
        }
        if (
          s.includes("FROM entries e LEFT JOIN episodes ep ON ep.id = e.current_episode_id") &&
          s.includes("current_document_title")
        ) {
          const entry = db.entries.find((row: any) => row.id === args[0]);
          if (!entry) return null;
          normalizeEntry(entry);
          const episode = db.episodes.find((row: any) => row.id === entry.current_episode_id);
          const document = db.documents
            .filter((row: any) => row.episode_id === entry.current_episode_id)
            .sort((a: any, b: any) => (b.created_at - a.created_at) || String(a.id).localeCompare(String(b.id)))[0];
          const currentPassages = db.passages
            .filter((row: any) => row.episode_id === entry.current_episode_id)
            .sort((a: any, b: any) => ((a.start_offset ?? 0) - (b.start_offset ?? 0)) || String(a.id).localeCompare(String(b.id)));
          return {
            ...entry,
            current_content_type: episode?.content_type ?? null,
            current_source_url: episode?.source_url ?? null,
            current_materialized_content: episode?.materialized_content ?? null,
            current_document_title: document?.title ?? null,
            current_document_title_origin: document?.title_origin ?? "generated",
            current_page: currentPassages.find((row: any) => row.page != null)?.page ?? null,
            current_page_end: currentPassages.find((row: any) => row.page_end != null)?.page_end ?? null,
          };
        }
        if (s.includes("FROM entry_snapshots s JOIN entries parent") && s.includes("source_title")) {
          const [ownerUserId, entryId, requestedSnapshotId] = args;
          const entry = db.entries.find((row: any) => row.id === entryId);
          if (!entry || normalizeEntry(entry).owner_user_id !== ownerUserId) return null;
          const snapshot = db.entry_snapshots
            .filter((row: any) => row.entry_id === entryId
              && (requestedSnapshotId == null || row.id === requestedSnapshotId))
            .sort((a: any, b: any) =>
              (Number(b.created_at) - Number(a.created_at))
              || String(b.id).localeCompare(String(a.id)))[0];
          if (!snapshot) return null;
          const episode = db.episodes.find((row: any) =>
            row.id === snapshot.episode_id
            && row.entry_id === entryId
            && row.owner_user_id === ownerUserId);
          const document = episode
            ? db.documents.find((row: any) =>
                row.episode_id === episode.id
                && (row.owner_user_id === ownerUserId || row.owner_user_id === ""))
            : undefined;
          const sourceTitle = typeof document?.title === "string" && document.title.trim()
            ? document.title
            : null;
          return {
            ...snapshot,
            source_title: sourceTitle,
            source_title_origin: sourceTitle ? document?.title_origin ?? null : null,
            source_url: document?.source_url ?? episode?.source_url ?? null,
            content_type: document?.content_type ?? episode?.content_type ?? null,
          };
        }
        if (
          s.includes("FROM entry_snapshots s JOIN entries e ON e.id = s.entry_id") &&
          s.includes("s.episode_id") && s.includes("e.owner_user_id")
        ) {
          const snapshot = db.entry_snapshots.find((row: any) => row.id === args[0]);
          if (!snapshot) return null;
          const entry = db.entries.find((row: any) => row.id === snapshot.entry_id);
          return entry ? {
            id: snapshot.id,
            entry_id: snapshot.entry_id,
            episode_id: snapshot.episode_id ?? null,
            owner_user_id: normalizeEntry(entry).owner_user_id,
          } : null;
        }
        if (s.includes("FROM entry_snapshots s LEFT JOIN episodes e ON e.id = s.episode_id")) {
          let snapshot: any | undefined;
          if (s.includes("WHERE s.id = ?")) {
            snapshot = db.entry_snapshots.find((row: any) => row.id === args[0] && row.entry_id === args[1]);
          } else {
            snapshot = db.entry_snapshots
              .filter((row: any) => row.entry_id === args[0])
              .sort((a: any, b: any) => (b.created_at - a.created_at) || String(b.id).localeCompare(String(a.id)))[0];
          }
          if (!snapshot) return null;
          const episode = db.episodes.find((row: any) => row.id === snapshot.episode_id);
          return {
            ...snapshot,
            source_url: episode?.source_url ?? null,
            content_type: episode?.content_type ?? null,
          };
        }
        if (s.includes("FROM documents WHERE episode_id = ?") && s.includes("owner_user_id = ?")) {
          return db.documents.find((row: any) => row.episode_id === args[0]
            && (row.owner_user_id === args[1]
              || s.includes("owner_user_id = ''") && row.owner_user_id === "")) ?? null;
        }
        if (s.includes("FROM vector_cleanup_queue") && s.includes("WHERE id")) {
          return db.vector_cleanup_queue.find((row: any) => row.id === args[0]) ?? null;
        }
        if (s.includes("FROM users WHERE normalized_username") && s.includes("auth_key_hash")) {
          const normalized = extractValue(s, args, 0) ?? "";
          const row = db.users.find((u: any) => u.normalized_username === normalized && u.status === "active");
          return row ? { id: row.id, username: row.username, auth_key_hash: row.auth_key_hash } : null;
        }
        if (s.includes("SELECT id, username, auth_key_hash FROM users WHERE id")) {
          const userId = extractValue(s, args, 0) ?? "";
          const row = db.users.find((u: any) => u.id === userId && u.status === "active");
          if (row) return { id: row.id, username: row.username, auth_key_hash: row.auth_key_hash };
          return userId === TEST_USER_ID
            ? { id: TEST_USER_ID, username: TEST_USERNAME, auth_key_hash: TEST_USER_AUTH_HASH }
            : null;
        }
        if (s.includes("SELECT id, username, status FROM users WHERE username")) {
          const username = extractValue(s, args, 0) ?? "";
          const row = db.users.find((u: any) => u.username === username);
          return row ? { id: row.id, username: row.username, status: row.status } : null;
        }
        if (s.includes("SELECT status FROM users WHERE username")) {
          const username = extractValue(s, args, 0) ?? "";
          const row = db.users.find((u: any) => u.username === username);
          return row ? { status: row.status } : null;
        }
        if (s.includes("SELECT id, username, status FROM users WHERE id")) {
          const userId = args[0] as string;
          const row = db.users.find((u: any) => u.id === userId);
          return row ? { id: row.id, username: row.username, status: row.status } : null;
        }
        if (s.includes("SELECT username FROM users WHERE id")) {
          const userId = args[0] as string;
          const row = db.users.find((u: any) => u.id === userId);
          return row ? { username: row.username } : null;
        }
        if (s.includes("SELECT id FROM users WHERE username")) {
          const username = extractValue(s, args, 0) ?? "";
          const row = db.users.find((u: any) => u.username === username);
          return row ? { id: row.id } : null;
        }
        if (s.includes("SELECT owner_user_id FROM entries")) {
          if (s.includes("WHERE content =")) {
            const content = extractValue(s, args, 0) ?? "";
            const row = db.entries.find((e: any) => e.content === content);
            return row ? { owner_user_id: row.owner_user_id } : null;
          }
          if (s.includes("WHERE id =")) {
            const id = extractValue(s, args, 0) ?? "";
            const row = db.entries.find((e: any) => e.id === id);
            return row ? { owner_user_id: row.owner_user_id } : null;
          }
          const row = db.entries[0];
          return row ? { owner_user_id: row.owner_user_id } : null;
        }
        if (s.includes("COUNT(*) as count") && s.includes("AVG(importance_score)")) {
          const count = db.entries.length;
          const scored = db.entries.filter((e: any) => typeof e.importance_score === "number");
          const avg_importance = scored.length > 0
            ? scored.reduce((sum: number, e: any) => sum + e.importance_score, 0) / scored.length
            : null;
          const cutoff = args.length > 0 ? Number(args[0]) : undefined;
          const unvectorized = cutoff !== undefined
            ? db.entries.filter((e: any) => e.vector_ids === '[]' && e.created_at < cutoff).length
            : 0;
          const unclassified = db.entries.filter((e: any) => !String(e.tags).includes('"status:') && !String(e.tags).includes('"kind:')).length;
          return { count, avg_importance, unvectorized, unclassified };
        }
        if (s.includes("COUNT(*) as count") && s.includes("vector_ids = '[]'") && s.includes("created_at <")) {
          const cutoff = Number(args[0]);
          const count = db.entries.filter((e: any) => e.vector_ids === '[]' && e.created_at < cutoff).length;
          return { count };
        }
        if (s.includes("COUNT(*) as count") && s.includes(`tags NOT LIKE '%"status:%'`) && s.includes(`tags NOT LIKE '%"kind:%'`)) {
          let rows = db.entries.filter((e: any) => !String(e.tags).includes('"status:') && !String(e.tags).includes('"kind:'));
          if (s.includes("entries.owner_user_id = ?")) {
            rows = rows.filter((e: any) => e.owner_user_id === args[0]);
          }
          if (s.includes("EXISTS") && s.includes("users.status = 'active'")) {
            rows = rows.filter((e: any) => db.users.some((u: any) => u.id === e.owner_user_id && u.status === "active"));
          }
          return { count: rows.length };
        }
        // ─── Table-specific COUNT handlers (must precede generic COUNT) ─────
        if (s.includes("COUNT(*) as count") && s.includes("FROM edge_proposals") && s.includes("status = 'pending'")) {
          return { count: db.edgeProposals.filter((p: any) => p.status === "pending").length };
        }
        if (s.includes("COUNT(*) as count") && s.includes("FROM entries") && s.includes("created_at >= ?")) {
          const cutoff = Number(args[0]);
          return { count: db.entries.filter((e: any) => e.created_at >= cutoff).length };
        }
        if (s.includes("COUNT(*) as count") && s.includes("FROM entries") && s.includes("epistemic_status = 'stale'")) {
          return { count: db.entries.filter((e: any) => e.epistemic_status === "stale").length };
        }
        // ─── Agent runs/events first() — must precede generic COUNT ──
        if (s.includes("FROM agent_runs") && s.includes("COUNT(*) as count") && s.includes("started_at >= ?")) {
          const cutoff = args[0] as number;
          const count = db.agentRuns.filter((r: any) => r.started_at >= cutoff).length;
          return { count };
        }
        if (s.includes("FROM agent_runs") && s.includes("COUNT(DISTINCT user_id)") && s.includes("started_at >= ?")) {
          const cutoff = args[0] as number;
          const users = new Set(db.agentRuns.filter((r: any) => r.started_at >= cutoff).map((r: any) => r.user_id));
          return { count: users.size };
        }
        if (s.includes("FROM agent_events") && s.includes("COUNT(*) as count") && s.includes("created_at >= ?")) {
          const cutoff = args[0] as number;
          const count = db.agentEvents.filter((e: any) => e.created_at >= cutoff).length;
          return { count };
        }
        if (s.includes("COUNT(*) as count")) {
          return { count: db.entries.length };
        }
        // Table-specific WHERE id handlers (must precede generic entries handler)
        if (s.includes("FROM entry_snapshots") && s.includes("WHERE id")) {
          return db.entry_snapshots.find((r: any) => r.id === args[0]) ?? null;
        }
        if (s.includes("FROM episodes") && s.includes("WHERE id")) {
          return db.episodes.find((r: any) => r.id === args[0]) ?? null;
        }
        if (s.includes("FROM passages") && s.includes("WHERE id")) {
          return db.passages.find((r: any) => r.id === args[0]) ?? null;
        }
        if (s.includes("FROM documents") && s.includes("WHERE id")) {
          return db.documents.find((r: any) => r.id === args[0]) ?? null;
        }
        if (s.includes("FROM document_sections") && s.includes("WHERE id")) {
          return db.document_sections.find((r: any) => r.id === args[0]) ?? null;
        }
        // ─── Edge proposals (first) — must precede generic WHERE id ──────
        if (s.includes("FROM edge_proposals WHERE id = ?")) {
          const id = args[0];
          return db.edgeProposals.find((p: any) => p.id === id) ?? null;
        }
        if (s.includes("FROM edge_proposals WHERE source_id = ? AND target_id = ? AND type") && s.includes("status = 'pending'")) {
          const typeMatch = s.match(/type = '?(\w+)'?/);
          const typeValue = typeMatch ? typeMatch[1] : args[2];
          const [sourceId, targetId] = args;
          return db.edgeProposals.find((pp: any) => pp.source_id === sourceId && pp.target_id === targetId && pp.type === typeValue && pp.status === "pending") ?? null;
        }
        if (
          s.startsWith("SELECT current_episode_id, revision, recorded_at FROM entries")
          && s.includes("WHERE id = ? AND owner_user_id = ?")
        ) {
          const row = db.entries.find((entry: any) => entry.id === args[0]);
          if (!row || normalizeEntry(row).owner_user_id !== args[1]) return null;
          return {
            current_episode_id: row.current_episode_id,
            revision: row.revision,
            recorded_at: row.recorded_at,
          };
        }
        if (s.includes("WHERE id") && !s.includes("json_each")) {
          const row = db.entries.find((e: any) => e.id === args[0]);
          if (!row) return null;
          normalizeEntry(row);
          if (s.includes("owner_user_id = ?") && row.owner_user_id !== args[1]) return null;
          return row;
        }
        if (s.includes("tags LIKE") && s.includes("created_at >")) {
          // Cooldown check: find entries matching arg LIKE patterns + any hardcoded tags in SQL
          const ownerId = s.includes("owner_user_id = ?") ? String(args[0]) : null;
          const likePatterns: string[] = args.slice(ownerId ? 1 : 0, -1).map((a: any) => String(a));
          const cutoff = args[args.length - 1] as number;
          // Extract hardcoded tags from SQL (e.g. '%"synthesized"%')
          const hardcoded = [...s.matchAll(/'%"(\w+)"%'/g)].map(m => m[1]);
          const match = db.entries.find((e: any) => {
            if (ownerId && e.owner_user_id !== ownerId) return false;
            if (e.created_at <= cutoff) return false;
            const tags: string[] = JSON.parse(e.tags ?? "[]");
            if (!hardcoded.every(t => tags.includes(t))) return false;
            return likePatterns.every((p: string) => {
              const tag = p.replace(/%"/g, "").replace(/"%/g, "");
              return tags.includes(tag);
            });
          });
          return match ? { id: match.id } : null;
        }
        if (s.includes("FROM episodes WHERE entry_id")) {
          const entryId = args[0] as string;
          const ep = db.episodes.find((e: any) => e.entry_id === entryId);
          return ep ? { id: ep.id } : null;
        }
        if (s.includes("SELECT owner_user_id, epistemic_status FROM entries WHERE id")) {
          const id = args[0] as string;
          const row = db.entries.find((e: any) => e.id === id);
          return row ? { owner_user_id: row.owner_user_id ?? "", epistemic_status: row.epistemic_status ?? "canonical" } : null;
        }
        return null;
      },
      async all() {
        if (s.includes("FROM episodes ep LEFT JOIN documents d") && s.includes("COUNT(*) OVER() AS total_count")) {
          const [entryId, ownerUserId] = args;
          const owned = db.episodes
            .filter((row: any) => row.entry_id === entryId && row.owner_user_id === ownerUserId)
            .sort((a: any, b: any) =>
              (Number(b.created_at) - Number(a.created_at))
              || String(b.id).localeCompare(String(a.id)));
          const totalCount = owned.length;
          return { results: owned.slice(0, 50).map((row: any) => {
            const document = db.documents.find((candidate: any) =>
              candidate.episode_id === row.id
              && (candidate.owner_user_id === ownerUserId || candidate.owner_user_id === ""));
            return {
              id: row.id,
              mutation_kind: row.mutation_kind ?? null,
              parent_episode_id: row.parent_episode_id ?? null,
              restored_from_snapshot_id: row.restored_from_snapshot_id ?? null,
              content_hash: row.content_hash ?? null,
              source: row.source ?? null,
              content_type: row.content_type ?? null,
              source_title: document?.title ?? null,
              source_url: document?.source_url ?? row.source_url ?? null,
              created_at: row.created_at,
              total_count: totalCount,
            };
          }) };
        }
        if (s.includes("FROM entry_snapshots s JOIN entries parent") && s.includes("COUNT(*) OVER() AS total_count")) {
          const [ownerUserId, entryId] = args;
          const entry = db.entries.find((row: any) => row.id === entryId);
          if (!entry || normalizeEntry(entry).owner_user_id !== ownerUserId) return { results: [] };
          const owned = db.entry_snapshots
            .filter((row: any) => row.entry_id === entryId)
            .sort((a: any, b: any) =>
              (Number(b.created_at) - Number(a.created_at))
              || String(b.id).localeCompare(String(a.id)));
          const totalCount = owned.length;
          return { results: owned.slice(0, 50).map((row: any) => ({
            id: row.id,
            episode_id: row.episode_id ?? null,
            mutation_kind: row.mutation_kind ?? null,
            recorded_at: row.recorded_at ?? null,
            revision: row.revision ?? null,
            created_at: row.created_at,
            total_count: totalCount,
          })) };
        }
        if (s.includes("SELECT * FROM episodes WHERE entry_id IN")) {
          const entryIds = new Set(args.map(String));
          return { results: db.episodes.filter((row: any) => entryIds.has(String(row.entry_id))).map((row: any) => ({ ...row })) };
        }
        if (s.includes("SELECT * FROM episodes WHERE id IN")) {
          const episodeIds = new Set(args.map(String));
          return { results: db.episodes.filter((row: any) => episodeIds.has(String(row.id))).map((row: any) => ({ ...row })) };
        }
        if (s.includes("SELECT * FROM entry_snapshots WHERE entry_id IN") && !s.includes("recorded_at IS NOT NULL")) {
          const entryIds = new Set(args.map(String));
          return { results: db.entry_snapshots.filter((row: any) => entryIds.has(String(row.entry_id))).map((row: any) => ({ ...row })) };
        }
        if (s.includes("SELECT * FROM documents WHERE episode_id IN")) {
          const ownerBound = s.includes("owner_user_id = ?");
          const ownerlessAllowed = s.includes("owner_user_id = ''");
          const ownerUserId = ownerBound ? String(args[args.length - 1]) : undefined;
          const episodeIds = new Set((ownerBound ? args.slice(0, -1) : args).map(String));
          return { results: db.documents
            .filter((row: any) => episodeIds.has(String(row.episode_id))
              && (!ownerBound || row.owner_user_id === ownerUserId
                || ownerlessAllowed && row.owner_user_id === ""))
            .map((row: any) => ({ ...row })) };
        }
        if (s.includes("SELECT * FROM documents WHERE id IN")) {
          const ownerBound = s.includes("owner_user_id = ?");
          const ownerlessAllowed = s.includes("owner_user_id = ''");
          const ownerUserId = ownerBound ? String(args[args.length - 1]) : undefined;
          const documentIds = new Set((ownerBound ? args.slice(0, -1) : args).map(String));
          return { results: db.documents
            .filter((row: any) => documentIds.has(String(row.id))
              && (!ownerBound || row.owner_user_id === ownerUserId
                || ownerlessAllowed && row.owner_user_id === ""))
            .map((row: any) => ({ ...row })) };
        }
        if (s.includes("SELECT * FROM document_sections WHERE document_id IN")) {
          const documentIds = new Set(args.map(String));
          return { results: db.document_sections
            .filter((row: any) => documentIds.has(String(row.document_id)))
            .map((row: any) => ({ ...row })) };
        }
        if (s.includes("FROM edge_versions WHERE edge_id = ?") && s.includes("ORDER BY revision DESC")) {
          const edgeId = args[0];
          const results = db.edge_versions
            .filter((version: any) => version.edge_id === edgeId)
            .sort((a: any, b: any) => Number(b.revision) - Number(a.revision))
            .map((version: any) => ({ ...version }));
          return { results };
        }
        if (
          s.includes("FROM entries WHERE id IN") &&
          (
            s.includes("SELECT id, visibility, owner_user_id") ||
            s.includes("SELECT id, owner_user_id, visibility")
          )
        ) {
          const results = db.entries
            .filter((row: any) => args.includes(row.id))
            .map((row: any) => {
              normalizeEntry(row);
              return {
                id: row.id,
                visibility: row.visibility,
                owner_user_id: row.owner_user_id,
              };
            });
          return { results };
        }
        if (
          s.includes("FROM entries WHERE id IN") &&
          s.includes("SELECT id, content, tags, source, created_at, owner_user_id, visibility")
        ) {
          const results = db.entries
            .filter((row: any) => args.includes(row.id))
            .map((row: any) => {
              normalizeEntry(row);
              return {
                id: row.id,
                content: row.content,
                tags: row.tags,
                source: row.source,
                created_at: row.created_at,
                owner_user_id: row.owner_user_id,
                visibility: row.visibility,
              };
            });
          return { results };
        }
        if (
          s.includes("FROM entries WHERE id IN") &&
          s.includes("SELECT id, content, tags, importance_score, created_at, owner_user_id, visibility")
        ) {
          const results = db.entries
            .filter((row: any) => args.includes(row.id))
            .map((row: any) => {
              normalizeEntry(row);
              return {
                id: row.id,
                content: row.content,
                tags: row.tags,
                importance_score: row.importance_score,
                created_at: row.created_at,
                owner_user_id: row.owner_user_id,
                visibility: row.visibility,
              };
            });
          return { results };
        }
        if (
          s.includes("SELECT id, content, tags, source, created_at, updated_at") &&
          s.includes("owner_user_id, created_by_user_id, visibility, current_episode_id") &&
          s.includes("FROM entries")
        ) {
          let rows = db.entries.map((row: any) => normalizeEntry(row));
          if (s.includes("owner_user_id = ? AND visibility = 'public'")) {
            rows = rows.filter((row: any) => row.owner_user_id === args[0] && row.visibility === "public");
          } else if (s.includes("owner_user_id = ? AND visibility = 'private'")) {
            rows = rows.filter((row: any) => row.owner_user_id === args[0] && row.visibility === "private");
          } else if (s.includes("visibility = 'public'")) {
            rows = rows.filter((row: any) => row.visibility === "public");
          }
          return {
            results: rows
              .sort((a: any, b: any) => b.created_at - a.created_at)
              .map((row: any) => ({
                id: row.id,
                content: row.content,
                tags: row.tags,
                source: row.source,
                created_at: row.created_at,
                updated_at: row.updated_at,
                owner_user_id: row.owner_user_id,
                created_by_user_id: row.created_by_user_id,
                visibility: row.visibility,
                current_episode_id: row.current_episode_id,
                revision: row.revision,
                valid_from: row.valid_from,
                valid_to: row.valid_to,
                recorded_at: row.recorded_at,
                epistemic_status: row.epistemic_status,
              })),
          };
        }
        if (
          s.includes("SELECT id, content, tags, source, created_at, vector_ids") &&
          s.includes("owner_user_id, created_by_user_id, visibility, revision") &&
          s.includes("FROM entries")
        ) {
          let rows = db.entries.map((row: any) => normalizeEntry(row));

          const bindingAt = (clause: string): any => {
            const index = s.indexOf(clause);
            if (index < 0) return undefined;
            return args[(s.slice(0, index).match(/\?/g) ?? []).length];
          };
          if (s.includes("tags LIKE ?")) {
            const tag = String(bindingAt("tags LIKE ?")).replace(/%"/g, "").replace(/"%/g, "");
            rows = rows.filter((row: any) => parseTags(row.tags).includes(tag));
          }
          if (s.includes("created_at >= ?")) {
            const after = Number(bindingAt("created_at >= ?"));
            rows = rows.filter((row: any) => row.created_at >= after);
          }
          if (s.includes("created_at <= ?")) {
            const before = Number(bindingAt("created_at <= ?"));
            rows = rows.filter((row: any) => row.created_at <= before);
          }
          if (s.includes("owner_user_id = (SELECT id FROM users WHERE username = ?)")) {
            const username = String(bindingAt("owner_user_id = (SELECT id FROM users WHERE username = ?)"));
            const owner = db.users.find((row: any) => row.username === username);
            rows = owner ? rows.filter((row: any) => row.owner_user_id === owner.id) : [];
          }
          if (s.includes("owner_user_id = ? AND visibility = 'private'")) {
            const owner = String(bindingAt("owner_user_id = ? AND visibility = 'private'"));
            rows = rows.filter((row: any) => row.owner_user_id === owner && row.visibility === "private");
          } else if (s.includes("owner_user_id = ? OR visibility = 'public'")) {
            const owner = String(bindingAt("owner_user_id = ? OR visibility = 'public'"));
            rows = rows.filter((row: any) => row.owner_user_id === owner || row.visibility === "public");
          } else if (s.includes("visibility = 'public'")) {
            rows = rows.filter((row: any) => row.visibility === "public");
          }

          const limit = Number(args[args.length - 1]);
          const results = rows
            .sort((a: any, b: any) => b.created_at - a.created_at)
            .slice(0, limit)
            .map((row: any) => ({
              id: row.id,
              content: row.content,
              tags: row.tags,
              source: row.source,
              created_at: row.created_at,
              vector_ids: row.vector_ids,
              owner_user_id: row.owner_user_id,
              created_by_user_id: row.created_by_user_id,
              visibility: row.visibility,
              revision: row.revision,
            }));
          return { results };
        }
        if (
          s.includes("FROM entries WHERE tags LIKE ?") &&
          s.includes("id, vector_ids, content, tags, source, created_at, owner_user_id")
        ) {
          const tag = String(args[0]).replace(/%"/g, "").replace(/"%/g, "");
          const results = db.entries
            .filter((row: any) => parseTags(row.tags).includes(tag))
            .map((row: any) => {
              normalizeEntry(row);
              return {
                id: row.id,
                vector_ids: row.vector_ids,
                content: row.content,
                tags: row.tags,
                source: row.source,
                created_at: row.created_at,
                owner_user_id: row.owner_user_id,
                visibility: row.visibility,
              };
            });
          return { results };
        }
        if (
          s.includes("FROM entries") && s.includes("content LIKE ?") &&
          s.includes("ORDER BY created_at DESC") && s.includes("LIMIT ?")
        ) {
          const tokenCount = (s.match(/content LIKE \?/g) ?? []).length;
          const tokens = args.slice(0, tokenCount)
            .map((value: any) => String(value).replace(/^%|%$/g, "").toLowerCase());
          const ownerUserId = s.includes("owner_user_id = ?") ? String(args[tokenCount]) : undefined;
          const limit = Number(args[args.length - 1]);
          const results = db.entries
            .map((row: any) => normalizeEntry(row))
            .filter((row: any) => tokens.some((token: string) => String(row.content).toLowerCase().includes(token)))
            .filter((row: any) => {
              if (ownerUserId && row.owner_user_id === ownerUserId) return true;
              return row.visibility === "public";
            })
            .sort((a: any, b: any) => b.created_at - a.created_at)
            .slice(0, limit)
            .map((row: any) => ({
              id: row.id,
              content: row.content,
              tags: row.tags,
              source: row.source,
              created_at: row.created_at,
              owner_user_id: row.owner_user_id,
              visibility: row.visibility,
            }));
          return { results };
        }
        if (
          s.includes("SELECT id, tags, owner_user_id, visibility, current_episode_id") &&
          s.includes("FROM entries WHERE id IN")
        ) {
          const results = db.entries
            .filter((row: any) => args.includes(row.id))
            .map((row: any) => {
              normalizeEntry(row);
              return {
                id: row.id,
                tags: row.tags,
                owner_user_id: row.owner_user_id,
                visibility: row.visibility,
                current_episode_id: row.current_episode_id,
              };
            });
          return { results };
        }
        if (
          s.includes("SELECT id, content, tags, source, created_at, owner_user_id") &&
          s.includes("current_episode_id, valid_from, valid_to, recorded_at") &&
          s.includes("FROM entries") && s.includes("WHERE id IN")
        ) {
          const results = db.entries
            .filter((row: any) => args.includes(row.id))
            .map((row: any) => ({ ...normalizeEntry(row) }));
          return { results };
        }
        if (
          s.includes("FROM entry_snapshots") && s.includes("WHERE entry_id IN") &&
          s.includes("recorded_at IS NOT NULL")
        ) {
          const knownAt = Number(args[args.length - 1]);
          const entryIds = new Set(args.slice(0, -1).map(String));
          const results = db.entry_snapshots
            .filter((row: any) => entryIds.has(String(row.entry_id)) && row.recorded_at != null && Number(row.recorded_at) <= knownAt)
            .sort((a: any, b: any) =>
              (Number(b.recorded_at) - Number(a.recorded_at)) ||
              (Number(b.created_at) - Number(a.created_at)) ||
              String(b.id).localeCompare(String(a.id)))
            .map((row: any) => ({ ...row }));
          return { results };
        }
        if (s.startsWith("WITH base_entries AS") && s.includes("state_at_time")) {
          const knownAt = Number(args[0]);
          const secondKnownAt = Number(args[1]);
          const limit = Number(args[args.length - 1]);
          const ownerBound = s.includes("owner_user_id = ?");
          const ownerUserId = ownerBound ? String(args[args.length - 2]) : undefined;
          const tokenEnd = ownerBound ? args.length - 2 : args.length - 1;
          const tokens = args.slice(2, tokenEnd).map((value: any) => String(value).replace(/^%|%$/g, "").toLowerCase());
          const results: any[] = [];
          for (const rawEntry of db.entries) {
            const entry = normalizeEntry(rawEntry);
            const useCurrent = entry.recorded_at != null && Number(entry.recorded_at) <= knownAt;
            const snapshot = db.entry_snapshots
              .filter((row: any) => row.entry_id === entry.id && row.recorded_at != null && Number(row.recorded_at) <= secondKnownAt)
              .sort((a: any, b: any) =>
                (Number(b.recorded_at) - Number(a.recorded_at)) ||
                (Number(b.created_at) - Number(a.created_at)) ||
                String(b.id).localeCompare(String(a.id)))[0];
            const state = useCurrent ? entry : snapshot;
            if (!state) continue;
            const aclTags = entry.tags;
            if (!(ownerUserId && entry.owner_user_id === ownerUserId) && parseTags(aclTags).includes("private")) continue;
            if (!tokens.some((token: string) => String(state.content).toLowerCase().includes(token))) continue;
            results.push({
              id: entry.id,
              content: state.content,
              tags: state.tags,
              source: state.source,
              created_at: entry.created_at,
              owner_user_id: entry.owner_user_id,
              acl_tags: aclTags,
              episode_id: useCurrent ? entry.current_episode_id : snapshot?.episode_id ?? null,
              vector_ids: useCurrent ? entry.vector_ids : "[]",
            });
          }
          results.sort((a, b) => b.created_at - a.created_at);
          return { results: results.slice(0, limit) };
        }
        if (s.includes("FROM episodes WHERE entry_id = ?") && s.includes("ORDER BY created_at DESC")) {
          const ownerBound = s.includes("owner_user_id = ?");
          const results = db.episodes
            .filter((row: any) => row.entry_id === args[0] && (!ownerBound || row.owner_user_id === args[1]))
            .sort((a: any, b: any) => (b.created_at - a.created_at) || String(b.id).localeCompare(String(a.id)))
            .slice(0, Number(s.match(/LIMIT (\d+)/)?.[1] ?? db.episodes.length))
            .map((row: any) => ({ ...row }));
          return { results };
        }
        if (s.includes("FROM entry_snapshots WHERE entry_id = ?") && s.includes("ORDER BY created_at DESC")) {
          const results = db.entry_snapshots
            .filter((row: any) => row.entry_id === args[0])
            .sort((a: any, b: any) => (b.created_at - a.created_at) || String(b.id).localeCompare(String(a.id)))
            .slice(0, Number(s.match(/LIMIT (\d+)/)?.[1] ?? db.entry_snapshots.length))
            .map((row: any) => ({ ...row }));
          return { results };
        }
        if (s.includes("FROM document_sections WHERE document_id = ?")) {
          const results = db.document_sections
            .filter((row: any) => row.document_id === args[0])
            .sort((a: any, b: any) => (a.order_index - b.order_index) || String(a.id).localeCompare(String(b.id)))
            .map((row: any) => ({ ...row }));
          return { results };
        }
        if (s.includes("FROM passages p LEFT JOIN documents d") && s.includes("p.entry_id = ?") && s.includes("p.episode_id = ?")) {
          const [ownerUserId, entryId, episodeId] = args;
          const results = db.passages
            .filter((row: any) => row.entry_id === entryId && row.episode_id === episodeId)
            .sort((a: any, b: any) => ((a.start_offset ?? 0) - (b.start_offset ?? 0)) || String(a.id).localeCompare(String(b.id)))
            .slice(0, Number(s.match(/LIMIT (\d+)/)?.[1] ?? 10))
            .map((row: any) => {
              const document = db.documents.find((doc: any) =>
                doc.id === row.document_id && doc.episode_id === row.episode_id && doc.owner_user_id === ownerUserId);
              return { ...row, document_title: document?.title ?? null, source_url: document?.source_url ?? null };
            });
          return { results };
        }
        if (s.includes("FROM passages") && s.includes("(? IS NULL OR episode_id = ?)")) {
          const [ownerUserId, _documentOwner, entryId, nullableEpisodeId, episodeId] = args;
          const selectedEpisodeId = nullableEpisodeId == null ? null : episodeId;
          const results = db.passages
            .filter((row: any) => row.entry_id === entryId && (!selectedEpisodeId || row.episode_id === selectedEpisodeId))
            .filter((row: any) => {
              if (!row.document_id) return true;
              return db.documents.some((doc: any) =>
                doc.id === row.document_id &&
                (doc.episode_id == null || doc.episode_id === row.episode_id) &&
                (doc.owner_user_id === "" || doc.owner_user_id === ownerUserId));
            })
            .filter((row: any) => !row.section_id || db.document_sections.some((section: any) =>
              section.id === row.section_id && section.document_id === row.document_id))
            .sort((a: any, b: any) =>
              (b.created_at - a.created_at) ||
              ((a.start_offset ?? 0) - (b.start_offset ?? 0)) ||
              String(a.id).localeCompare(String(b.id)))
            .slice(0, 5)
            .map((row: any) => {
              const document = db.documents.find((doc: any) => doc.id === row.document_id);
              const section = db.document_sections.find((item: any) => item.id === row.section_id && item.document_id === row.document_id);
              return {
                ...row,
                section: row.section ?? section?.title ?? null,
                source_url: document?.source_url ?? null,
                document_title: document?.title ?? null,
                page: row.page ?? section?.page_start ?? null,
                page_end: row.page_end ?? section?.page_end ?? row.page ?? null,
                start_offset: row.start_offset ?? section?.start_offset ?? null,
                end_offset: row.end_offset ?? section?.end_offset ?? null,
              };
            });
          return { results };
        }
        if (s.includes("FROM passages") && s.includes("WHERE entry_id = ? AND episode_id = ?")) {
          const results = db.passages
            .filter((row: any) => row.entry_id === args[0] && row.episode_id === args[1])
            .sort((a: any, b: any) => ((a.start_offset ?? 0) - (b.start_offset ?? 0)) || String(a.id).localeCompare(String(b.id)))
            .map((row: any) => ({ ...row }));
          return { results };
        }
        if (s.includes("FROM vector_cleanup_queue")) {
          return { results: db.vector_cleanup_queue.map((row: any) => ({ ...row })) };
        }
        if (s.includes("SELECT id, username, status, role FROM users WHERE status")) {
          const activeUsers = db.users.filter((u: any) => u.status === "active");
          return { results: activeUsers.map((u: any) => ({
            id: u.id,
            username: u.username,
            status: u.status,
            role: u.role ?? "member",
          })) };
        }
        if (s.includes("SELECT id, username, status FROM users WHERE status")) {
          const activeUsers = db.users.filter((u: any) => u.status === "active");
          return { results: activeUsers.map((u: any) => ({ id: u.id, username: u.username, status: u.status })) };
        }
        if (s.includes("SELECT id FROM users WHERE status = 'active' ORDER BY created_at ASC")) {
          const activeUsers = db.users.filter((u: any) => u.status === "active").sort((a: any, b: any) => a.created_at - b.created_at);
          const limitMatch = s.match(/LIMIT (\d+)/);
          const limit = limitMatch ? parseInt(limitMatch[1], 10) : activeUsers.length;
          return { results: activeUsers.slice(0, limit).map((u: any) => ({ id: u.id })) };
        }
        if (s.includes("SELECT id FROM users WHERE username") && !s.includes("FROM entries")) {
          const username = extractValue(s, args, 0) ?? "";
          const matches = db.users.filter((u: any) => u.username === username);
          return { results: matches.map((u: any) => ({ id: u.id })) };
        }
        if (s.includes("SELECT id, username FROM users WHERE id IN")) {
          const results = db.users
            .filter((u: any) => args.includes(u.id))
            .map((u: any) => ({ id: u.id, username: u.username }));
          return { results };
        }
        if (s.includes("SELECT username FROM users WHERE id =")) {
          const userId = args[0] as string;
          const user = db.users.find((u: any) => u.id === userId);
          return { results: user ? [{ username: user.username }] : [] };
        }
        if (s.includes("recall_count, importance_score, contradiction_wins, contradiction_losses, last_recalled_at, created_at, epistemic_status FROM entries WHERE id IN")) {
          const ids = args.map((a: any) => String(a));
          const rows = db.entries.filter((e: any) => ids.includes(e.id));
          return { results: rows.map((r: any) => ({ id: r.id, recall_count: r.recall_count ?? 0, importance_score: r.importance_score ?? 0, contradiction_wins: r.contradiction_wins ?? 0, contradiction_losses: r.contradiction_losses ?? 0, last_recalled_at: r.last_recalled_at ?? null, created_at: r.created_at, epistemic_status: r.epistemic_status ?? "canonical" })) };
        }
        if (s.includes("SELECT tags, owner_user_id FROM entries WHERE id =")) {
          // createEdge visibility check.
          const entryId = args[0] as string;
          const entry = db.entries.find((e: any) => e.id === entryId);
          return { results: entry ? [{ tags: entry.tags ?? "[]", owner_user_id: (entry as any).owner_user_id ?? "" }] : [] };
        }
        if (
          s === "SELECT id FROM entries WHERE tags LIKE ?" ||
          s === "SELECT id, vector_ids FROM entries WHERE tags LIKE ?" ||
          s === "SELECT id, vector_ids, content, tags, source, created_at FROM entries WHERE tags LIKE ?" ||
          s === "SELECT id, vector_ids, content, tags, source, created_at, owner_user_id FROM entries WHERE tags LIKE ?"
        ) {
          const pattern = String(args[0]);
          const tag = pattern.replace(/%"/g, "").replace(/"%/g, "");
          const results = db.entries
            .filter((e: any) => {
              try {
                const tags = JSON.parse(e.tags ?? "[]");
                return Array.isArray(tags) && tags.includes(tag);
              } catch {
                return false;
              }
            })
            .map((e: any) => ({
              id: e.id,
              vector_ids: e.vector_ids ?? "[]",
              content: e.content,
              tags: e.tags,
              source: e.source,
              created_at: e.created_at,
              owner_user_id: e.owner_user_id ?? "",
              visibility: normalizeEntry(e).visibility,
            }));
          return { results };
        }
        if (s.includes("FROM entries WHERE vector_ids != '[]'")) {
          // reindexAllVectors query — entries with existing vectors.
          const results = db.entries
            .map((entry: any) => normalizeEntry(entry))
            .filter((entry: any) => entry.vector_ids && entry.vector_ids !== "[]")
            .filter((entry: any) => !s.includes("AND owner_user_id = ?") || entry.owner_user_id === args[0])
            .map((entry: any) => ({
              id: entry.id, content: entry.content, tags: entry.tags, source: entry.source,
              created_at: entry.created_at, vector_ids: entry.vector_ids,
              owner_user_id: entry.owner_user_id,
              visibility: entry.visibility,
            }));
          return { results };
        }
        // Versioned staleness candidate scans.
        if (
          s.includes("SELECT id, content, tags, source, owner_user_id, revision") &&
          s.includes("epistemic_status != 'stale'") &&
          s.includes("FROM entries")
        ) {
          let rows = db.entries.map((entry: any) => normalizeEntry(entry))
            .filter((entry: any) => entry.epistemic_status !== "stale");
          if (s.includes("valid_to IS NOT NULL")) {
            rows = rows.filter((entry: any) => entry.valid_to != null);
          } else if (s.includes("SELECT DISTINCT target_id FROM edges WHERE confidence < ?")) {
            const threshold = Number(args[0]);
            const targetIds = new Set(db.edges
              .filter((edge: any) => Number(edge.confidence ?? 1) > 0 && Number(edge.confidence ?? 1) < threshold)
              .map((edge: any) => edge.target_id));
            rows = rows.filter((entry: any) => targetIds.has(entry.id));
          } else if (s.includes("created_at < ?") && s.includes("recall_count = 0")) {
            const cutoff = Number(args[0]);
            rows = rows.filter((entry: any) => entry.created_at < cutoff && Number(entry.recall_count ?? 0) === 0);
          }
          return {
            results: rows.slice(0, 100).map((entry: any) => ({
              id: entry.id,
              content: entry.content,
              tags: entry.tags,
              source: entry.source,
              owner_user_id: entry.owner_user_id,
              revision: entry.revision,
              valid_from: entry.valid_from,
              valid_to: entry.valid_to,
              epistemic_status: entry.epistemic_status,
            })),
          };
        }
        // ─── detectCrossUserContradictions query ────────────────────────
        if (s.includes("SELECT id, content, owner_user_id FROM entries WHERE created_at >= ?") && s.includes("tags NOT LIKE")) {
          const cutoff = args[0] as number;
          const limit = args[1] as number;
          const results = db.entries
            .filter((e: any) => e.created_at >= cutoff)
            .filter((e: any) => {
              const tags: string[] = JSON.parse(e.tags ?? "[]");
              return !tags.includes("private");
            })
            .sort((a: any, b: any) => b.created_at - a.created_at)
            .slice(0, limit)
            .map((e: any) => ({ id: e.id, content: e.content, owner_user_id: e.owner_user_id ?? "" }));
          return { results };
        }
        if (s.includes("SELECT id, content, tags, source, created_at, vector_ids, owner_user_id FROM entries")) {
          // GET /list query — returns all matching entries with owner_user_id.
          const limit = Number(args[args.length - 1]);
          let rows = [...db.entries] as any[];
          const whereIdx = s.indexOf("WHERE");
          const orderIdx = s.indexOf("ORDER BY");
          const whereClause = whereIdx !== -1 && orderIdx !== -1
            ? s.substring(whereIdx + 5, orderIdx)
            : whereIdx !== -1
              ? s.substring(whereIdx + 5)
              : "";

          // Apply user filter if present
          if (whereClause.includes("owner_user_id = (SELECT id FROM users WHERE username = ?)")) {
            const username = args[0] as string;
            const user = db.users.find((u: any) => u.username === username);
            if (user) {
              rows = rows.filter(e => e.owner_user_id === user.id);
            } else {
              rows = [];
            }
          }

          // Apply tag filter if present
          if (whereClause.includes("tags LIKE ?")) {
            const tagIdx = whereClause.indexOf("tags LIKE ?");
            // Count how many bindings come before this one
            const beforeStr = whereClause.substring(0, tagIdx);
            const bindCount = (beforeStr.match(/\?/g) || []).length;
            const pattern = String(args[bindCount]);
            const tag = pattern.replace(/%"/g, "").replace(/"%/g, "");
            rows = rows.filter(e => (JSON.parse(e.tags ?? "[]") as string[]).includes(tag));
          }

          // Apply date filters
          if (whereClause.includes("created_at >= ?")) {
            const idx = whereClause.indexOf("created_at >= ?");
            const beforeStr = whereClause.substring(0, idx);
            const bindCount = (beforeStr.match(/\?/g) || []).length;
            const after = Number(args[bindCount]);
            rows = rows.filter(e => e.created_at >= after);
          }
          if (whereClause.includes("created_at <= ?")) {
            const idx = whereClause.indexOf("created_at <= ?");
            const beforeStr = whereClause.substring(0, idx);
            const bindCount = (beforeStr.match(/\?/g) || []).length;
            const before = Number(args[bindCount]);
            rows = rows.filter(e => e.created_at <= before);
          }

          // Apply visibility filter
          if (whereClause.includes("tags NOT LIKE") && !whereClause.includes("owner_user_id = ? OR")) {
            // Public only
            rows = rows.filter(e => !(JSON.parse(e.tags ?? "[]") as string[]).includes("private"));
          } else if (whereClause.includes("owner_user_id = ? AND tags LIKE")) {
            // Own private only - find the bind index for this clause
            const idx = whereClause.indexOf("owner_user_id = ? AND tags LIKE");
            const beforeStr = whereClause.substring(0, idx);
            const bindCount = (beforeStr.match(/\?/g) || []).length;
            const userId = args[bindCount] as string;
            rows = rows.filter(e => e.owner_user_id === userId && (JSON.parse(e.tags ?? "[]") as string[]).includes("private"));
          } else if (whereClause.includes("owner_user_id = ? OR tags NOT LIKE")) {
            // Default visibility (own + public) - find the bind index
            const idx = whereClause.indexOf("owner_user_id = ? OR tags NOT LIKE");
            const beforeStr = whereClause.substring(0, idx);
            const bindCount = (beforeStr.match(/\?/g) || []).length;
            const userId = args[bindCount] as string;
            rows = rows.filter(e => e.owner_user_id === userId || !(JSON.parse(e.tags ?? "[]") as string[]).includes("private"));
          }

          const results = rows
            .sort((a: any, b: any) => b.created_at - a.created_at)
            .slice(0, limit)
            .map((e: any) => ({
              id: e.id, content: e.content, tags: e.tags, source: e.source,
              created_at: e.created_at, vector_ids: e.vector_ids ?? "[]",
              owner_user_id: e.owner_user_id ?? "",
            }));
          return { results };
        }
        if (s.includes("WHERE content LIKE") && s.includes("ORDER BY created_at DESC LIMIT")) {
          // Keyword (hybrid recall) query: content LIKE ? OR content LIKE ? ... LIMIT ?
          const limit = Number(args[args.length - 1]);
          const patterns = args.slice(0, -1).map((a: any) => String(a).replace(/^%/, "").replace(/%$/, "").toLowerCase());
          const rows = [...db.entries]
            .filter((e: any) => patterns.some((p: string) => String(e.content).toLowerCase().includes(p)))
            .sort((a: any, b: any) => b.created_at - a.created_at)
            .slice(0, limit)
            .map((e: any) => ({
              id: e.id,
              content: e.content,
              tags: e.tags,
              source: e.source,
              created_at: e.created_at,
              owner_user_id: e.owner_user_id ?? "",
            }));
          return { results: rows };
        }
        if (s.includes("FROM entries") && s.includes("id NOT IN (SELECT source_id FROM edges)")) {
          // runGraphPass backfill: entries not referenced by any edge, newest first.
          const linked = new Set(db.edges.flatMap((e: any) => [e.source_id, e.target_id]));
          const limitMatch = s.match(/LIMIT (\d+)/);
          const limit = limitMatch ? parseInt(limitMatch[1], 10) : 25;
          const rows = [...db.entries]
            .filter((e: any) => {
              if (linked.has(e.id)) return false;
              if (s.includes('"status:deprecated"') && (JSON.parse(e.tags ?? "[]") as string[]).includes("status:deprecated")) return false;
              return true;
            })
            .sort((a: any, b: any) => b.created_at - a.created_at)
            .slice(0, limit)
            .map((e: any) => ({
              id: e.id,
              content: e.content,
              owner_user_id: (e as any).owner_user_id ?? "",
              tags: e.tags ?? "[]",
              visibility: normalizeEntry(e).visibility,
            }));
          return { results: rows };
        }
        if (s.includes("FROM edges WHERE source_id IN") && s.includes("OR target_id IN")) {
          // expandGraph BFS / graph edge fetch: every edge touching the frontier, strongest
          // first. Args are the frontier id list bound twice (source_id IN …, target_id IN …).
          const ids = new Set(args.map((a: any) => String(a)));
          const results = db.edges
            .filter((e: any) => ids.has(e.source_id) || ids.has(e.target_id))
            .sort((a: any, b: any) => b.weight - a.weight)
            .map((e: any) => ({ source_id: e.source_id, target_id: e.target_id, type: e.type, weight: e.weight, confidence: e.confidence ?? 1.0 }));
          return { results };
        }
        if (s.includes("SELECT source_id, target_id FROM edges ORDER BY weight DESC")) {
          // buildGraph default mode: strongest edges first (to derive the node set).
          const limitMatch = s.match(/LIMIT (\d+)/);
          const limit = limitMatch ? parseInt(limitMatch[1], 10) : db.edges.length;
          const results = [...db.edges]
            .sort((a: any, b: any) => b.weight - a.weight)
            .slice(0, limit)
            .map((e: any) => ({ source_id: e.source_id, target_id: e.target_id }));
          return { results };
        }
        if (s.includes("SELECT id, content, tags, importance_score, created_at FROM entries WHERE id IN") || s.includes("SELECT id, content, tags, importance_score, created_at, owner_user_id FROM entries WHERE id IN")) {
          // buildGraph node hydration.
          const results = db.entries
            .filter((e: any) => args.includes(e.id))
            .map((e: any) => ({ id: e.id, content: e.content, tags: e.tags, importance_score: e.importance_score ?? 0, created_at: e.created_at, owner_user_id: e.owner_user_id ?? "" }));
          return { results };
        }
        if (s.includes("SELECT id, owner_user_id, tags FROM entries WHERE id IN")) {
          // recallEntries post-fusion visibility filter.
          const results = db.entries
            .filter((e: any) => args.includes(e.id))
            .map((e: any) => ({ id: e.id, owner_user_id: (e as any).owner_user_id ?? "", tags: e.tags ?? "[]" }));
          return { results };
        }
        if (s.includes("SELECT id, tags, owner_user_id FROM entries WHERE id IN")) {
          // filterVisibleIds: visibility check for graph traversal.
          const results = db.entries
            .filter((e: any) => args.includes(e.id))
            .map((e: any) => ({ id: e.id, tags: e.tags ?? "[]", owner_user_id: (e as any).owner_user_id ?? "" }));
          return { results };
        }
        if (s.includes("SELECT id, vector_ids FROM entries WHERE owner_user_id") && s.includes("tags LIKE")) {
          const ownerId = args[0] as string;
          const results = db.entries
            .filter((e: any) => e.owner_user_id === ownerId && (JSON.parse(e.tags ?? "[]") as string[]).includes("private"))
            .map((e: any) => ({ id: e.id, vector_ids: e.vector_ids ?? "[]" }));
          return { results };
        }
        if (s.includes("SELECT id, tags FROM entries WHERE id IN")) {
          // expandGraph deprecation check.
          const results = db.entries
            .filter((e: any) => args.includes(e.id))
            .map((e: any) => ({ id: e.id, tags: e.tags }));
          return { results };
        }
        if (s.includes("FROM entries e LEFT JOIN users u ON e.owner_user_id = u.id")) {
          // GET /team-activity query.
          let rows = db.entries.map((row: any) => normalizeEntry(row));
          // Team activity is an explicit public projection, independent of
          // potentially stale or malformed legacy tag metadata.
          rows = rows.filter((entry: any) => entry.visibility === "public");
          // Apply user filter
          if (s.includes("e.owner_user_id = (SELECT id FROM users WHERE username = ?)")) {
            const clauseIndex = s.indexOf("e.owner_user_id = (SELECT id FROM users WHERE username = ?)");
            const argIndex = (s.slice(0, clauseIndex).match(/\?/g) ?? []).length;
            const username = args[argIndex] as string;
            const user = db.users.find((u: any) => u.username === username);
            if (user) {
              rows = rows.filter(e => e.owner_user_id === user.id);
            } else {
              rows = [];
            }
          }
          // Apply an opaque cursor or the legacy numeric `after` boundary.
          if (s.includes("e.created_at < ? OR (e.created_at = ? AND e.id < ?)")) {
            const idx = s.indexOf("e.created_at < ? OR (e.created_at = ? AND e.id < ?)");
            const bindCount = (s.slice(0, idx).match(/\?/g) ?? []).length;
            const createdAt = Number(args[bindCount]);
            const id = String(args[bindCount + 2]);
            rows = rows.filter((entry: any) =>
              entry.created_at < createdAt || (entry.created_at === createdAt && String(entry.id) < id));
          } else if (s.includes("e.created_at <= ?")) {
            const idx = s.indexOf("e.created_at <= ?");
            const beforeStr = s.substring(0, idx);
            const bindCount = (beforeStr.match(/\?/g) || []).length;
            const afterVal = Number(args[bindCount]);
            rows = rows.filter(e => e.created_at <= afterVal);
          }
          // Sort and limit
          const limitMatch = s.match(/LIMIT \?/);
          const limit = limitMatch ? Number(args[args.length - 1]) : 20;
          rows.sort((a: any, b: any) => (b.created_at - a.created_at) || String(b.id).localeCompare(String(a.id)));
          rows = rows.slice(0, limit);
          // Hydrate usernames
          const results = rows.map((e: any) => {
            const user = db.users.find((u: any) => u.id === e.owner_user_id);
            const creator = db.users.find((u: any) => u.id === e.created_by_user_id);
            return {
              id: e.id,
              content: e.content,
              tags: e.tags,
              source: e.source,
              created_at: e.created_at,
              owner_user_id: e.owner_user_id ?? "",
              created_by_user_id: e.created_by_user_id ?? "",
              owner_username: user?.username ?? "",
              creator_username: creator?.username ?? "",
            };
          });
          return { results };
        }
        // ─── Edge proposals ──────────────────────────────────────────────
        if (s.includes("FROM edge_proposals WHERE id = ?") && !s.includes("status = 'pending'")) {
          // GET single proposal
          const id = args[0];
          const p = db.edgeProposals.find((p: any) => p.id === id);
          return { results: p ? [p] : [] };
        }
        if (s.includes("FROM edge_proposals WHERE source_id = ? AND target_id = ? AND type") && s.includes("status = 'pending'")) {
          // Dedup check — handles both: type = ? (MCP) and type = 'contradicts' (lifecycle)
          const typeMatch = s.match(/type = '?(\w+)'?/);
          const typeValue = typeMatch ? typeMatch[1] : args[2];
          const [sourceId, targetId] = args;
          const p = db.edgeProposals.find((pp: any) => pp.source_id === sourceId && pp.target_id === targetId && pp.type === typeValue && pp.status === "pending");
          return { results: p ? [p] : [] };
        }
        if (s.includes("FROM edge_proposals") && s.includes("status = 'pending'") && !s.includes("source_id = ?")) {
          // List pending proposals — handles both aliased and non-aliased SQL
          const results = db.edgeProposals
            .filter((p: any) => p.status === "pending")
            .sort((a: any, b: any) => b.created_at - a.created_at);
          return { results };
        }
        if (s.includes("INSERT INTO edge_proposals")) {
          // Parse columns and values to handle hardcoded literals
          const colMatch = s.match(/INSERT INTO edge_proposals \(([^)]+)\) VALUES \(([^)]+)\)/);
          if (colMatch) {
            const columns = colMatch[1].split(',').map((c: string) => c.trim());
            const values = colMatch[2].split(',').map((v: string) => v.trim());
            const proposal: any = {};
            let argIdx = 0;
            for (let i = 0; i < columns.length; i++) {
              if (values[i] === '?') {
                proposal[columns[i]] = args[argIdx++];
              } else {
                proposal[columns[i]] = values[i].replace(/^'|'$/g, '');
              }
            }
            proposal.status = proposal.status ?? "pending";
            db.edgeProposals.push(proposal as any);
            return { results: [] };
          }
          // Fallback
          const id = args[0] as string;
          const proposal = {
            id, source_id: args[1], target_id: args[2], type: args[3],
            reason: args[4], proposed_by: args[5], status: "pending", created_at: args[7] as number,
          };
          db.edgeProposals.push(proposal as any);
          return { results: [] };
        }
        if (s.includes("UPDATE edge_proposals SET status =")) {
          const status = s.includes("'approved'") ? "approved" : "rejected";
          const resolvedAt = args[0] as number;
          const id = args[1] as string;
          const p = db.edgeProposals.find((pp: any) => pp.id === id);
          if (p) { p.status = status; p.resolved_at = resolvedAt; }
          return { results: [] };
        }
        if (s.includes("SELECT id, content, tags, source, created_at") && s.includes("FROM entries WHERE id IN") && !s.includes("tags NOT LIKE")) {
          // Graph node hydration (/connections, /graph). The `tags NOT LIKE` guard
          // keeps this from shadowing recall's hydration query (same columns, but it
          // applies the auto-pattern/deprecated/kind filters itself further down).
          const results = db.entries
            .filter((e: any) => args.includes(e.id))
            .map((e: any) => ({ id: e.id, content: e.content, tags: e.tags, source: e.source, created_at: e.created_at, owner_user_id: e.owner_user_id ?? "" }));
          return { results };
        }
        if (s.includes("SELECT id, recall_count, importance_score") && s.includes("WHERE id IN")) {
          const results = db.entries
            .filter((e: any) => args.includes(e.id))
            .map((e: any) => ({ id: e.id, recall_count: e.recall_count ?? 0, importance_score: e.importance_score ?? 0, contradiction_wins: e.contradiction_wins ?? 0, contradiction_losses: e.contradiction_losses ?? 0, last_recalled_at: e.last_recalled_at ?? null, created_at: e.created_at }));
          return { results };
        }
        if (s.includes("FROM entries WHERE id IN") && s.includes("tags NOT LIKE")) {
          // recallEntries D1 hydration — filter by IDs, exclude auto-pattern entries, apply after/before
          const inMatch = s.match(/WHERE id IN \(([^)]*)\)/);
          const idCount = inMatch ? inMatch[1].split(",").length : 0;
          const ids = args.slice(0, idCount);
          // Skip the visibility clause binding (owner_user_id = ?) if present
          const visOffset = s.includes("owner_user_id = ?") ? 1 : 0;
          const rest = args.slice(idCount + visOffset);
          let argIdx = 0;
          const kindMatch = s.match(/tags LIKE '%"(kind:(?:episodic|semantic))"%'/);
          let rows = db.entries.filter((e: any) => {
            const tags: string[] = JSON.parse(e.tags ?? "[]");
            if (!ids.includes(e.id)) return false;
            if (tags.includes("auto-pattern")) return false;
            if (s.includes('"status:deprecated"') && tags.includes("status:deprecated")) return false;
            if (kindMatch && !tags.includes(kindMatch[1])) return false;
            return true;
          });
          // Apply visibility: owner_user_id = userId OR entries not tagged private
          if (s.includes("owner_user_id = ?") && s.includes("tags NOT LIKE")) {
            const ownerId = args[ids.length] as string;
            rows = rows.filter((e: any) => e.owner_user_id === ownerId || !(JSON.parse(e.tags ?? "[]") as string[]).includes("private"));
          }
          if (s.includes("created_at >= ?")) {
            const after = Number(rest[argIdx++]);
            rows = rows.filter((e: any) => e.created_at >= after);
          }
          if (s.includes("created_at <= ?")) {
            const before = Number(rest[argIdx++]);
            rows = rows.filter((e: any) => e.created_at <= before);
          }
          if (s.includes("valid_from IS NULL OR valid_from <= ?")) {
            const asOf = Number(rest[argIdx++]);
            rows = rows.filter((e: any) => e.valid_from == null || e.valid_from <= asOf);
          }
          if (s.includes("valid_to IS NULL OR valid_to > ?")) {
            const asOf = Number(rest[argIdx++]);
            rows = rows.filter((e: any) => e.valid_to == null || e.valid_to > asOf);
          }
          const results = rows.map((e: any) => ({ id: e.id, content: e.content, tags: e.tags, source: e.source, created_at: e.created_at, owner_user_id: e.owner_user_id ?? "" }));
          return { results };
        }
        if (s.includes("SELECT id, content FROM entries") && s.includes("WHERE tags LIKE") && s.includes("ORDER BY created_at DESC")) {
          // compressTag raw entries query — tag match, system-tag exclusion, and the
          // recall/age/contradiction eligibility predicate (cutoff is the 2nd bind param).
          // When userId is provided (3rd bind param), filter by owner_user_id or public visibility.
          const tagPattern = args[0] as string;
          const tag = tagPattern.replace(/%"/g, "").replace(/"%/g, "");
          const cutoff = Number(args[1]);
          const userId = args.length > 2 ? (args[2] as string) : undefined;
          const results = [...db.entries]
            .filter((e: any) => {
              const tags: string[] = JSON.parse(e.tags ?? "[]");
              if (!tags.includes(tag)) return false;
              if (tags.includes("synthesized") || tags.includes("auto-pattern") || tags.includes("rolled-up")) return false;
              if (!(e.importance_score == null || e.importance_score < COMPRESSION_IMPORTANCE_THRESHOLD)) return false;
              const rc = e.recall_count; // NULL/undefined → recall clause is falsy → protected (matches SQL)
              if (!(rc === 0 || (rc < COMPRESSION_MIN_RECALL && e.created_at < cutoff))) return false;
              if (!(e.contradiction_wins == null || e.contradiction_wins === 0)) return false;
              // Per-user visibility: owner's entries OR public entries
              if (userId) {
                const isOwner = e.owner_user_id === userId;
                const isPublic = !tags.includes("private");
                if (!isOwner && !isPublic) return false;
              }
              return true;
            })
            .sort((a: any, b: any) => b.created_at - a.created_at)
            .slice(0, 50)
            .map((e: any) => ({ id: e.id, content: e.content }));
          return { results };
        }
        if (s.includes("SELECT id, content FROM entries WHERE id IN")) {
          const results = db.entries
            .filter((e: any) => args.includes(e.id))
            .map((e: any) => ({ id: e.id, content: e.content }));
          return { results };
        }
        if (s.includes("FROM passages WHERE entry_id")) {
          const entryIds = args.map((a: any) => String(a));
          const results = db.passages
            .filter((p: any) => entryIds.includes(p.entry_id))
            .sort((a: any, b: any) => (a.start_offset ?? 0) - (b.start_offset ?? 0))
            .map((p: any) => ({ ...p, section: p.section ?? null, start_offset: p.start_offset ?? null, end_offset: p.end_offset ?? null, vector_ids: p.vector_ids ?? "[]" }));
          return { results };
        }
        if (s.includes("FROM document_sections ds") && s.includes("JOIN documents d")) {
          // Hierarchy query — return all document sections
          const results = db.document_sections.map((ds: any) => ({
            id: ds.id, title: ds.title, level: ds.level, order_index: ds.order_index, parent_section_id: ds.parent_section_id,
          }));
          return { results };
        }
        if (s.includes("FROM document_sections ds") && s.includes("WHERE ds.title IN")) {
          // Hierarchy query (by passage section names) — match section titles
          const titles = args.map((a: any) => String(a));
          const results = db.document_sections
            .filter((ds: any) => titles.includes(ds.title))
            .sort((a: any, b: any) => a.order_index - b.order_index)
            .map((ds: any) => ({
              id: ds.id, title: ds.title, level: ds.level, order_index: ds.order_index, parent_section_id: ds.parent_section_id,
            }));
          return { results };
        }
        if (s.includes("FROM entry_snapshots") && s.includes("WHERE entry_id")) {
          const entryId = args[0] as string;
          const results = db.entry_snapshots
            .filter((s: any) => s.entry_id === entryId)
            .map((s: any) => ({ id: s.id }));
          return { results };
        }
        if (s.includes("json_each(entries.tags)") && s.includes("HAVING count > 10")) {
          // Digest-candidate query (nightly compression + /stats): per-tag count of
          // entries that pass the compression eligibility predicate. Cutoff is args[0].
          const cutoff = Number(args[0]);
          const SYSTEM = ["synthesized", "auto-pattern", "duplicate-candidate", "contradiction-resolved", "rolled-up"];
          const counts = new Map<string, number>();
          for (const e of db.entries as any[]) {
            const tags: string[] = JSON.parse(e.tags ?? "[]");
            if (tags.includes("rolled-up") || tags.includes("synthesized") || tags.includes("auto-pattern")) continue;
            if (!(e.importance_score == null || e.importance_score < COMPRESSION_IMPORTANCE_THRESHOLD)) continue;
            const rc = e.recall_count; // NULL/undefined → recall clause is falsy → protected (matches SQL)
            if (!(rc === 0 || (rc < COMPRESSION_MIN_RECALL && e.created_at < cutoff))) continue;
            if (!(e.contradiction_wins == null || e.contradiction_wins === 0)) continue;
            for (const t of tags) {
              if (SYSTEM.includes(t)) continue;
              if (t.startsWith("status:") || t.startsWith("kind:")) continue;
              counts.set(t, (counts.get(t) ?? 0) + 1);
            }
          }
          const results = [...counts.entries()]
            .filter(([, c]) => c > 10)
            .sort((a, b) => b[1] - a[1])
            .map(([tag, count]) => ({ tag, count }));
          return { results };
        }
        if (s.includes("json_each(entries.tags)") && s.includes("GROUP BY value")) {
          // Top tags by frequency — for /stats
          const freq = new Map<string, number>();
          db.entries.forEach((e: any) => {
            (JSON.parse(e.tags ?? "[]") as string[]).forEach(t => freq.set(t, (freq.get(t) ?? 0) + 1));
          });
          const sorted = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
          return { results: sorted.map(([value, n]) => ({ value, n })) };
        }
        if (s.includes("json_each(entries.tags)")) {
          // Distinct sorted tags — for /tags
          const tags = new Set<string>();
          db.entries.forEach((e: any) => {
            (JSON.parse(e.tags ?? "[]") as string[]).forEach(t => tags.add(t));
          });
          return { results: [...tags].sort().map(t => ({ value: t })) };
        }
        if (s.includes(`tags NOT LIKE '%"status:%'`) && s.includes(`tags NOT LIKE '%"kind:%'`) && s.includes("ORDER BY created_at ASC LIMIT")) {
          const limitMatch = s.match(/LIMIT\s+(\d+)/i);
          const limit = limitMatch ? parseInt(limitMatch[1], 10) : 25;
          let candidates = [...db.entries]
            .filter((e: any) => !String(e.tags).includes('"status:') && !String(e.tags).includes('"kind:'));
          if (s.includes("entries.owner_user_id = ?")) {
            candidates = candidates.filter((e: any) => e.owner_user_id === args[0]);
          }
          if (s.includes("EXISTS") && s.includes("users.status = 'active'")) {
            candidates = candidates.filter((e: any) => db.users.some((u: any) => u.id === e.owner_user_id && u.status === "active"));
          }
          const rows = candidates
            .sort((a: any, b: any) => a.created_at - b.created_at)
            .slice(0, limit)
            .map((e: any) => {
              normalizeEntry(e);
              return {
                id: e.id,
                content: e.content,
                tags: e.tags,
                source: e.source,
                owner_user_id: e.owner_user_id,
                revision: e.revision,
                valid_from: e.valid_from,
                valid_to: e.valid_to,
                epistemic_status: e.epistemic_status,
              };
            });
          return { results: rows };
        }
        if (s.includes("vector_ids = '[]' AND created_at <") && s.includes("ORDER BY created_at DESC LIMIT")) {
          const cutoff = Number(args[0]);
          const limitMatch = s.match(/LIMIT\s+(\d+)/i);
          const limit = limitMatch ? parseInt(limitMatch[1], 10) : 25;
          const rows = [...db.entries]
            .filter((e: any) => e.vector_ids === '[]' && e.created_at < cutoff)
            .sort((a: any, b: any) => b.created_at - a.created_at)
            .slice(0, limit)
            .map((e: any) => ({ id: e.id, content: e.content, tags: e.tags, source: e.source, created_at: e.created_at }));
          return { results: rows };
        }
        if (s.includes("recall_count, importance_score, contradiction_wins, contradiction_losses FROM entries") && s.includes("ORDER BY created_at DESC") && !s.includes("LIMIT")) {
          // GET /export: entries with optional WHERE filters, newest first, no LIMIT.
          let rows = [...db.entries] as any[];
          if (s.includes("owner_user_id = ? AND tags NOT LIKE ?")) {
            const userId = args[0] as string;
            rows = rows.filter(e => e.owner_user_id === userId && !(JSON.parse(e.tags ?? "[]") as string[]).includes("private"));
          } else if (s.includes("owner_user_id = ? AND tags LIKE ?")) {
            const userId = args[0] as string;
            rows = rows.filter(e => e.owner_user_id === userId && (JSON.parse(e.tags ?? "[]") as string[]).includes("private"));
          } else if (s.includes("tags NOT LIKE ?")) {
            rows = rows.filter(e => !(JSON.parse(e.tags ?? "[]") as string[]).includes("private"));
          }
          const results = rows
            .sort((a: any, b: any) => b.created_at - a.created_at)
            .map((e: any) => ({
              id: e.id, content: e.content, tags: e.tags, source: e.source, created_at: e.created_at,
              recall_count: e.recall_count ?? 0, importance_score: e.importance_score ?? 0,
              contradiction_wins: e.contradiction_wins ?? 0, contradiction_losses: e.contradiction_losses ?? 0,
            }));
          return { results };
        }
        if (s.startsWith("SELECT source_id, target_id, type, weight, provenance, created_at") && s.includes("FROM edges") && !s.includes("WHERE")) {
          // GET /export: the whole edges table.
          const results = db.edges.map((e: any) => ({
            source_id: e.source_id, target_id: e.target_id, type: e.type,
            weight: e.weight, provenance: e.provenance, created_at: e.created_at,
            confidence: e.confidence ?? 1.0,
          }));
          return { results };
        }
        if (s.includes("ORDER BY created_at DESC LIMIT") && s.includes("FROM entries")) {
          const limit = Number(args[args.length - 1]);
          const filterArgs = args.slice(0, -1);
          let argIdx = 0;
          let rows = [...db.entries];
          if (s.includes("tags LIKE ?")) {
            const pattern = String(filterArgs[argIdx++]);
            const tag = pattern.replace(/%"/g, "").replace(/"%/g, "");
            rows = rows.filter((e: any) => (JSON.parse(e.tags ?? "[]") as string[]).includes(tag));
          }
          if (s.includes("created_at >= ?")) {
            const after = Number(filterArgs[argIdx++]);
            rows = rows.filter((e: any) => e.created_at >= after);
          }
          if (s.includes("created_at <= ?")) {
            const before = Number(filterArgs[argIdx++]);
            rows = rows.filter((e: any) => e.created_at <= before);
          }
          if (s.includes("owner_user_id = ?")) {
            const userId = String(filterArgs[argIdx++]);
            rows = rows.filter((e: any) => {
              const tags: string[] = JSON.parse(e.tags ?? "[]");
              return e.owner_user_id === userId || !tags.includes("private");
            });
          }
          rows.sort((a: any, b: any) => b.created_at - a.created_at);
          return { results: rows.slice(0, limit) };
        }
        // ─── Agent runs/events all() ────────────────────────────────
        if (s.includes("FROM agent_events") && s.includes("tool_name") && s.includes("GROUP BY tool_name")) {
          const cutoff = args[0] as number;
          const filtered = db.agentEvents.filter((e: any) => e.created_at >= cutoff);
          const grouped = new Map<string, { count: number; totalDuration: number; errorCount: number }>();
          for (const e of filtered) {
            const existing = grouped.get(e.tool_name) ?? { count: 0, totalDuration: 0, errorCount: 0 };
            existing.count++;
            existing.totalDuration += e.duration_ms ?? 0;
            if (e.error) existing.errorCount++;
            grouped.set(e.tool_name, existing);
          }
          const results = [...grouped.entries()]
            .map(([tool_name, g]) => ({ tool_name, count: g.count, avg_duration_ms: g.count > 0 ? g.totalDuration / g.count : 0, errorCount: g.errorCount }))
            .sort((a: any, b: any) => b.count - a.count);
          return { results };
        }
        if (s.includes("FROM agent_runs") && s.includes("ORDER BY started_at DESC")) {
          let rows = [...db.agentRuns];
          const userIdx = s.indexOf("WHERE user_id = ?");
          if (userIdx !== -1) {
            const userId = args[0] as string;
            rows = rows.filter((r: any) => r.user_id === userId);
          }
          const limitIdx = s.indexOf("LIMIT ?");
          const limit = limitIdx !== -1 ? Number(args[args.length - 1]) : rows.length;
          rows.sort((a: any, b: any) => b.started_at - a.started_at);
          return { results: rows.slice(0, limit).map((r: any) => ({ id: r.id, userId: r.user_id, startedAt: r.started_at, completedAt: r.completed_at, toolCount: r.tool_count })) };
        }
        if (s.includes("FROM agent_events") && s.includes("WHERE run_id = ?") && s.includes("ORDER BY created_at ASC")) {
          const runId = args[0] as string;
          const rows = db.agentEvents.filter((e: any) => e.run_id === runId).sort((a: any, b: any) => a.created_at - b.created_at);
          return { results: rows.map((r: any) => ({ id: r.id, runId: r.run_id, toolName: r.tool_name, inputSummary: r.input_summary, outputSummary: r.output_summary, durationMs: r.duration_ms, error: r.error, createdAt: r.created_at })) };
        }
        return { results: [] };
      },
    });

    return {
      bind(...args: any[]) { return makeStmt(args); },
      ...makeStmt([]),
    };
  }

  async exec(_sql: string) { }

  async batch(stmts: any[]) {
    const tableNames = [
      "entries",
      "edges",
      "edge_versions",
      "users",
      "episodes",
      "passages",
      "documents",
      "document_sections",
      "entry_snapshots",
      "vector_cleanup_queue",
      "edgeProposals",
      "agentRuns",
      "agentEvents",
      "user_deactivations",
      "service_identities",
      "service_credentials",
      "security_events",
      "action_proposals",
      "proposal_events",
    ] as const;
    const snapshot = new Map<string, any[]>();
    for (const table of tableNames) snapshot.set(table, structuredClone(this[table]));

    try {
      const results = [];
      for (const statement of stmts) results.push(await statement.run());
      return results;
    } catch (error) {
      for (const table of tableNames) this[table] = snapshot.get(table)!;
      throw error;
    }
  }

  reset() {
    this.entries = [];
    this.edges = [];
    this.edge_versions = [];
    this.users = [];
    this.episodes = [];
    this.passages = [];
    this.documents = [];
    this.document_sections = [];
    this.entry_snapshots = [];
    this.vector_cleanup_queue = [];
    this.edgeProposals = [];
    this.agentRuns = [];
    this.agentEvents = [];
    this.user_deactivations = [];
    this.service_identities = [];
    this.service_credentials = [];
    this.security_events = [];
    this.action_proposals = [];
    this.proposal_events = [];
  }
}
