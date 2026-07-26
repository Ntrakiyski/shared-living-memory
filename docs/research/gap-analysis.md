# Gap Analysis: Competitor Patterns vs. Shared Living Memory Implementation

**Date:** 2026-07-13  
**Source:** `competitor-analysis.md` (13 systems) + `competitor-to-schema-mapping.md` (10 patterns)  
**Codebase baseline:** `src/index.ts` (single-file Worker), D1 + Vectorize + AI bindings

---

## Methodology

Each of the 10 patterns from `competitor-to-schema-mapping.md` is assessed against:
1. Which competitors actually implement it (with specifics)
2. What Shared Living Memory's codebase needs to change (file-level, function-level)
3. Effort estimate
4. Dependencies
5. Impact on memory quality

Effort tiers: **Small** (< 1 day), **Medium** (1–3 days), **Large** (1+ weeks).

---

## Pattern 1: Bi-Temporal Fact Validity

### Competitor implementations

| Competitor | How they do it |
|------------|----------------|
| **Graphiti** | Every edge has `valid_from` / `valid_to` + `created_at` (ingestion time). Old facts are structurally invalidated — never deleted. Query `as_of` any timestamp. |
| **MemPalace** | Knowledge graph entries have `valid_from` / `valid_to`. Temporal proximity boosting in hybrid search ranks recently-valid facts higher. |
| **Honcho** | Representations are time-stamped snapshots but no explicit validity windows. Newer conclusions supersede older ones via the deriver. |
| **AgentMemory** | `supersedes` edges with temporal tracking, but no bi-temporal model (no separation of "when fact was true" vs "when ingested"). |

**Only Graphiti has true bi-temporal separation.** MemPalace comes closest. The rest use simple recency.

### What Shared Living Memory needs to change

**Schema — 3 new columns on `entries` + new `facts` table:**
- `src/db.ts:92–100` — add ALTER TABLE statements for `valid_from`, `valid_to`, `recorded_at` columns on `entries`
- New `facts` table for sub-entry-level claims (each entry can decompose into multiple facts with independent validity)
- `db/schema.sql` — add the table definition

**Capture pipeline — `src/recall.ts` (capture path) / `src/routes.ts`:**
- `captureEntry()` in `src/lifecycle.ts` must set `recorded_at = Date.now()` on every new entry
- The LLM classification step (`classifyEntry()` in `src/classification.ts`) must also extract temporal claims: "X started on Y", "Z ended in Q3" → set `valid_from`/`valid_to` accordingly

**Recall — `src/recall.ts:285–519`:**
- `recallEntries()` gains an optional `as_of` parameter
- When `as_of` is provided, filter entries to those where `valid_from <= as_of AND (valid_to IS NULL OR valid_to >= as_of)`
- Reranking at `recall.ts:63` must incorporate temporal validity: facts valid at `as_of` get full weight, expired facts get reduced weight
- The `temporal_query` MCP tool needs to be added to `src/mcp.ts`

**Cron — `src/lifecycle.ts:281` (`runGraphPass`):**
- Background pass should auto-invalidate facts when contradicting evidence arrives: set `valid_to` on the old fact, create new fact with `valid_from`

### Effort: **Medium** (2–3 days)

### Dependencies
- `episodes` table (Pattern 2) — facts must trace to source episodes
- `evidence_passages` (Pattern 5) — each fact links to `source_passage_id`

### Impact: **Critical**

This is the single highest-value gap. Without bi-temporal validity, Shared Living Memory cannot answer "what did we believe about X at time Y?" — the most common governance query. Graphiti's entire value proposition rests on this.

---

## Pattern 2: Episode-Based Provenance

### Competitor implementations

