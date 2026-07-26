# 01 — Auth Infrastructure & User Model

**What to build:** A `users` table with secure key storage. Auth middleware that resolves `(username, key)` from request headers against the workspace key (`AUTH_TOKEN`). Legacy single-key auth continues to work. The system is ready for multi-user but no data changes yet.

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

---

## Files to modify

### `db/schema.sql` — Add users table
- **After line 17** (after the entries indexes): Add `CREATE TABLE IF NOT EXISTS users` with columns:
  - `id TEXT PRIMARY KEY` (UUID)
  - `username TEXT NOT NULL UNIQUE`
  - `normalized_username TEXT NOT NULL UNIQUE`
  - `auth_key_hash TEXT NOT NULL` (HMAC-SHA-256 of raw key, server-peppered)
  - `auth_key_prefix TEXT NOT NULL` (first 8 chars of secret part, for lookup hints)
  - `status TEXT NOT NULL DEFAULT 'active'` (`'active'` | `'inactive'`)
  - `created_at INTEGER NOT NULL`
  - `last_used_at INTEGER`
- Add index `idx_users_normalized_username ON users(normalized_username)`

### `src/index.ts` — Auth middleware + users table init + HMAC utility

**New helper functions (near `isAuthorized` at line 561):**
- `hmacKey(rawKey: string, pepper: string): Promise<string>` — HMAC-SHA-256 using Web Crypto API
- `generateApiKey(): { publicId: string; secret: string; fullKey: string }` — generates `slm_<publicId>.<secret>` format
- `parseUserCredentials(request: Request): { username: string | null; key: string | null }` — extracts `X-Shared-Living-Memory-User` and `X-Shared-Living-Memory-User-Key` headers
- `resolveUser(request: Request, env: Env): Promise<{ user_id: string; username: string } | null>` — looks up user by normalized username, verifies HMAC key hash

**Modify `isAuthorized()` (line 561-564):**
- Keep existing Bearer token check as-is
- Add second path: if `Authorization: Bearer <DEPLOYMENT_TOKEN>` AND `X-Shared-Living-Memory-User` + `X-Shared-Living-Memory-User-Key` headers present, resolve user via `resolveUser()`
- Return `{ authorized: boolean; user_id?: string; username?: string }` instead of boolean

**Modify `requireAuth()` (line 575-578):**
- Return type changes from `Response | null` to `{ error: Response | null; user_id?: string; username?: string }`
- If only Bearer token (no user headers): legacy mode, return `user_id = "_legacy"` (will be replaced by system user in ticket 03)
- If Bearer + user headers: resolve user, verify key, return user_id
- If no auth at all: return 401

**Modify `initializeDatabase()` (line 678-701):**
- Add `CREATE TABLE IF NOT EXISTS users` after the existing table creation (mirrors schema.sql)
- This is the pattern already used for entries/edges ALTER TABLE statements at lines 693-700

**Modify all route handlers in `defaultHandler.fetch` (lines 2708-3461):**
- Every `const authErr = requireAuth(request, env); if (authErr) return authErr;` becomes destructured: `const { error: authErr, user_id } = requireAuth(request, env); if (authErr) return authErr;`
- `user_id` is now available in every handler for downstream use (tickets 04+ will use it)

**Modify `resolveExternalToken` (line 3476-3481):**
- When only AUTH_TOKEN matches (no user headers): return `{ props: { userId: "_legacy" } }`
- When AUTH_TOKEN + user headers: resolve user, return `{ props: { userId: resolved_user_id } }`

**Modify OAuth login page `loginHtml()` (line 582-634):**
- No changes yet — ticket 02 handles the login UI

### `src/index.ts` — New endpoint: `GET /api/users`

**Add route after the auth block (near line 2748):**
- `GET /api/users` — returns `{ users: [{ id, username, status }] }` for all active users
- Requires workspace key (`AUTH_TOKEN`, same as existing auth)
- No user credentials needed — this is for the login screen

### `test/helpers/make-env.ts` — Update test environment
- Add `AUTH_TOKEN` to the env object in `makeTestEnv()` (line 62-71) if not already there
- Add a `makeUserHelper()` utility for creating test users with hashed keys

### `test/helpers/make-request.ts` — Extend request helper
- Extend `req()` function (line 4-17) to accept optional `userCredentials: { username: string; key: string }` parameter
- When provided, add `X-Shared-Living-Memory-User` and `X-Shared-Living-Memory-User-Key` headers

### `test/integration/auth.test.ts` — Add multi-user auth tests
- Add test: Bearer token alone → 200 (legacy mode)
- Add test: Bearer + valid user headers → 200
- Add test: Bearer + invalid key → 401
- Add test: Bearer + unknown username → 401
- Add test: No Bearer token, only user headers → 401
- Add test: `GET /api/users` returns `[]` initially

### New file: `test/integration/users-api.test.ts`
- Test `POST /api/users` creates user, returns key
- Test `POST /api/users` rejects duplicate username
- Test `GET /api/users` lists active users
- Test `GET /api/users` requires auth

---

## Acceptance criteria

- [ ] `users` table created with correct schema on startup
- [ ] `POST /api/users` creates a user, returns `{ username, key }` (key shown once)
- [ ] `GET /api/users` returns list of active users
- [ ] Auth with `(workspace_key + username + key)` passes and resolves user_id
- [ ] Auth with only `workspace_key` (legacy) passes with user_id `_legacy`
- [ ] Auth with wrong key returns 401
- [ ] Auth with unknown username returns 401
- [ ] All existing auth tests still pass
- [ ] `npm run typecheck` passes
- [ ] `npm test` passes
