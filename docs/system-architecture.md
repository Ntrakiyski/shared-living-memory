# Shared Living Memory v2 — System Architecture & Data Science Reference

## 1. Overview

Shared Living Memory v2 is a **multi-user shared memory** platform for AI agents and humans. It provides persistent, semantically-searchable, graph-linked memory via the Model Context Protocol (MCP) and a web dashboard.

**Deployment:** Cloudflare Workers (~3900 lines across modules)
**Live:** `https://shared-living-memory.nikolay-trakiyski.workers.dev`

### Infrastructure Map

```
┌─────────────────────────────────────────────────────┐
│                  Cloudflare Workers                   │
│                  ┌──────────────┐                     │
│                  │  OAuthProvider│ ← wraps both       │
│                  │  (oauth KV)  │    handler paths    │
│                  └──────┬───────┘                     │
│          ┌───────────────┼───────────────┐            │
│          ▼               ▼               ▼            │
│   ┌──────────┐   ┌──────────────┐   ┌─────────┐      │
│   │apiHandler│   │defaultHandler│   │scheduled│      │
│   │  /mcp    │   │  REST + SPA  │   │   cron  │      │
│   └──────────┘   └──────────────┘   └─────────┘      │
│                        │               │              │
└────────────────────────┼───────────────┼──────────────┘
                         │               │
           ┌─────────────┼──────┬────────┼──────┐
           ▼             ▼      ▼        ▼      ▼
       ┌──────┐    ┌────────┐ ┌───┐ ┌──────┐ ┌──┐
       │  D1  │    │Vectoriz│ │ AI│ │OAUTH │ │pub│
       │  DB  │    │   e    │ │   │ │  KV  │ │lic│
       │      │    │384-cos │ │LLM│ │      │ │/  │
       │      │    │        │ │+  │ │token │ │   │
       │      │    │        │ │emb│ │grant │ │   │
       └──────┘    └────────┘ └───┘ └──────┘ └──┘
```

### Cloudflare Resources (from `wrangler.jsonc`)

| Binding | Resource | Purpose |
|---------|----------|---------|
| `DB` | D1 Database `shared-living-memory-db` | Entries, edges, users tables |
| `VECTORIZE` | Vectorize Index `shared-living-memory-vectors` | 384-dim cosine semantic search |
| `AI` | Workers AI | `@cf/baai/bge-small-en-v1.5` (embeddings) + `@cf/meta/llama-4-scout-17b-16e-instruct` (LLM) |
| `OAUTH_KV` | KV Namespace | OAuth tokens, grants, clients + integration state |
| `AUTH_TOKEN` | Secret (workspace key) | Bearer auth for all requests |

**Cron:** `0 1 * * *` — nightly compression + graph pass + integration sync + cross-user contradiction detection. Hermes (the external agent) owns higher-level scheduled jobs like the morning digest.

### Database Schema

**`entries`** — the core memory store:
```sql
id                   TEXT PRIMARY KEY,
content              TEXT NOT NULL,
tags                 TEXT NOT NULL DEFAULT '[]',   -- JSON array
source               TEXT NOT NULL DEFAULT 'api',  -- phone, browser, voice, claude, api
created_at           INTEGER NOT NULL,             -- Unix ms
vector_ids           TEXT NOT NULL DEFAULT '[]',   -- JSON array of Vectorize vector IDs
recall_count         INTEGER DEFAULT 0,
importance_score     INTEGER DEFAULT 0,
contradiction_wins   INTEGER DEFAULT 0,
contradiction_losses INTEGER DEFAULT 0,
owner_user_id        TEXT NOT NULL DEFAULT ''
-- Indexes: created_at DESC, source, owner_user_id
```

**`edges`** — relationship graph:
```sql
id          TEXT PRIMARY KEY,
source_id   TEXT NOT NULL,
target_id   TEXT NOT NULL,
type        TEXT NOT NULL DEFAULT 'relates_to',
weight      REAL NOT NULL DEFAULT 0.5,            -- 0..1
confidence  REAL NOT NULL DEFAULT 1.0,            -- 0..1, set by provenance
provenance  TEXT NOT NULL DEFAULT 'inferred',      -- explicit | inferred | system
metadata    TEXT NOT NULL DEFAULT '{}',            -- JSON escape-hatch
created_at  INTEGER NOT NULL,
updated_at  INTEGER NOT NULL,
UNIQUE(source_id, target_id, type)
-- Indexes: source_id, target_id
```

**`edge_proposals`** — proposed cross-user relationships:
```sql
id          TEXT PRIMARY KEY,
source_id   TEXT NOT NULL,
target_id   TEXT NOT NULL,
type        TEXT NOT NULL DEFAULT 'contradicts',
reason      TEXT NOT NULL DEFAULT '',
proposed_by TEXT NOT NULL DEFAULT '',
status      TEXT NOT NULL DEFAULT 'pending',      -- pending | approved | rejected
created_at  INTEGER NOT NULL,
resolved_at INTEGER,
UNIQUE(source_id, target_id, type, status)
```