| Competitor | How they do it |
|------------|----------------|
| **Graphiti** | Episodes are immutable raw data. Every derived fact (entity, relationship) traces back to the episode that produced it via `source_episode_id`. The episode is never mutated. |
| **MemPalace** | Verbatim storage in "drawers" — every memory IS the original text. No compression loss. |
| **memU** | Raw source files copied verbatim into `resource/` directory. |
| **Honcho** | Messages are atomic data units; conclusions trace back to source messages. |
| **AgentMemory** | `derives_from` relation type tracks derivation chains. |

**Graphiti is the gold standard.** Episode = immutable raw source. Derived facts link to episodes. Compression never touches episodes.

### What Shared Living Memory needs to change

**Schema — new `episodes` table + entry linkage:**
- `db/schema.sql` — add `episodes` table (id, source_url, content_hash, raw_content, content_type, ingested_at, ingested_by, owner_user_id)
- `src/db.ts` — add `CREATE TABLE IF NOT EXISTS episodes` to `initializeDatabase()`
- `ALTER TABLE entries ADD COLUMN episode_id TEXT` — link entries to their source episode

**Capture pipeline — `src/lifecycle.ts` capture flow:**
- `captureEntry()` at `lifecycle.ts` must be refactored: before creating the entry, create an `episode` row with the raw content
- The `content_hash` (SHA-256) enables deduplication: if the same raw content is captured twice, link to the existing episode instead of creating a duplicate
- `src/routes.ts` POST /remember handler — pass raw content to episode creation before entry creation

**Compression — `src/lifecycle.ts:163` (`compressTag`):**
- Currently: `compressTag()` replaces entry content with digest text at line 223 (`content = content || ?`)
- Must change: compression overwrites `entries.content` (the derived/summary version) but **never** touches `episodes.raw_content`
- The compressed entry gets `episode_id` pointing to the immutable source
- Recall path can return either the summary or the original based on a `detail` parameter

**Forget — `src/lifecycle.ts:347` (`forgetEntry`):**
- Must cascade-delete episodes OR leave them as orphaned provenance (policy decision)
- Recommended: episodes are never deleted (audit trail), but entry→episode link is severed

### Effort: **Small** (1 day)

### Dependencies
- None — this is foundational. Must be built first.

### Impact: **Critical**

Without episodes, compression is destructive. Every compressed digest loses the original wording, context, and nuance. This is the "information loss" problem the competitor analysis flags. Building episodes first makes all subsequent patterns (facts, evidence passages, verbatim storage) possible.

---

## Pattern 3: Spaced Repetition Decay

### Competitor implementations

| Competitor | How they do it |
|------------|----------------|
| **AgentMemory** | SM-2-inspired retention scoring. `retention_score = e^(-λ × days_since_recall)`. Configurable half-life per memory type. Memories decay unless reinforced. Auto-forget when retention drops below threshold. |
| **AgeMem** | 7-day half-life recency decay. Hybrid scoring: `0.6 × cosine + 0.25 × recency_decay + 0.15 × learning_score`. |
| **Graphiti** | `valid_to` timestamps invalidate facts structurally, but no gradual forgetting curve. |
| **Shared Living Memory (current)** | `getHalfLifeMs()` at `helpers.ts:79` returns fixed half-lives per tag type (7d for tasks, 180d for context, 30d default). `recall_count` incremented on recall but only used as `1 + log1p(rc)` multiplier at `recall.ts:86`. No actual forgetting — memories never lose rank due to irrelevance. |

**The key gap:** Shared Living Memory has time decay in *reranking* but no *retention score* that degrades independently. A memory recalled 100 days ago with high recall_count still scores well. AgentMemory's model would penalize it because it hasn't been recalled *recently*.

### What Shared Living Memory needs to change

**Schema — 3 new columns on `entries`:**
```sql
ALTER TABLE entries ADD COLUMN last_recalled_at INTEGER;
ALTER TABLE entries ADD COLUMN retention_score REAL DEFAULT 1.0;
ALTER TABLE entries ADD COLUMN decay_halflife_days INTEGER DEFAULT 30;
```
- `src/db.ts:92–100` — add ALTER statements

