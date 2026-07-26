# PRINCIPLES.md — Non-Negotiable Architectural Principles

**Date:** 2026-07-13  
**Status:** Active  
**Audience:** Solutions architects, implementers, reviewers  
**Source:** Research-backed findings from primary papers, production system analysis, and benchmark evidence

---

These 10 principles are the architectural foundation of Shared Living Memory v2. Every implementation decision must comply with them. They are not guidelines — they are non-negotiables grounded in research evidence.

---

## 1. Never Delete Contradicted Facts — Invalidate with Timestamps

When new evidence contradicts existing knowledge, stamp `invalid_at` on the old edge/entry and keep it. The old fact must remain queryable for audit and historical QA.

```
❌  DELETE old fact, INSERT new fact
✅  UPDATE old_fact SET invalid_at = now; INSERT new fact
```

**Why:** Graphiti's production implementation proved that deletion loses lineage and makes historical queries impossible. Contradicted facts are still facts — they just stopped being true. Preserving them enables "how did our understanding change?" queries that are critical for research memory systems.

**Schema requirement:** Every edge and entry needs `valid_at`/`invalid_at` (or `valid_from`/`valid_to`) columns. Invalidated records stay in the active database, filtered at query time, never physically removed.

**Research basis:**
- Graphiti edge invalidation logic: `graphiti_core/utils/maintenance/edge_operations.py` — contradicted edges get `invalid_at` set, never deleted
- Graphiti README: "explicit bi-temporal tracking with automatic fact invalidation"
- Zep paper (arXiv:2501.13956): temporal knowledge graph architecture for agent memory

**References:**
- `outputs/graphiti-bitemporal-memory-deepresearch-2026-07-13.md` — Section: "How Graphiti invalidates facts"
- `outputs/deepresearch-kg-memory-typed-relations-confidence-contradictions.md` — Section: "Graphiti/Zep: newest valid fact wins, older fact retained"

---

## 2. Decay Memories from Last Recall, Not from Creation Time

A memory recalled 100 days ago should score higher than a memory never recalled that was created yesterday. Decay must originate from `last_recalled_at`, not `created_at`.

**Why:** The current system decays from creation time, which creates a feedback loop — frequently recalled entries stay high, rarely recalled entries fade regardless of actual relevance. This violates the core principle of spaced repetition: reinforcement extends memory life.

**Implementation:** Add `last_recalled_at` (INTEGER, nullable) and `retention_score` (REAL, default 1.0) to entries. Compute: `retention_score = exp(-λ × daysSinceLastRecall)` where `λ = ln(2) / halfLifeDays`. On recall, update `last_recalled_at` for returned entries (fire-and-forget). If `last_recalled_at` is NULL, fall back to `created_at`.

**Research basis:**
- Settles & Meeder (ACL 2016): recall probability `p = 2^(-Δ/h)` where Δ is elapsed time and h is half-life — but this is from last review, not creation
- SuperMemo SM-17: explicitly separates stability (how long memory lasts) from retrievability (probability of recall now) — retrievability decays from last review
- ADR-0004 in this project: "decays from last recall, not creation" — accepted decision

**References:**
- `outputs/spaced-repetition-decay-curves-for-ai-agent-memory-systems.md` — Section: "Exponential forgetting is a useful local model"
- `docs/memory-system/adr/0004-spaced-repetition-decay.md` — Accepted ADR

---

## 3. Classify Memory Type at Write Time — Different Types Need Different Half-Lives

Task-state memories should decay in days. User preferences should last months. Verified knowledge should last years. One global half-life is wrong for heterogeneous memory corpora.

| Memory Type | Initial Half-Life | Rationale |
|---|---|---|
| Ephemeral context | 0.5–6 hours | High staleness risk; usefulness drops fast |
| Task-state | 1–7 days | Must survive pauses; decay after completion |
| User facts/preferences | 30–180 days | Persistent but drift over time |
| Procedures/workflows | 30–365 days | Reuse strengthens; decay guards against outdated |
| Verified knowledge | 90–385+ days | Long-lived if provenance is strong |
| Untrusted/safety-sensitive | Minutes to 7 days | Short default persistence reduces poisoning |

**Why:** The human memory literature (SuperMemo, HLR) shows that different material types have fundamentally different forgetting curves. A single 30-day half-life for all content means tasks decay too slowly and facts decay too quickly.