**`users`** — multi-user auth:
```sql
id                   TEXT PRIMARY KEY,
username             TEXT NOT NULL UNIQUE,
normalized_username  TEXT NOT NULL UNIQUE,
auth_key_hash        TEXT NOT NULL,      -- HMAC-SHA-256(secret, pepper)
auth_key_prefix      TEXT NOT NULL,      -- e.g. "slm_abc123."
status               TEXT DEFAULT 'active',
created_at           INTEGER NOT NULL,
last_used_at         INTEGER
```

### Application Structure

The backend is organized across multiple TypeScript modules (re-exported through `src/index.ts`):

| Module | Lines | Purpose |
|--------|-------|---------|
| `src/index.ts` | ~220 | Entry point, re-exports all modules |
| `src/routes.ts` | ~1300 | REST route handlers (if/else chain) |
| `src/recall.ts` | ~716 | Recall pipeline (semantic search, RRF fusion, cross-user detection) |
| `src/mcp.ts` | ~693 | MCP tool definitions and handlers (with audit wrapper) |
| `src/graph.ts` | ~474 | Graph traversal, edge creation, expansion |
| `src/lifecycle.ts` | ~519 | Nightly cron jobs (compression, graph pass, contradiction detection) |
| `src/auth.ts` | ~175 | Authentication, HMAC key generation, user resolution |
| `src/db.ts` | ~162 | Database schema, initialization, helpers |
| `src/audit.ts` | ~166 | Agent audit logging (runs + tool call events) |
| `src/autonomy.ts` | ~66 | Per-tool governance levels (automatic/gated/never) |
| `src/config.ts` | ~159 | Application-wide constants and thresholds |

Two handler paths wrapped in `OAuthProvider`:

- **`apiHandler`** — serves `/mcp` (MCP protocol), resolves a verified human or service actor, and revalidates persisted service identity/credential state before building the actor-scoped tool surface
- **`defaultHandler`** — all REST routes (`/recall`, `/remember`, `/forget`, `/link`, `/list`, `/graph`, `/health`, etc.) + static assets from `public/`

The `OAuthProvider` (from `@cloudflare/workers-oauth-provider`) auto-serves:
- `/.well-known/*` — OAuth metadata
- `/oauth/token` — OAuth token endpoint
- `/oauth/register` — RFC 7591 dynamic client registration
- `/oauth/authorize` — authorization endpoint

---

## 2. Embedding Pipeline

### Model
`@cf/baai/bge-small-en-v1.5` — **384 dimensions**, cosine similarity. Non-normalized embeddings (norms matter for cosine denominator).

### Embed Call
```typescript
async function embed(text: string, env: Env): Promise<number[]> {
  const result = await env.AI.run(EMBEDDING_MODEL, { text: [text] });
  return result.data[0];
}
```
(`src/index.ts:782` — 3 lines, no caching, no batching.)

### Chunking
`chunkText()` at `src/index.ts:1106`:

| Parameter | Value | Description |
|-----------|-------|-------------|
| `CHUNK_MAX_CHARS` | 1600 | Hard character limit |
| `CHUNK_OVERLAP_CHARS` | 200 | Overlap between adjacent chunks |

Algorithm:
1. If `text.length ≤ 1600` → single chunk (vector ID = entry UUID)
2. Otherwise, iterate: find last `.` or `\n` in `[start, start + 1600]`; if breakpoint > `start + 800`, use it; else hard cut at 1600
3. Slide by `1600 - 200 = 1400` chars, repeat
4. Multi-chunk entries: vector IDs = `{uuid}-chunk-{index}`

**Fine print for data scientists:**
- For content with no periods for 800+ chars, the breakpoint heuristic falls through to a hard cut at exactly 1600 chars — may split in the middle of a word
- The overlap is a fixed 200 chars regardless of content structure — could produce semantically redundant chunks
- Appends create separate `{uuid}-update-{timestamp}` vectors (not re-embedded unless combined content exceeds 1600 chars)
- `getDuplicateCheckSample()` (`:902`) samples long content to 500 + 500 + 500 = 1500 chars when checking for duplicates — this means duplicate detection evaluates only a 1500-char summary, not the full content

### Vector Metadata (stored in Vectorize per vector)