**Recall path — `src/recall.ts:500–509`:**
- Currently: `UPDATE entries SET recall_count = recall_count + 1`
- Must also: `UPDATE entries SET last_recalled_at = ?, retention_score = ?` where retention is recalculated
- `retention_score = Math.exp(-lambda * daysSinceLastRecall)` where `lambda = Math.log(2) / halflife_days`

**Reranking — `src/recall.ts:63` (`rerankWithTimeDecay`):**
- Currently: `recencyMultiplier * frequencyMultiplier` at line 87
- Must add: `retentionScore` as a fourth multiplier
- The `frequencyMultiplier` should be weakened — recall count alone shouldn't override a stale memory

**Cron — `src/lifecycle.ts`:**
- Nightly cron should decay `retention_score` for all entries: `UPDATE entries SET retention_score = retention_score * 0.97` (or recalculate from `last_recalled_at`)
- Entries below a threshold (e.g., 0.1) could be auto-tagged `status:cold` for UI filtering (not auto-deleted)

### Effort: **Small** (1 day)

### Dependencies
- None — can be built independently

### Impact: **High**

This is the difference between a memory system that "forgets" gracefully and one that accumulates forever. Without decay, recall quality degrades as the corpus grows — old irrelevant entries crowd out fresh ones. AgentMemory's core differentiator is this feature.

---

## Pattern 4: Typed Relations with Confidence

### Competitor implementations

| Competitor | How they do it |
|------------|----------------|
| **AgentMemory** | `contradicts`, `supersedes`, `derives_from`, `conflicts_with` — each with confidence 0.0–1.0. Confidence used in retrieval scoring. |
| **Graphiti** | Relationships are typed with `valid_from`/`valid_to`. Entity types are extensible via Pydantic models. |
| **Memori** | Semantic triples (SPO) with type system: entities, actions, events, facts. |
| **Shared Living Memory (current)** | `EDGE_TYPES` at `graph.ts:37` has 7 types: `relates_to`, `supersedes`, `caused_by`, `decided`, `about_person`, `part_of_project`, `follows`. `weight` (REAL, 0–1) exists on edges. No `confidence` column. No `contradicts`, `derives_from`, `supports` types. |

**Key gap:** Shared Living Memory has `weight` but not `confidence`. The distinction matters: `weight` is link strength (how related), `confidence` is certainty (how sure we are about this relationship). Also missing `contradicts` and `derives_from` — the two most important types for a research memory system.

### What Shared Living Memory needs to change

**Schema — `edges` table:**
- `db/schema.sql:39` — add `confidence REAL DEFAULT 1.0` column
- `db/schema.sql:39` — add `valid_from TEXT` and `valid_to TEXT` columns
- `src/db.ts` — add ALTER TABLE for these columns

**Edge type registry — `src/graph.ts:37`:**
- Add to `EDGE_TYPES`:
  ```
  contradicts:    { directed: true,  label: "Contradicts",    allowedKinds: null }
  derives_from:   { directed: true,  label: "Derives from",   allowedKinds: null }
  supports:       { directed: false, label: "Supports",       allowedKinds: null }
  evaluates_on:   { directed: true,  label: "Evaluates on",   allowedKinds: null }
  has_limitation: { directed: true,  label: "Has limitation", allowedKinds: null }
  ```
- This is literally a one-line-per-type change per the architecture docs

**Auto-linking — `src/graph.ts` (`inferEdgesOnWrite`):**
- When cosine similarity produces an edge, set `confidence = (cosine_score - threshold) / (1 - threshold)` normalized to 0–1
- `contradicts` edges must be created during contradiction detection in `src/duplicates.ts:195`

**Contradiction detection — `src/duplicates.ts`:**
- Currently: when `contradicts: true` is detected, it creates a `supersedes` edge at line 217
- Must also create a `contradicts` edge with confidence score, linking the two entries

