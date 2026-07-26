# Shared Living Memory v2 — Multi-User Shared Memory Platform

## What This Is

Shared Living Memory is a Cloudflare Worker-based personal memory platform. Single-file Worker (`src/index.ts`, ~3,500 lines), single-page dashboard (`public/index.html`, ~4,681 lines). Currently single-user. This project extends it to multi-user with ownership, visibility, and team sharing.

**Source of truth:** `PRD.md` — full user stories, implementation decisions, testing decisions, out-of-scope items.

**Project conventions:** `shared-living-memory/AGENTS.md` — commands, architecture, gotchas, test setup.

## How To Start

1. Read `PRD.md` for the full specification
2. Read `shared-living-memory/AGENTS.md` for project conventions and commands
3. Read this file for ticket order and current status
4. Pick the first ticket with no incomplete blockers (see table below)
5. Read the ticket file in `tasks/` for exact file changes needed
6. Implement, run `npm run typecheck && npm test`, mark done

## Quick Commands

```bash
cd shared-living-memory
npm install              # install deps (uses legacy-peer-deps via .npmrc)
npm test                 # run all unit tests (vitest)
npm run typecheck        # wrangler types + tsc --noEmit
npm run dev              # local dev server (wrangler dev)
```

No lint step. Typecheck is the only static analysis.

## Tech Stack

- **Runtime:** Cloudflare Workers (single-file Worker)
- **Database:** D1 (SQLite), Vectorize (384-dim cosine), KV
- **AI:** Cloudflare AI (embeddings + LLM)
- **Testing:** Vitest with mocked D1/Vectorize/KV
- **Frontend:** Vanilla HTML/CSS/JS (single page, no framework)
- **Auth:** HMAC-SHA-256 keys, Web Crypto API

## Installed Skills

Cloudflare skills are installed locally in `.agents/skills/`:
- `workers-best-practices` — code review, anti-patterns
- `wrangler` — CLI guidance
- `cloudflare` — platform docs
- `durable-objects`, `agents-sdk`, `sandbox-sdk` — if needed
- `web-perf`, `turnstile-spin`, `cloudflare-email-service` — if needed

MCP servers configured in `~/.config/opencode/opencode.json`:
- `cloudflare` (OAuth), `cloudflare-docs`, `cloudflare-bindings`, `cloudflare-builds`, `cloudflare-observability`

## Dependency Graph

```
01 (Auth Infrastructure)
├── 02 (User Creation & Dashboard)
├── 03 (Migration & Ownership)
│   └── 04 (Entry Ownership on Write)
│       ├── 05 (Visibility Enforcement)
│       │   ├── 06 (Dashboard Login) ── 07 (Dashboard Display)
│       │   ├── 08 (Graph Visibility)
│       │   ├── 10 (Conflict Detection)
│       │   ├── 11 (Export Modes)
│       │   └── 12 (User Management)
│       ├── 09 (Vector Metadata) ── 10
│       └── 14 (Per-User Compression)
└── 13 (Client Credentials)
```

## Tickets

| # | Ticket | Blocked by | Status |
|---|--------|------------|--------|
| 01 | [Auth Infrastructure & User Model](01-auth-infrastructure.md) | None | ✅ done |
| 02 | [User Creation & Dashboard Registration](02-user-creation-dashboard.md) | 01 | ✅ done |
| 03 | [Migration & Ownership Assignment](03-migration-ownership.md) | 01 | ✅ done |
| 04 | [Entry Ownership on Write](04-entry-ownership-write.md) | 01, 03 | ✅ done |
| 05 | [Visibility Enforcement (Backend)](05-visibility-enforcement.md) | 04 | ✅ done |
| 06 | [Dashboard Login & User Selection](06-dashboard-login.md) | 02, 05 | ✅ done |
| 07 | [Dashboard Ownership & Visibility Display](07-dashboard-ownership-display.md) | 05, 06 | ✅ done |
| 08 | [Graph & Connection Visibility](08-graph-visibility.md) | 05 | ✅ done |
| 09 | [Vector Metadata & Filtering](09-vector-metadata.md) | 04 | ✅ done |
| 10 | [Cross-User Conflict Detection](10-cross-user-conflict.md) | 05, 09 | ✅ done |
| 11 | [Export Modes](11-export-modes.md) | 05 | ✅ done |
| 12 | [User Management & Deactivation](12-user-management.md) | 01, 05 | ✅ done |
| 13 | [Client Credential Propagation](13-client-credentials.md) | 01, 05 | ✅ done |
| 14 | [Per-User Compression](14-per-user-compression.md) | 04, 05 | ✅ done |

## Execution Strategy

Sequential implementation, one ticket at a time. Tickets 02+03 can technically parallelize after 01, but we edit the same files so sequential is safer.

**Recommended order:** 01 → 03 → 04 → 05 → 09 → 02 → 06 → 07 → 08 → 10 → 11 → 12 → 13 → 14

**Start here:** Ticket 01 — `tasks/01-auth-infrastructure.md`

## Key Files

| File | Lines | Purpose |
|------|-------|---------|
| `src/index.ts` | ~3,500 | Single-file Worker — all backend logic |
| `public/index.html` | ~4,681 | Dashboard — single-page app |
| `db/schema.sql` | 37 | Database schema (entries + edges) |
| `test/helpers/make-env.ts` | 71 | Test environment builder |
| `test/helpers/make-request.ts` | 17 | Authenticated request helper |
| `test/integration/auth.test.ts` | 37 | Current auth tests |
| `AGENTS.md` | 72 | Project conventions |

## Completed Tickets

All 14 tickets complete. 702/702 tests passing.

| # | Ticket | Completed |
|---|--------|-----------|
| 01 | Auth Infrastructure & User Model | ✅ |
| 02 | User Creation & Dashboard Registration | ✅ |
| 03 | Migration & Ownership Assignment | ✅ |
| 04 | Entry Ownership on Write | ✅ |
| 05 | Visibility Enforcement (Backend) | ✅ |
| 06 | Dashboard Login & User Selection | ✅ |
| 07 | Dashboard Ownership & Visibility Display | ✅ |
| 08 | Graph & Connection Visibility | ✅ |
| 09 | Vector Metadata & Filtering | ✅ |
| 10 | Cross-User Conflict Detection | ✅ |
| 11 | Export Modes | ✅ |
| 12 | User Management & Deactivation | ✅ |
| 13 | Client Credential Propagation | ✅ |
| 14 | Per-User Compression | ✅ |