```typescript
{
  content: chunk,           // The actual text of this chunk
  parentId: id,             // Entry UUID (all chunks of one entry share this)
  chunkIndex: i,            // Position in sequence
  totalChunks: n,           // Total chunks for this entry
  tags,                     // JSON array of tags
  source,                   // api, phone, browser, voice, claude
  created_at: now,          // Unix ms
  owner_user_id: userId,    // "" for legacy/system entries
  is_private: boolean,      // Based on tags.includes("private")
  tag_{t}: true,            // Per-tag boolean (for Vectorize metadataFilter)
}
```

---

## 3. Capture Pipeline

`captureEntry()` at `src/index.ts:2402`

```
rawContent, tags, source
        │
        ▼
extractHashtags()    ─── #tags → tags array
        │
        ▼
checkDuplicateAndContradiction()
  - embed(sample, env)              ← samples to 1500 chars
  - Vectorize.query(topK=5)
  - Collapse chunks to parents
        │
        ├─ ≥ 0.95 → BLOCKED (return)
        ├─ 0.85–0.95 → LLM decides: replace / merge / contradiction / keep_both
        ├─ 0.45–0.85 → LLM checks contradiction only
        └─ < 0.45 → UNIQUE (store as new)
        │
        ▼
Ownership check (merge path only):
  - target importance ≥ 4 OR status:canonical → protect, fall back to flagged
  - cross-user owner → fall back to flagged
        │
        ▼
INSERT into entries (D1)         ─── id = crypto.randomUUID()
  ctx.waitUntil(storeEntry())     ─── chunk + embed + Vectorize.insert()
  scheduleClassifyAndTag()        ─── LLM classify (async)
        │
        ├─ contradiction detected:
        │    ├─ canonical incumbent → new entry = status:draft, incumbent wins
        │    │   (incumbent contradiction_wins++, new contradiction_losses++)
        │    ├─ non-canonical incumbent → new entry wins, incumbent deprecated
        │    │   (new contradiction_wins++, incumbent contradiction_losses++)
        │    │   supersedes edge created (provenance: "system", weight: 1.0)
        │    └─ auto-link neighbors (excluding the conflicting entry)
        │
        └─ no contradiction:
             auto-link neighbors (inferEdgesOnWrite, async)
```

### Smart Merge Prompt (0.85–0.95 band)

(`src/index.ts:1014`)

```
New memory: "{content}"

Similar existing memories:
[1] ID: {id} \n {content}
[2] ...

Choose exactly one action. Prioritise in this order:
1. "contradiction" — DIRECTLY CONFLICTS
2. "replace" — clearly supersedes
3. "merge" — complementary, better combined (max 400 chars)
4. "keep_both" — safe default

Respond with JSON only.
```

### Classification Prompt

(`src/index.ts:1304`)

```
Classify this memory. Respond with ONLY one JSON object.
{"importance": <1-5>, "canonical": <true|false>, "kind": "episodic"|"semantic"}

importance: 1=trivial, 3=useful context, 5=critical decision or goal.
canonical: true ONLY for confirmed decision/durable fact/permanent preference.
kind: "episodic" for specific event/decision/milestone; "semantic" for general fact.

Memory: {content.slice(0, 500)}
```

**Note:** Content is truncated to 500 chars for classification. Everything after 500 is invisible to the classifier.

---

## 4. Recall Pipeline

`recallEntries()` at `src/index.ts:2050`

```
query, topK, tag?, after?, before?, kind?, hops?, userId?
        │
        ▼
parseTimePhrase()       ─── extract "last week", "today" etc.
        │
        ▼
tokenizeQuery()          ─── lowercase, strip punctuation, drop stopwords/1-char
embed(query)              ─── BGE-small-en-v1.5, 384-dim
inferQueryTags(query)     ─── LLM maps query to known tags
        │
        ▼
┌─── TAG PATH (tag provided) ──────────────────────────┐
│ D1: SELECT entries tagged with this tag              │
│ Filter visibility (client-side)                      │
│ Vectorize.getByIds(tag's vector IDs, batch 20)       │
│ cosineSim(query embedding × each vector)             │
│ Keyword = re-ranking signal only (allowKeywordOnly=F) │
└──────────────────────────────────────────────────────┘
        │
┌─── DEFAULT PATH ─────────────────────────────────────┐
│ Vectorize.query(topK = min(topK×3, 50))              │
│   metadataFilter: OR[{owner_user_id: eq userId},     │
│                    {is_private: eq false}]            │
│ Keyword search in parallel (LIKE OR-chain, limit 100)│
│ If top match < 0.85 → widen to topK=50               │
└──────────────────────────────────────────────────────┘
        │
        ▼
fuseDenseAndKeyword()  ─── RRF (k=60)
  • dense weight = 1/(k + position)
  • keyword weight = tokenMatchCount / (k + position)
  • allowKeywordOnly = true (default) | false (tag path)
        │
        ▼
Visibility post-filter  ─── D1 check: remove others' private entries
        │
        ▼
Load scoring data  ─── recall_count, importance_score, contradiction_wins/losses
        │
        ▼
rerankWithTimeDecay()  ─── all multipliers applied
        │
        ▼
Dedupe by parent ID → take topK
        │
        ▼
Graph expansion (if hops > 0):
  BFS from seed nodes through edges table
  depth ≤ 3, fanout ≤ 8 edges/node, max 50 nodes
  Score = minSeedScore × 0.6^hop × edgeWeight
  Skips status:deprecated nodes
        │
        ▼
Hydrate from D1 (full content)
  Filter: auto-pattern, status:deprecated, kind, after/before
  Increment recall_count (seeds only, async)
        │
        ▼
Normalize scores to [0, 1]  (divide by maxScore)
        │
        ▼
Cross-user mentions annotation
        │
        ▼
Cross-user contradiction detection (S05):
  For each cross-user match (owner ≠ caller):
    embed(crossMatch.content)
    Vectorize.query(caller's entries, topK=3)
    If caller match score ≥ 0.85 → INSERT edge_proposals (type: contradicts)
        │
        ▼
synthesizeInsight()  ─── LLM, if >1 match (async)
derivePattern()      ─── LLM, if ≥5 results (async, max 1/48h)
```