**Recall scoring — `src/recall.ts` (`rerankWithTimeDecay`):**
- Entries with incoming `contradicts` edges should be penalized (already partially handled via `contradiction_losses`)
- Entries with incoming `derives_from` edges should get a provenance boost (trace back to source)

**MCP tool — `src/mcp.ts`:**
- `link` tool already accepts edge type from `EDGE_TYPES` — adding new types automatically makes them available

### Effort: **Small** (1 day)

### Dependencies
- None — schema changes are additive, code changes are localized

### Impact: **High**

Typed relations make the graph machine-readable, not just human-navigable. `derives_from` enables provenance chains (trace any fact to its source). `contradicts` makes contradiction handling structural instead of just a counter on entries. This is the graph becoming a real knowledge structure.

---

## Pattern 5: Evidence Passages

### Competitor implementations

| Competitor | How they do it |
|------------|----------------|
| **Graphiti** | Raw episodes are the evidence. Every derived fact links to its source episode. |
| **MemPalace** | Verbatim "drawers" — the original text IS the evidence. Section-level granularity. |
| **Technical KB Report** | Recommends passage-level indexing for citable research. |
| **Shared Living Memory (current)** | Entries are flat text blobs. No sub-entry granularity. When recall returns an entry, you get the entire content — no "which 2 sentences support this claim?" |

**The problem:** Shared Living Memory returns entries (which can be paragraphs or pages). There's no way to say "this specific sentence from entry X supports the query." For research use cases, citation requires passage-level granularity.

### What Shared Living Memory needs to change

**Schema — new `evidence_passages` table:**
```sql
CREATE TABLE IF NOT EXISTS evidence_passages (
  id TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL REFERENCES entries(id),
  episode_id TEXT REFERENCES episodes(id),
  passage_text TEXT NOT NULL,
  section_heading TEXT,
  char_offset_start INTEGER,
  char_offset_end INTEGER,
  embedding_id TEXT,
  created_at INTEGER NOT NULL
);
```
- `src/db.ts` — add to `initializeDatabase()`

**Indexing — new pipeline step in `src/lifecycle.ts`:**
- After `captureEntry()`, chunk the entry content into semantic passages (by section heading or paragraph)
- Each passage gets its own Vectorize embedding (stored in `embedding_id`)
- This is separate from the entry-level embedding — passages are finer-grained

**Recall — `src/recall.ts` major refactor:**
- Currently: recall returns entry-level matches with `content` field
- Must add: after finding matching entries, also query `evidence_passages` for the most relevant passage within each matched entry
- Two-phase recall: (1) find relevant entries, (2) find relevant passages within those entries
- The recall response gains a `passage` field: `{ entry_id, passage_text, section_heading, char_offset }`
- `renderRecallText()` at `recall.ts` must format passages with citations

**MCP tool — `src/mcp.ts`:**
- `recall` tool response gains optional `passages` array per match
- New `get_passages(entry_id)` tool for drilling into an entry's passages

**Vectorize — index considerations:**
- Passages need their own vector IDs, separate from entry vectors
- Current Vectorize index may need a second index OR metadata-based partitioning
- Batch embedding of passages: an entry with 5 paragraphs = 5 additional vector inserts

### Effort: **Large** (1+ weeks)

### Dependencies
- `episodes` table (Pattern 2) — passages link to episodes
- Significant refactor of the recall pipeline

### Impact: **Critical for citable research**

Without passage-level evidence, every claim in Shared Living Memory is "trust me." With it, the system can say "this claim is supported by lines 42–47 of the source paper." This is the difference between a note-taking app and a research tool.

---

## Pattern 6: Background Reasoning Pipeline

### Competitor implementations

