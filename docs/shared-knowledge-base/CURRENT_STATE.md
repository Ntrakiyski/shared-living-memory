# CURRENT_STATE.md

> Baseline snapshot of the Shared Living Memory architecture. Keep this file current as the foundation evolves.

## What Is Shared Living Memory?

A personal, self-hosted memory layer for AI tools. It gives Claude, ChatGPT, Cursor, Codex, and every other AI client access to the same persistent memory via the Model Context Protocol (MCP). The memory is stored in the user's own Cloudflare account — no third-party lock-in.

## Technology Stack

| Layer | Technology |
|---|---|
| Runtime | Cloudflare Workers |
| Database | Cloudflare D1 (SQLite) |
| Vector search | Cloudflare Vectorize (384-dim, cosine) |
| AI inference | Workers AI (Llama 4 Scout for classification/merge, BGE-small-en-v1.5 for embeddings) |
| Auth | Static AUTH_TOKEN + OAuth 2.0 via `@cloudflare/workers-oauth-provider` |
| Protocol | MCP via `@modelcontextprotocol/sdk` |
| Language | TypeScript |
| Tests | Vitest |
| Deploy | Wrangler |

## Repository Structure

```
shared-living-memory/
├── src/
│   ├── index.ts              # Single-file Worker: all routes, MCP tools, core logic
│   └── integrations/
│       ├── framework.ts       # Provider-agnostic sync/mirror interface
│       ├── index.ts           # Provider registry
│       └── notion.ts          # Notion provider implementation
├── db/
│   └── schema.sql            # D1 schema (entries + edges tables)
├── public/                   # Dashboard SPA (served as static assets)
│   ├── index.html
│   └── utils.js
├── test/
│   ├── unit/                 # 27 unit test files
│   ├── integration/
│   ├── ui/
│   └── helpers/
├── scripts/                  # Client connection scripts
├── integrations/             # External integrations (iOS shortcuts, bookmarklet)
├── wrangler.jsonc            # Cloudflare Worker config
├── vitest.config.ts
└── package.json
```

## Core Architecture

### Single-File Worker (`src/index.ts`)

The entire backend lives in one ~3,500-line Worker. It exposes two handler paths wrapped in an OAuth provider:

1. **`apiHandler`** — serves `/mcp` (MCP protocol endpoint)
2. **`defaultHandler`** — serves all REST routes and static assets
3. **`scheduled`** — nightly cron for compression, graph maintenance, and integration sync

### Data Model

**`entries` table** — the memory store:

| Column | Type | Purpose |
|---|---|---|
| `id` | TEXT PK | UUID |
| `content` | TEXT | Memory text |
| `tags` | TEXT (JSON array) | User tags + system tags (`status:*`, `kind:*`, `synthesized`, `rolled-up`, etc.) |
| `source` | TEXT | Origin: `api`, `claude`, `phone`, `browser`, `notion`, etc. |
| `created_at` | INTEGER | Unix ms timestamp |
| `vector_ids` | TEXT (JSON array) | Vectorize vector IDs for this entry |
| `recall_count` | INTEGER | How many times recalled |
| `importance_score` | INTEGER | AI-classified 1–5 |
| `contradiction_wins` | INTEGER | Times this entry won a contradiction |
| `contradiction_losses` | INTEGER | Times this entry lost a contradiction |

**`edges` table** — the relationship graph:

| Column | Type | Purpose |
|---|---|---|
| `id` | TEXT PK | UUID |
| `source_id` | TEXT | Entry ID |
| `target_id` | TEXT | Entry ID |
| `type` | TEXT | Edge type (see below) |
| `weight` | REAL | 0–1 confidence |
| `provenance` | TEXT | `explicit` (user), `inferred` (auto), `system` (lifecycle) |
| `metadata` | TEXT (JSON) | Escape hatch for future per-edge attributes |

**Edge types:** `relates_to`, `supersedes`, `caused_by`, `decided`, `about_person`, `part_of_project`, `follows`

### Memory Lifecycle Tags

Tags prefixed with `status:` and `kind:` are reserved system tags — no schema change needed:

- **Status** (`status:canonical`, `status:draft`, `status:deprecated`) — lifecycle state
- **Kind** (`kind:episodic`, `kind:semantic`) — memory type classification

### MCP Tools

Registered in `buildMcpServer()`:

| Tool | Description |
|---|---|
| `remember` | Store a memory (runs duplicate/contradiction pipeline) |
| `append` | Add an update to an existing memory |
| `update` | Replace an existing memory entirely |
| `recall` | Semantic search with hybrid keyword+vector retrieval |
| `list_recent` | Browse recent memories by time |
| `forget` | Permanently delete a memory |
| `link` | Create an explicit edge between two memories |
| `unlink` | Remove an edge between two memories |
| `connections` | List 1-hop neighbors of an entry |
| `set_status` | Set lifecycle status (canonical/draft/deprecated) |

### REST API Routes

All routes require `Authorization: Bearer <AUTH_TOKEN>`:

| Method | Path | Description |
|---|---|---|
| POST | `/capture` | Store a memory |
| POST | `/append` | Append to existing memory |
| POST | `/update` | Replace memory content |
| GET | `/recall` | Semantic search |
| GET | `/list` | List recent entries |
| GET | `/count` | Entry count |
| GET | `/tags` | All distinct tags |
| GET | `/stats` | Dashboard statistics |
| GET | `/health` | Vectorize index health |
| GET | `/export` | Full backup (entries + edges) |
| POST | `/forget` | Delete entry |
| POST | `/link` | Create edge |
| POST | `/unlink` | Remove edge |
| GET | `/connections` | 1-hop neighbors |
| GET | `/graph` | Node+edge subgraph for visualization |
| GET | `/entry` | Single entry by ID |
| POST | `/status` | Set lifecycle status |
| POST | `/digest` | Compress tag into summary |
| POST | `/chat` | LLM chat over memories |
| POST | `/vectorize-pending` | Re-embed entries missing vectors |
| POST | `/classify-pending` | Backfill status/kind tags |
| POST | `/patterns/resolve` | Confirm or dismiss auto-derived patterns |
| GET | `/integrations` | List connected integrations |
| POST | `/integrations/:provider/(connect\|sync\|disconnect)` | Manage integrations |

## Core Pipelines

### 1. Capture Pipeline (`captureEntry`)

```
raw content
  → extract hashtags
  → checkDuplicateAndContradiction (embed + Vectorize query)
    → blocked (≥0.95): reject
    → flagged (0.85–0.95): smart merge via LLM (keep_both / replace / merge / contradiction)
    → unique: insert
  → insert into D1
  → storeEntry (chunk + embed + insert vectors)
  → classifyEntry (async: importance + canonical + kind)
  → inferEdgesOnWrite (auto-link to similar neighbors)
```

### 2. Recall Pipeline (`recallEntries`)

```
query
  → parseTimePhrase (extract temporal filters)
  → embed query + inferQueryTags
  → hybrid retrieval:
    → Vectorize query (dense)
    → keyword search (LIKE on content)
    → RRF fusion (Reciprocal Rank Fusion)
  → fetch recall_count, importance_score, contradiction stats
  → rerankWithTimeDecay (half-life per tag, frequency boost, importance, tag boost)
  → dedupe by parent ID
  → optional graph expansion (hops 0–3)
  → hydrate from D1
  → synthesizeInsight (LLM summary over results)
  → derivePattern (async: auto-detect recurring themes)
```

### 3. Nightly Cron (`scheduled`)

Runs at `0 1 * * *` (1 AM daily):

1. **Compression** — compress tags with >10 eligible entries into synthesized digests
2. **Graph maintenance** — prune weak inferred edges, backfill unlinked entries
3. **Integration sync** — sync connected providers (e.g., Notion)

### 4. Duplicate Detection

Three-tier system using Vectorize cosine similarity:

| Score | Action |
|---|---|
| ≥ 0.95 | **Blocked** — near-exact duplicate rejected |
| 0.85–0.95 | **Flagged** — LLM decides: keep_both, replace, merge, or contradiction |
| 0.45–0.85 | LLM checks for contradiction only |
| < 0.45 | Treated as unique |

### 5. Contradiction Resolution

When a new memory contradicts an existing one:
- If existing is **canonical** → new entry becomes `status:draft`, existing wins
- If existing is **not canonical** → new entry wins, existing deprecated, `supersedes` edge created
- Both get `contradiction_wins` / `contradiction_losses` incremented

### 6. Semantic Compression

Nightly pass compresses low-value entries tagged together:
- Requires ≥10 eligible entries with the same tag
- Eligibility: importance < 4, recalled < 2 times (or < 2 recalls and older than 60 days), no contradiction wins
- Creates a `synthesized` entry, marks originals as `rolled-up`

### 7. Graph Traversal (`expandGraph`)