### RRF Fusion Formula

```typescript
function rrfFuse(denseRanked, keywordRanked, k = 60) {
  // denseRanked: [id0, id1, id2, ...]  (ordered by cosine score)
  // keywordRanked: [{id, weight}, ...]  (weight = token match count)

  score(id) = dense_score + keyword_score
  dense_score  = 1 / (k + dense_position)          // if present in dense results
  keyword_score = weight / (k + keyword_position)   // if present in keyword results
}
```

Both lists contribute independently. An entry appearing in BOTH lists gets two additive contributions. Keyword weight = number of distinct query tokens matched (not TF-IDF, not BM25 — just raw token count).

### Keyword Search

```typescript
SELECT id, content, tags, source, created_at FROM entries
WHERE content LIKE '%token1%' OR content LIKE '%token2%' OR ...
[AND visibility clause]
ORDER BY created_at DESC
LIMIT 100
```

**`tokenizeQuery()`:** lowercase → strip surrounding punctuation → drop SQL wildcards → filter by `length ≥ 2` and stopword set (18 English words). Returns deduplicated tokens.

---

## 5. Scoring Engine — `rerankWithTimeDecay()`

At `src/index.ts:1156`. Applied after RRF fusion, before dedupe.

### Formula

```
final_score = cosineScore × combinedMultiplier × appendPenalty
              × rolledUpPenalty × importanceMultiplier × tagBoost
```

### Component Breakdown

| Component | Calculation | Range | Notes |
|-----------|------------|-------|-------|
| **recency** | `exp(-ageMs / halfLifeMs)` | `(0, 1]` | Exponential decay |
| **frequency** | `1 + log1p(recall_count)` | `[1, ∞)` | Logarithmic return |
| **combined** | `min(1.0, recency × frequency)` | `(0, 1]` | Capped — freq never beats fresh |
| **appendPenalty** | `0.2` if short update chunk, else `1.0` | `{0.2, 1.0}` | `< 200 chars & isUpdate` |
| **rolledUpPenalty** | `0.4` if `rolled-up` tag, else `1.0` | `{0.4, 1.0}` | Compressed digest source |
| **importanceMultiplier** | `0.8 + (effectiveImp / 5) × 0.4` | `[0.88, 1.20]` | See below |
| **tagBoost** | `min(1.5, 1 + overlap × 0.15)` | `[1.0, 1.5]` | Applied after cap |

### Half-Life by Tag

```
task    →  7 days  (7 × 24 × 3600 × 1000 ms)
work    → 90 days
context → 180 days
default → 30 days
```

### Effective Importance (Contradiction-Adjusted)

```typescript
base   = (importance_score === 0) ? 3 : importance_score
net    = contradiction_wins - contradiction_losses
adj    = sign(net) × log1p(|net|) × CONTRADICTION_IMPORTANCE_STEP  // step = 1.0
effImp = clamp(base + adj, 1, 5)
impMult = 0.8 + (effImp / 5) × 0.4
```

| | imp=1 | imp=2 | imp=3 | imp=4 | imp=5 |
|--|-------|-------|-------|-------|-------|
| base multiplier | 0.88 | 0.96 | 1.04 | 1.12 | 1.20 |
| after 1 win (+0.69 imp) | 0.93 | 1.00 | 1.08 | 1.16 | — |
| after 1 loss (-0.69 imp) | — | 0.93 | 1.00 | 1.08 | 1.16 |
| after 3 wins (+1.09 imp) | 0.97 | 1.05 | 1.13 | — | — |
| after 3 losses (-1.09 imp) | — | — | 0.97 | 1.05 | 1.12 |

