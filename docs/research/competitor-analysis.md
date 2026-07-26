# Competitor Analysis — Shared Living Memory / Living Knowledge Organism

**Date:** 2026-07-13  
**Scope:** 13 open-source memory systems for AI agents  
**Purpose:** Extract architectural patterns, design principles, and implementation lessons for Hermes

---

## 1. Graphiti (Zep)

**Repo:** `getzep/graphiti` · **Lang:** Python · **Backend:** Neo4j/FalkorDB/Neptune/Kuzu · **License:** Apache 2.0

### Architecture
Temporal context graph engine. Nodes = entities (people, products, policies), edges = facts with validity windows, episodes = raw data provenance. Every derived fact traces back to source episodes.

### Memory Model
- **Entities** (nodes): Evolving summaries, custom types via Pydantic models
- **Facts** (edges): Triplets `Entity → Relationship → Entity` with `valid_from` / `valid_to` temporal windows
- **Episodes**: Raw ingested data, immutable provenance stream
- **Communities**: Entity clusters with community summaries

### Retrieval
Hybrid: semantic embeddings + BM25 keyword + graph traversal. Cross-encoder reranking (OpenAI, Gemini, or local). Sub-second latency.

### Provenance
First-class. Every entity and relationship traces back to the episodes that produced it. Full lineage from derived fact to source.

### Temporal Handling
**Best-in-class.** Bi-temporal tracking: fact validity windows (`valid_from`/`valid_to`) + ingestion timestamps. Old facts are invalidated, not deleted. Query what's true now or what was true at any point in time.

### Conflict Resolution
Automatic fact invalidation with temporal history preserved. When new data contradicts existing facts, old facts get `valid_to` timestamps. No LLM summarization judgments — structural invalidation.

### Key Patterns Worth Adopting
- **Bi-temporal fact validity** — the `valid_from`/`valid_to` pattern is the gold standard for temporal knowledge
- **Episode-based provenance** — raw data preserved as immutable ground truth
- **Pluggable graph backends** — Neo4j, FalkorDB, Neptune, Kuzu abstraction
- **Prescribed + learned ontology** — Pydantic models for structure, emergence for flexibility

### Gaps / Anti-Patterns
- Heavy infrastructure dependency (Neo4j or equivalent)
- No multi-user isolation built in (group_id partitioning only)
- No compression/consolidation lifecycle
- OpenAI-centric defaults (other providers require extra config)

---

## 2. Hindsight

**Repo:** `hindsight-memory/hindsight` · **Lang:** Python · **Backend:** PostgreSQL + pgvector · **License:** AGPL-3.0

### Architecture
Memory engine with three-layer architecture: temporal + semantic + entity memory. Server-based (FastAPI) with embedded PostgreSQL. MCP endpoint at `/mcp`.

### Memory Model
- **Memory banks**: Isolated per-agent memory stores
- **Temporal memory**: Time-indexed facts with recency tracking
- **Semantic memory**: Vector-embedded facts for similarity search
- **Entity memory**: Tracked entities with relationships
- **Disposition traits**: Configurable personality/opinion formation

### Retrieval
Vector similarity search via pgvector. Temporal filtering ("what happened last spring?"). Entity-based retrieval.

### Provenance
Facts linked to their source memory bank. Temporal indexing provides basic provenance.

### Temporal Handling
Temporal reasoning capability — can answer time-scoped queries. Recency tracking on memories.

### Conflict Resolution
Basic — newer memories can override older ones. Disposition traits influence how conflicting information is weighted.

### Key Patterns Worth Adopting
- **Memory bank isolation** — per-agent memory scoping
- **Disposition traits** — configurable personality that influences memory interpretation
- **Embedded PostgreSQL** — zero-config local deployment
- **`reflect()` endpoint** — reasoning over stored memories, not just retrieval

### Gaps / Anti-Patterns
- No explicit contradiction detection or resolution pipeline
- No compression/consolidation lifecycle
- No graph relationships between memories
- Limited provenance beyond temporal indexing

