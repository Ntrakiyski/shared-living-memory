# Shared Living Memory v2 — Product Goal

## Vision

Extend Shared Living Memory from a single-user personal memory tool into a multi-user shared memory platform. The existing memory model (entries + edges + tags) is preserved and extended. Tags become the organizing principle — workspace, project, private/public are all tags. No separate workspace infrastructure.

---

## What Changes

| Current (v1) | Next (v2) |
|---|---|
| One deployment, one owner | One deployment, multiple users |
| Single AUTH_TOKEN | Workspace key + per-user authentication keys |
| No ownership tracking | Every memory has an owner (owner_user_id) |
| No visibility rules | System-enforced `private` tag: only owner can see |
| No connection visibility rules | Private memories connect only to owner's private memories |
| All clients use one token | All clients carry per-user credentials |

## What Stays the Same

- Memory model: entries + edges + tags
- Tag structure continues to work
- MCP tools (remember, recall, list_recent, forget, link, etc.)
- REST API endpoints
- Cloudflare Workers + D1 + Vectorize stack
- Semantic search, duplicate detection, contradiction handling
- Nightly compression and graph maintenance
- Existing deployment URL + workspace key flow (first screen)

---

# 1. Core Principle

**Memory is the identity. Tags are the organizing principle.**

A user dumps data and sets tags. Tags can indicate:
- **Workspace** (e.g., `workspace:arete`) — team-level grouping
- **Project** (e.g., `project:shared-living-memory`) — project-level grouping
- **Visibility** (`private`) — system-enforced: only the owner can see

No separate workspace table. No workspace_memberships. No workspace API keys. A "workspace" is just a tag on a memory.

---

# 2. Authentication

Two-screen flow:

**Screen 1:** Connect to Shared Living Memory (same as today)
- Worker URL
- Workspace key (`AUTH_TOKEN`)

**Screen 2:** Who are you?
- Select existing username → enter their key
- Create new username → key is generated automatically

Every request carries:

```http
Authorization: Bearer <WORKSPACE_KEY>
X-Shared-Living-Memory-User: nik
X-Shared-Living-Memory-User-Key: <USER_AUTH_KEY>
```

The server:
1. Validates workspace key
2. Looks up user by normalized username
3. Verifies user key hash
4. Resolves internal `user_id`
5. Uses `user_id` for all operations

**Rule:** The username is display-only. The key proves identity. The internal user ID is the trusted reference.

---

# 3. User Model

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  normalized_username TEXT NOT NULL UNIQUE,
  auth_key_hash TEXT NOT NULL,
  auth_key_prefix TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