**Key insight:** The multiplier band is ±16% from baseline. Even the most extreme case (importance=1 with many losses vs importance=5 with many wins) only spans ~0.88–1.20. The score is dominated by the raw cosine similarity and the recency×frequency combined multiplier.

---

## 6. Graph & Edge System

### Edge Types

```typescript
relates_to      { directed: false }  — auto-link (0.78 threshold, top 3)
supersedes      { directed: true }   — contradiction resolution (system)
caused_by       { directed: true }
decided         { directed: true }   — episodic only
about_person    { directed: true }
part_of_project { directed: true }
follows         { directed: true }   — episodic only
derives_from    { directed: true }
supports        { directed: true }
evaluates_on    { directed: true }
has_limitation  { directed: true }
contradicts     { directed: true }   — cross-user contradiction proposals
temporal_after  { directed: true }
temporal_before { directed: true }
prerequisite    { directed: true }
context_for     { directed: true }
```

### `createEdge()` — Write Path

1. Validate type and reject self-links
2. Visibility check: read `tags` and `owner_user_id` for both entries from D1
   - Private + different owner → blocked
   - Private + same owner → allowed
   - Public + public → allowed
3. Symmetric normalization (undirected types only): store with smaller ID first
4. Weight clamped to [0, 1], default 0.5
5. **Confidence by provenance:** auto-link edges → `0.78`; explicit user edges → `1.0`; system edges → `1.0`
6. Idempotent upsert: `ON CONFLICT DO UPDATE SET weight = max(weight, excluded.weight), confidence = max(confidence, excluded.confidence)`

### Auto-Link Flow (`inferEdgesOnWrite`, `:560`)

```typescript
neighbors = checkDuplicateAndContradiction().neighbors  // Vectorize top 5
  .filter(n => n.score >= EDGE_INFER_THRESHOLD)         // 0.78
  .sort(desc).slice(0, EDGE_INFER_MAX)                  // top 3

for each neighbor: createEdge(newId, neighborId, "relates_to",
                              { weight: score, provenance: "inferred" })
```

### Graph Expansion (`expandGraph`, `:297`)

BFS from seed nodes:

| Parameter | Value | Effect |
|-----------|-------|--------|
| `GRAPH_MAX_HOPS` | 3 | BFS depth limit |
| `GRAPH_FANOUT_CAP` | 8 | Max edges followed per node per hop |
| `GRAPH_MAX_NODES` | 50 | Total nodes returned |
| `GRAPH_HOP_DECAY` | 0.6 | Score multiplier per hop |

Expanded node score (in recall): `minSeedScore × 0.6^hop × edgeWeight`

### Nightly Graph Pass (`runGraphPass`, `:1865`)

1. **Prune:** DELETE inferred edges with `weight < 0.3 AND age > 7 days`
2. **Backfill:** Find up to 25 entries with zero edges. For each: embed → Vectorize.query(top 5) → filter visibility → `inferEdgesOnWrite()`

### Nightly Cross-User Contradiction Detection (`detectCrossUserContradictions`, `src/lifecycle.ts:459`)

Runs during the nightly cron after compression and graph pass:

1. Query D1 for public entries created in the last 7 days (excluding private entries)
2. For each entry, embed its content and query Vectorize for similar entries owned by a different user
3. If cosine similarity ≥ 0.85, create a `contradicts` edge proposal in `edge_proposals`
4. Dedup: skip if a pending proposal already exists for the same source/target/type

**Coverage gap:** This catches contradictions between entries that weren't recently recalled. The recall-path detection (S05) catches contradictions at query time for entries the user actually searches for.

---

## 7. Edge Proposals

Proposed relationships between entries from different users, created automatically (cross-user contradiction detection) or manually (MCP tools / REST API).

### Lifecycle

```
POST /edge-proposals  or  MCP propose-edge  or  auto-detection (S05/S06)
        │
        ▼
  Dedup check: same (source_id, target_id, type) with status='pending'?
        │
        ├─ yes → return existing proposal
        └─ no  → INSERT with status='pending'
                │
                ▼
  POST /edge-proposals/:id/approve  or  MCP approve-proposal
  POST /edge-proposals/:id/reject   or  MCP reject-proposal
                │
                ▼
  status → 'approved' | 'rejected', resolved_at set
```

### REST Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/edge-proposals` | POST | Create a new proposal |
| `/edge-proposals` | GET | List pending proposals (visibility-scoped) |
| `/edge-proposals/:id/approve` | POST | Approve a proposal |
| `/edge-proposals/:id/reject` | POST | Reject a proposal |

### MCP Tools