---

## 3. AgentMemory

**Repo:** `agentmemory/agentmemory` · **Lang:** TypeScript · **Backend:** In-memory + SQLite · **License:** MIT

### Architecture
Most feature-rich memory system analyzed. 3-tier consolidation pipeline (L0→L1→L2), retention scoring with spaced repetition, auto-forget with TTL and contradiction detection, relation graph with confidence scoring.

### Memory Model
- **L0 (Working)**: Raw memories, newest, highest fidelity
- **L1 (Recent)**: Promoted from L0, slightly compressed
- **L2 (Archive)**: Heavily compressed, lowest access frequency
- **Relations**: `supersedes`, `contradicts`, `related`, `derives_from`, `conflicts_with` — each with confidence scores
- **SemanticMemory / ProceduralMemory**: Typed memory categories

### Retrieval
Vector similarity search with confidence-weighted scoring. Retention scoring uses spaced repetition decay (SM-2 inspired). Hot/warm/cold tiering.

### Provenance
Relation graph tracks derivation chains (`derives_from`). Confidence scores on all relations.

### Temporal Handling
Spaced repetition decay model — memories decay over time unless reinforced by recall. TTL-based expiry. Half-life configurable per memory type.

### Conflict Resolution
**Sophisticated.** `contradicts` and `conflicts_with` relation types. Auto-forget detects contradictions and marks conflicting memories. `supersedes` edges for explicit versioning.

### Key Patterns Worth Adopting
- **Spaced repetition decay** — `retention.ts` implements a proper forgetting curve
- **3-tier consolidation** — L0→L1→L2 with LLM-driven compression
- **Typed relations with confidence** — not just "related" but `contradicts`, `supersedes`, `derives_from`
- **Auto-forget with contradiction detection** — proactive memory hygiene

### Gaps / Anti-Patterns
- In-memory storage (not persistent by default)
- No multi-user support
- No graph traversal for recall
- LLM-heavy consolidation (cost concern at scale)

---

## 4. TencentDB-Agent-Memory

**Repo:** `TencentDB-Agent-Memory` · **Lang:** TypeScript · **Backend:** File-based + Mermaid diagrams · **License:** MIT

### Architecture
Dual-layer: symbolic short-term (Mermaid flowcharts) + layered long-term (persona + scene). Host-neutral design via `HostAdapter` interface — works with any LLM agent runtime.

### Memory Model
- **Short-term**: Mermaid diagram snapshots (visual + parseable)
- **Long-term Persona**: 4-layer deep scan for user modeling
- **Long-term Scene**: LLM-driven extraction of scene blocks from conversations
- **Backup/checkpoint**: Every scene extraction creates a backup before mutation

### Retrieval
Scene-based — retrieve relevant scenes for current context. Persona lookup for user preferences.

### Provenance
Scene extraction tracks source conversations. Backup system provides rollback capability.

### Temporal Handling
Scene blocks have temporal ordering from source conversations. Persona evolves over time through deep scans.

### Conflict Resolution
Backup/checkpoint before every scene extraction. If extraction fails or produces bad results, roll back to previous state.

### Key Patterns Worth Adopting
- **Host-neutral architecture** — `HostAdapter` pattern for framework-agnostic integration
- **Backup/checkpoint before mutation** — defensive memory writes
- **Mermaid for short-term** — visual, parseable, human-readable
- **61% token reduction** claimed through scene-based compression

### Gaps / Anti-Patterns
- Mermaid diagrams are fragile for complex knowledge
- No vector search or semantic retrieval
- No provenance chain beyond backup snapshots
- Limited scalability (file-based)

---

## 5. Memori

**Repo:** `getzep/memori` (or similar) · **Lang:** Python · **Backend:** Cloud API + local embedding · **License:** MIT

### Architecture
Graph-based memory with entity extraction, semantic triples, and scene/event/fact modeling. Cloud recall API with cosine similarity search.