**Implementation:** The LLM classifier at capture already outputs importance/canonical/kind. Add a `memory_type` field and route to the appropriate half-life prior. Update half-life online from retrieval outcomes: successful retrieval → increase; contradiction → decrease; repeated confirmation → increase and trust.

**Research basis:**
- SuperMemo SM-17: stability (half-life) is memory-specific, not global
- Kumbam et al. (ICML 2026, arXiv:2606.29178): multi-factor retention scoring including memory type as a feature
- "Forget to Improve" (arXiv:2606.25115): net-value-per-byte score varies by memory class

**References:**
- `outputs/spaced-repetition-decay-curves-for-ai-agent-memory-systems.md` — Section: "Optimal half-life values by memory type"

---

## 4. Every Edge Must Carry a Confidence Score (0.0–1.0) Separate from Weight

Weight = link strength (how related). Confidence = certainty (how sure we are about this relationship). These are orthogonal. A weak-but-certain link needs both signals.

**Why:** No production system (Graphiti, AgentMemory, MemPalace) has native edge confidence in their public OSS. This is a gap in the entire field. Shared Living Memory can be the first to implement it correctly. Confidence enables: (a) trusting LLM-inferred edges less than user-created ones, (b) confidence-weighted graph traversal, (c) evidence-weighted contradiction resolution.

**Implementation:** Add `confidence REAL DEFAULT 1.0` to edges. Set on first insert, never upserted (preserve original certainty). For LLM-inferred edges: `confidence = (cosine_score - threshold) / (1 - threshold)` normalized to 0–1. For user-created edges: default to 1.0. For contradiction-detected edges: LLM provides confidence.

**Research basis:**
- Graphiti analysis: confidence scoring is NOT a first-class edge field in public Graphiti OSS — this is a documented gap
- AgentMemory: has `confidence` on relations but only in-memory, not persisted
- TOKI (arXiv:2606.06240): evidence-weighted merge requires confidence scores on edges

**References:**
- `outputs/deepresearch-kg-memory-typed-relations-confidence-contradictions.md` — Section: "Confidence scoring: weak evidence in Graphiti OSS"

---

## 5. Model Valid Time and Ingestion Time as Independent Dimensions

Every fact needs: (a) when it became true in the world (`valid_from`/`valid_to`), and (b) when we learned it (`recorded_at`). Without this separation, you cannot answer "what did we believe in March?" vs "what is now known about March?"

**Why:** This is the single highest-value gap identified in the research. Graphiti's entire value proposition rests on this. Without bi-temporal modeling, the system cannot support historical QA, backfill ingestion, or "what changed?" explanations — all critical for a research memory system.

**Schema:**
```sql
ALTER TABLE entries ADD COLUMN valid_from INTEGER;   -- when fact became true
ALTER TABLE entries ADD COLUMN valid_to INTEGER;     -- when fact stopped being true (NULL = still valid)
ALTER TABLE entries ADD COLUMN recorded_at INTEGER;  -- when we learned it (DEFAULT created_at)
```

**Temporal query patterns:**
1. **Current-state:** `valid_from <= now AND (valid_to IS NULL OR valid_to > now)`
2. **Historical as-of:** `valid_from <= t AND (valid_to IS NULL OR valid_to > t)`
3. **Windowed retrieval:** overlap query between fact validity interval and target interval
4. **History-of-fact:** fetch all versions of a fact, sort by `valid_from`

**Research basis:**
- Graphiti `EntityEdge` schema: `valid_at`, `invalid_at`, `expired_at`, `reference_time`
- "Bitemporal Property Graphs to Organize Evolving Systems" (arXiv:2111.13499): property-graph bitemporal design
- Zep paper (arXiv:2501.13956): temporal knowledge graph architecture

**References:**
- `outputs/graphiti-bitemporal-memory-deepresearch-2026-07-13.md` — Section: "What Graphiti actually stores" and "Temporal query patterns"
- `docs/research/technical-knowledge-base-report.md` — Section: 5. Bi-Temporal Fact Tracking

---

## 6. Use Multi-Factor Retention Scoring, Not Exponential Decay Alone

Combine age + access frequency + provenance strength + redundancy + downstream utility. Pure time decay does not resist distractor pollution.

**Formula:**
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

