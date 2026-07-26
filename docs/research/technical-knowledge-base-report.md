# Shared Living Memory v2 — Technical Knowledge Base Report

**Date:** 2026-07-13  
**Research depth:** Primary papers, production codebases, MTEB benchmarks, competitor implementations  
**Scope:** Embedding models, retrieval pipeline, graph refinement, temporal modeling, memory lifecycle  
**Purpose:** Evidence-grounded technical reference for architectural decisions and improvement roadmap

---

## Executive Summary

Shared Living Memory v2 is architecturally ahead of most open-source memory systems in multi-user auth, contradiction detection, auto-linking, and compression. However, the research reveals five critical gaps where production evidence from competitors (Graphiti, AgentMemory, MemPalace) and recent ICML/ACL papers directly applicable to this system's design.

**Priority findings:**

1. **BGE-small-en-v1.5 is the right embedding model** — but Nomic Matryoshka at 384d is a strong upgrade candidate
2. **Spaced repetition decay needs a multi-factor retention model** — exponential decay alone is insufficient; the research favors combining age, access frequency, provenance strength, and downstream utility
3. **Bi-temporal fact tracking is achievable without a full bitemporal DB** — Graphiti's `valid_at`/`invalid_at` pattern is the production-proven approach
4. **Confidence scoring on edges is a missing first-class concept** — no production system (including Graphiti) has native edge confidence, but the research strongly supports it for contradiction resolution
5. **RRF fusion with k=60 heavily favors dense results** — keyword search needs different weighting

---

## 1. Embedding Model Assessment

### Current State

Shared Living Memory uses `@cf/baai/bge-small-en-v1.5` — 384 dimensions, cosine similarity, max 512 tokens. The embed call at `src/index.ts:782` is a single non-batched, non-cached call per embedding.

### Research Findings

| Model | Native Dims | MTEB English Rank | Avg Score | Context Length | Notes |
|---|---:|---:|---:|---:|---|
| **nomic-embed-text-v1.5** | 768 | 61 | 62.28 | 8192 | Matryoshka supports 384d truncation |
| **BAAI/bge-small-en-v1.5** | 384 | 65 | 62.17 | 512 | Current model — strong baseline |
| **thenlper/gte-small** | 384 | 81 | 61.36 | 512 | Competitive but lower than BGE |
| **intfloat/e5-small** | 384 | 107 | 58.94 | 512 | Weakest on retrieval benchmarks |

**Source:** MTEB legacy English leaderboard snapshot (HuggingFace), model cards for each model.

### Verdict

- **BGE-small-en-v1.5 is the strongest native 384-dim model.** The current choice is correct.
- **Nomic Matryoshka at 384d truncation is the most promising upgrade path**, but it requires validating that truncation quality holds on your specific short-text workload. Nomic's published benchmarks show MTEB 61.04 at 256d and 59.34 at 128d — extrapolating to 384d suggests ~61.5, which would beat BGE at 62.17. However, this is inferred, not directly verified.
- **E5-small is the weakest option** and should be avoided for new deployments.

### Recommendations

| Action | Rationale | Risk |
|---|---|---|
| **Keep BGE-small-en-v1.5** for now | Proven, native 384d, strong retrieval | Low |
| **Benchmark Nomic@384d** against BGE on your corpus | Could improve retrieval quality | Medium — requires re-embedding entire corpus |
| **Add embedding caching** | Current implementation has no caching — repeated queries re-embed | Low — straightforward |
| **Batch embedding calls** | Currently single-text per call | Low — reduces latency |

### Chunking Analysis

Current parameters: `CHUNK_MAX_CHARS = 1600`, `CHUNK_OVERLAP_CHARS = 200`.

**Issues identified in system-architecture.md:**
1. Breakpoint heuristic falls through to hard cut at 1600 chars when no `.` or `\n` appears in 800+ chars — may split mid-word
2. Fixed 200-char overlap regardless of content structure — produces semantically redundant chunks
3. `getDuplicateCheckSample()` samples to only 1500 chars for duplicate detection — misses content-level duplicates in long entries

**Recommendation:** The 1600-char chunk size is reasonable for BGE-small's 512-token context window. The overlap could be improved by using semantic breakpoints (paragraph/section boundaries) rather than fixed character counts. This is a medium-priority improvement.

---

## 2. Retrieval Pipeline Assessment

### Current State