| Competitor | How they do it |
|------------|----------------|
| **Honcho** | Background "deriver" worker extracts conclusions from conversations asynchronously. Representations are pre-computed snapshots. Two services: Storage (API) + Insights (async reasoning). |
| **Graphiti** | Episode ingestion triggers background entity/relationship extraction. |
| **AgentMemory** | LLM-driven consolidation runs in background (L0→L1→L2). |
| **Shared Living Memory (current)** | All processing is either synchronous in request handlers OR via `ctx.waitUntil()` in the cron handler at `index.ts:206`. The nightly cron at `0 1 * * *` runs compression + graph pass + integration sync. No queue-based processing. |

**The problem:** `ctx.waitUntil()` has a ~30 second timeout on Workers. Complex extraction (contradiction detection, claim extraction, auto-linking) can exceed this. There's no retry mechanism, no priority queue, no dead-letter handling.

### What Shared Living Memory needs to change

**Schema — new `extraction_queue` table:**
```sql
CREATE TABLE IF NOT EXISTS extraction_queue (
  id TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL REFERENCES entries(id),
  status TEXT NOT NULL DEFAULT 'pending',
  extraction_type TEXT NOT NULL,
  priority INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  processed_at INTEGER
);
```

**Capture pipeline — `src/lifecycle.ts`:**
- `captureEntry()` must enqueue extraction jobs instead of doing them inline
- Currently, contradiction detection + auto-linking + classification happen during capture via `ctx.waitUntil()`
- Change: write to `extraction_queue` and let the cron process them

**Cron — `src/lifecycle.ts:233` (`runNightlyCompression`):**
- Expand to process extraction queue: `SELECT * FROM extraction_queue WHERE status = 'pending' ORDER BY priority DESC LIMIT 50`
- Process each: extract claims, check contradictions, auto-link, set `status = 'completed'`
- Failed jobs get `status = 'failed'` with retry count

**MCP tool — `src/mcp.ts`:**
- New `process_queue` tool for manual trigger (not just cron)

**Operational concern:** The extraction queue is D1-based. On Cloudflare Workers, D1 is not a message queue — it's a database. For high throughput, consider Cloudflare Queues (a real message queue) as an alternative. D1-based queue is fine for current scale (< 1000 entries/day).

### Effort: **Medium** (2–3 days)

### Dependencies
- None — can be built independently

### Impact: **High**

This decouples capture from processing. Currently, if capture takes too long (LLM calls for classification + contradiction detection + auto-linking), the user waits. With a queue, capture is instant and processing happens in the background. This is especially important for Hermes (overnight batch runs).

---

## Pattern 7: Backup/Checkpoint Before Mutation

### Competitor implementations

| Competitor | How they do it |
|------------|----------------|
| **TencentDB** | Every scene extraction creates a backup before mutation. If extraction fails, roll back to previous state. |
| **beads** | Dolt provides git-like snapshots — every change is atomic and revertable. |
| **MemPalace** | Verbatim storage means no mutation — originals are never changed. |
| **Shared Living Memory (current)** | `remember`, `update`, `append` mutate entries directly. `compressTag()` at `lifecycle.ts:163` overwrites content with digest. No rollback capability. |

### What Shared Living Memory needs to change

**Schema — new `entry_snapshots` table:**
```sql
CREATE TABLE IF NOT EXISTS entry_snapshots (
  id TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL,
  content TEXT NOT NULL,
  tags TEXT,
  snapshot_type TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
```

**Mutation points — 3 locations:**
1. `src/lifecycle.ts:163` (`compressTag`) — snapshot before line 223 overwrites content
2. `src/routes.ts` `update` handler — snapshot before any content replacement
3. `src/lifecycle.ts` `applyStatus` — snapshot before status change

**New function — `src/lifecycle.ts`:**
```typescript
async function snapshotEntry(entryId: string, snapshotType: string, env: Env): Promise<void>
```

**New MCP tool — `src/mcp.ts`:**
- `restore(entry_id, snapshot_id)` — revert entry to a previous snapshot

### Effort: **Small** (0.5 days)

### Dependencies
- None

### Impact: **Medium**

Safety net for automated mutations. Low probability of use but high value when needed (e.g., compression produces garbage, batch update goes wrong). This is defensive infrastructure — you don't need it until you desperately do.