| Tool | Description |
|------|-------------|
| `propose-edge` | Create a cross-user edge proposal |
| `list-proposals` | List pending proposals (visibility-scoped) |
| `approve-proposal` | Approve a pending proposal |
| `reject-proposal` | Reject a pending proposal |

### Visibility Scoping

GET /edge-proposals uses `EXISTS` subqueries to ensure both the source and target entries are visible to the requesting user:

```sql
SELECT ... FROM edge_proposals ep WHERE ep.status = 'pending'
  AND EXISTS (SELECT 1 FROM entries e1 WHERE e1.id = ep.source_id AND <visibility>)
  AND EXISTS (SELECT 1 FROM entries e2 WHERE e2.id = ep.target_id AND <visibility>)
```

---

## 8. Team Activity

### `GET /team-activity`

Returns recent memory activity across all users, visibility-scoped.

| Parameter | Type | Description |
|-----------|------|-------------|
| `user` | string | Filter by username |
| `limit` | number | Max results (default 20) |
| `after` | number | Unix ms timestamp — only entries created after this time |

Response shape:
```json
{
  "ok": true,
  "results": [
    {
      "id": "...",
      "content": "...",
      "tags": "...",
      "source": "...",
      "created_at": 1234567890,
      "owner_user_id": "...",
      "owner_username": "alice"
    }
  ]
}
```

---

## 9. Compression Pipeline

Runs nightly via cron (`{scheduled}` handler at `:4209`).

### Eligibility (`compressionEligibilitySql`, `:63`)

```
importance_score < 4                              — not critical
AND (recall_count = 0 OR (recall_count < 2 AND age > 60 days))  — not proven useful
AND (contradiction_wins = 0)                      — never won a contradiction
```

### Per-Tag Compression (`compressTag`, `:1747`)

1. Skip reserved/namespaced tags (`status:*`, `kind:*`)
2. Skip if a synthesized digest for this tag was created in the last 24h
3. Fetch eligible entries: tagged with this tag, not already `synthesized`/`auto-pattern`/`rolled-up`, meeting eligibility criteria, limit 50
4. If `< 10` entries → skip
5. LLM synthesizes a cohesive paragraph (`synthesizeDigest` prompt at `:1725`)
6. Store as new entry tagged `["synthesized", tag]`, source `"system"`
7. Mark source entries as `rolled-up` (append `[Digest: {id}]` text + add tag)

### Nightly Compression (`runNightlyCompression`, `:1817`)

1. Get all active users from `users` table
2. For each user: query D1 to find tags with >10 compressible entries
3. Call `compressTag()` for each qualifying tag

### Digest Synthesis Prompt

```
You are a shared living memory assistant. Based on these stored memories tagged "{tag}",
write a single cohesive paragraph describing the current state of this area —
what has been done, decided, and is being worked toward. Write as one flowing
paragraph, not a list.

Memories:
[1] {content}
[2] {content}
...

State of "{tag}":
```

---

## 10. Pattern Derivation

`derivePattern()` at `src/index.ts:1660`

Runs **after recall** (async, `ctx.waitUntil`) when ≥5 results returned.

**Guard:** Max one `auto-pattern` per 48 hours to prevent spam.

**Prompt:**
```
You are analyzing stored memories to find genuine recurring themes.

Memories:
[1] {content}
[2] {content}
...

Find a pattern that appears across 3 or more of these memories — a real tendency,
preference, or recurring theme about this person. Do NOT summarize individual
memories. Do NOT describe any single event.

If you find a genuine cross-memory pattern, respond with exactly ONE sentence
starting with exactly one of: "You tend to", "There's a recurring",
or "Across your memories".

If no genuine pattern exists across 3+ memories, respond with exactly: NONE
```

Stored as entry tagged `["auto-pattern"]`. Hidden from normal recall until confirmed via `/patterns/resolve`.

---

## 11. Auth & Multi-User

### Human Request Auth

1. **Workspace key** (`AUTH_TOKEN` secret) — Bearer header on every request
2. **User credentials** — `X-Shared-Living-Memory-User` (username) + `X-Shared-Living-Memory-User-Key` (`slm_xxx.yyy` format)

MCP clients may instead authenticate directly with a personal API key. Automated operators use dedicated service credentials and the actor/scoping path described in section 13; the workspace key is never treated as an identity.

### User Key Format

`slm_{publicId}.{secret}` — stored as HMAC-SHA-256 hash of secret portion

### Visibility Enforcement

`buildVisibilityClause(userId)`:

```sql
(owner_user_id = ? OR visibility = 'public')
```

Applied to every entry-reading query. Users see:
- Their own entries (private or public)
- All other public entries
- **Never** other users' private entries

### The `_system` User

- Status: `inactive` (cannot authenticate)
- Owns all pre-migration entries
- All such entries are public (no `private` tag)
- Visible to every authenticated user