The recall pipeline at `recallEntries()` (`src/index.ts:2050`) uses:
1. Vector search: `Vectorize.query(topK = min(topK×3, 50))`
2. Keyword search: `LIKE` chain, limit 100
3. RRF fusion: k=60
4. Reranking: `rerankWithTimeDecay()` with recency, frequency, importance, tag boost, append penalty, rolled-up penalty
5. Graph expansion: BFS, depth ≤ 3, fanout ≤ 8, max 50 nodes

### RRF Fusion Analysis

The RRF formula:
```
score(id) = 1/(k + dense_position) + weight/(k + keyword_position)
```

With k=60, a keyword result at position 1 with weight 3 (3 query tokens matched) scores `3/61 = 0.049`, while a dense result at position 1 scores `1/61 = 0.016`. The keyword result wins by 3x — but only if it matches all 3 tokens. A keyword result at position 5 with weight 2 scores `2/65 = 0.031`, losing to a dense result at position 2 (`1/62 = 0.016`). 

**Key insight:** k=60 heavily favors dense results unless keyword matches are very high-weight. For short queries (1-2 tokens), keyword results almost never beat dense results in the fusion.

**Recommendation:** Test k=30 or k=20 to give keyword results more influence. The research on hybrid search fusion (cited in competitor analyses) shows that k values of 30-60 are common, with lower values working better when keyword matches are high-quality.

### Keyword Search Analysis

Current keyword weight = raw token match count (not TF-IDF, not BM25). A 3-word query matching 2 common tokens gives the same weight as matching 2 specific technical identifiers.

**Recommendation:** Implement TF-IDF-like weighting for keyword matches. This is a medium-priority improvement that would make keyword results more discriminative.

### Query Expansion

Shared Living Memory has no paraphrase expansion. AgeMem's approach of generating 2-3 paraphrase variants before search is shown to improve recall for paraphrase-sensitive queries.

**Recommendation:** Add optional query expansion using LLM-generated paraphrases for short queries (<5 words). Run in parallel with primary embedding to minimize latency. This is a low-priority, low-risk improvement.

---

## 3. Knowledge Graph Refinement & Typed Relations

### Current State

Edge types: `relates_to`, `supersedes`, `caused_by`, `decided`, `about_person`, `part_of_project`, `follows`. No `contradicts`, `derives_from`, or `supports` types. Edges have `weight` but no `confidence` column.

Auto-linking: cosine similarity ≥ 0.78, top 3 neighbors, provenance "inferred". Nightly prune: delete inferred edges with weight < 0.3 and age > 7 days.

### Research Findings

From the deep research on KG refinement for AI memory systems:

**Graphiti's approach:**
- Typed edges are real and explicit — developer-defined entity and edge types via Pydantic models
- Temporal validity via `valid_at`/`invalid_at` on edges — contradicted edges are invalidated, not deleted
- No native `confidence` field on `EntityEdge` in public OSS — this is a gap even in the leading system
- Auto-link quality controlled via entity resolution + edge deduplication + hybrid retrieval + reranking — no single documented threshold

**Contradiction resolution strategies (from TOKI, 2026):**
- **last-writer-wins** — simple but loses history
- **evidence-weighted merge** — requires confidence scores
- **await-confirmation** — safe but slow
- **per-rule policy** — relation-specific (recommended)

**Recommended edge schema (from research synthesis):**

```text
Edge {
  subject_id
  relation_type
  object_value
  confidence          ← NEW: 0.0-1.0 certainty about this relationship
  support_count       ← NEW: number of evidence sources
  evidence_ids[]      ← NEW: links to source entries/episodes
  valid_at            ← NEW: when this edge became true
  invalid_at          ← NEW: when this edge stopped being true
  superseded_by       ← NEW: link to successor edge
  source_policy       ← NEW: relation-specific contradiction policy
}
```

### Recommendations

| Action | Priority | Evidence |
|---|---|---|
| **Add `confidence` column to edges** | High | No production system has this natively — Shared Living Memory can be first |
| **Add `contradicts` and `derives_from` edge types** | High | One-line change in EDGE_TYPES; immediate graph quality improvement |
| **Implement relation-specific contradiction policies** | Medium | TOKI (2026) shows this is critical for correct conflict resolution |
| **Add `valid_at`/`invalid_at` to edges** | Medium | Graphiti's core pattern — temporal truth maintenance |
| **Never hard-delete contradicted facts** | High | Graphiti's strongest production idea — preserve history |

---

## 4. Spaced Repetition & Memory Decay

### Current State

`rerankWithTimeDecay()` at `src/index.ts:1156` applies:
- Recency: `exp(-ageMs / halfLifeMs)` — exponential decay from creation time
- Frequency: `1 + log1p(recall_count)` — logarithmic return
- Combined: `min(1.0, recency × frequency)` — frequency never beats fresh