**Why:** The ICML 2026 paper on selective memory retention showed that bounded retention with multi-factor scoring resists distractor pollution while unbounded memory degrades retrieval precision. Exponential decay alone cannot distinguish a frequently-used fact from a stale one that was recently captured.

**Implementation:** Start with exponential half-life as the baseline prior. Add frequency and confidence as multipliers (already partially implemented). Add redundancy detection (cosine similarity to other entries in the same tag cluster). Add risk scoring for untrusted/safety-sensitive memories.

**Research basis:**
- Kumbam et al. (ICML 2026, arXiv:2606.29178): bounded retention resisted distractor pollution while unbounded memory degraded precision
- Wu et al. (arXiv:2606.25115): net-value-per-byte score for keep/share/trust decisions
- Microsoft "Human-Inspired Memory Architecture": consolidation, interference-based forgetting, reconsolidation

**References:**
- `outputs/spaced-repetition-decay-curves-for-ai-agent-memory-systems.md` — Section: "Recent LLM-agent evidence favors multi-factor retention scoring"

---

## 7. Relation-Specific Contradiction Policies — One Rule Does Not Fit All

Different edge types need different contradiction handling rules. Applying the same "latest wins" policy to all relationships is incorrect.

| Relation Class | Contradiction Rule |
|---|---|
| Immutable facts (`born_in`, `created_at`) | Never supersede, just dedupe |
| Stateful single-value (`works_at`, `api_endpoint`) | Invalidate previous active fact on contradiction |
| Multi-valued (`likes`, `skills`, `uses`) | Additive unless explicit negation |
| Safety-critical | Await confirmation or evidence-weighted merge |

**Why:** TOKI (2026) proved that production contradiction handling must declare: isolation assumptions, provenance retention, audit behavior, and replay consistency guarantees. A single "latest wins" rule works for simple cases but breaks for immutable facts (you don't want "born_in" to be overridden) and multi-valued facts (adding a skill shouldn't delete existing skills).

**Implementation:** Add a `source_policy` field to edges that maps relation types to contradiction rules. The contradiction detection pipeline reads this policy before applying resolution. Different edge types route to different resolution logic.

**Research basis:**
- TOKI (arXiv:2606.06240): classifies production contradiction strategies into last-writer-wins, evidence-weighted merge, await-confirmation, per-rule policy
- RoMem (arXiv:2604.11544): temporal representation where outdated facts naturally lose retrieval salience without deletion

**References:**
- `outputs/deepresearch-kg-memory-typed-relations-confidence-contradictions.md` — Section: "Contradiction resolution strategies"

---

## 8. Episodes Are Immutable — Compression Must Never Touch Raw Content

The `episodes` table is the provenance ledger. Every entry links to its source episode. Compression overwrites `entries.content` (the derived/summary version) but never touches `episodes.raw_content`.

**Why:** Without episodes, compression is destructive. Every compressed digest loses the original wording, context, and nuance. This is the "information loss" problem identified in the competitor analysis. With episodes, compression is automatic — the entry becomes the summary, the episode preserves the original.

**Implementation:**
1. `episodes.raw_content` = immutable original (verbatim, never mutated)
2. `entries.content` = summary/digest (derived, can be compressed)
3. Recall returns either based on context: `detail: "summary" | "original"`
4. Compression continues to work as-is but gains provenance through episode linkage

**Schema:**
```sql
CREATE TABLE IF NOT EXISTS episodes (
  id TEXT PRIMARY KEY,
  source_url TEXT,
  content_hash TEXT,           -- SHA-256 for dedup
  raw_content TEXT NOT NULL,   -- immutable
  content_type TEXT,
  ingested_at INTEGER,
  ingested_by TEXT,
  owner_user_id TEXT
);
ALTER TABLE entries ADD COLUMN episode_id TEXT;
```

**Research basis:**
- Graphiti: episodes are immutable raw data; every derived fact traces back to source episodes via `source_episode_id`
- MemPalace: verbatim storage in "drawers" — every memory IS the original text, achieving 96.6% R@5 without LLM
- ADR-0001 in this project: episodes as immutable source ledger — accepted decision

**References:**
- `docs/memory-system/adr/0001-episodes-immutable-source-ledger.md` — Accepted ADR
- `docs/research/gap-analysis.md` — Pattern 2: Episode-Based Provenance

---

## 9. Keyword Search Needs TF-IDF Weighting, Not Raw Token Count