---

## 12. Integrations

Provider pattern in `src/integrations/`:

- **`framework.ts`** — interfaces: `IntegrationProvider` (id, name, validateToken, sync), `MirrorStore` (upsert, delete, listMirrored), `IntegrationRecord` (KV blob schema)
- **`index.ts`** — registry (currently: Notion only)
- **`notion.ts`** — Notion sync. Resource-budgeted for Workers free plan (~35 external fetches per sync batch)

**Mirror semantics:** External source is source of truth. Each sync batch replaces content wholesale. Dedup by external item ID. Items that disappear upstream delete their mirror. Mirrors bypass the duplicate/contradiction pipeline entirely.

---

## 13. Agent Governance (Pillar 3 — Operator)

Infrastructure for external agents to operate on Shared Living Memory with least-privilege identity, fail-closed audit, and human oversight. The normative runtime boundary is [Operator Runtime and Hermes Deployment](operator-runtime-deployment.md); Hermes behavior is governed by the [canonical charter](research/hermes-living-knowledge-agent-charter.md).

Hermes is a replaceable client of this control plane. It is not a storage component and never receives direct D1, Vectorize, R2, migration, or deployment access.

### Actor and service identity

- Human, service, and internal-system actors use explicit actor contexts.
- Service identities have a human owner, status, autonomy profile, and independently rotatable credentials.
- Raw service secrets are shown once; D1 stores hashes, credential prefixes, scopes, status, expiry, and usage metadata.
- Authentication rechecks persisted identity status, credential status, expiry, and granted scopes. A request cannot expand scopes carried by its credential.
- The default Hermes identity can read, create constrained private drafts, and create/read proposals. Approved-execution scopes are excluded by default.

### Policy (`src/operator-policy.ts`)

Each governed request produces `allow`, `proposal_required`, or `deny` with the policy version, required/granted scopes, and reason:

| Service action | Decision |
|---|---|
| Visibility-scoped read with `memory:read` | Direct allow |
| Create private + draft + epistemic-candidate entry, with merge/auto-deprecation disabled | Direct allow with draft/audit/run scopes |
| Append, update, merge, restore, status/epistemic change, or edge mutation | Human-reviewable proposal required |
| Approve/reject a proposal | Denied; human-only |
| Hard forget, direct unlink, permissions, credentials, deployment, or storage access | Denied |

### Mandatory audit (`src/mandatory-audit.ts`)

Every governed mutation first persists a requested row/event, then runs one bounded mutation, then records success or failure. If the requested audit cannot be persisted, the mutation does not run.

- **`agent_runs`** — actor/service/credential attribution, policy/scopes, correlation/proposal/target IDs, status, and redacted request/result hashes.
- **`agent_events`** — ordered requested/policy/started/succeeded/failed events for the run.

### Action proposals (`src/action-proposals.ts`)

Consequential service actions are stored as idempotent proposals with action type, payload hash, targets, expected revision/preconditions, risk, expiry, evidence, policy version, reviewer, and execution result. Only a human can approve/reject. Execution uses compare-and-set status transitions and rechecks current policy and preconditions; approval alone is not authority to bypass them.

### Scheduled Jobs

- **Shared Living Memory cron** (`0 1 * * *`): nightly compression, graph pass, integration sync, cross-user contradiction detection
- **Hermes** (external and replaceable): source scouting, bounded research, maintenance proposals, and morning digest through governed MCP/API calls only. It is deployed after Pillars 1–3 and starts in read-only shadow mode.

---

## 13. Tunable Constants — Master Table