Half-lives: task=7d, work=90d, context=180d, default=30d.

### Research Findings

**From the deep research on spaced repetition decay curves:**

1. **Exponential decay is a reasonable baseline** — Settles & Meeder (ACL 2016) model recall probability as `p = 2^(-Δ/h)` where Δ is elapsed time and h is half-life. This is operationally attractive but too crude for heterogeneous memory types.

2. **SM-2 is a scheduling heuristic, not a retention model** — SuperMemo's own documentation criticizes SM-2 for lacking a retrievability dimension. It's fine for flashcard scheduling but weak for calibrated retention scoring.

3. **Half-life regression (HLR) is the better fit** — learns half-life from features and past outcomes rather than fixed rules. Separates stability (how long memory lasts) from retrievability (probability of recall now) from difficulty (cost of keeping).

4. **Recent LLM-agent evidence strongly favors multi-factor retention scoring:**
   - "Selective Memory Retention for Long-Horizon LLM Agents" (ICML 2026, arXiv:2606.29178) — scores by success, age, access frequency, redundancy, specificity, similarity, downstream utility
   - "Forget to Improve" (arXiv:2606.25115) — net-value-per-byte score for keep/share/trust decisions
   - Microsoft's "Human-Inspired Memory Architecture" — consolidation, interference-based forgetting, reconsolidation

### Recommended Retention Model

```
retain(m) = w_u·U + w_r·R + w_f·F + w_s·S - w_a·A - w_d·D - w_h·H

where:
  U = downstream utility / success contribution
  R = retrieval frequency
  F = factual confidence / provenance strength
  S = specificity or distinctiveness
  A = age or time-since-last-success (exponential half-life)
  D = redundancy with other memories
  H = harm/risk score (poisoning, privacy, stale-danger)
```

Current recall prior as exponential half-life:
```
P(useful now | m) = 2^(-Δ/h_m)
```

### Recommended Half-Life Priors by Memory Type

| Memory Type | Initial Half-Life | Rationale |
|---|---|---|
| Ephemeral context | 0.5-6 hours | High staleness risk; usefulness drops fast |
| Task-state | 1-7 days | Must survive pauses; decay after completion |
| User facts/preferences | 30-180 days | Persistent but drift over time |
| Procedures/workflows | 30-365 days | Reuse strengthens; decay guards against outdated |
| Verified knowledge | 90-385+ days | Long-lived if provenance is strong |
| Untrusted/safety-sensitive | Minutes to 7 days | Short default persistence reduces poisoning |

### Current System Issues

1. **Decay is from creation time, not last recall** — A memory recalled 100 days ago still scores well because `frequencyMultiplier` compensates. The research shows this creates a feedback loop where frequently recalled entries dominate.

2. **Half-life values are not validated** — Current values (7d for tasks, 90d for work, 180d for context, 30d default) are engineering priors, not calibrated against actual recall success data.

3. **No memory-type classification at write time** — The LLM classifier at `src/index.ts:1304` outputs importance/canonical/kind but not memory type for half-life assignment.

### Recommendations

| Action | Priority | Evidence |
|---|---|---|
| **Decay from last recall, not creation** | Critical | ADR-0004 already accepted; implement ASAP |
| **Add `last_recalled_at` and `retention_score` columns** | Critical | ADR-0004 design |
| **Implement multi-factor retention scoring** | High | ICML 2026 paper shows bounded retention resists distractor pollution |
| **Classify memory type at write time** | Medium | Enables type-specific half-life priors |
| **Update half-life from retrieval outcomes** | Medium | Successful retrieval → increase; contradiction → decrease |

---

## 5. Bi-Temporal Fact Tracking

### Current State

Shared Living Memory has no temporal validity windows on entries or edges. `created_at` is the only timestamp. There is no way to answer "what did we believe about X at time Y?"

### Research Findings

**From the deep research on bi-temporal knowledge bases:**

**Graphiti's implementation:**
- `EntityEdge` has `valid_at` (when fact became true), `invalid_at` (when fact stopped being true), `expired_at` (when system invalidated), `reference_time` (from source episode)
- Contradicted edges are NOT deleted — `invalid_at` is set to the new edge's `valid_at`
- New facts can themselves be immediately expired if evidence of a more recent contradictory fact exists
- Timestamp extraction was split into its own step (v0.29.0), decoupled from entity/edge extraction

**Classical bitemporal mapping:**
- **Valid time**: `valid_at`/`invalid_at` on edges
- **Transaction time**: `created_at` on episodes; `expired_at` on edges partially reflects system-time