Current keyword weight = count of matched tokens. A query matching 2 common English words scores the same as matching 2 unique technical identifiers. Implement TF-IDF-like weighting so rare terms contribute more to the fusion score.

**Why:** The RRF formula with k=60 heavily favors dense results. A keyword result at position 1 with weight 3 (3 tokens matched) scores `3/61 = 0.049`, while a dense result at position 1 scores `1/61 = 0.016`. The keyword result wins — but only if all tokens match. Common tokens like "the" or "system" give the same weight as unique tokens like "Vectorize" or "bitemporal". This makes keyword results non-discriminative.

**Implementation:**
1. Build an IDF index from the corpus (D1-based, updated nightly)
2. Weight each keyword match by `log(N/df)` where N = total entries, df = entries containing the term
3. Use weighted token count as the keyword score in RRF fusion
4. Consider reducing RRF k from 60 to 30-40 to give keyword results more influence

**Research basis:**
- AgeMem: hybrid scoring `0.6 × cosine + 0.25 × recency + 0.15 × learning` — weighted keyword matching
- BM25/TF-IDF is the standard for keyword retrieval quality — raw token count is a known anti-pattern
- MTEB retrieval benchmarks show that hybrid systems outperform pure dense or pure keyword

**References:**
- `docs/system-architecture.md` — Section: 4. Recall Pipeline, RRF Fusion Formula
- `docs/research/technical-knowledge-base-report.md` — Section: 2. Retrieval Pipeline Assessment

---

## 10. Prune the Graph by Relation Type — Never Apply the Same TTL to All Edges

Pruning `favorite_color` is not the same as pruning `manager_of`. Stateful single-value edges should be invalidated on contradiction, not age-based TTL. Additive multi-valued edges should have longer retention. Separate the active graph from the audit graph.

**Why:** The current nightly prune (delete inferred edges with weight < 0.3 and age > 7 days) is too aggressive for inferred edges that may be weak but correct, and too lenient for contradicted edges that should be invalidated. Different edge types have fundamentally different value lifetimes.

**Implementation:**
1. **Active graph:** Edges where `invalid_at IS NULL` — used for recall, traversal, scoring
2. **Audit graph:** All edges including invalidated — used for provenance, history, debugging
3. **Relation-aware pruning:**
   - `relates_to` (inferred): age-based TTL is acceptable, but raise threshold to 14 days
   - `contradicts` (system): never prune — permanent audit record
   - `supersedes` (system): never prune — permanent version chain
   - `derives_from` (explicit/inferred): never prune — provenance chain
   - `decided`, `follows` (episodic): prune after 180 days if no incoming edges
4. **Never hard-delete contradicted facts immediately** — mark inactive first, audit every destructive compaction step

**Research basis:**
- Graphiti: prunes by invalidation, not deletion for contradicted facts
- Graph pruning research: retire stale facts from active retrieval but preserve in audit/history; apply TTL only to weakly supported, low-confidence, never-reused facts
- TOKI: separation of active and audit graphs is required for correct contradiction resolution

**References:**
- `outputs/deepresearch-kg-memory-typed-relations-confidence-contradictions.md` — Section: "Graph pruning heuristics"
- `docs/system-architecture.md` — Section: 6. Graph & Edge System, Nightly Graph Pass

---

## Summary

| # | Principle | Criticality | Research Basis |
|---|---|---|---|
| 1 | Never delete — invalidate with timestamps | Critical | Graphiti, arXiv:2501.13956 |
| 2 | Decay from last recall, not creation | Critical | ACL 2016, SM-17, ADR-0004 |
| 3 | Classify memory type at write time | High | SM-17, ICML 2026, arXiv:2606.29178 |
| 4 | Confidence on edges, separate from weight | High | Graphiti gap analysis, TOKI |
| 5 | Valid time ≠ ingestion time | Critical | Graphiti, arXiv:2111.13499 |
| 6 | Multi-factor retention scoring | Critical | ICML 2026, arXiv:2606.29178, arXiv:2606.25115 |
| 7 | Relation-specific contradiction policies | High | TOKI (arXiv:2606.06240), RoMem |
| 8 | Episodes are immutable provenance | Critical | Graphiti, MemPalace, ADR-0001 |
| 9 | TF-IDF weighting for keyword search | Medium | BM25/TF-IDF standards, AgeMem |
| 10 | Relation-aware graph pruning | Medium | Graphiti, TOKI, pruning research |