```

- Key format: `slm_<public-user-id>.<secret>`
- Storage: HMAC-SHA-256(server pepper, raw key) only
- Raw key shown once at creation, never retrievable
- Username: 3–32 chars, letters/numbers/`_`/`-`, case-insensitive unique

---

# 4. User Deactivation

When a user is deactivated (leaves the team):
- **Public memories** stay visible to the team
- **Private memories** are deleted
- The user's status changes to `inactive` in the users table
- No admin concept is needed for now — any user can deactivate themselves, or the deployment owner can deactivate others

---

# 5. Memory Ownership

Every memory gains one column:

```sql
ALTER TABLE entries ADD COLUMN owner_user_id TEXT NOT NULL DEFAULT '';
```

Tags continue to work as before. `owner_user_id` identifies who created the memory.

---

# 6. Visibility Rules

## The `private` tag

The tag `private` is system-enforced:
- If a memory has the `private` tag, only the owner (`owner_user_id`) can see it
- If a memory does not have the `private` tag, it is public — all registered users can see it
- Public means: all team members can read. Not anonymous internet access.

## Retrieval filtering

When a user retrieves memories:
- Always see their own memories (private + public)
- See other users' public memories only
- Never see other users' private memories

---

# 7. Connection Rules

Edges (links between memories) respect visibility:

- **Private ↔ Private (same owner):** Allowed. A user's private memories can connect to each other.
- **Private ↔ Private (different owner):** Blocked. Cannot create edges between different users' private memories.
- **Private ↔ Public:** Blocked. Cannot connect a private memory to any public memory.
- **Public ↔ Public:** Allowed. Any user's public memories can connect to any other user's public memories.

When the graph maintenance pipeline runs, it respects these rules. No cross-visibility edges are created.

---

# 8. Memory Targeting

When creating a memory (via MCP `remember`, REST `/capture`, CLI, etc.):

- **Default:** Memory goes to the user's public pool (no `private` tag)
- **Explicit:** User adds `private` tag to restrict visibility
- **Workspace/Project tags:** User adds `workspace:X` or `project:Y` tags as needed

The client does not need to specify a workspace ID. Tags determine scope.

---

# 9. Retrieval & Search

When searching/recalling:
- Filter by user ownership and visibility before semantic search
- Private memories of other users are excluded from results
- Public memories of all users are included in results
- Tag-based filtering continues to work as before

---

# 10. Graph Traversal

When building the knowledge graph:
- Edges respect visibility rules (Section 7)
- Graph queries return only memories the user is authorized to see
- Cross-user public connections are visible (e.g., "Nik and Partner both mentioned Arete")
- **Auto-linking:** The system auto-links public memories across users when they mention the same entity (e.g., both mention "Arete" → edge created)

---

# 11. Conflict Detection

When detecting duplicates or contradictions:
- Scan the current user's memories + all public memories
- **Don't flag** duplicates across users — just mention if the same content exists elsewhere
- The system notes the similarity but does not block or warn aggressively
- Within a user's own memories, existing duplicate/contradiction handling continues to work

---

# 12. Vector Store

Vectors currently have no user/workspace metadata. After migration:

- Add `owner_user_id` to vector metadata
- Add visibility metadata (`is_private: true/false`)
- Filter at query time using Vectorize `metadataFilter`
- Existing vectors are re-indexed with new metadata during migration

---

# 13. Compression Pipeline

Currently compresses all memories together. After v2:

- Compress per-user: each user's memories compress independently
- Cross-user compression is not needed (different users have different contexts)
- Within a user, compression continues to work across all their memories (private and public)

---

# 14. Export

Three export modes:

1. **My public memories** — all memories owned by the user without the `private` tag
2. **All public memories** — all memories from all users without the `private` tag
3. **My private memories** — all memories owned by the user with the `private` tag

---

# 15. Migration

All existing data must be migrated without loss:

1. **Create system user:** A special "system" user (development user) is created for migration. This user is not linked with other users' memories — their memories are private to the system user.
2. **Add column:** `owner_user_id` to entries table, default empty string
3. **Assign ownership:** All existing memories get `owner_user_id` = system user
4. **Re-index vectors:** Add `owner_user_id` and `is_private` to vector metadata
5. **Backward compatibility:** Existing clients continue to work during migration — if no user credentials are present, treat the request as belonging to the system user
6. **Rollout:** Ship server changes first, then update clients

---

# 16. Client & Connection Updates

Every client that talks to the Shared Living Memory server must carry user credentials after migration. All clients update from single AUTH_TOKEN to user+key authentication.

## 16.1 MCP Server

The MCP server (stdio-based, invoked by Claude Desktop, Claude Code, Cursor, etc.) currently reads `AUTH_TOKEN` from environment. It must:
- Accept user key and username as additional config/env vars
- Send all requests with user headers (`X-Shared-Living-Memory-User`, `X-Shared-Living-Memory-User-Key`)
- Update README and setup docs with new config fields

## 16.2 REST API Clients

Any HTTP client calling the REST API:
- Must include `X-Shared-Living-Memory-User` and `X-Shared-Living-Memory-User-Key` headers
- Existing single-token requests are treated as legacy (still accepted during transition)
- After migration, all new requests must carry user credentials

## 16.3 CLI

The CLI tool must:
- Accept `--user` and `--user-key` flags (or equivalent config)
- Update `.env` or config file to store user credentials
- Continue working with just the workspace key during transition

## 16.4 Browser Extension

The Chrome/Firefox extension must:
- Add user selection/credential input UI
- Store per-user credentials locally (encrypted at rest)
- Send user headers with every request
- Allow switching between users without re-entering deployment URL

## 16.5 iOS Shortcuts

The iOS Shortcuts integration must:
- Accept user credentials as shortcut parameters or via config
- Send user headers with every request
- Allow switching users via shortcut selection

## 16.6 Obsidian Plugin

The Obsidian community plugin must:
- Add user credential fields to settings
- Send user headers with every request
- Work during transition (graceful fallback to legacy auth)

---

# 17. Dashboard

Expand the main page to better visualize memories with the new features:

- **User selection (step 2):** Dropdown showing all created users. New users can be created from here.
- Show memory ownership (who created what)
- Show visibility status (private/public) per memory
- Show team-wide public memories
- Filter by user, visibility, workspace tag, project tag
- Simple, clean interface — not over-engineered

**User list endpoint:** A new API endpoint returns all usernames (for the dropdown). This is needed for the dashboard and for knowing who to share with.

---

# 18. Security Rules

- **Owner tracking** — every memory has `owner_user_id`, never empty after migration
- **Private tag is system-enforced** — cannot be bypassed by clients
- **Authorization before context** — filter memories before the LLM sees anything
- **Key shown once** — raw secrets never stored, logged, or returned by API
- **LLM proposes, policy decides** — contradiction resolution goes to human review for risky cases

---

# 19. Build Order

1. Users and authentication
2. Memory ownership (`owner_user_id` column)
3. Visibility rules (`private` tag enforcement)
4. Connection rules (edge visibility)
5. Vector store migration (add metadata, re-index)
6. Compression pipeline (per-user)
7. Export modes
8. Dashboard expansion
9. Client updates (MCP, REST, CLI, extension, shortcuts, Obsidian)
10. Isolation tests (cross-user leakage)

**Rule:** Never trade isolation, provenance, or auditability for smarter-looking memory behaviour.

---

# 20. Acceptance Criteria

1. Existing URL + workspace key flow still works
2. User selection screen appears after workspace-key auth
3. New users can be created with auto-generated keys
4. Raw keys are shown once, only hashes stored
5. Incorrect keys are rejected
6. Every memory has `owner_user_id`
7. Nik cannot see partner's private memories
8. Both can see each other's public memories
9. Private memories only connect to owner's other private memories
10. Public memories connect across users
11. MCP clients authenticate as one user
12. REST requests authenticate as one user
13. Existing memories are migrated without loss
14. All cross-user isolation tests pass
15. Browser extension sends user credentials with every request
16. CLI sends user credentials with every request
17. iOS shortcuts send user credentials with every request
18. Obsidian plugin sends user credentials with every request
19. Export works for all three modes (my public, all public, my private)
20. User list endpoint returns all usernames
21. User deactivation works (public stays, private deleted)

---

# 21. Definition of Done

The project is complete when:

1. Every user authenticates with username + key
2. Every memory has an owner
3. Private memories are invisible to other users
4. Public memories are visible to all registered users
5. Connection rules are enforced (private ↔ private same owner, public ↔ public)
6. Raw keys are shown once and never stored
7. Vector store respects ownership and visibility
8. All cross-user leakage tests pass with zero failures
9. All clients carry user credentials
10. Legacy single-token auth still works during transition period
11. Zero data loss during migration
12. Export works for all three modes
13. User deactivation works correctly
14. Dashboard shows user selection and memory ownership
