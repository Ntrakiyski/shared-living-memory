# AGENTS.md

## Project: Shared Living Memory v2 — Multi-User Shared Memory

**Deployment:** [https://shared-living-memory.nikolay-trakiyski.workers.dev](https://shared-living-memory.nikolay-trakiyski.workers.dev/)

**Docs:** `docs/shared-memory/` — PRD, GOAL, task tickets, current state

## Shared Living Memory MCP Client Instructions

Use this consolidated block when configuring Claude, Codex, ChatGPT, or another MCP-capable agent to use Shared Living Memory as its durable memory.

<!-- shared-living-memory:mcp-client-instructions:start -->
You have access to Shared Living Memory through MCP. Treat it as the authoritative memory source for project context, decisions, preferences, tasks, prior discussions, evidence, and durable conclusions.

### First-run identity setup

- Personal Bearer API keys are the default connection method. The MCP client authenticates with `Authorization: Bearer <personal-api-key>`; no separate user headers are required.
- If the client does not have a personal API key yet, open `https://shared-living-memory.nikolay-trakiyski.workers.dev/` automatically when browser tools are available; otherwise give the human the link. Have them create or select their username, copy the generated personal API key, and provide it to the agent or MCP client configuration.
- The legacy workspace-key + user-header flow remains supported but is labelled legacy: `Authorization: Bearer <workspace-key>` plus `X-Shared-Living-Memory-User` and `X-Shared-Living-Memory-User-Key` headers. Prefer a personal Bearer key for new connections.
- A connection may expose a reduced tool profile (`capture`, `review`, or `full`) via the `X-SLM-Tool-Profile` header; the key holder can always select `full`.
- Never store the workspace key or personal API key with `remember`.

### Mandatory memory behavior

- Start every conversation with an intent-framed `recall`, not a bare keyword search. Good: `User wants to improve MCP resources in Shared Living Memory — what should I know?`
- Before recommendations, action items, outreach ideas, implementation plans, or repeated suggestions, call `recall` to check whether this was already recommended, completed, rejected, or superseded.
- Before asking a clarifying question, call `recall` to check whether the answer already exists. Ask only if memory is insufficient.
- Store durable information automatically with `remember`: user goals, preferences, constraints, decisions, project context, plans, tasks, commitments, important opinions, technical conclusions, and useful sources.
- Store valuable conclusions from the agent's own responses as short summaries, not full transcripts. Tag these with `agent-response` plus the client name when useful, such as `codex-response`, `claude-response`, or `chatgpt-response`.
- Respect explicit exclusions. If the user says "don't remember this", "off the record", "don't save this", or excludes a project, do not store that content unless they opt back in.
- Never store secrets, API keys, passwords, tokens, or raw private transcripts unless the user explicitly asks and it is safe to do so.

### Recall and graph behavior

- Always include both topic and intent in `recall` queries.
- Use `hops: 1` or `hops: 2` when tracing why/how something happened, when direct recall is thin, or when linked context could change the answer.
- Use `connections` to inspect one-hop neighbors around a key entry.
- Use `link` or `propose_edge` when the user identifies an important relationship between entries.
- Prefer citation-backed answers. If evidence conflicts, cite both sides, name the conflict, and suggest what should be reviewed next.

### Tool guidance

- `remember` — capture a durable note, source, decision, idea, task, or context.
- `recall` — semantic and temporal search. Use intent-framed natural language; add tags, time filters, kind, and graph hops when helpful.
- `list_recent` — browse recent entries by date or find an entry ID.
- `passages` — inspect evidence chunks and source citations for an entry.
- `history` — inspect an owned entry's immutable episodes and snapshots.
- `append` — add new information to an existing entry without replacing it.
- `update` — replace outdated entry content when the current projection should change.
- `set_status` / `set_epistemic_status` — update lifecycle or confidence state when evidence changes.
- `reinforce` — strengthen retention only when the user asks to keep a memory salient.
- `forget` — permanently delete only after explicit user instruction.
- `restore` — create a new entry from a snapshot; do not rewrite history.
- `link` / `unlink` / `connections` — manage or inspect explicit graph relationships.
- `propose_edge`, `list-proposals`, `approve-proposal`, `reject-proposal` — use proposal flow for uncertain, cross-user, or consequential relationships.
- `create_action_proposal`, `list_action_proposals`, `review_action_proposal`, `execute_approved_action` — use governed action proposals when direct action needs review, scopes, preconditions, or audit.

### Tagging and source conventions

- Use broad tags: `personal`, `work`, `task`, `idea`, `context`, `decision`, `source`, `agent-response`.
- Always tag action items and commitments with `task`.
- Add specific project, person, domain, client, repository, or product tags alongside broad tags.
- Set `source` to the client or integration identity, such as `codex`, `claude-desktop`, `chatgpt`, `browser`, `ios`, `notion`, or a service identity name.

If the Shared Living Memory MCP tools are unavailable, tell the user immediately. Do not silently fall back to built-in memory.
<!-- shared-living-memory:mcp-client-instructions:end -->

## Quick Commands

```bash
npm install              # install deps (uses legacy-peer-deps via .npmrc)
npm test                 # run all unit tests (vitest)
npm run test:watch       # watch mode
npm run test:coverage    # coverage report
npm run typecheck        # wrangler types + tsc --noEmit
npm run dev              # local dev server (wrangler dev)
```

**No lint step exists.** No ESLint, Biome, or Prettier config is present. Typecheck is the only static analysis.

## Typecheck Order

```bash
npm run typecheck        # generates worker-configuration.d.ts first, then tsc
```

`worker-configuration.d.ts` is gitignored and auto-generated by `wrangler types`. It provides `Cloudflare.Env` bindings. Never hand-edit it.

## Test Setup

- `vitest.setup.ts` mocks `agents/mcp` and `@cloudflare/workers-oauth-provider` — these can't resolve in Node.
- Tests run in `node` environment with `globals: true` (no need to import `describe`/`it`/`expect`).
- To run a single test: `npm test -- test/unit/edges.test.ts`
- **D1Mock** (`test/helpers/d1-mock.ts`, ~690+ lines) simulates D1 with `prepare().bind().all()/first()/run()`. Handler order matters — use `s.includes()` with guards.
- **`req()` helper** (`test/helpers/make-request.ts`): exactly 3 args `(method, path, opts)` where opts = `{body?, token?, userCredentials?}`.
- **User credentials in tests:** `userCredentials: { username, key }` sets `X-Shared-Living-Memory-User` / `X-Shared-Living-Memory-User-Key` headers.
- **Legacy entries** in tests use `owner_user_id: "_system"` — these are public and visible to all users.

## Architecture

**Modular Worker.** The backend is modular under `src/`. `src/index.ts` is only the Cloudflare entrypoint (wiring `apiHandler` and `defaultHandler` through `OAuthProvider` plus the cron handler). There is no router framework — URL pathname matching uses if/else chains.

**Two handler paths** wrapped in OAuthProvider:
- `apiHandler` — serves `/mcp` (MCP protocol); `resolveExternalToken` resolves personal Bearer API keys (`resolveUserByApiKey`) and service credentials (`resolveServiceCredential`)
- `defaultHandler` — all REST routes + static assets from `public/`

**Multi-user auth layers:**
1. **Personal Bearer API key** (default) — `Authorization: Bearer <personal-key>`, resolved by `resolveUserByApiKey`
2. **Service credential** — scoped service API key resolved by `resolveServiceCredential`
3. **Workspace key** (`AUTH_TOKEN`) — bootstrap/transport key only; it is never a user principal
4. **Legacy user headers** — `X-Shared-Living-Memory-User` + `X-Shared-Living-Memory-User-Key` (still supported, labelled legacy)
5. **Visibility enforcement** — `buildVisibilityClause(userId)` returns `{ sql, bind }` adding `(owner_user_id = ? OR tags NOT LIKE '%"private"%')` to queries
6. **Ownership checks** — forget/link/unlink/update verify `owner_user_id` before mutating

**Key functions:**
- `buildVisibilityClause(userId)` — `{ sql, bind }` for per-user scoping (`src/tags.ts`)
- `resolveUser(request, env)` — validates legacy user headers against `users` (`src/auth.ts`)
- `resolveUserByApiKey(key, env)` — resolves a personal Bearer API key (`src/auth.ts`)
- `requireAuthAsync(request, env)` — auth gate returning `{ error, user_id, username }` (`src/auth.ts`)
- `forgetEntry(id, env)` — deletes entry + cascades edges/vectors, no ownership check (caller must check) (`src/lifecycle.ts`)
- `escapeLikePattern(s)` — escapes `%` and `_` for LIKE queries (`src/helpers.ts`)
- `compressionEligibilitySql(prefix, ownerUserId?)` — per-user compression scope (`src/config.ts`)

**Database tables:**
- `entries` — `id, content, tags, source, vector_ids, created_at, recall_count, importance_score, owner_user_id, ...`
- `edges` — `id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at`
- `users` — `id, username, normalized_username, auth_key_hash, auth_key_prefix, status, created_at`

**Integrations** (`src/integrations/`) use a provider pattern:
- `framework.ts` — interfaces (`IntegrationProvider`, `MirrorStore`)
- `index.ts` — registry (currently: Notion only)
- `notion.ts` — Notion sync implementation

## Key Gotchas

- **Personal Bearer is the default auth.** A personal API key (`slm_xxx.yyy`) goes in `Authorization: Bearer <key>`. The legacy two-header flow (`X-Shared-Living-Memory-User` + `X-Shared-Living-Memory-User-Key`) plus the workspace transport key remains supported but is labelled legacy.
- **`AUTH_TOKEN` is the workspace bootstrap key only.** It is never a user principal. Personal API keys go in the Bearer header; the legacy user headers carry `X-Shared-Living-Memory-User-Key`. Confusing these causes "Invalid credentials".
- **`forgetEntry()` has no ownership check.** Always verify `owner_user_id` BEFORE calling it. The REST `POST /forget` and MCP `forget` handlers do this; direct calls don't.
- **`_system` user** owns all pre-migration entries (public, visible to everyone). Their `status` is `'inactive'` so they can't authenticate.
- **Visibility clause format:** `(owner_user_id = ? OR tags NOT LIKE '%"private"%')`. Private entries must include `"private"` in the JSON tags array.
- **`escapeLikePattern(s)` must be used** on any user-supplied value going into a `LIKE` pattern. Missing escapes allow % and _ injection.
- **No `node_modules` in tests.** `agents/mcp` and `@cloudflare/workers-oauth-provider` are mocked in `vitest.setup.ts`. If you add a new Cloudflare binding import, it likely needs a mock.
- **`ctx.waitUntil()` is used heavily.** Async work (vectorization, classification, pattern derivation) runs outside the request lifecycle. Don't await these in request handlers.
- **Tags are metadata.** `status:*` and `kind:*` tags are reserved prefixes — no schema column backs them. Adding new metadata is a tag convention, not a migration.
- **Edges are code-validated.** Edge types live in `EDGE_TYPES` in `src/graph.ts`, not SQL constraints. Adding a type is a one-line change.
- **D1 bound params capped at 100.** All batch queries chunk IDs with `D1_MAX_BOUND_PARAMS`.
- **Vectorize rejects >20 IDs per `getByIds` call.** Tag-scoped recall batches with `VECTORIZE_GET_BY_IDS_BATCH`.
- **Vectorize topK capped at 50** when `returnMetadata="all"`. The recall path uses a multiplier then widens conditionally.
- **No `.env` file.** Cloudflare Workers use `.dev.vars` for local secrets (copy `.dev.vars.example`).

## Cloudflare Resources

Configured in `wrangler.jsonc`:
- D1: `DB` (entries + edges)
- Vectorize: `VECTORIZE` (384-dim, cosine)
- AI: `AI` (embeddings + LLM)
- KV: `OAUTH_KV` (OAuth + integration state)
- Cron: `0 1 * * *` (nightly compression + graph pass + sync)

## Database

`db/schema.sql` defines tables: `entries`, `edges`, `users`. The Worker also runs `CREATE TABLE IF NOT EXISTS` and `ALTER TABLE ADD COLUMN` on startup in `initializeDatabase()` — schema changes can go in either place, but the startup code is what actually matters for existing deployments.

- `users` table: `id, username, normalized_username, auth_key_hash, auth_key_prefix, status, created_at`
- User auth keys are never stored — only the HMAC-SHA-256 hash (`auth_key_hash`) of the secret portion
- The `owner_user_id` column on entries was added via migration; startup backfills unowned entries to `_system`

## Coverage

Coverage includes `src/**/*.ts` and `public/utils.js`. Reports go to `coverage/` (gitignored).