### Memory Model
- **Conversation**: Full conversation storage
- **Entity**: Named entities with types
- **SemanticTriple**: Subject-Predicate-Object triples
- **Action**: User/agent actions
- **Scene**: Temporal scenes
- **Event**: Discrete events
- **Fact**: Extracted facts
- **Agent**: Agent identity modeling

### Retrieval
Cloud recall API with `rank_score` (cosine similarity). Embedding-based search with configurable threshold.

### Provenance
Triple-based provenance — each fact traces to its source conversation and extraction context.

### Temporal Handling
Scene-based temporal ordering. Events have timestamps.

### Conflict Resolution
Basic — newer facts can override older ones based on `rank_score`.

### Key Patterns Worth Adopting
- **Semantic triples (SPO)** — structured fact representation
- **Multi-type memory model** — not just "memories" but typed entities, actions, events, facts
- **Cloud recall with rank scoring** — production-ready retrieval

### Gaps / Anti-Patterns
- Cloud dependency (API-based)
- No temporal validity windows
- No contradiction detection
- No compression/consolidation

---

## 6. A-Mem (Agentic Memory)

**Repo:** `agiresearch/A-mem` · **Lang:** Python · **Backend:** ChromaDB · **License:** MIT

### Architecture
Zettelkasten-inspired dynamic memory organization. LLM-driven evolution decisions. ChromaDB for vector storage. Memories are "notes" that evolve through agent-driven operations.

### Memory Model
- **MemoryNote**: Content + keywords + context + tags + links + evolution_history
- **Links**: Explicit connections between memories (like Zettelkasten links)
- **Evolution history**: Track how memories change over time

### Retrieval
ChromaDB semantic search. Linked memories retrieved as neighbors. Hybrid search combining vector similarity with link traversal.

### Provenance
Evolution history tracks all changes. Timestamp-based creation and access tracking.

### Temporal Handling
Timestamps on creation and last access. No explicit temporal validity or decay.

### Conflict Resolution
LLM-driven evolution decisions — the agent decides whether to strengthen connections, update neighbors, or evolve the memory graph. No automatic contradiction detection.

### Key Patterns Worth Adopting
- **Zettelkasten-inspired linking** — explicit memory connections like a personal wiki
- **Agent-driven evolution** — the agent decides how to organize its own memory
- **Evolution history** — full audit trail of memory changes

### Gaps / Anti-Patterns
- LLM cost on every memory addition (evolution decisions)
- No temporal decay or forgetting
- No contradiction detection
- ChromaDB-only (no backend flexibility)

---

## 7. AgeMem

**Repo:** `agemem/agemem` · **Lang:** Python · **Backend:** sqlite-vec + JSON · **License:** MIT

### Architecture
Hybrid STM/LTM (Short-Term Memory / Long-Term Memory) system. Three-layer control: deterministic rules + LLM-driven memory agent + self-assessed learning scores. Privacy-first, runs locally.

### Memory Model
- **STM**: Active context window, managed with token budgets
- **LTM**: Persistent store of high-value facts, promoted from STM
- **Learning scores**: Self-assessed 0–1 novelty rating after every N turns

### Retrieval
Hybrid scoring: `0.6 × cosine_similarity + 0.25 × recency_decay + 0.15 × learning_score`. Query expansion with paraphrase variants.

### Provenance
Learning scores provide salience provenance. Recency decay tracks temporal relevance.

### Temporal Handling
Recency decay with 7-day half-life. STM has hard token limits with force-fit eviction.

### Conflict Resolution
Semantic deduplication via Jaccard similarity (0.70 threshold) or cosine similarity (0.92 threshold). No explicit contradiction handling.

### Key Patterns Worth Adopting
- **Self-assessed learning scores** — the agent rates its own output novelty
- **Hybrid retrieval scoring** — semantic + recency + learning signal
- **Dual overflow guard** — enforce token limits at both message boundaries
- **Query expansion** — paraphrase variants for better recall

### Gaps / Anti-Patterns
- No contradiction detection
- No graph relationships
- No compression/consolidation lifecycle
- Privacy-first means no multi-user

