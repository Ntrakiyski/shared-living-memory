# 06 — Dashboard Login & User Selection

**What to build:** The dashboard login screen shows a username dropdown (from `/api/users`) and a key input. Selected username + key are sent with every request. The auth overlay is updated with the new UI. Existing single-token users can still log in directly.

**Blocked by:** Tickets 02, 05

**Status:** ready-for-agent

---

## Files to modify

### `public/index.html` — Auth overlay finalization

**Auth overlay HTML (lines 2342-2363):**
- Ensure the Sign In tab from ticket 02 is fully functional:
  - Username dropdown (`<select id="auth-username">`) populated from `GET /api/users`
  - Key input (`<input type="password" id="auth-key">`)
  - Connect button
  - Error display area
- Add a "Use workspace key only" link for legacy single-key auth:
  - Shows a single Bearer token input (the existing `#auth-token` field)
  - For backward compatibility during transition

**JavaScript — `connect()` function (line 2798-2824):**
- When username dropdown is selected: send `X-Shared-Living-Memory-User` + `X-Shared-Living-Memory-User-Key` headers
- When "workspace key only" mode: send only `Authorization: Bearer <key>` (legacy)
- Store mode in localStorage (`slm_auth_mode: 'user' | 'legacy'`)

**JavaScript — `init()` function (line 2783-2796):**
- On load, check `slm_auth_mode` from localStorage
- If `'user'`: populate username dropdown, pre-fill stored username
- If `'legacy'`: show legacy token input
- If no stored auth: show Sign In tab by default

**JavaScript — all API calls:**
- Every `fetch()` call that sends `Authorization: Bearer <token>` must also include:
  - `X-Shared-Living-Memory-User: <username>` (from stored `slm_username`)
  - `X-Shared-Living-Memory-User-Key: <key>` (from stored `slm_key`)
- Update the `headers` object construction in:
  - `loadRecent()` (line 3124)
  - `loadTags()`
  - `updateStatus()`
  - `checkVectorize()`
  - `exportMemories()` (line 3835)
  - All other fetch calls in the dashboard JS

**JavaScript — `logout()` function (line 2903-2914):**
- Clear `slm_username`, `slm_key`, `slm_auth_mode` from localStorage

**CSS (lines 170-306 area):**
- Style the "workspace key only" link as subtle text below the main form
- Ensure responsive layout works on mobile

---

## Acceptance criteria

- [ ] Dashboard login shows username dropdown populated from `/api/users`
- [ ] Login with username + key works
- [ ] Bearer-only (legacy) login still works via "workspace key only" option
- [ ] Credentials stored in localStorage and sent with all API calls
- [ ] Username dropdown pre-selects stored username on reload
- [ ] Logout clears all stored credentials
- [ ] All API calls include user headers when in user mode
- [ ] `npm run typecheck` passes
- [ ] `npm test` passes
