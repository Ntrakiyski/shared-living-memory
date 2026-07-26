# Shared Living Memory v2 — PRD: Multi-User Shared Memory Platform

## Problem Statement

Shared Living Memory is currently a single-user tool. One deployment, one owner, one `AUTH_TOKEN`. The owner's partner and teammates cannot use it independently — there is no user identity, no ownership tracking, and no visibility controls. If the owner's partner wants to capture memories, they either share the same token (no accountability) or cannot use the system at all. There is no way to keep certain memories private while sharing others with the team. The system treats all data as belonging to a single invisible owner.

## Solution

Extend Shared Living Memory into a multi-user shared memory platform. Every user authenticates with their own credentials (username + key). Every memory tracks its owner. The `private` tag becomes system-enforced: private memories are invisible to other users, public memories are visible to the whole team. Tags become the organizing principle — workspace, project, and visibility are all tags. No separate workspace infrastructure. The team shares one brain, each person controls their own data.

---

## User Stories

### Authentication & Identity

1. As a team member, I want to connect to the Shared Living Memory deployment with my own username and key, so that my memories are attributed to me
2. As a new user, I want to create a username and receive an auto-generated key, so that I can start using the system immediately
3. As a returning user, I want to select my username from a dropdown and enter my key, so that I can access my memories quickly
4. As a user, I want my key to be shown once at creation and never stored in plaintext, so that my identity is secure
5. As a user, I want incorrect keys to be rejected with a clear error, so that I know what went wrong
6. As a user, I want the workspace key (`AUTH_TOKEN`) to still work as the first screen of authentication, so that existing setups are not disrupted
7. As a user, I want my username to be display-only and my key to prove identity, so that the system is secure by design

### Memory Ownership

8. As a user, I want every memory I create to be tagged with my user ID, so that the system knows who owns it
9. As a user, I want to see which memories are mine versus which are from teammates, so that I can track my own knowledge
10. As a user, I want the system to assign all existing (pre-migration) memories to a system user, so that no data is lost during the transition
11. As a user, I want the system user's memories to be private to that user, so that legacy data does not leak into the team's view

### Visibility & Privacy

12. As a user, I want to mark a memory as `private` by adding a tag, so that only I can see it
13. As a user, I want private memories to be invisible to other users in search, recall, and graph views, so that my sensitive data stays confidential
14. As a user, I want public memories (no `private` tag) to be visible to all registered team members, so that the team can share knowledge
15. As a user, I want the `private` tag to be system-enforced, so that no client can bypass visibility rules
16. As a user, I want to see other users' public memories in my search results, so that I benefit from the team's collective knowledge
17. As a user, I want to never see other users' private memories, so that privacy is guaranteed

### Connection Rules

18. As a user, I want my private memories to connect only to my other private memories, so that private context stays isolated
19. As a user, I want public memories to connect across users, so that the team's knowledge graph reflects shared context
20. As a user, I want the system to auto-link public memories across users when they mention the same entity, so that the graph stays connected without manual effort
21. As a user, I want the graph maintenance pipeline to respect visibility rules, so that no cross-visibility edges are created
22. As a user, I want to see cross-user public connections in the graph (e.g., "Nik and Partner both mentioned Arete"), so that I can see how team knowledge overlaps

### Memory Targeting

23. As a user, I want memories to default to public (no `private` tag) when I create them, so that the team can benefit from my knowledge
24. As a user, I want to explicitly add a `private` tag when creating a memory, so that I control visibility at creation time
25. As a user, I want to add `workspace:X` or `project:Y` tags to organize my memories, so that I can group related content
26. As a user, I want to create memories without specifying a workspace ID, so that the interface stays simple

### Retrieval & Search

27. As a user, I want search results to include my private memories and all users' public memories, so that I get comprehensive results
28. As a user, I want search results to exclude other users' private memories, so that privacy is maintained
29. As a user, I want tag-based filtering to continue working as before, so that existing workflows are not disrupted
30. As a user, I want semantic search to respect visibility rules before the LLM sees context, so that hidden memories are never surfaced

### Graph & Knowledge

31. As a user, I want the knowledge graph to show only memories I am authorized to see, so that the graph respects privacy
32. As a user, I want cross-user public connections visible in the graph, so that I can see how team knowledge connects
33. As a user, I want the system to auto-create edges between public memories that share entities, so that the graph stays rich without manual linking

### Conflict Detection