---

## 8. Honcho

**Repo:** `plastic-labs/honcho` · **Lang:** Python (FastAPI) · **Backend:** PostgreSQL + pgvector · **License:** AGPL-3.0

### Architecture
Peer-centric memory infrastructure. Background "deriver" worker extracts conclusions from conversations. Two services: Storage (API) + Insights (async reasoning). MCP server for agent integration.

### Memory Model
- **Peers**: Humans and AI agents as first-class entities
- **Sessions**: Conversations with many-to-many peer relationships
- **Messages**: Atomic data units on sessions
- **Conclusions**: Extracted facts about peers (deductive + inductive)
- **Representations**: Static snapshots of what Honcho knows about a peer
- **Peer Cards**: Compact identity summaries

### Retrieval
Hybrid search (BM25 + vector). Chat endpoint for natural-language queries. Context endpoint for prompt-ready bundles. Representation endpoint for low-latency static snapshots.

### Provenance
Conclusions trace back to source messages. Representations are session-scoped snapshots.

### Temporal Handling
Background reasoning processes messages asynchronously. Representations are time-stamped snapshots. No explicit temporal validity windows.

### Conflict Resolution
Background deriver handles evolving conclusions. Newer conclusions can supersede older ones through the reasoning pipeline.

### Key Patterns Worth Adopting
- **Peer-centric model** — humans and agents as equal entities
- **Background reasoning pipeline** — async extraction, not inline
- **Conclusions API** — structured extraction from conversations
- **Representations** — low-latency pre-computed snapshots
- **Multi-peer perspective** — modeling what one peer knows about another

### Gaps / Anti-Patterns
- Heavy infrastructure (PostgreSQL, background workers)
- No explicit contradiction detection
- No temporal validity windows
- No graph relationships between conclusions
- Cloud dependency for managed service

---

## 9. MemPalace

**Repo:** `MemPalace/mempalace` · **Lang:** Python · **Backend:** ChromaDB (pluggable) · **License:** MIT

### Architecture
Verbatim storage with semantic search. Structured index (wings → rooms → drawers). Pluggable backends (ChromaDB, Milvus, Qdrant, pgvector, sqlite). Temporal knowledge graph via SQLite. 96.6% R@5 on LongMemEval without LLM.

### Memory Model
- **Wings**: People and projects (top-level organization)
- **Rooms**: Topics within wings
- **Drawers**: Original verbatim content
- **Knowledge Graph**: Temporal entity-relationship graph with validity windows
- **Agent Diaries**: Per-agent memory logs

### Retrieval
Semantic search (ChromaDB default). Hybrid v4 with keyword boosting + temporal proximity + preference patterns. LLM rerank optional (≥99% R@5).

### Provenance
Verbatim storage means 100% provenance — every memory is the original text. Knowledge graph links facts back to source drawers.

### Temporal Handling
Knowledge graph has `valid_from` / `valid_to` temporal windows. Temporal proximity boosting in hybrid search.

### Conflict Resolution
Basic — newer facts can override older ones via knowledge graph invalidation.

### Key Patterns Worth Adopting
- **Verbatim storage** — no information loss from summarization
- **Palace metaphor** — wings/rooms/drawers for human-navigable organization
- **Pluggable backends** — ChromaDB, Milvus, Qdrant, pgvector, sqlite
- **Knowledge graph with temporal validity** — local SQLite, no cloud dependency
- **96.6% R@5 without LLM** — proves retrieval quality without LLM dependency

### Gaps / Anti-Patterns
- No contradiction detection pipeline
- No compression/consolidation lifecycle
- No auto-linking between related memories
- Knowledge graph is add-on, not integrated into core retrieval

---

## 10. beads

**Repo:** `beads` · **Lang:** Go · **Backend:** Dolt (git-for-data) · **License:** MIT

### Architecture
Distributed graph issue tracker with tiered compaction. Dolt provides snapshot-based version history. Tiered compaction summarizes old issues into higher-level views.

