# Memory landscape → Shared Living Memory comparison

Compared on 2026-08-01 against Hindsight commit
[`b5d8439`](https://github.com/vectorize-io/hindsight/tree/b5d8439c8f1b8aa158f4e8278334066792638543)
and Hermes LCM commit
[`854e869`](https://github.com/stephenschoettler/hermes-lcm/tree/854e8699e129774fa6320cfdae00d79cb08556c9),
the Hermes Atlas memory-provider directory, selected providers' primary repositories,
and the current Shared Living Memory `main` worktree.

## Conclusion

Do not replace Shared Living Memory with Hindsight or copy its full architecture.
Shared Living Memory already has the stronger trust substrate: explicit ownership and
visibility, immutable episodes, reversible versions, bitemporal projections, typed and
versioned relationships, contradiction workflows, service identities, policy, proposals,
and mandatory audit.

The highest-value pattern to adopt is a derived-knowledge ladder:

`source document / episode → extracted fact → evidence-backed observation → living mental map`

Shared Living Memory already owns both ends of that ladder (source evidence and the product
vision for mental-map translation). Its missing middle is durable, incrementally refreshed,
source-linked understanding.

Hermes LCM belongs one layer earlier. It is an agent-runtime context engine, not the shared
knowledge authority:

`active session → bounded summaries with exact drill-down → durable conclusions promoted to SLM`

Use it beside Shared Living Memory when Hermes needs long-session continuity. Do not mirror its
entire raw transcript or summary DAG into the canonical knowledgebase.

## Comparison matrix

| Capability | Hindsight | Shared Living Memory now | Judgment |
|---|---|---|---|
| Source provenance | Documents, chunks, extracted facts, observation source IDs | Episodes, documents, sections, passages, citations, snapshots | Already strong; preserve SLM's model |
| Temporal knowledge | Occurrence time plus learned/mentioned time | `valid_from` / `valid_to` plus `recorded_at`; `as_of` / `known_at` recall | Already stronger and explicitly bitemporal |
| Hybrid recall | Semantic, BM25, graph, temporal, RRF, cross-encoder | Semantic, keyword, graph, temporal filters, RRF, heuristic reranking | Mostly present; benchmark before adding a cross-encoder |
| Recall output control | Token budget, search-depth budget, optional raw chunks, trace | Fixed `topK`, evidence passages, no public retrieval trace | Small useful gap |
| Entity model | Extracted canonical entities, fuzzy resolution, co-occurrence links | Entry graph and typed relations; no canonical entity resolution | Valuable later, but expensive and error-prone |
| Derived observations | Continuously creates/refines source-linked observations with proof counts and history | One-off recall insight; rate-limited `auto-pattern`; tag digest/compression | Largest engine gap |
| Living mental models | Saved `source_query` summaries with provenance and automatic/delta refresh | Translation and mental-map behavior is planned, not yet a persistent product object | Largest product opportunity |
| Scoped extraction | Per-bank retain mission and extraction mode | One generic 500-character classifier; external operator profiles can have missions | High-leverage targeted addition |
| Idempotent ingestion | Caller `document_id`, replace/append/reprocess modes | Integration-specific external IDs; generic capture relies on similarity dedupe | Useful reliability gap for sync/transcript sources |
| Consolidation boundaries | Observation scopes can differ from visibility/source tags | Per-user compression and explicit visibility, but no public/team derived-belief scope | Adopt a much simpler private/team/project scope model |
| Safety at ingest | Optional Memory Defense blocks/redacts patterns and logs decisions | Strong authorization/governance; recalled memory is treated as evidence, not instructions; no general ingest secret scan | Add a narrow secret scan before broader PII policy |
| Governed operation | Bank isolation and API/MCP controls | Human/service actors, scopes, proposals, policy rechecks, audit, visibility enforcement | Keep SLM's design; do not borrow backward |

## Additional findings from Hermes LCM and Hermes Atlas

Hermes Atlas is a curated discovery list, not an evaluation: this list is ordered by GitHub
stars, not measured memory quality. Its provider descriptions were used only to select patterns
for verification at the providers' own repositories.

| Source | Verified pattern | Fit for Shared Living Memory | Decision |
|---|---|---|---|
| Hermes LCM | Hierarchical summary DAG over preserved raw messages; fresh tail; deterministic paged expansion; stable refs for oversized payloads | Useful for Hermes active-session continuity and as a retrieval-interface contract | Integrate as a separate context engine; borrow bounded expansion semantics only |
| Honcho | Representations are directional, keyed by `(observer, observed)` peer pairs | Directly refines SLM's translation-between-mental-maps goal | Make living mental maps recipient-aware, with strict privacy and provenance |
| GBrain | Cited synthesized answers explicitly report stale, uncited, conflicting, and missing evidence | Strong fit with SLM's epistemic state, citations, contradictions, and source coverage | Add an evidence-gap block to answers and mental maps |
| YantrikDB | Every result carries machine-readable `why_retrieved` reasons; explicit reinforcement can tune rank | SLM already has explicit reinforcement, but not result-level retrieval reasons | Add compact result reasons; do not add another reinforcement model |
| AgentCairn | Inspectable Markdown is canonical and the search database is disposable | Useful portability/trust principle, but SLM already has an authoritative database and immutable history | Add a human-readable export only when users need offline ownership; do not replace D1 |
| PLUR | Recall/injection IDs, counted retrieval receipts, and positive/negative relevance feedback | SLM has retention reinforcement and epistemic truth state, but no negative relevance signal tied to a recall event | Add analytics-only recall feedback first; never conflate relevance with factual confidence |
| OpenViking | L0 abstract, L1 overview, L2 exact detail, and an observable retrieval trajectory | Fits SLM's existing document/passage hierarchy without another storage model | Fold layered loading into bounded expansion and trace; do not copy the virtual filesystem |

## Revised product contract

The combined sources suggest one coherent contract rather than several new subsystems:

1. Raw evidence is immutable and directly inspectable.
2. Every derived observation names its supporting evidence and preserves version history.
3. Every mental map states whose perspective it represents and who may see it.
4. Every answer distinguishes supported conclusions from conflicts, staleness, and searched-but-not-found evidence.
5. Every compacted or truncated result provides a bounded continuation or expansion handle.
6. Every retrieved result can explain its main ranking reasons without exposing private candidates.
7. Relevance feedback belongs to a recall event and never changes the memory's factual confidence.
8. Injected memory carries provenance markers and is excluded from later transcript ingestion.

## Ranked adoption candidates

### 1. Evidence-backed living observations

Replace the current orphaned `auto-pattern` behavior with a derived entry that:

- records explicit `derives_from` / `supports` edges to every source entry;
- updates the same observation when new evidence changes the same facet;
- uses the existing entry-version service for history and rollback;
- never silently deletes or rewrites source episodes;
- respects a simple consolidation scope: owner-private, team-public, or one project/tag.

This reuses existing entries, edges, episodes, visibility, and snapshots. A new graph or
second memory engine is unnecessary.

### 2. Living mental maps

Make a saved, source-linked view for a person, project, domain agent, or house:

- name;
- subject and intended recipient/observer;
- scope/query;
- current synthesized content;
- provenance links;
- last refresh time;
- manual or post-consolidation refresh mode.

This is the most direct implementation of Shared Living Memory's stated translation layer.
Honcho's useful refinement is that a representation is directional: Nikolay's understanding
of Goria is not the same object as Goria's self-representation or an agent's permitted view.
Default to self-representation; require explicit scope, visibility, and provenance for
cross-person maps.
Start with full regeneration. Add delta editing only if regeneration quality or cost becomes
a measured problem.

### 3. Gap-aware answers

Add a compact evidence-health block to synthesized answers and living mental maps:

- conflicting evidence found;
- source is stale;
- claim lacks passage-level support;
- a relevant configured source is not connected or has not synced;
- no support was found in the searched memory scope.

Never turn retrieval failure into a global claim that information does not exist. GBrain's
gap-analysis behavior is valuable because it tells the user what to verify next, while SLM's
existing epistemic status, contradictions, citations, and integration state can ground most
of these signals without another model call.

### 4. Retrieval receipts and relevance feedback

Persist a lightweight recall event containing the IDs actually returned or injected, client,
scope, timestamp, and a redacted query fingerprint. Let the owner mark it `helpful` or
`not_helpful`. Initially use this only to measure coverage and retrieval quality; do not let
it change ranking until there is an offline benchmark and enough representative feedback.
This signal is distinct from reinforcement (retention/salience) and epistemic status (truth).

### 5. Per-profile extraction missions

Allow a domain profile or living mental map to say what it pays attention to. Reuse the
existing classification/background-processing path and keep one optional plain-language
mission. Do not copy Hindsight's multiple extraction modes until real use cases require them.

### 6. Token-budgeted recall with reasons and bounded expansion

Keep `topK` internally, but let MCP clients request `max_tokens` and stop rendering when the
budget is full. Each result should expose a short `why_retrieved` list, while an optional
trace can show which semantic, keyword, graph, and temporal stages contributed. When content
is truncated, return a stable continuation or passage-expansion handle rather than silently
dropping detail. Render existing data progressively as abstract, overview, then exact passages;
another virtual filesystem is unnecessary. Evidence passages already provide most of the
underlying source path.

### 7. Idempotency keys for ingestion

Accept a stable source/document identity for transcript, webhook, and sync ingestion. Reuse
the existing episode/document/version machinery for replace or append behavior. This avoids
LLM similarity dedupe being the only retry defense.

### 8. Narrow secret detection before persistence

Add an optional pre-storage check for high-confidence credentials such as private keys and
known token formats. Log the decision without storing the secret. Do not auto-redact general
personal information: private life details are legitimate product data and need an explicit
policy, not a broad regex guess.

## Do not copy yet

- The Python/PostgreSQL/worker/control-plane stack: it would duplicate the current Cloudflare
  architecture without creating product value.
- Full canonical entity resolution: add only after alias/entity failures are measured.
- Cross-encoder reranking: benchmark Shared Living Memory recall first; it adds latency and
  hosting cost.
- Disposition sliders (`skepticism`, `literalism`, `empathy`): domain-agent prompts and
  governed profiles already cover the useful behavior more directly.
- World-versus-experience taxonomy: SLM's ownership, source, episodic/semantic kind, and actor
  identity already encode most of the distinction.
- Hindsight's broad “learns from feedback” positioning: the inspected public API has no
  first-class reward or thumbs-up/down learning loop; feedback becomes ordinary retained
  evidence.
- Tag-based visibility as the primary security boundary: keep SLM's explicit ownership and
  visibility enforcement.
- Hermes LCM's SQLite summary DAG inside SLM: use the plugin for Hermes session continuity;
  do not create a second canonical store or duplicate every transcript.
- A memory-provider marketplace or abstraction layer: Hermes supports one external provider at
  a time, while SLM should remain the durable authority rather than becoming a provider router.
- Honcho server code without a deliberate licensing decision: its repository is AGPL-3.0.
- Hermes Atlas rankings as evidence: it is useful discovery metadata, not a benchmark or
  procurement evaluation.

## Suggested delivery order

1. Turn one existing auto-pattern into a versioned, source-linked observation.
2. Add one manually created, self-directed living mental map that refreshes from those observations.
3. Add an evidence-health block and compact retrieval reasons to its output.
4. Emit recall receipts and collect analytics-only helpful/not-helpful feedback.
5. Add provenance markers and a regression test proving injected context is not re-ingested.
6. Evaluate the result on a real Shared Living Memory corpus for citation quality, duplicate beliefs,
   stale updates, privacy boundaries, latency, and LLM cost.
7. Only then alter ranking or add automatic refresh, cross-person maps, and profile-specific
   extraction missions.

## Primary sources

- [Hindsight retain and extraction](https://hindsight.vectorize.io/developer/retain)
- [Hindsight hybrid retrieval and token budgets](https://hindsight.vectorize.io/developer/retrieval)
- [Hindsight observation consolidation](https://hindsight.vectorize.io/developer/observations)
- [Hindsight mental models](https://hindsight.vectorize.io/developer/api/mental-models)
- [Hindsight reflect](https://hindsight.vectorize.io/developer/api/reflect)
- [Hindsight MIT license](https://github.com/vectorize-io/hindsight/blob/b5d8439c8f1b8aa158f4e8278334066792638543/LICENSE)
- [Hermes LCM architecture and retrieval contract](https://github.com/stephenschoettler/hermes-lcm/tree/854e8699e129774fa6320cfdae00d79cb08556c9)
- [Official Hermes memory-provider lifecycle and bundled providers](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/memory-providers.md)
- [Honcho peer-centric and observer/observed model](https://github.com/plastic-labs/honcho)
- [GBrain cited answers and gap analysis](https://github.com/garrytan/gbrain)
- [YantrikDB explainable recall](https://github.com/yantrikos/yantrikdb-hermes-plugin)
- [AgentCairn inspectable canonical memory](https://github.com/ccf/agentcairn)
- [PLUR retrieval receipts and feedback](https://github.com/plur-ai/plur)
- [OpenViking layered context and retrieval trajectory](https://github.com/volcengine/OpenViking)
- [Hermes Atlas provider directory](https://hermesatlas.com/lists/best-memory-providers)

## License note

Hindsight and Hermes LCM are MIT licensed. Architectural ideas can be reimplemented. If code
is copied, retain the applicable copyright and permission notice in copies or substantial
portions and audit dependencies separately. Honcho is AGPL-3.0, so use its directional peer
model as a design reference unless the project deliberately accepts that license's obligations.
PLUR is Apache-2.0 and OpenViking is AGPL-3.0; the recommendations above borrow contracts and
interaction patterns, not their code.
Provider names and branding are not part of the reusable implementation ideas.