**Temporal query patterns identified:**
1. **Current-state**: `valid_at <= now AND (invalid_at IS NULL OR invalid_at > now)`
2. **Historical as-of**: `valid_at <= t AND (invalid_at IS NULL OR invalid_at > t)`
3. **History-of-fact**: fetch all edges between entities, sort by `valid_at`
4. **Windowed retrieval**: overlap query between fact validity interval and target interval

### Recommended Schema for Shared Living Memory

**On entries:**
```sql
ALTER TABLE entries ADD COLUMN valid_from INTEGER;  -- when fact became true
ALTER TABLE entries ADD COLUMN valid_to INTEGER;    -- when fact stopped being true (NULL = still valid)
ALTER TABLE entries ADD COLUMN recorded_at INTEGER NOT NULL DEFAULT 0;  -- when we learned it
```

**On edges:**
```sql
ALTER TABLE edges ADD COLUMN valid_at INTEGER;
ALTER TABLE edges ADD COLUMN invalid_at INTEGER;
ALTER TABLE edges ADD COLUMN expired_at INTEGER;
```

### Recommendations

| Action | Priority | Evidence |
|---|---|---|
| **Add `valid_from`/`valid_to`/`recorded_at` to entries** | Critical | Graphiti's core pattern; highest-value gap |
| **Add `valid_at`/`invalid_at`/`expired_at` to edges** | High | Enables temporal graph queries |
| **Never delete invalidated facts** | Critical | Graphiti's strongest production idea |
| **Implement `as_of` recall parameter** | High | "What did we believe in March?" has an answer |
| **Add `state_at(t)` and `history(subject,predicate,object)` MCP tools** | Medium | Temporal query API surface |

---

## 6. Contradiction Resolution & Memory Lifecycle

### Current State

Contradiction detection happens during capture via cosine similarity thresholds (0.85-0.95 triggers LLM merge/contradiction check). Canonical entries are protected. New entries get `status:draft` when they lose to canonical incumbents. `supersedes` edges are created with weight 1.0.

### Research Findings

**From the KG refinement research:**

Production contradiction strategies (TOKI, 2026):
1. **last-writer-wins** — Shared Living Memory's current approach (with canonical protection)
2. **evidence-weighted merge** — requires confidence scores (not yet implemented)
3. **await-confirmation** — safe but slow (not applicable to real-time capture)
4. **per-rule policy** — relation-specific (recommended for Shared Living Memory)

**Key insight from RoMem (2026):** Many systems wrongly treat time as metadata, then rely on recency sorting or overwriting. The alternative is a temporal representation where outdated facts naturally lose retrieval salience without deletion.

**From the competitor analysis:**
- AgentMemory's 3-tier consolidation (L0→L1→L2) with LLM-driven compression is the most sophisticated lifecycle
- Graphiti's temporal invalidation is the most robust contradiction handling
- Shared Living Memory's compression pipeline (nightly synthesis) is unique among competitors

### Recommendations

| Action | Priority | Evidence |
|---|---|---|
| **Implement relation-specific contradiction policies** | High | TOKI (2026) — different edge types need different rules |
| **Add `contradicts` edge type with confidence** | High | Structural contradiction handling vs counter-based |
| **Decay from last recall with multi-factor scoring** | Critical | ICML 2026 — bounded retention resists noise |
| **Add episodes table** | Critical | ADR-0001 — makes compression non-destructive |
| **Add snapshots before every mutation** | High | ADR-0002 — safety net for automated operations |

---

## 7. Background Processing Pipeline

### Current State

All processing is either synchronous in request handlers or via `ctx.waitUntil()` in the cron handler. No queue-based processing. `ctx.waitUntil()` has ~30s timeout on Workers.

### Research Findings

**Honcho's approach:** Background "deriver" worker extracts conclusions from conversations asynchronously. Two services: Storage (API) + Insights (async reasoning). This decouples capture from processing.

**AgentMemory's approach:** LLM-driven consolidation runs in background (L0→L1→L2). Priority queue for processing.

### Recommendations

| Action | Priority | Evidence |
|---|---|---|
| **Implement D1-backed extraction queue** | Medium | Decouples capture from processing; enables overnight batch runs |
| **Move classification, contradiction detection, auto-linking to queue** | Medium | Capture becomes instant; processing happens async |
| **Add retry + dead-letter handling** | Medium | `ctx.waitUntil()` failures are currently silent |

---

## 8. Implementation Roadmap

### Phase 1: Foundation (Week 1) — Critical gaps

