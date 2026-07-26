# Competitor Patterns → Shared Living Memory Schema Changes

**Date:** 2026-07-13
**Derived from:** `docs/research/competitor-analysis.md` (13 systems) + `docs/research/technical-knowledge-base-report.md`
**Purpose:** Concrete D1 schema and API changes needed to adopt patterns from competitor analysis

---

## 1. Bi-Temporal Fact Validity (from Graphiti, MemPalace)

**Current state:** Entries have `created_at` only. No concept of when a fact was true vs. when it was recorded.

**What competitors do:**
- Graphiti: Every edge has `valid_from`/`valid_to` + `created_at` (ingestion time)
- MemPalace: Knowledge graph entries have `valid_from`/`valid_to`

**Required changes:**

### Schema — new `facts` table
```sql
CREATE TABLE IF NOT EXISTS facts (
  id TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL REFERENCES entries(id),
  claim TEXT NOT NULL,
  confidence REAL DEFAULT 1.0,
  valid_from TEXT,            -- ISO timestamp: when this fact became true
  valid_to TEXT,              -- ISO timestamp: when this fact stopped being true (NULL = still valid)
  recorded_at TEXT NOT NULL,  -- ISO timestamp: when we ingested this fact
  superseded_by TEXT REFERENCES facts(id),
  source_passage_id TEXT,     -- link to evidence_passages
  owner_user_id TEXT NOT NULL DEFAULT '_system',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_facts_entry ON facts(entry_id);
CREATE INDEX IF NOT EXISTS idx_facts_valid ON facts(valid_from, valid_to);
```

### Schema — add bitemporal columns to `entries`
```sql
ALTER TABLE entries ADD COLUMN valid_from TEXT;
ALTER TABLE entries ADD COLUMN valid_to TEXT;
ALTER TABLE entries ADD COLUMN recorded_at TEXT;
```

### API — new MCP tool
```
temporal_query(entry_id?, query?, as_of?)
  → returns facts valid at the given timestamp
```

**Priority:** Critical — this is the single highest-value pattern from competitors.

---

## 2. Episode-Based Provenance (from Graphiti)

**Current state:** Entries have `source` field (URL/text) but no immutable raw record. Compression overwrites originals.

**What Graphiti does:** Raw episodes are immutable. Every derived fact traces back to the episode that produced it.

**Required changes:**

### Schema — new `episodes` table
```sql
CREATE TABLE IF NOT EXISTS episodes (
  id TEXT PRIMARY KEY,
  source_url TEXT,
  content_hash TEXT NOT NULL,     -- SHA-256 of raw content
  raw_content TEXT NOT NULL,      -- immutable original
  content_type TEXT NOT NULL,     -- 'paper', 'conversation', 'webpage', 'code'
  ingested_at TEXT NOT NULL DEFAULT (datetime('now')),
  ingested_by TEXT,               -- agent_name or user_id
  owner_user_id TEXT NOT NULL DEFAULT '_system'
);
CREATE INDEX IF NOT EXISTS idx_episodes_hash ON episodes(content_hash);
```

### Schema — link entries to episodes
```sql
ALTER TABLE entries ADD COLUMN episode_id TEXT REFERENCES episodes(id);
```

### Change to compression pipeline
Compression must **never overwrite** `episodes.raw_content`. Compressed digests link back to their source episodes.

**Priority:** Critical — prevents information loss during compression.

---

## 3. Spaced Repetition Decay (from AgentMemory)

**Current state:** `recall_count` incremented on recall, `importance_score` set by LLM. No forgetting curve.

**What AgentMemory does:** SM-2-inspired retention scoring. Memories decay over time unless reinforced. Half-life configurable per type.

**Required changes:**

### Schema — add decay columns to `entries`
```sql
ALTER TABLE entries ADD COLUMN last_recalled_at TEXT;
ALTER TABLE entries ADD COLUMN retention_score REAL DEFAULT 1.0;
ALTER TABLE entries ADD COLUMN decay_halflife_days INTEGER DEFAULT 30;
```