---

## Pattern 8: Pluggable Storage Backends

### Competitor implementations

| Competitor | How they do it |
|------------|----------------|
| **MemPalace** | Pluggable backends: ChromaDB, Milvus, Qdrant, pgvector, sqlite. `MemoryStore` interface. |
| **Graphiti** | Pluggable graph backends: Neo4j, FalkorDB, Neptune, Kuzu. |
| **Shared Living Memory (current)** | Tightly coupled to D1 + Vectorize. Every query uses `env.DB.prepare()` and `env.VECTORIZE.query()` directly. No abstraction layer. |

### What Shared Living Memory needs to change

- Define `MemoryStore` interface (as sketched in `competitor-to-schema-mapping.md`)
- Wrap all D1/Vectorize calls behind this interface
- Current codebase has ~40+ direct `env.DB.prepare()` calls across `recall.ts`, `lifecycle.ts`, `graph.ts`, `db.ts`, `routes.ts`

### Effort: **Large** (2+ weeks)

### Dependencies
- Should wait until the codebase stabilizes after other pattern implementations

### Impact: **Low** (for current scale)

Premature abstraction. Shared Living Memory runs on Cloudflare with D1 + Vectorize — there's no second backend to support. Document the interface for future reference but don't implement until there's a concrete reason (e.g., migrating to a different platform, adding a local-only mode).

---

## Pattern 9: Query Expansion

### Competitor implementations

| Competitor | How they do it |
|------------|----------------|
| **AgeMem** | Generates paraphrase variants of the query before search. "how does gradient checkpointing work" → ["activation checkpointing memory tradeoff", "selective recomputation backward pass"]. All variants searched, results merged via RRF. |
| **MemPalace** | Hybrid v4 with keyword boosting + temporal proximity. |
| **Shared Living Memory (current)** | Single query → embed → vector search → keyword search → RRF fuse. No paraphrase expansion. `tokenizeQuery()` at `helpers.ts:107` splits into tokens but doesn't generate alternatives. |

### What Shared Living Memory needs to change

**Recall — `src/recall.ts:296–309`:**
- Before embedding, call Cloudflare AI to generate 2–3 paraphrase variants:
  ```
  const variants = await generateParaphrases(query, env);
  const allQueries = [query, ...variants];
  ```
- Embed all variants in parallel: `Promise.all(allQueries.map(q => embed(q, env)))`
- Run vector search for each variant, merge results via RRF
- This adds 2–3 additional AI calls per recall (latency concern)

**Optimization — don't expand for simple queries:**
- Short queries (< 5 words) benefit most from expansion
- Queries with technical terms (e.g., "D1 batch binding limit") may not benefit
- Add a heuristic: skip expansion if query contains code-like tokens

**Latency mitigation:**
- Run variant embeddings in parallel with the primary embedding
- Cache paraphrases for common query patterns (KV-based)

### Effort: **Small** (1 day)

### Dependencies
- None

### Impact: **Medium**

Improves recall for paraphrase-sensitive queries. Diminishing returns for well-phrased queries. Worth building but not critical — the existing RRF fusion already handles keyword vs. semantic gaps.

---

## Pattern 10: Verbatim Storage

### Competitor implementations

| Competitor | How they do it |
|------------|----------------|
| **MemPalace** | All memories stored verbatim — no summarization. 96.6% R@5 without LLM. |
| **memU** | Raw source files copied verbatim into `resource/`. |
| **Shared Living Memory (current)** | `compressTag()` at `lifecycle.ts:163` replaces entry content with LLM-generated digest. Original text is lost. Tags get `rolled-up` appended. |

### What Shared Living Memory needs to change

This pattern is **fully subsumed by Pattern 2 (Episodes)**. Once episodes exist:
1. `episodes.raw_content` = immutable original (verbatim)
2. `entries.content` = summary/digest (derived)
3. Recall can return either based on context