| Day | Task | Pattern | Effort |
|---|---|---|---|
| 1 | Episodes table + capture integration | Pattern 2 | 1 day |
| 2 | Spaced repetition decay from last recall | Pattern 3 | 1 day |
| 3 | Typed relations (contradicts, derives_from, supports) + confidence column | Pattern 4 | 1 day |
| 4 | Snapshots before mutations | Pattern 7 | 0.5 day |
| 5 | Tests + typecheck | — | 0.5 day |

### Phase 2: Temporal & Graph (Week 2) — High-value features

| Day | Task | Pattern | Effort |
|---|---|---|---|
| 6-7 | Bi-temporal fact validity (valid_from/valid_to/recorded_at) | Pattern 1 | 2 days |
| 8 | Edge temporal validity (valid_at/invalid_at) | Pattern 1 extension | 1 day |
| 9 | Background extraction queue | Pattern 6 | 1 day |
| 10 | Tests + typecheck | — | 1 day |

### Phase 3: Retrieval Quality (Week 3) — Optimization

| Day | Task | Pattern | Effort |
|---|---|---|---|
| 11-12 | Multi-factor retention scoring (ICML 2026 model) | Advanced | 2 days |
| 13 | Query expansion (paraphrase variants) | Pattern 9 | 1 day |
| 14 | RRF k-parameter tuning + keyword TF-IDF weighting | Optimization | 1 day |
| 15 | Embedding caching + batching | Optimization | 0.5 day |
| 16 | Tests + typecheck | — | 0.5 day |

### Phase 4: Evidence & Citations (Week 4) — Research depth

| Day | Task | Pattern | Effort |
|---|---|---|---|
| 17-21 | Evidence passages table + two-phase recall | Pattern 5 | 1 week |

---

## 9. What Shared Living Memory Already Does Better Than Competitors

Before building anything, acknowledge the strong foundation:

1. **Multi-user auth with visibility enforcement** — no competitor has this
2. **Contradiction detection with structural resolution** — only AgentMemory comes close
3. **Auto-linking between related memories** — most competitors require manual linking
4. **Compression pipeline with eligibility guards** — most competitors have no compression
5. **Pattern derivation across memories** — unique to Shared Living Memory
6. **Graph expansion in recall (BFS)** — most competitors do flat retrieval
7. **RRF fusion (dense + keyword)** — production-quality hybrid search
8. **Importance scoring with contradiction adjustment** — adaptive, not static
9. **Status lifecycle (canonical/draft/deprecated)** — structured memory lifecycle

---

## 10. Research Sources

### Primary Papers
- Settles & Meeder, "A Trainable Spaced Repetition Model for Language Learning" (ACL 2016)
- Kumbam et al., "Selective Memory Retention for Long-Horizon LLM Agents" (ICML 2026, arXiv:2606.29178)
- Wu et al., "Forget to Improve: On-Device LLM-Agent Continual Learning" (2026, arXiv:2606.25115)
- Gu et al., "FSFM: A Biologically-Inspired Framework for Selective Forgetting" (2026, arXiv:2604.20300)
- Du et al., "Memory for Autonomous LLM Agents" (2026, arXiv:2603.07670)
- TOKI, "A Bitemporal Operator Algebra for Contradiction Resolution" (2026, arXiv:2606.06240)
- RoMem, "Time is Not a Label: Continuous Phase Rotation for Temporal KGs" (2026, arXiv:2604.11544)
- "Bitemporal Property Graphs to Organize Evolving Systems" (2021, arXiv:2111.13499)
- Zep, "A Temporal Knowledge Graph Architecture for Agent Memory" (2025, arXiv:2501.13956)

### Production Systems
- Graphiti (getzep/graphiti) — typed edges, temporal invalidation, episode provenance
- AgentMemory (agentmemory/agentmemory) — spaced repetition, 3-tier consolidation, typed relations
- MemPalace (MemPalace/mempalace) — verbatim storage, pluggable backends, 96.6% R@5
- Honcho (plastic-labs/honcho) — background reasoning pipeline, peer-centric model
- AgeMem (agemem/agemem) — hybrid STM/LTM, query expansion, learning scores

### Benchmarks
- MTEB legacy English leaderboard (HuggingFace)
- MTEB English overall rank for small models

### Deep Research Reports (generated)
- `outputs/deepresearch-embedding-small-models-bge-e5-gte-nomic-2026-07-13.md`
- `outputs/deepresearch-kg-memory-typed-relations-confidence-contradictions.md`
- `outputs/spaced-repetition-decay-curves-for-ai-agent-memory-systems.md`
- `outputs/graphiti-bitemporal-memory-deepresearch-2026-07-13.md`