### API — recall path update
When `recall` returns results, update `last_recalled_at` and recalculate `retention_score`:

```
retention_score = e^(-λ × days_since_last_recall)
λ = ln(2) / halflife_days
```

### Retrieval integration
Multiply retrieval score by `retention_score` as a multiplier (like existing `importance_score`).

**Priority:** High — enables natural memory lifecycle without manual curation.

---

## 4. Typed Relations with Confidence (from AgentMemory, Graphiti)

**Current state:** Edge types are `relates_to`, `supersedes`, `caused_by`, `decided`, `about_person`, `part_of_project`, `follows`. No confidence scores.

**What AgentMemory does:** `contradicts`, `supersedes`, `derives_from`, `conflicts_with` — each with confidence 0.0–1.0.

**Required changes:**

### Schema — add confidence to `edges`
```sql
ALTER TABLE edges ADD COLUMN confidence REAL DEFAULT 1.0;
ALTER TABLE edges ADD COLUMN valid_from TEXT;
ALTER TABLE edges ADD COLUMN valid_to TEXT;
```

### Schema — add new edge types
Add to `EDGE_TYPES` in `src/index.ts`:
```
'contradicts'    — two entries present conflicting claims
'derives_from'   — entry B was extracted from entry A
'supports'       — entry B provides evidence for entry A
'evaluates_on'   — method A was evaluated on dataset B
'has_limitation' — entry B documents a limitation of approach A
```

### API — auto-linking threshold update
When auto-linking at cosine 0.78, also set `confidence` based on the cosine score:
```
confidence = (cosine_score - 0.78) / (1.0 - 0.78)  -- normalized 0.0–1.0 above threshold
```

**Priority:** High — makes the graph machine-readable, not just human-navigable.

---

## 5. Evidence Passages (from Graphiti episodes, technical-knowledge-base-report)

**Current state:** Entries are flat text. No sub-entry granularity for citation.

**Required changes:**

### Schema — new `evidence_passages` table
```sql
CREATE TABLE IF NOT EXISTS evidence_passages (
  id TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL REFERENCES entries(id),
  episode_id TEXT REFERENCES episodes(id),
  passage_text TEXT NOT NULL,
  section_heading TEXT,
  page_number INTEGER,
  char_offset_start INTEGER,
  char_offset_end INTEGER,
  embedding_id TEXT,           -- Vectorize vector ID
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_evidence_entry ON evidence_passages(entry_id);
```

### Retrieval change
When `recall` returns an entry, also return the most relevant `evidence_passages` for that entry (section-level granularity).

**Priority:** Critical for citable research — without this, every claim is unsourced.

---

## 6. Background Reasoning Pipeline (from Honcho)

**Current state:** All processing happens synchronously in request handlers or via `ctx.waitUntil()`.

**What Honcho does:** Background "deriver" worker extracts conclusions asynchronously. Representations are pre-computed snapshots.

**Required changes:**

### Architecture — add async extraction queue
```sql
CREATE TABLE IF NOT EXISTS extraction_queue (
  id TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL REFERENCES entries(id),
  status TEXT NOT NULL DEFAULT 'pending',  -- pending/processing/completed/failed
  extraction_type TEXT NOT NULL,           -- 'claims', 'links', 'contradictions'
  priority INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  processed_at TEXT
);
```

### Cron job addition
Add to the existing `0 1 * * *` cron:
- Process pending extractions from queue
- Extract claims from new entries
- Auto-link new entries to existing corpus
- Check for contradictions with existing entries

**Priority:** High — decouples capture from processing, enables Hermes overnight runs.

---

## 7. Backup/Checkpoint Before Mutation (from TencentDB)

**Current state:** `remember`, `update`, `append` mutate entries directly. No rollback.