**No additional schema or API changes needed beyond Pattern 2.**

**Compression change — `src/lifecycle.ts:213`:**
- Currently: `[Synthesized from ${rows.length} entries...]\n\n${text}` → replaces content
- After episodes: same content, but entry now has `episode_id` linking to the immutable source
- Recall path adds a `detail: "summary" | "original"` parameter

### Effort: **Small** (included in Pattern 2)

### Dependencies
- `episodes` table (Pattern 2)

### Impact: **High** (when combined with Pattern 2)

Without episodes, verbatim storage is impossible — compression is destructive. With episodes, it's automatic.

---

## Prioritized Implementation Roadmap

### Phase 1: Foundation (Days 1–3) — Episodes + Verbatim + Decay

These are independent, low-risk changes that unlock everything else.

| Order | Pattern | Effort | Why first |
|-------|---------|--------|-----------|
| 1a | **Episodes** (Pattern 2) | 1 day | Foundational. Makes compression non-destructive. Enables facts, evidence, verbatim. |
| 1b | **Spaced Repetition Decay** (Pattern 3) | 1 day | Independent. 3 schema columns + recall path change. Immediate memory quality improvement. |
| 1c | **Backup Snapshots** (Pattern 7) | 0.5 day | Independent. Safety net before Phase 2 changes anything. |
| 1d | **Typed Relations** (Pattern 4) | 1 day | Independent. One-line-per-type registry change + schema. Immediate graph quality improvement. |

**Concrete steps for Phase 1:**

```
Day 1 (Episodes):
  1. db/schema.sql — add episodes table
  2. src/db.ts initializeDatabase() — CREATE TABLE IF NOT EXISTS episodes
  3. src/db.ts initializeDatabase() — ALTER TABLE entries ADD COLUMN episode_id
  4. src/lifecycle.ts captureEntry() — create episode row before entry row
  5. src/lifecycle.ts compressTag() — verify episode is never touched
  6. src/lifecycle.ts forgetEntry() — cascade or orphan episodes
  7. Tests: test/unit/episodes.test.ts

Day 2 (Decay + Snapshots):
  1. src/db.ts — ALTER TABLE entries ADD COLUMN last_recalled_at, retention_score, decay_halflife_days
  2. src/recall.ts recallEntries() — update last_recalled_at on recall
  3. src/recall.ts rerankWithTimeDecay() — add retentionScore multiplier
  4. src/lifecycle.ts — snapshotEntry() function
  5. src/lifecycle.ts compressTag() — snapshot before mutation
  6. Tests: test/unit/decay.test.ts, test/unit/snapshots.test.ts

Day 3 (Typed Relations):
  1. src/db.ts — ALTER TABLE edges ADD COLUMN confidence, valid_from, valid_to
  2. src/graph.ts EDGE_TYPES — add contradicts, derives_from, supports
  3. src/duplicates.ts — create contradicts edges during detection
  4. src/graph.ts inferEdgesOnWrite() — set confidence from cosine score
  5. Tests: test/unit/typed-relations.test.ts
```

### Phase 2: Processing Infrastructure (Days 4–6) — Queue + Query Expansion

| Order | Pattern | Effort | Why second |
|-------|---------|--------|------------|
| 2a | **Background Queue** (Pattern 6) | 2–3 days | Decouples capture from processing. Enables overnight batch runs. |
| 2b | **Query Expansion** (Pattern 9) | 1 day | Independent. Low risk, moderate recall improvement. |

**Concrete steps for Phase 2:**

