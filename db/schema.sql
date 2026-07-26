-- Current schema snapshot for a fresh Shared Living Memory D1 database.
-- Runtime upgrades are ordered and recorded by src/db.ts. Keep this snapshot in
-- sync with the latest runtime migration.
-- Run with: wrangler d1 execute shared-living-memory-db --file=db/schema.sql

CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  applied_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS entries (
  id                     TEXT PRIMARY KEY,
  content                TEXT NOT NULL,
  tags                   TEXT NOT NULL DEFAULT '[]',
  source                 TEXT NOT NULL DEFAULT 'api',
  created_at             INTEGER NOT NULL,
  vector_ids             TEXT NOT NULL DEFAULT '[]',
  recall_count           INTEGER NOT NULL DEFAULT 0,
  importance_score       INTEGER NOT NULL DEFAULT 0,
  contradiction_wins     INTEGER NOT NULL DEFAULT 0,
  contradiction_losses   INTEGER NOT NULL DEFAULT 0,
  owner_user_id          TEXT NOT NULL DEFAULT '',
  retention_score        REAL NOT NULL DEFAULT 1.0,
  last_recalled_at       INTEGER,
  valid_from             INTEGER,
  valid_to               INTEGER,
  recorded_at            INTEGER,
  epistemic_status       TEXT NOT NULL DEFAULT 'canonical',
  current_episode_id     TEXT,
  revision               INTEGER NOT NULL DEFAULT 0,
  created_by_user_id     TEXT NOT NULL DEFAULT '',
  visibility             TEXT NOT NULL DEFAULT 'private',
  vector_sync_pending    INTEGER NOT NULL DEFAULT 0,
  updated_at             INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_entries_created_at ON entries(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_entries_source ON entries(source);
-- idx_entries_owner and idx_entries_temporal are created by runtime migration 2
-- after it has verified that legacy entries tables contain the required columns.
-- Indexes over provenance-integrity columns are likewise created by runtime
-- migration 4 so this file remains safe when legacy tables already exist.

CREATE TABLE IF NOT EXISTS users (
  id                  TEXT PRIMARY KEY,
  username            TEXT NOT NULL UNIQUE,
  normalized_username TEXT NOT NULL UNIQUE,
  auth_key_hash       TEXT NOT NULL,
  auth_key_prefix     TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'active',
  created_at          INTEGER NOT NULL,
  last_used_at        INTEGER,
  role                TEXT NOT NULL DEFAULT 'member'
);

CREATE INDEX IF NOT EXISTS idx_users_normalized_username ON users(normalized_username);

CREATE TABLE IF NOT EXISTS edges (
  id                 TEXT PRIMARY KEY,
  source_id          TEXT NOT NULL,
  target_id          TEXT NOT NULL,
  type               TEXT NOT NULL DEFAULT 'relates_to',
  weight             REAL NOT NULL DEFAULT 0.5,
  provenance         TEXT NOT NULL DEFAULT 'inferred',
  metadata           TEXT NOT NULL DEFAULT '{}',
  confidence         REAL NOT NULL DEFAULT 1.0,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  revision           INTEGER NOT NULL DEFAULT 1,
  last_actor_kind    TEXT NOT NULL DEFAULT 'system',
  last_actor_id      TEXT NOT NULL DEFAULT '_migration',
  last_mutation_kind TEXT NOT NULL DEFAULT 'legacy',
  last_mutation_id   TEXT,
  UNIQUE(source_id, target_id, type)
);

CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id);

CREATE TABLE IF NOT EXISTS edge_versions (
  id              TEXT PRIMARY KEY,
  edge_id         TEXT NOT NULL,
  source_id       TEXT NOT NULL,
  target_id       TEXT NOT NULL,
  type            TEXT NOT NULL,
  weight          REAL NOT NULL,
  provenance      TEXT NOT NULL,
  metadata        TEXT NOT NULL,
  confidence      REAL NOT NULL,
  edge_created_at INTEGER NOT NULL,
  edge_updated_at INTEGER NOT NULL,
  revision        INTEGER NOT NULL,
  is_deleted      INTEGER NOT NULL DEFAULT 0,
  mutation_kind   TEXT NOT NULL,
  mutation_id     TEXT,
  actor_kind      TEXT NOT NULL,
  actor_id        TEXT NOT NULL,
  recorded_at     INTEGER NOT NULL,
  UNIQUE(edge_id, revision)
);

CREATE INDEX IF NOT EXISTS idx_edge_versions_edge_revision
  ON edge_versions(edge_id, revision DESC);
CREATE INDEX IF NOT EXISTS idx_edge_versions_relationship
  ON edge_versions(source_id, target_id, type, revision DESC);

CREATE TRIGGER IF NOT EXISTS edge_versions_after_insert
  AFTER INSERT ON edges
  BEGIN
    INSERT OR IGNORE INTO edge_versions (
      id, edge_id, source_id, target_id, type, weight, provenance,
      metadata, confidence, edge_created_at, edge_updated_at,
      revision, is_deleted, mutation_kind, mutation_id, actor_kind,
      actor_id, recorded_at
    ) VALUES (
      'edge-version:' || NEW.id || ':' || NEW.revision,
      NEW.id, NEW.source_id, NEW.target_id, NEW.type, NEW.weight,
      NEW.provenance, NEW.metadata, NEW.confidence, NEW.created_at,
      NEW.updated_at, NEW.revision, 0, NEW.last_mutation_kind,
      NEW.last_mutation_id, NEW.last_actor_kind, NEW.last_actor_id,
      NEW.updated_at
    );
  END;

CREATE TRIGGER IF NOT EXISTS edge_versions_after_update
  AFTER UPDATE ON edges
  BEGIN
    INSERT OR IGNORE INTO edge_versions (
      id, edge_id, source_id, target_id, type, weight, provenance,
      metadata, confidence, edge_created_at, edge_updated_at,
      revision, is_deleted, mutation_kind, mutation_id, actor_kind,
      actor_id, recorded_at
    ) VALUES (
      'edge-version:' || NEW.id || ':' || NEW.revision,
      NEW.id, NEW.source_id, NEW.target_id, NEW.type, NEW.weight,
      NEW.provenance, NEW.metadata, NEW.confidence, NEW.created_at,
      NEW.updated_at, NEW.revision, 0, NEW.last_mutation_kind,
      NEW.last_mutation_id, NEW.last_actor_kind, NEW.last_actor_id,
      NEW.updated_at
    );
  END;

CREATE TRIGGER IF NOT EXISTS edge_versions_after_delete
  AFTER DELETE ON edges
  BEGIN
    INSERT OR IGNORE INTO edge_versions (
      id, edge_id, source_id, target_id, type, weight, provenance,
      metadata, confidence, edge_created_at, edge_updated_at,
      revision, is_deleted, mutation_kind, mutation_id, actor_kind,
      actor_id, recorded_at
    ) VALUES (
      'edge-version:' || OLD.id || ':' || (OLD.revision + 1),
      OLD.id, OLD.source_id, OLD.target_id, OLD.type, OLD.weight,
      OLD.provenance, OLD.metadata, OLD.confidence, OLD.created_at,
      OLD.updated_at, OLD.revision + 1, 1, OLD.last_mutation_kind,
      OLD.last_mutation_id, OLD.last_actor_kind, OLD.last_actor_id,
      CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
    );
  END;

CREATE TABLE IF NOT EXISTS episodes (
  id           TEXT PRIMARY KEY,
  entry_id     TEXT NOT NULL,
  content      TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'text',
  source       TEXT NOT NULL DEFAULT 'api',
  created_at   INTEGER NOT NULL,
  materialized_content      TEXT NOT NULL DEFAULT '',
  content_hash              TEXT,
  mutation_id               TEXT,
  mutation_kind             TEXT NOT NULL DEFAULT 'legacy',
  parent_episode_id         TEXT,
  restored_from_snapshot_id TEXT,
  owner_user_id             TEXT NOT NULL DEFAULT '',
  source_url                TEXT
);

CREATE INDEX IF NOT EXISTS idx_episodes_entry_id ON episodes(entry_id);

CREATE TABLE IF NOT EXISTS entry_snapshots (
  id         TEXT PRIMARY KEY,
  entry_id   TEXT NOT NULL,
  content    TEXT NOT NULL,
  tags       TEXT NOT NULL DEFAULT '[]',
  source     TEXT NOT NULL DEFAULT 'api',
  created_at INTEGER NOT NULL,
  episode_id       TEXT,
  mutation_id      TEXT,
  mutation_kind    TEXT NOT NULL DEFAULT 'legacy',
  recorded_at      INTEGER,
  valid_from       INTEGER,
  valid_to         INTEGER,
  epistemic_status TEXT,
  revision         INTEGER,
  visibility       TEXT NOT NULL DEFAULT 'private'
);

CREATE INDEX IF NOT EXISTS idx_snapshots_entry_id ON entry_snapshots(entry_id);

CREATE TABLE IF NOT EXISTS passages (
  id           TEXT PRIMARY KEY,
  entry_id     TEXT NOT NULL,
  episode_id   TEXT,
  document_id  TEXT,
  section_id   TEXT,
  content      TEXT NOT NULL,
  section      TEXT,
  page         INTEGER,
  page_end     INTEGER,
  start_offset INTEGER,
  end_offset   INTEGER,
  vector_ids   TEXT NOT NULL DEFAULT '[]',
  created_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_passages_entry_id ON passages(entry_id);
CREATE INDEX IF NOT EXISTS idx_passages_episode_id ON passages(episode_id);

CREATE TABLE IF NOT EXISTS documents (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  source_url   TEXT,
  content_type TEXT NOT NULL DEFAULT 'research',
  created_at   INTEGER NOT NULL,
  episode_id   TEXT,
  owner_user_id TEXT NOT NULL DEFAULT '',
  content_hash TEXT,
  version      TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_episode_unique
  ON documents(episode_id) WHERE episode_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS document_sections (
  id                TEXT PRIMARY KEY,
  document_id       TEXT NOT NULL,
  parent_section_id TEXT,
  title             TEXT NOT NULL,
  level             INTEGER NOT NULL DEFAULT 0,
  order_index       INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL,
  page_start        INTEGER,
  page_end          INTEGER,
  start_offset      INTEGER,
  end_offset        INTEGER
);

CREATE INDEX IF NOT EXISTS idx_sections_document_id ON document_sections(document_id);
CREATE INDEX IF NOT EXISTS idx_sections_parent ON document_sections(parent_section_id);

CREATE TABLE IF NOT EXISTS edge_proposals (
  id          TEXT PRIMARY KEY,
  source_id   TEXT NOT NULL,
  target_id   TEXT NOT NULL,
  type        TEXT NOT NULL DEFAULT 'contradicts',
  reason      TEXT NOT NULL DEFAULT '',
  proposed_by TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',
  created_at  INTEGER NOT NULL,
  resolved_at INTEGER,
  resolved_by TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_edge_proposals_pending_unique
  ON edge_proposals(source_id, target_id, type)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_edge_proposals_status_created
  ON edge_proposals(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_edge_proposals_source_target
  ON edge_proposals(source_id, target_id);

-- Indexes over migration-added entry/user columns are created by runtime
-- migration 5 after legacy tables have been upgraded.

CREATE TABLE IF NOT EXISTS user_deactivations (
  id                   TEXT PRIMARY KEY,
  user_id              TEXT NOT NULL,
  requested_by_user_id TEXT NOT NULL,
  transfer_to_user_id  TEXT,
  transfer_cursor      TEXT,
  processed_entries    INTEGER NOT NULL DEFAULT 0,
  status               TEXT NOT NULL DEFAULT 'pending',
  last_error           TEXT,
  requested_at         INTEGER NOT NULL,
  started_at           INTEGER,
  updated_at           INTEGER NOT NULL,
  completed_at         INTEGER
);

CREATE INDEX IF NOT EXISTS idx_user_deactivations_user_created
  ON user_deactivations(user_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_deactivations_resume
  ON user_deactivations(status, updated_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_deactivations_active_user
  ON user_deactivations(user_id)
  WHERE status IN ('pending', 'running');

CREATE TABLE IF NOT EXISTS agent_runs (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL,
  started_at          INTEGER NOT NULL,
  completed_at        INTEGER,
  tool_count          INTEGER NOT NULL DEFAULT 0,
  actor_kind          TEXT NOT NULL DEFAULT 'human',
  actor_id            TEXT NOT NULL DEFAULT '',
  service_identity_id TEXT,
  credential_id       TEXT,
  auth_method         TEXT NOT NULL DEFAULT 'legacy',
  autonomy_profile    TEXT NOT NULL DEFAULT 'legacy',
  policy_version      TEXT NOT NULL DEFAULT 'legacy',
  correlation_id      TEXT,
  status              TEXT NOT NULL DEFAULT 'legacy',
  policy_decision     TEXT,
  requested_scopes    TEXT NOT NULL DEFAULT '[]',
  granted_scopes      TEXT NOT NULL DEFAULT '[]',
  decision_reason     TEXT,
  proposal_id         TEXT,
  target_ids          TEXT NOT NULL DEFAULT '[]',
  redacted_request_summary TEXT,
  request_hash        TEXT,
  redacted_result_summary TEXT,
  result_hash         TEXT,
  error_code          TEXT,
  requested_at        INTEGER,
  succeeded_at        INTEGER,
  failed_at           INTEGER
);

CREATE INDEX IF NOT EXISTS idx_agent_runs_user_id ON agent_runs(user_id);
CREATE INDEX IF NOT EXISTS idx_agent_runs_started_at ON agent_runs(started_at DESC);
-- Indexes over migration-added audit columns are created by migration 6.

CREATE TABLE IF NOT EXISTS agent_events (
  id                  TEXT PRIMARY KEY,
  run_id              TEXT NOT NULL,
  tool_name           TEXT NOT NULL,
  input_summary       TEXT,
  output_summary      TEXT,
  duration_ms         INTEGER,
  error               TEXT,
  created_at          INTEGER NOT NULL,
  sequence            INTEGER NOT NULL DEFAULT 0,
  event_type          TEXT NOT NULL DEFAULT 'legacy',
  actor_kind          TEXT NOT NULL DEFAULT 'human',
  actor_id            TEXT NOT NULL DEFAULT '',
  service_identity_id TEXT,
  credential_id       TEXT,
  auth_method         TEXT NOT NULL DEFAULT 'legacy',
  autonomy_profile    TEXT NOT NULL DEFAULT 'legacy',
  policy_version      TEXT NOT NULL DEFAULT 'legacy',
  correlation_id      TEXT,
  status              TEXT NOT NULL DEFAULT 'legacy',
  policy_decision     TEXT,
  requested_scopes    TEXT NOT NULL DEFAULT '[]',
  granted_scopes      TEXT NOT NULL DEFAULT '[]',
  decision_reason     TEXT,
  proposal_id         TEXT,
  target_ids          TEXT NOT NULL DEFAULT '[]',
  redacted_input_summary  TEXT,
  redacted_output_summary TEXT,
  input_hash          TEXT,
  output_hash         TEXT,
  error_code          TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_events_run_id ON agent_events(run_id);
CREATE INDEX IF NOT EXISTS idx_agent_events_tool_name ON agent_events(tool_name);
CREATE INDEX IF NOT EXISTS idx_agent_events_created_at ON agent_events(created_at DESC);

-- A reservation is created atomically with every governed audit request. The
-- post-mutation path stages only redacted terminal metadata here before writing
-- the normal run/event projection, so a partial completion can be reconciled.
CREATE TABLE IF NOT EXISTS audit_completion_reconciliation (
  run_id                    TEXT PRIMARY KEY,
  outcome                   TEXT
    CHECK (outcome IS NULL OR outcome IN ('succeeded', 'failed', 'indeterminate')),
  redacted_result_summary   TEXT,
  result_hash               TEXT,
  failure_name              TEXT,
  error_code                TEXT,
  status                    TEXT NOT NULL DEFAULT 'reserved'
    CHECK (status IN ('reserved', 'ready', 'completed', 'dead_letter')),
  attempts                  INTEGER NOT NULL DEFAULT 0,
  last_error                TEXT,
  created_at                INTEGER NOT NULL,
  updated_at                INTEGER NOT NULL,
  ready_at                  INTEGER,
  completed_at              INTEGER
);

CREATE INDEX IF NOT EXISTS idx_audit_completion_reconciliation_status
  ON audit_completion_reconciliation(status, updated_at, run_id);

CREATE TABLE IF NOT EXISTS service_identities (
  id                       TEXT PRIMARY KEY,
  name                     TEXT NOT NULL UNIQUE,
  description              TEXT,
  owner_user_id            TEXT NOT NULL,
  status                   TEXT NOT NULL DEFAULT 'active',
  default_autonomy_profile TEXT NOT NULL DEFAULT 'observe',
  created_by_user_id       TEXT NOT NULL,
  created_at               INTEGER NOT NULL,
  updated_at               INTEGER NOT NULL,
  revoked_at               INTEGER
);

CREATE INDEX IF NOT EXISTS idx_service_identities_owner_status
  ON service_identities(owner_user_id, status);
CREATE INDEX IF NOT EXISTS idx_service_identities_status_updated
  ON service_identities(status, updated_at);

CREATE TABLE IF NOT EXISTS service_credentials (
  id                         TEXT PRIMARY KEY,
  service_identity_id        TEXT NOT NULL,
  credential_hash            TEXT NOT NULL UNIQUE,
  credential_prefix          TEXT NOT NULL,
  scopes                     TEXT NOT NULL DEFAULT '[]',
  status                     TEXT NOT NULL DEFAULT 'active',
  expires_at                 INTEGER,
  last_used_at               INTEGER,
  use_count                  INTEGER NOT NULL DEFAULT 0,
  last_used_metadata         TEXT,
  rotated_from_credential_id TEXT,
  created_by_user_id         TEXT NOT NULL,
  created_at                 INTEGER NOT NULL,
  revoked_at                 INTEGER,
  revoked_by_user_id         TEXT
);

CREATE INDEX IF NOT EXISTS idx_service_credentials_service_status
  ON service_credentials(service_identity_id, status);
CREATE INDEX IF NOT EXISTS idx_service_credentials_prefix
  ON service_credentials(credential_prefix);
CREATE INDEX IF NOT EXISTS idx_service_credentials_expiry
  ON service_credentials(status, expires_at);

CREATE TABLE IF NOT EXISTS security_events (
  id                  TEXT PRIMARY KEY,
  event_type          TEXT NOT NULL,
  actor_kind          TEXT,
  actor_id            TEXT,
  service_identity_id TEXT,
  credential_id       TEXT,
  auth_method         TEXT,
  correlation_id      TEXT,
  source_ip_hash      TEXT,
  user_agent_hash     TEXT,
  reason              TEXT NOT NULL,
  error_code          TEXT,
  redacted_summary    TEXT,
  summary_hash        TEXT,
  metadata            TEXT NOT NULL DEFAULT '{}',
  created_at          INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_security_events_created
  ON security_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_security_events_actor
  ON security_events(actor_kind, actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_security_events_correlation
  ON security_events(correlation_id);

CREATE TABLE IF NOT EXISTS action_proposals (
  id                     TEXT PRIMARY KEY,
  action_type            TEXT NOT NULL,
  proposer_kind          TEXT NOT NULL,
  proposer_id            TEXT NOT NULL,
  visibility_scope       TEXT NOT NULL DEFAULT 'private',
  payload_json           TEXT NOT NULL,
  payload_hash           TEXT,
  target_ids             TEXT NOT NULL DEFAULT '[]',
  expected_preconditions TEXT NOT NULL DEFAULT '{}',
  expected_revision      INTEGER,
  status                 TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'executing', 'executed', 'rejected', 'failed', 'stale', 'expired')),
  risk_level             TEXT NOT NULL DEFAULT 'medium',
  reason                 TEXT NOT NULL,
  evidence_json          TEXT NOT NULL DEFAULT '[]',
  autonomy_profile       TEXT NOT NULL,
  policy_version         TEXT NOT NULL,
  idempotency_key        TEXT NOT NULL,
  expires_at             INTEGER,
  reviewer_kind          TEXT,
  reviewer_id            TEXT,
  review_reason          TEXT,
  reviewed_at            INTEGER,
  executor_kind          TEXT,
  executor_id            TEXT,
  execution_started_at   INTEGER,
  executed_at            INTEGER,
  rejected_at            INTEGER,
  failed_at              INTEGER,
  stale_at               INTEGER,
  expired_at             INTEGER,
  result_json            TEXT,
  result_hash            TEXT,
  error_code             TEXT,
  error_message          TEXT,
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_action_proposals_status_created
  ON action_proposals(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_action_proposals_proposer
  ON action_proposals(proposer_kind, proposer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_action_proposals_action_status
  ON action_proposals(action_type, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_action_proposals_expiry
  ON action_proposals(status, expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_action_proposals_idempotency
  ON action_proposals(idempotency_key);

CREATE TABLE IF NOT EXISTS proposal_events (
  id          TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL,
  sequence    INTEGER NOT NULL,
  event_type  TEXT NOT NULL,
  actor_kind  TEXT NOT NULL,
  actor_id    TEXT NOT NULL,
  data_json   TEXT NOT NULL DEFAULT '{}',
  data_hash   TEXT,
  created_at  INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_proposal_events_sequence
  ON proposal_events(proposal_id, sequence);
CREATE INDEX IF NOT EXISTS idx_proposal_events_proposal_created
  ON proposal_events(proposal_id, created_at);
CREATE INDEX IF NOT EXISTS idx_proposal_events_type_created
  ON proposal_events(event_type, created_at DESC);

CREATE TRIGGER IF NOT EXISTS proposal_events_no_update
  BEFORE UPDATE ON proposal_events
  BEGIN
    SELECT RAISE(ABORT, 'proposal_events are append-only');
  END;
CREATE TRIGGER IF NOT EXISTS proposal_events_no_delete
  BEFORE DELETE ON proposal_events
  BEGIN
    SELECT RAISE(ABORT, 'proposal_events are append-only');
  END;

CREATE TABLE IF NOT EXISTS awareness_events (
  id                TEXT PRIMARY KEY,
  event_type        TEXT NOT NULL DEFAULT 'cross_user_overlap'
    CHECK (event_type IN ('cross_user_overlap')),
  recipient_user_id TEXT NOT NULL,
  entry_a_id        TEXT NOT NULL,
  entry_b_id        TEXT NOT NULL,
  trigger_entry_id  TEXT NOT NULL,
  similarity        REAL NOT NULL CHECK (similarity >= 0 AND similarity <= 1),
  created_at        INTEGER NOT NULL,
  read_at           INTEGER,
  CHECK (entry_a_id < entry_b_id),
  UNIQUE(event_type, recipient_user_id, entry_a_id, entry_b_id)
);

CREATE INDEX IF NOT EXISTS idx_awareness_events_recipient_created
  ON awareness_events(recipient_user_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_awareness_events_recipient_unread
  ON awareness_events(recipient_user_id, read_at, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_awareness_events_pair
  ON awareness_events(entry_a_id, entry_b_id);

CREATE TABLE IF NOT EXISTS overlap_awareness_reconciliation (
  id                             TEXT PRIMARY KEY,
  new_entry_id                   TEXT NOT NULL,
  matched_entry_id               TEXT NOT NULL,
  expected_new_owner_user_id     TEXT NOT NULL,
  expected_matched_owner_user_id TEXT NOT NULL,
  similarity                     REAL NOT NULL CHECK (similarity >= 0 AND similarity <= 1),
  status                         TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'completed', 'discarded', 'failed')),
  attempts                       INTEGER NOT NULL DEFAULT 0,
  last_error                     TEXT,
  created_at                     INTEGER NOT NULL,
  updated_at                     INTEGER NOT NULL,
  completed_at                   INTEGER,
  UNIQUE(new_entry_id, matched_entry_id)
);

CREATE INDEX IF NOT EXISTS idx_overlap_reconciliation_status_updated
  ON overlap_awareness_reconciliation(status, updated_at, id);

CREATE TABLE IF NOT EXISTS vector_cleanup_queue (
  id         TEXT PRIMARY KEY,
  vector_ids TEXT NOT NULL,
  reason     TEXT NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Do not insert schema_migrations rows here. CREATE TABLE IF NOT EXISTS cannot
-- prove that an existing legacy table has the current columns. src/db.ts records
-- a version only after its ordered migration batch succeeds.