**Required changes:**

### Schema — new `entry_snapshots` table
```sql
CREATE TABLE IF NOT EXISTS entry_snapshots (
  id TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL REFERENCES entries(id),
  content TEXT NOT NULL,
  tags TEXT,
  snapshot_type TEXT NOT NULL,  -- 'pre_update', 'pre_merge', 'pre_compress'
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_snapshots_entry ON entry_snapshots(entry_id, created_at);
```

### API change
Before any `update` or compression mutation, create a snapshot row. Add `restore(entry_id, snapshot_id)` MCP tool for rollback.

**Priority:** Medium — safety net for automated mutations.

---

## 8. Pluggable Storage Backends (from MemPalace)

**Current state:** Tightly coupled to D1 + Vectorize. No abstraction layer.

**This is a long-term architectural concern, not a near-term change.** Document the interface but don't implement until there's a concrete second backend.

### Interface sketch
```typescript
interface MemoryStore {
  // CRUD
  put(entry: Entry): Promise<string>;
  get(id: string): Promise<Entry | null>;
  delete(id: string): Promise<void>;  // internal only, never exposed to Hermes
  
  // Search
  vectorSearch(query: string, topK: number, filters: VisibilityFilter): Promise<ScoredEntry[]>;
  keywordSearch(query: string, filters: VisibilityFilter): Promise<ScoredEntry[]>;
  
  // Graph
  getEdges(entryId: string, type?: string): Promise<Edge[]>;
  addEdge(edge: Edge): Promise<void>;
}
```

**Priority:** Low — premature abstraction. Revisit when a second backend is needed.

---

## 9. Query Expansion (from AgeMem)

**Current state:** Single query → recall. No paraphrase expansion.

**Required changes:**

### API — recall path enhancement
Before vector search, generate 2-3 paraphrase variants of the query:
```
original: "how does gradient checkpointing work"
variants: ["activation checkpointing memory tradeoff", "selective recomputation backward pass"]
```

Run all variants through vector search, merge results via RRF.

### Implementation
Use Cloudflare AI `run()` with a small prompt to generate paraphrases:
```
Generate 2 alternative phrasings of this search query for semantic retrieval.
Return only the phrasings, one per line.
```

**Priority:** Medium — improves recall for paraphrase-sensitive queries.

---

## 10. Verbatim Storage (from MemPalace)

**Current state:** Compression summarises entries. Original text is lost.

**Required changes:**

### Compression pipeline change
Instead of replacing entry content with summary:
1. Keep original content in `episodes.raw_content`
2. Set compressed summary as the entry content
3. Link entry to episode via `episode_id`
4. Recall path can return either summary or original based on context

**Priority:** High — prevents information loss, enables citation of original text.

---

## Summary: Change Priority Matrix

| Change | Priority | Effort | Blocks |
|--------|----------|--------|--------|
| Bi-temporal facts (`facts` table) | **Critical** | Medium | Hermes governance |
| Episode-based provenance | **Critical** | Low | Compression safety |
| Evidence passages | **Critical** | Medium | Citable research |
| Typed relations + confidence | **High** | Low | Graph quality |
| Spaced repetition decay | **High** | Low | Memory lifecycle |
| Background extraction queue | **High** | Medium | Hermes overnight runs |
| Verbatim storage | **High** | Low | Compression safety |
| Backup/checkpoint snapshots | **Medium** | Low | Mutation safety |
| Query expansion | **Medium** | Low | Recall quality |
| Pluggable backends | **Low** | High | Future flexibility |

### Recommended implementation order

1. **Episodes + evidence passages** (enables everything else)
2. **Bi-temporal facts** (Graphiti's core pattern)
3. **Typed relations + confidence** (graph quality)
4. **Spaced repetition decay** (memory lifecycle)
5. **Background extraction queue** (Hermes operational)
6. **Backup snapshots** (safety)
7. **Query expansion** (recall quality)
