# 13 — Client Credential Propagation

**What to build:** MCP server carries user credentials. Browser extension lets user select identity and stores credentials. CLI accepts credentials via flags or config. iOS shortcuts carry credentials. Obsidian plugin carries credentials. All clients send `X-Shared-Living-Memory-User` and `X-Shared-Living-Memory-User-Key` headers.

**Blocked by:** Tickets 01, 05

**Status:** ready-for-agent

---

## Files to modify

### `src/index.ts` — MCP session user context

**Modify MCP server setup (`buildMcpServer`, line 2296):**
- The MCP server receives requests via the OAuth provider
- The `userId` from OAuth props (resolved in ticket 01) should be accessible to MCP tools
- Thread `userId` from the OAuth session into the MCP tool handlers

**Modify MCP tool handlers:**
- `remember` (line 2300): Extract `userId` from session, pass to `captureEntry()`
- `append` (line 2335): Same
- `update` (line 2389): Same
- `recall` (line 2465): Extract `userId`, pass to `recallEntries()`
- `list_recent` (line 2495): Extract `userId`, pass to query builder
- `forget` (line 2526): Extract `userId`, validate ownership
- `link` (line 2544): Extract `userId`, validate visibility
- `unlink` (line 2562): Same
- `connections` (line 2580): Extract `userId`, pass to `getConnections()`

### `integrations/` — Client credential storage

**Browser extension (`integrations/browser-extension/` or similar):**
- Add user selection UI to extension popup
- Store `username` and `key` alongside existing `token` and `url`
- Send `X-Shared-Living-Memory-User` and `X-Shared-Living-Memory-User-Key` headers with all requests

**CLI (`integrations/cli/` or scripts):**
- Add `--user` and `--user-key` flags to CLI commands
- Alternatively, read from config file (`~/.shared-living-memory/config.json`)
- Send user headers with all API calls

**iOS shortcuts:**
- Add user credential fields to shortcut configuration
- Send user headers with HTTP requests

**Obsidian plugin:**
- Add user credential fields to plugin settings
- Send user headers with all API calls

### `test/integration/misc.test.ts` or new file — Client header tests
- Test: MCP tool calls include user context
- Test: Legacy MCP calls (no user) still work

---

## Acceptance criteria

- [ ] MCP captures are attributed to the calling user
- [ ] MCP recall respects the calling user's visibility
- [ ] Browser extension has user selection UI
- [ ] CLI accepts `--user` and `--user-key` flags
- [ ] iOS shortcuts carry user credentials
- [ ] Obsidian plugin carries user credentials
- [ ] All clients send correct headers
- [ ] Legacy clients (no user headers) still work
- [ ] `npm run typecheck` passes
- [ ] `npm test` passes
