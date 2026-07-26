# 02 — User Creation & Dashboard Registration

**What to build:** A new user can register via the dashboard. The auth overlay shows a "Create account" flow with username input. After creation, the raw key is displayed once with a copy button. The login form has a username dropdown populated from `/api/users`. End-to-end: create user → see key → log in → see empty brain.

**Blocked by:** Ticket 01

**Status:** ready-for-agent

---

## Files to modify

### `public/index.html` — Auth overlay UI overhaul

**Auth overlay HTML (lines 2342-2363):**
- Replace the current single-form auth overlay with a tabbed interface:
  - **Tab 1: "Sign In"** — username dropdown (populated from `GET /api/users`) + key input + Connect button
  - **Tab 2: "Create Account"** — username text input + Create button
- Add a `#key-reveal` div (hidden by default) that shows after account creation:
  - Displays the raw key with a copy-to-clipboard button
  - Warning text: "Save this key now. It will not be shown again."
  - "I've saved it" button that switches back to Sign In tab
- Keep the existing honeypot field and URL input

**CSS (lines 170-306 area):**
- Style the tab switcher (two buttons, active state)
- Style the key reveal card (prominent, copy button, warning text)
- Style the username dropdown (matches existing input styling)

**JavaScript — `init()` function (line 2783-2796):**
- On load, fetch `GET /api/users` with stored token (if any) to populate username dropdown
- If no users exist, auto-switch to "Create Account" tab
- If users exist, show "Sign In" tab by default

**JavaScript — new `loadUsers()` function:**
- `async function loadUsers()` — fetches `GET /api/users`, populates `<select id="auth-username">`
- Called on init and after account creation

**JavaScript — new `createAccount()` function:**
- `async function createAccount()` — reads username from input, calls `POST /api/users` with workspace key
- On success: hides create form, shows `#key-reveal` with the returned key
- On error: shows error message
- After "I've saved it" clicked: switch to Sign In tab, reload user dropdown

**JavaScript — modify `connect()` function (line 2798-2824):**
- Read username from dropdown (`#auth-username`) in addition to key from `#auth-token`
- Send both `X-Shared-Living-Memory-User` and `X-Shared-Living-Memory-User-Key` headers with the validation request
- Store `slm_username` in localStorage alongside `slm_url` and `slm_token`
- On subsequent loads, pre-select the stored username in the dropdown

**JavaScript — modify `showApp()` function (line 2826-2833):**
- No changes needed — it already hides overlay and loads data

**JavaScript — modify `logout()` function (line 2903-2914):**
- Also clear `slm_username` from localStorage

### `src/index.ts` — User creation endpoint

**Add route (near the `GET /api/users` route from ticket 01):**
- `POST /api/users` — creates a new user
  - Body: `{ username: string }`
  - Validates: username is non-empty, alphanumeric + underscores, max 32 chars
  - Generates key via `generateApiKey()` from ticket 01
  - Hashes key, inserts into users table
  - Returns: `{ ok: true, username: string, key: string }` (key is the raw `slm_<id>.<secret>`)
  - Requires workspace key (`AUTH_TOKEN`, same as existing auth)

### `test/integration/users-api.test.ts` — Registration flow tests
- Test: POST /api/users creates user, returns key
- Test: POST /api-users with duplicate username → 409
- Test: POST /api/users with invalid username → 400
- Test: After creation, GET /api/users includes new user
- Test: Can authenticate with created user's key

---

## Acceptance criteria

- [ ] Dashboard auth overlay shows Sign In and Create Account tabs
- [ ] Create Account flow: enter username → get key → key shown once → copy button works
- [ ] Sign In flow: dropdown lists users → enter key → Connect → see empty brain
- [ ] Username dropdown populated from `GET /api/users`
- [ ] Stored username remembered across sessions
- [ ] Logout clears stored username
- [ ] Error shown for duplicate username
- [ ] Error shown for invalid username format
- [ ] `npm run typecheck` passes
- [ ] `npm test` passes