```
Day 4–5 (Background Queue):
  1. db/schema.sql — add extraction_queue table
  2. src/db.ts — CREATE TABLE IF NOT EXISTS extraction_queue
  3. src/lifecycle.ts captureEntry() — enqueue extraction jobs
  4. src/lifecycle.ts — processExtractionQueue() function
  5. src/index.ts scheduled handler — add queue processing to cron
  6. src/mcp.ts — process_queue tool
  7. Migrate existing inline processing from captureEntry() to queue
  8. Tests: test/unit/extraction-queue.test.ts

Day 6 (Query Expansion):
  1. src/helpers.ts — generateParaphrases() function
  2. src/recall.ts recallEntries() — expand query before embed
  3. src/recall.ts — RRF merge across variants
  4. Tests: test/unit/query-expansion.test.ts
```

### Phase 3: High-Value Complex Patterns (Days 7–14) — Facts + Evidence

These require Phase 1 (episodes) to exist.

| Order | Pattern | Effort | Why third |
|-------|---------|--------|------------|
| 3a | **Bi-Temporal Facts** (Pattern 1) | 2–3 days | Requires episodes. Highest-value governance feature. |
| 3b | **Evidence Passages** (Pattern 5) | 1+ week | Requires episodes. Major recall pipeline refactor. |

**Concrete steps for Phase 3:**

```
Day 7–9 (Bi-Temporal Facts):
  1. db/schema.sql — add facts table
  2. src/db.ts — CREATE TABLE IF NOT EXISTS facts
  3. src/classification.ts — extract temporal claims during classification
  4. src/mcp.ts — temporal_query tool
  5. src/recall.ts — as_of parameter, temporal filtering
  6. src/recall.ts rerankWithTimeDecay() — temporal validity multiplier
  7. src/lifecycle.ts runGraphPass() — auto-invalidate contradicting facts
  8. Tests: test/unit/temporal-facts.test.ts

Day 10–14 (Evidence Passages):
  1. db/schema.sql — add evidence_passages table
  2. src/db.ts — CREATE TABLE IF NOT EXISTS evidence_passages
  3. src/lifecycle.ts — passage chunking pipeline (split entry into sections)
  4. src/lifecycle.ts — passage embedding (separate vector per passage)
  5. src/recall.ts — two-phase recall (entries → passages within entries)
  6. src/recall.ts renderRecallText() — format with citations
  7. src/mcp.ts — recall response gains passages array
  8. Vectorize considerations — second index or metadata partitioning
  9. Tests: test/unit/evidence-passages.test.ts
```

### Phase 4: Skip (For Now)

| Pattern | Effort | Reason to skip |
|---------|--------|----------------|
| **Pluggable Backends** (Pattern 8) | 2+ weeks | Premature abstraction. No second backend needed. |

---

## Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|------------|
| D1 schema migration fails on existing data | High | All ALTERs use `ADD COLUMN` with defaults — idempotent, safe |
| Vectorize index overflow from passage embeddings | Medium | Use batch inserts, monitor index size. Can create second index if needed |
| Extraction queue grows unbounded | Medium | Bounded batch processing (50/cron run), TTL cleanup for failed jobs |
| Query expansion adds latency to recall | Low | Run paraphrases in parallel, skip for short queries |
| Episode storage increases D1 row size | Low | `raw_content` can be truncated or stored in R2 for large inputs |

---

## What Shared Living Memory Already Does Better Than Competitors

Before building anything, acknowledge what's already ahead:

1. **Multi-user auth with visibility enforcement** — no competitor has this
2. **Contradiction detection with structural resolution** — only AgentMemory comes close
3. **Auto-linking between related memories** — most competitors require manual linking
4. **Compression pipeline with eligibility guards** — most competitors have no compression
5. **Pattern derivation across memories** — unique to Shared Living Memory
6. **Graph expansion in recall (BFS)** — most competitors do flat retrieval
7. **RRF fusion (dense + keyword)** — production-quality hybrid search
8. **Importance scoring with contradiction adjustment** — adaptive, not static
9. **Status lifecycle (canonical/draft/deprecated)** — structured memory lifecycle

The gaps are real but the foundation is strong. Phase 1 alone (3 days) closes the most critical gaps (episodes, decay, typed relations) and puts Shared Living Memory ahead of every competitor on the feature matrix.