| Constant | File:Line | Value | Domain | Sensitivity |
|----------|-----------|-------|--------|-------------|
| `DUPLICATE_BLOCK_THRESHOLD` | `:43` | 0.95 | cosine sim | High — near-exact duplicate detection |
| `DUPLICATE_FLAG_THRESHOLD` | `:44` | 0.85 | cosine sim | High — triggers LLM merge/contradiction |
| `CANDIDATE_SCORE_THRESHOLD` | `:45` | 0.45 | cosine sim | Low — no LLM check below this |
| `TAG_BOOST_STEP` | `:46` | 0.15 | multiplier | Medium — per overlapping tag |
| `TAG_BOOST_MAX` | `:47` | 1.5 | multiplier | Medium — cap on tag boost |
| `CONTRADICTION_IMPORTANCE_STEP` | `:50` | 1.0 | importance shift | Medium — contradiction win/loss impact |
| `COMPRESSION_IMPORTANCE_THRESHOLD` | `:56` | 4 | importance scale | High — protects entries from compression |
| `COMPRESSION_MIN_RECALL` | `:57` | 2 | count | High — recall count protection |
| `COMPRESSION_MIN_AGE_MS` | `:58` | 60 days | ms | Medium — age floor before compression |
| `EMBEDDING_MODEL` | `:76` | BGE-small-en-v1.5 | model | **Critical** — quality ceiling |
| `LLM_MODEL` | `:27` | Llama 4 Scout 17B | model | High — classification/merge/insight |
| `CHUNK_MAX_CHARS` | `:80` | 1600 | chars | Medium — chunk granularity |
| `CHUNK_OVERLAP_CHARS` | `:81` | 200 | chars | Low — overlap between chunks |
| `CLASSIFY_MAX_TOKENS` | `:85` | 80 | tokens | Low — LLM output budget |
| `SMART_MERGE_MAX_TOKENS` | `:87` | 250 | tokens | Low — LLM output budget |
| `DIGEST_MAX_TOKENS` | `:90` | 400 | tokens | Low — LLM output budget |
| `VECTORIZE_TOP_K_MULTIPLIER` | `:97` | 3 | multiplier | Medium — initial recall width |
| `RRF_K` | `:105` | 60 | scalar | Medium — dense vs keyword balance |
| `KEYWORD_CANDIDATE_LIMIT` | `:106` | 100 | rows | Low — keyword search ceiling |
| `EDGE_INFER_THRESHOLD` | auto-link path | 0.78 | cosine sim | High — auto-link quality |
| `EDGE_INFER_MAX` | auto-link path | 3 | count | Medium — auto-link count |
| `GRAPH_MAX_HOPS` | `:262` | 3 | depth | Medium — traversal range |
| `GRAPH_FANOUT_CAP` | `:263` | 8 | edges/node | Medium — hub-node bounds |
| `GRAPH_HOP_DECAY` | `:265` | 0.6 | multiplier | Medium — distance score decay |
| `GRAPH_PASS_BACKFILL_LIMIT` | `:1861` | 25 | entries/night | Low — graph maintenance pace |
| `EDGE_PRUNE_WEIGHT` | `:1862` | 0.3 | weight | Medium — auto-edge pruning |
| `EDGE_PRUNE_MIN_AGE_MS` | `:1863` | 7 days | ms | Medium — auto-edge pruning |
| `AUTO_LINK_CONFIDENCE` | graph.ts | 0.78 | confidence | High — default for inferred edges |
| `EXPLICIT_CONFIDENCE` | graph.ts | 1.0 | confidence | High — default for user-created edges |
| `CONTRADICTION_THRESHOLD` | recall.ts | 0.85 | cosine sim | High — cross-user contradiction detection |

---

## 14. Data Science Questions

### Embedding Quality
1. BGE-small-en-v1.5 (384d) — what's the actual cosine score distribution across the corpus? Are the tier boundaries (0.45, 0.78, 0.85, 0.95) empirically validated?
2. Are there identifiable failure modes in chunking? E.g., semantic drift between chunks of long entries?
3. The `-update-` vectors are appended as separate chunks without re-embedding — what fraction of queries match an update chunk vs the main entry?

### Ranking Calibration
1. What proportion of entries fall into each importance bucket (1–5)? Is the LLM classifier using the full range?
2. What's the actual half-life of memory utility? Is 7d for task memories correct, or do they decay faster/slower?
3. The `combined = min(1.0, recency × frequency)` cap — what fraction of recall results hit the cap? Are frequently-recalled entries dominating at the expense of fresh high-quality matches?
4. `CONTRADICTION_IMPORTANCE_STEP = 1.0` — how many entries have nonzero contradiction wins/losses? What's the distribution?

### RRF Fusion
1. `k=60` favors dense results heavily (keyword needs 60× rank to match). What's the overlap between dense and keyword candidates? How many results are keyword-only?
2. Keyword weight = raw token match count — is this discriminative enough? A 3-word query matching 2 common tokens gives the same weight as matching 2 specific identifiers.

### Auto-Linking
1. `EDGE_INFER_THRESHOLD = 0.78` — what's P@3, P@5 at this threshold? How many auto-links are created per entry?
2. What's the survival rate of weak inferred edges (0.3–0.78) through the nightly prune cycle?
3. What does the graph degree distribution look like? Are there hub nodes with many edges?

### Compression
1. What fraction of entries are compressible? What fraction actually get compressed each nightly run?
2. Do compressed digests get recalled at a useful rate, or do they mostly sit unused?
3. How many tags have >10 compressible entries (triggering compression)?

### Pipeline Efficiency
1. `Vectorize.query(topK=15)` then widen to 50 if top < 0.85 — how often does the widen trigger? What's the latency impact?
2. `ctx.waitUntil()` is used extensively for async work (embedding, classification, linking, pattern derivation). What's the tail latency on these? Do they ever exceed Workers' 30s CPU limit?
3. How many entries are in the D1 database, and what's the Vectorize index size?