### Memory Model
- **Issues**: Atomic work items with relationships
- **Graph edges**: Typed relationships between issues
- **Snapshots**: Dolt-provided version history
- **Compacted tiers**: Summarized views of old issues

### Retrieval
Graph traversal + text search. Compacted tiers provide pre-summarized views.

### Provenance
Dolt snapshots provide full version history. Every change is tracked.

### Temporal Handling
Dolt's git-like branching provides temporal snapshots. Compaction summarizes old tiers.

### Conflict Resolution
Dolt's merge semantics handle concurrent edits. Compaction resolves old conflicts by summarization.

### Key Patterns Worth Adopting
- **Dolt for version history** — git-for-data provides atomic snapshots
- **Tiered compaction** — L0→L1→L2 summarization with AI
- **Graph-native relationships** — edges are first-class

### Gaps / Anti-Patterns
- Designed for issue tracking, not general memory
- Go ecosystem (different from our TypeScript)
- Heavy infrastructure dependency (Dolt)
- No vector search or semantic retrieval

---

## 11. memU

**Repo:** `NevaMind-AI/memU` · **Lang:** Rust (core) + Python · **Backend:** File-based (Markdown) · **License:** Apache 2.0

### Architecture
Compiles conversations into human-readable Markdown files (INDEX.md, MEMORY.md, SKILL.md). Three layers: Index (map), Memory (facts/preferences/goals), Skill (learned patterns). Agent traverses tree to load only what's needed.