34. As a user, I want duplicate detection to scan my memories and all public memories, so that I am aware of similar content
35. As a user, I want the system to mention (not flag) when similar content exists in another user's public memories, so that I am informed without being warned aggressively
36. As a user, I want duplicate/contradiction detection to work normally within my own memories, so that my personal knowledge stays consistent

### Vector Store

37. As a user, I want vectors to include my user ID and visibility metadata, so that search can filter by ownership and privacy
38. As a user, I want Vectorize metadata filtering to be used at query time, so that search is performant and accurate
39. As a user, I want existing vectors to be re-indexed with new metadata during migration, so that no search capability is lost

### Compression

40. As a user, I want compression to run per-user, so that my memories compress independently from teammates
41. As a user, I want compression to work across my own private and public memories, so that my knowledge stays consolidated

### Export

42. As a user, I want to export my public memories, so that I have a backup of my shared knowledge
43. As a user, I want to export all public memories from all users, so that I have the team's shared knowledge
44. As a user, I want to export my private memories, so that I have a backup of my personal knowledge

### User Management

45. As a user, I want to see a dropdown of all team members when selecting who I am, so that I can identify myself
46. As a user, I want to deactivate my account, so that I can leave the team
47. As a user, I want my public memories to stay visible to the team after I deactivate, so that shared knowledge is preserved
48. As a user, I want my private memories to be deleted when I deactivate, so that my personal data is removed
49. As the workspace owner, I want to be able to deactivate other users, so that I can manage team membership

### Dashboard

50. As a user, I want the main page to show memory ownership (who created what), so that I can attribute knowledge
51. As a user, I want the main page to show visibility status (private/public) per memory, so that I can see what is shared
52. As a user, I want to filter memories by user, visibility, workspace tag, and project tag, so that I can find what I need
53. As a user, I want a user selection dropdown on the login screen, so that I can pick my identity

### Client Updates

54. As a user, I want the MCP server to carry my user credentials, so that memories created via Claude are attributed to me
55. As a user, I want the browser extension to let me select my user and store my credentials, so that captures are attributed to me
56. As a user, I want the CLI to accept my user credentials via flags or config, so that command-line captures are attributed to me
57. As a user, I want iOS shortcuts to carry my user credentials, so that mobile captures are attributed to me
58. As a user, I want the Obsidian plugin to carry my user credentials, so that Obsidian captures are attributed to me
59. As a user, I want existing single-token authentication to still work during the transition period, so that I am not forced to update all clients at once

### Migration

60. As a user, I want all existing memories to be migrated without loss, so that no data is lost during the upgrade
61. As a user, I want the server to handle both old and new auth flows during transition, so that I can update clients at my own pace
62. As a user, I want existing memories assigned to a system user, so that they are preserved but isolated from real users

---

## Implementation Decisions

### User Model

New `users` table with columns: `id`, `username`, `normalized_username`, `auth_key_hash`, `auth_key_prefix`, `status`, `created_at`, `last_used_at`. Key format: `slm_<public-user-id>.<secret>`. Storage: HMAC-SHA-256(server pepper, raw key) only. Raw key shown once at creation.

### Memory Ownership

Add `owner_user_id` column to `entries` table. Default empty string. Every query that reads or writes memories must filter by `owner_user_id` or respect visibility rules.

### Visibility Enforcement

The `private` tag is system-enforced at the application layer. When a memory has the `private` tag, only the owner can see it. When retrieving memories, the system applies a WHERE clause that excludes other users' private memories. This applies to all operations: capture, recall, list, update, append, forget, graph, export.

### Connection Rules

Edges respect visibility. Private memories connect only to the same owner's private memories. Public memories connect across users. The graph maintenance pipeline (`runGraphPass`) checks visibility before creating edges. The `createEdge` function validates that both source and target entries are visible to each other given the owner context.

### Auto-Linking

The system auto-links public memories across users when they mention the same entity. This happens during the nightly graph pass and during capture (via `inferEdgesOnWrite`). The existing cosine similarity threshold (0.78) applies. Cross-user edges are only created between public memories.

### Conflict Detection

Duplicate/contradiction detection scans the current user's memories plus all public memories. When similar content is found in another user's public memories, the system mentions it but does not flag or block. Within a user's own memories, existing duplicate/contradiction handling continues to work unchanged.

### Vector Store Migration