BFS from seed nodes through the `edges` table:
- Max 3 hops
- Fanout cap: 8 edges per node per hop (strongest first)
- Max 50 total expanded nodes
- Skips `status:deprecated` nodes by default
- Each hop decays score by `GRAPH_HOP_DECAY = 0.6`

### 8. Reranking

`rerankWithTimeDecay` applies multipliers to raw similarity scores:
- **Time decay** — half-life varies by tag (task: 7d, work: 90d, context: 180d, default: 30d)
- **Frequency** — `1 + log1p(recall_count)`, capped at 1.0
- **Importance** — 0.88–1.20 band based on AI score + contradiction history
- **Tag boost** — up to 1.5× for tag-relevant memories
- **Append penalty** — 0.2× for short update chunks
- **Rolled-up penalty** — 0.4× for compressed entries

## Integrations Framework (`src/integrations/`)

Provider-agnostic mirror system for external sources:

- **`framework.ts`** — defines `IntegrationProvider` interface, `MirrorStore` write surface, KV-based state persistence
- **`index.ts`** — provider registry (currently: Notion only)
- **`notion.ts`** — full Notion sync: search listing, block fetching, content flattening, incremental sync

**Key design decisions:**
- State lives in `OAUTH_KV` under `integrations:<provider>` — no schema migration needed
- Mirrors bypass the capture pipeline (dedupe by external item ID)
- Edit guard: mirrored entries redirect edits to the source tool while connected
- Sync is bounded per call (respects Workers subrequest limits)

## Testing

27 unit test files covering:
- Core pipelines: capture, recall, classification, compression
- Data processing: chunking, hashtag extraction, temporal parsing, tokenization
- Graph: edges, auto-linking, graph pass
- Search: reranking, RRF fusion, cosine similarity
- Integrations: Notion provider
- Utilities: MCP tool list sanitization, vectorize health

Run with: `npm test` (vitest)

## Key Constants

| Constant | Value | Purpose |
|---|---|---|
| `DUPLICATE_BLOCK_THRESHOLD` | 0.95 | Near-exact duplicate rejection |
| `DUPLICATE_FLAG_THRESHOLD` | 0.85 | Smart merge band |
| `CANDIDATE_SCORE_THRESHOLD` | 0.45 | Minimum for contradiction check |
| `CHUNK_MAX_CHARS` | 1600 | Max vector chunk size |
| `CHUNK_OVERLAP_CHARS` | 200 | Overlap between chunks |
| `GRAPH_MAX_HOPS` | 3 | Max BFS depth |
| `GRAPH_FANOUT_CAP` | 8 | Max edges per node per hop |
| `GRAPH_MAX_NODES` | 50 | Max expanded nodes |
| `GRAPH_HOP_DECAY` | 0.6 | Score decay per hop |
| `EDGE_INFER_THRESHOLD` | 0.78 | Min similarity for auto-linking |
| `EDGE_INFER_MAX` | 3 | Max inferred links per entry |
| `RRF_K` | 60 | Reciprocal Rank Fusion dampening |
| `EMBEDDING_MODEL` | `@cf/baai/bge-small-en-v1.5` | 384-dim embeddings |
| `LLM_MODEL` | `@cf/meta/llama-4-scout-17b-16e-instruct` | Classification/merge LLM |

## Cloudflare Resources

| Resource | Binding | Purpose |
|---|---|---|
| D1 Database | `DB` | Entries + edges storage |
| Vectorize | `VECTORIZE` | Semantic search index (384-dim, cosine) |
| Workers AI | `AI` | Embeddings + LLM inference |
| KV | `OAUTH_KV` | OAuth tokens + integration state |
| Cron | `0 1 * * *` | Nightly compression + graph pass + sync |

## Known Patterns & Conventions

- **Non-fatal error handling** — nearly every external call (Vectorize, AI, DB) catches errors and logs them rather than failing the request. The system is designed to degrade gracefully.
- **`waitUntil` for async work** — vectorization, classification, pattern derivation, and edge inference run asynchronously via `ctx.waitUntil()` so the response returns immediately.
- **Tags as metadata** — status, kind, and other metadata live as prefixed tags rather than schema columns. Adding new metadata is a tag convention, not a migration.
- **Edges validated in code** — edge types and rules are defined in `EDGE_TYPES` registry, not SQL CHECK constraints. Adding a new type is a one-line code change.
- **KV for integration state** — integration records use the already-provisioned `OAUTH_KV` namespace, avoiding new resources per provider.
- **Mirror bypass** — integration-synced entries skip the capture pipeline's duplicate/contradiction detection since the external tool is the source of truth.