### Memory Model
- **INDEX.md**: Map of everything — raw sources and summaries
- **MEMORY.md**: Personal facts, preferences, goals, events
- **SKILL.md**: Auto-extracted patterns from agent traces
- **resource/**: Raw source files, copied verbatim
- **memory/**: One file per topic
- **skill/**: One file per learned pattern

### Retrieval
Tree traversal — walk to the right folder and rank the right files. No vector search by default (optional embedding layer).

### Provenance
Verbatim resource files preserved. Every memory traces back to source conversations.

### Temporal Handling
File timestamps. No explicit temporal validity or decay.

### Conflict Resolution
No explicit contradiction handling. Newer files can overwrite older ones.

### Key Patterns Worth Adopting
- **Human-readable Markdown** — inspectable, editable, auditable
- **Three-layer structure** — Index/Memory/Skill separation
- **Tree traversal retrieval** — scoped, not flat
- **Rust core** — performance for large workspaces

### Gaps / Anti-Patterns
- No vector search or semantic retrieval (by default)
- No contradiction detection
- No temporal validity or decay
- File-based (scaling concerns)

---

## 12. byterover-cli

**Repo:** `byterover-cli` · **Lang:** TypeScript · **Backend:** Local files + web dashboard · **License:** MIT

### Architecture
Context tree + knowledge storage. Web dashboard for visualization. Agentic map for navigation. MCP-compatible.

### Memory Model
- **Context tree**: Hierarchical knowledge organization
- **Knowledge storage**: Persistent local storage
- **Agentic map**: Navigation layer for agents

### Retrieval
Tree-based navigation with semantic search.

### Provenance
Context tree tracks source locations.

### Temporal Handling
Basic timestamps. No explicit temporal modeling.

### Conflict Resolution
Not documented.

### Key Patterns Worth Adopting
- **Web dashboard** — visual knowledge exploration
- **MCP compatibility** — agent-tool integration

### Gaps / Anti-Patterns
- Limited documentation
- No contradiction detection
- No temporal modeling
- No provenance chain

---

## 13. Agent-S

**Repo:** `THUDM/Agent-S` · **Lang:** Python · **Backend:** N/A (GUI agent) · **License:** Apache 2.0

### Architecture
GUI agent framework with S1/S2/S3 pipeline stages. NOT a memory system — it's a computer-use agent that interacts with desktop GUIs.

### Memory Model
None — operates on current screen state, not persistent memory.

### Retrieval
N/A — real-time GUI interaction, not memory retrieval.

### Key Patterns Worth Adopting
None for memory — relevant only if building GUI automation agents.

### Gaps / Anti-Patterns
Not a memory system. Misclassified as a competitor.

---

## Cross-Cutting Analysis

### Patterns Worth Adopting for Hermes

| Pattern | Source | Priority |
|---------|--------|----------|
| Bi-temporal fact validity (`valid_from`/`valid_to`) | Graphiti, MemPalace | **Critical** |
| Episode-based provenance (raw data preserved) | Graphiti | **Critical** |
| Spaced repetition decay / forgetting curve | AgentMemory | **High** |
| Typed relations with confidence scores | AgentMemory | **High** |
| Background reasoning pipeline (async extraction) | Honcho | **High** |
| Peer-centric multi-user model | Honcho | **High** |
| Backup/checkpoint before memory mutation | TencentDB | **High** |
| Pluggable storage backends | MemPalace | **Medium** |
| Zettelkasten-inspired explicit linking | A-Mem | **Medium** |
| Self-assessed learning scores | AgeMem | **Medium** |
| Human-readable Markdown storage | memU | **Medium** |
| Tiered compaction (L0→L1→L2) | AgentMemory, beads | **Medium** |
| Host-neutral adapter pattern | TencentDB | **Low** |
| Verbatim storage (no summarization loss) | MemPalace | **Low** |

### Anti-Patterns to Avoid

| Anti-Pattern | Where Seen | Why Avoid |
|--------------|------------|-----------|
| LLM on every memory operation | A-Mem, AgentMemory | Cost prohibitive at scale |
| Cloud-only architecture | Graphiti (Zep), Honcho (managed) | Limits adoption, privacy concerns |
| No contradiction detection | Most competitors | Knowledge drift goes undetected |
| No temporal validity | Most competitors | Cannot answer "what was true when?" |
| Flat memory (no structure) | Most competitors | Retrieval quality degrades |
| No compression/consolidation | Most competitors | Memory grows unbounded |
| Single storage backend | A-Mem (ChromaDB only) | Vendor lock-in |

### What Shared Living Memory Already Does Well

Compared to competitors, Shared Living Memory already has:
1. **Multi-user auth with visibility enforcement** — most competitors lack this
2. **Contradiction detection and resolution** — only AgentMemory comes close
3. **Auto-linking between related memories** — most competitors require manual linking
4. **Compression pipeline** — nightly synthesis of old memories into digests
5. **Pattern derivation** — LLM-powered pattern detection across memories
6. **Graph expansion in recall** — BFS traversal of memory relationships
7. **RRF fusion** — combining dense + keyword search
8. **Importance scoring** — LLM-classified importance levels
9. **Status lifecycle** — canonical/draft/deprecated states

### What Shared Living Memory Should Add

Based on competitor analysis:
1. **Bi-temporal fact validity** (from Graphiti) — `valid_from`/`valid_to` on entries or a new `facts` table
2. **Episode-based provenance** (from Graphiti) — preserve raw source data alongside derived memories
3. **Spaced repetition decay** (from AgentMemory) — proper forgetting curve instead of simple exponential decay
4. **Background reasoning pipeline** (from Honcho) — async extraction without blocking capture
5. **Backup/checkpoint before mutation** (from TencentDB) — defensive memory writes
6. **Typed relations with confidence** (from AgentMemory) — beyond just `relates_to`
7. **Pluggable backends** (from MemPalace) — abstract storage for future flexibility

---

## Summary

The landscape shows a clear split:
- **Production systems** (Graphiti, Honcho, MemPalace) focus on provenance, temporal modeling, and retrieval quality
- **Research systems** (A-Mem, AgeMem, AgentMemory) focus on memory evolution and forgetting curves
- **Infrastructure projects** (beads, memU) focus on storage format and human readability

Shared Living Memory is uniquely positioned as a **multi-user shared memory with contradiction handling** — no competitor combines these features. The main gaps are temporal modeling (validity windows), provenance (episode tracking), and memory lifecycle (spaced repetition decay).