Add `owner_user_id` and `is_private` to Vectorize vector metadata. Use Vectorize `metadataFilter` at query time to filter by ownership and visibility. Existing vectors are re-indexed with new metadata during migration. The `storeEntry` function updates to include these metadata fields.

### Compression Pipeline

Per-user compression. Each user's memories compress independently. Cross-user compression is not needed. Within a user, compression continues to work across all their memories (private and public). The `compressTag` function is scoped to the user's entry set.

### Export Modes

Three modes: (1) My public memories — user's memories without `private` tag, (2) All public memories — all users' memories without `private` tag, (3) My private memories — user's memories with `private` tag. The existing `GET /export` endpoint is extended with a `mode` parameter.

### User Deactivation

When a user is deactivated: public memories stay visible, private memories are deleted, status changes to `inactive`. No admin role is needed for now — workspace owner can deactivate others.

### Migration Strategy

1. Create system user for existing data
2. Add `owner_user_id` column to entries
3. Assign all existing memories to system user
4. Re-index vectors with new metadata
5. Ship server changes first (backward compatible with old auth)
6. Update clients after server is stable

### Auth Headers

Every request carries:
```
Authorization: Bearer <WORKSPACE_KEY>
X-Shared-Living-Memory-User: <username>
X-Shared-Living-Memory-User-Key: <user_key>
```

The server validates the workspace key, looks up user, verifies key hash, resolves internal `user_id`.

### User List Endpoint

New `GET /api/users` endpoint returns all active usernames. Used by the dashboard user selection dropdown and by clients for user discovery.

---

## Testing Decisions

### Testing Philosophy

Only test external behavior, not implementation details. Focus on: (1) Does the user see only authorized memories? (2) Are connection rules enforced? (3) Is migration lossless? (4) Do all auth paths work?

### New Test Seams

The primary test seam is the **auth middleware** — the point where user identity is resolved and applied to all downstream queries. A second seam is the **visibility filter** applied to every query that reads memories. A third seam is the **edge creation validation** that enforces connection rules.

### Test Categories

1. **Auth tests:** Verify user creation, key verification, header parsing, legacy fallback
2. **Isolation tests:** Verify cross-user leakage is impossible — user A cannot see user B's private memories in any operation (recall, graph, export, list)
3. **Visibility tests:** Verify private tag enforcement, public memory visibility, connection rules
4. **Migration tests:** Verify existing memories are assigned to system user, vectors are re-indexed, backward compatibility works
5. **Client tests:** Verify each client sends correct headers

### Prior Art

Existing test suite (27 unit + 28 integration tests) provides the pattern. New tests follow the same vitest setup with mocked D1, mocked Vectorize, and `makeRequest` helpers. The `test/helpers/make-request.ts` helper is extended to accept user credentials.

### Critical Test Cases

- Nik cannot see partner's private memories via recall, graph, or list
- Partner cannot see Nik's private memories via recall, graph, or list
- Both can see each other's public memories
- Private memories only connect to owner's other private memories
- Public memories connect across users
- Existing memories are migrated to system user without loss
- Legacy single-token auth still works during transition
- All clients send user credentials correctly

---

## Out of Scope

- **Admin role / admin dashboard** — no role-based access beyond owner can deactivate others
- **Rate limiting** — not a priority for v2
- **Workspace API keys** — workspace is a tag, not a separate entity with its own keys
- **Public API surface** — no separate endpoints for anonymous/machine access
- **Memory-level API exposure** — no `api_exposure` field per memory
- **Status transitions** (private ↔ public) — visibility is a tag, not a state machine
- **Role-based access** (admin/editor/viewer) — everyone is a user, no roles
- **Notion sync** — commented out, not needed for v2
- **Bookmarklet** — not in the client update list (removed)

---

## Further Notes

- The existing single-file Worker architecture (`src/index.ts` ~3,500 lines) means all changes happen in one place. This is a constraint, not a choice — refactoring the Worker is out of scope.
- The `userId: "owner"` hardcoded string in the OAuth flow must be replaced with the resolved `user_id` from the users table.
- Vectorize `metadataFilter` support should be verified before committing to the vector store strategy. If not supported, fall back to post-retrieval filtering.
- The system user for migration should be created with a recognizable username (e.g., `_system`) and marked as `inactive` to distinguish it from real users.
- The dashboard (`public/index.html` ~4,681 lines) needs the user selection UI added to the auth overlay. This is the most visible change for existing users.
