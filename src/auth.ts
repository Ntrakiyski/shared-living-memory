/**
 * auth.ts — Authentication and user identity resolution.
 *
 * Purpose: HMAC key generation, API key creation, credential parsing, user lookup
 *   against the `users` table, Bearer-token gating, and the combined requireAuthAsync
 *   gate used by all route handlers.
 * Input: HTTP requests with credential headers/bearer tokens, the DB, and env secrets.
 * Output: Auth results (user ID + username), API keys, login HTML, or error responses.
 * Logic: HMAC-SHA-256 hashing, constant-time comparison, and D1 user lookups.
 *   The workspace key bearer token is an administrative/transport gate only;
 *   user-scoped requests always resolve an active row from `users`.
 */

import { type Env } from "./types";
import { CORS_HEADERS } from "./config";

// ─── Constants ────────────────────────────────────────────────────────────────

export const AUTH_PEPPER = "shared-living-memory-v2"; // server-side pepper for HMAC
// Existing keys cannot be re-hashed because only their hashes are stored.
const LEGACY_AUTH_PEPPER = "second-brain-v2";

// ─── HMAC / API key helpers ────────────────────────────────────────────────────

export async function hmacKey(rawKey: string, pepper: string): Promise<string> {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(rawKey);
  const cryptoKey = await crypto.subtle.importKey(
    "raw", keyData, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(pepper));
  return Array.from(new Uint8Array(signature)).map(b => b.toString(16).padStart(2, "0")).join("");
}

export function generateApiKey(): { publicId: string; secret: string; fullKey: string } {
  const publicId = crypto.randomUUID().replace(/-/g, "");
  const secret = Array.from(crypto.getRandomValues(new Uint8Array(24)))
    .map(b => b.toString(36).padStart(2, "0")).join("").slice(0, 32);
  return { publicId, secret, fullKey: `slm_${publicId}.${secret}` };
}

/**
 * Generate a fresh key, hash it, update the user row, record the rotation as a
 * security event, and return the one-time plaintext. The old key is rejected
 * immediately because the hash column is updated in the same atomic write.
 * Returns null when the user does not exist or is not active.
 */
export async function rotateUserKey(
  actorUserId: string,
  operatorUserId: string,
  env: Env,
): Promise<{ username: string; key: string } | null> {
  const user = await env.DB.prepare(
    `SELECT id, username FROM users WHERE id = ? AND status IN ('active', 'deactivating')`,
  ).bind(operatorUserId).first<{ id: string; username: string }>();
  if (!user) return null;

  const { publicId, fullKey } = generateApiKey();
  const keyHash = await hmacKey(publicId + "." + fullKey.slice(fullKey.indexOf(".") + 1), AUTH_PEPPER);
  const prefix = fullKey.slice(0, 15);
  const now = Date.now();

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE users SET auth_key_hash = ?, auth_key_prefix = ?, last_used_at = ? WHERE id = ?`,
    ).bind(keyHash, prefix, now, operatorUserId),
    env.DB.prepare(
      `INSERT INTO security_events (
         id, event_type, actor_kind, actor_id, reason, created_at
       ) VALUES (?, ?, 'human', ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      actorUserId === operatorUserId ? "self_key_rotation" : "admin_key_rotation",
      actorUserId,
      `Key rotated for user ${operatorUserId}`,
      now,
    ),
  ]);

  return { username: user.username, key: fullKey };
}

// ─── Credential parsing / resolution ──────────────────────────────────────────

function parseUserCredentials(request: Request): { username: string | null; key: string | null } {
  return {
    username: request.headers.get("X-Shared-Living-Memory-User"),
    key: request.headers.get("X-Shared-Living-Memory-User-Key"),
  };
}

function bearerToken(request: Request): string | null {
  const authorization = request.headers.get("Authorization");
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

interface ActiveUserRow {
  id: string;
  username: string;
  auth_key_hash: string;
}

export interface UserPrincipal {
  user_id: string;
  username: string;
}

function parseApiKey(apiKey: string): { publicId: string; secret: string; legacy: boolean } | null {
  const match = apiKey.match(/^(slm|sbu)_([A-Za-z0-9][A-Za-z0-9_-]{0,127})\.([^\s.]+)$/);
  if (!match) return null;
  return { legacy: match[1] === "sbu", publicId: match[2], secret: match[3] };
}

function isReservedActorId(value: string): boolean {
  return value === "anonymous" || value === "_system" || value === "owner";
}

async function activeUserById(userId: string, env: Env): Promise<ActiveUserRow | null> {
  if (!isValidMcpActorId(userId)) return null;
  return await (env.DB as any).prepare(
    "SELECT id, username, auth_key_hash FROM users WHERE id = ? AND status = 'active'"
  ).bind(userId).first() as ActiveUserRow | null;
}

async function hashesMatch(rawSecret: string, storedHash: string): Promise<boolean> {
  if (typeof storedHash !== "string") return false;
  const [keyHash, legacyKeyHash] = await Promise.all([
    hmacKey(rawSecret, AUTH_PEPPER),
    hmacKey(rawSecret, LEGACY_AUTH_PEPPER),
  ]);
  if (keyHash.length !== storedHash.length || legacyKeyHash.length !== storedHash.length) return false;

  const encoder = new TextEncoder();
  const a = encoder.encode(keyHash);
  const legacy = encoder.encode(legacyKeyHash);
  const b = encoder.encode(storedHash);
  let diff = 0;
  let legacyDiff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
    legacyDiff |= legacy[i] ^ b[i];
  }
  return diff === 0 || legacyDiff === 0;
}

/** Resolve a personal API key to the active, non-system user that owns it. */
export async function resolveUserByApiKey(
  apiKey: string,
  env: Env,
): Promise<UserPrincipal | null> {
  const parsed = parseApiKey(apiKey);
  if (!parsed) return null;

  const row = await activeUserById(parsed.publicId, env);
  if (!row || !await hashesMatch(parsed.secret, row.auth_key_hash)) return null;
  return { user_id: row.id, username: row.username };
}

/** Revalidate an OAuth token's stored subject against the live users table. */
export async function resolveActiveUserPrincipal(
  userId: string,
  env: Env,
): Promise<UserPrincipal | null> {
  const row = await activeUserById(userId, env);
  return row ? { user_id: row.id, username: row.username } : null;
}

// MCP requests are authenticated by OAuthProvider before apiHandler runs. The
// provider places the authenticated principal in ExecutionContext.props. A
// complete pair of legacy per-user headers may still select a narrower actor,
// but only after the API key is verified; malformed/partial credentials never
// fall back to a broader OAuth principal.
export type McpActorSource = "oauth_props" | "user_credentials";

export interface McpActor {
  user_id: string;
  username?: string;
  source: McpActorSource;
}

export type McpActorResolution =
  | { ok: true; actor: McpActor }
  | {
      ok: false;
      reason:
        | "missing_actor"
        | "invalid_oauth_actor"
        | "incomplete_user_credentials"
        | "invalid_user_credentials"
        | "legacy_transport_unauthorized";
    };

/**
 * Validate an actor ID before it is allowed to scope MCP tools. Empty,
 * anonymous, and system-reserved identities would re-open unscoped or
 * privileged legacy behavior and are therefore rejected.
 */
export function isValidMcpActorId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (isReservedActorId(value)) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

function oauthActorId(props: unknown): string | null {
  if (!props || typeof props !== "object" || Array.isArray(props)) return null;
  const userId = (props as Record<string, unknown>).userId;
  return isValidMcpActorId(userId) ? userId : null;
}

export async function resolveUser(
  request: Request, env: Env
): Promise<{ user_id: string; username: string } | null> {
  const { username, key } = parseUserCredentials(request);
  if (!username || !key) return null;
  const parsed = parseApiKey(key);
  if (!parsed) return null;

  const normalized = username.toLowerCase().trim();
  const row = await (env.DB as any).prepare(
    "SELECT id, username, auth_key_hash FROM users WHERE normalized_username = ? AND status = 'active'"
  ).bind(normalized).first();
  if (!row || (!parsed.legacy && parsed.publicId !== row.id) || !isValidMcpActorId(row.id)) return null;
  if (!await hashesMatch(parsed.secret, row.auth_key_hash as string)) return null;

  return { user_id: row.id, username: row.username };
}

/**
 * Resolve the effective MCP actor without ever returning an unscoped identity.
 *
 * Resolution order:
 * 1. If either legacy user header is present, require both and verify them.
 *    This preserves the current two-factor workspace-key + user-key flow.
 * 2. Otherwise use the OAuthProvider principal from ctx.props.userId.
 * 3. If neither path yields a valid actor, fail closed.
 *
 * A legacy header actor requires either a valid OAuth principal (normal
 * provider-wrapped requests) or the explicit workspace key (safe direct
 * legacy calls/tests). This prevents user headers alone from bypassing OAuth.
 */
export async function resolveMcpActor(
  request: Request,
  env: Env,
  oauthProps: unknown,
): Promise<McpActorResolution> {
  const { username, key } = parseUserCredentials(request);
  const hasUsername = username !== null;
  const hasKey = key !== null;
  const suppliedOauthUserId = oauthActorId(oauthProps);
  const oauthPrincipal = suppliedOauthUserId
    ? await resolveActiveUserPrincipal(suppliedOauthUserId, env)
    : null;

  if (hasUsername || hasKey) {
    if (!username || !key) {
      return { ok: false, reason: "incomplete_user_credentials" };
    }

    const resolved = await resolveUser(request, env);
    if (!resolved) {
      return { ok: false, reason: "invalid_user_credentials" };
    }

    if (!oauthPrincipal && !isAuthorized(request, env)) {
      return { ok: false, reason: "legacy_transport_unauthorized" };
    }

    if (!isValidMcpActorId(resolved.user_id)) {
      return { ok: false, reason: "invalid_user_credentials" };
    }

    return {
      ok: true,
      actor: {
        user_id: resolved.user_id,
        username: resolved.username,
        source: "user_credentials",
      },
    };
  }

  if (oauthPrincipal) {
    return {
      ok: true,
      actor: {
        user_id: oauthPrincipal.user_id,
        username: oauthPrincipal.username,
        source: "oauth_props",
      },
    };
  }

  const suppliedUserId =
    oauthProps && typeof oauthProps === "object" && !Array.isArray(oauthProps)
      ? (oauthProps as Record<string, unknown>).userId
      : undefined;

  return {
    ok: false,
    reason: suppliedUserId === undefined ? "missing_actor" : "invalid_oauth_actor",
  };
}

export function isAuthorized(request: Request, env: Env): boolean {
  // Credentials in URLs leak into access logs, browser history, analytics, and
  // referrer headers. Accept the workspace key only in Authorization.
  return request.headers.get("Authorization") === `Bearer ${env.AUTH_TOKEN}`;
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

// ─── Combined auth gate ────────────────────────────────────────────────────────

// Async auth: returns `{ error, user_id, username }`. All user-scoped route
// handlers should use this. Accepted forms are either a personal API key as
// Bearer token, or the workspace transport key plus verified user headers.
// The workspace key alone deliberately has no user principal.
export async function requireAuthAsync(
  request: Request, env: Env
): Promise<{ error: Response | null; user_id?: string; username?: string }> {
  const { username, key } = parseUserCredentials(request);
  const hasUsername = username !== null;
  const hasKey = key !== null;
  if (hasUsername || hasKey) {
    // A partial actor selection must never fall back to the workspace-wide
    // system actor. Treat malformed/partial credential attempts as failures.
    if (!username || !key) {
      return { error: json({ ok: false, error: "Unauthorized" }, 401) };
    }
    if (!isAuthorized(request, env)) {
      return { error: json({ ok: false, error: "Unauthorized" }, 401) };
    }
    const resolved = await resolveUser(request, env);
    if (!resolved) {
      return { error: json({ ok: false, error: "Unauthorized" }, 401) };
    }
    return { error: null, user_id: resolved.user_id, username: resolved.username };
  }

  const token = bearerToken(request);
  if (!token || token === env.AUTH_TOKEN) {
    return { error: json({ ok: false, error: "Unauthorized" }, 401) };
  }

  const resolved = await resolveUserByApiKey(token, env);
  if (!resolved) {
    return { error: json({ ok: false, error: "Unauthorized" }, 401) };
  }
  return { error: null, user_id: resolved.user_id, username: resolved.username };
}

// Sync version for backward compat (doesn't verify user key — use requireAuthAsync in routes)
function requireAuth(request: Request, env: Env): Response | null {
  if (isAuthorized(request, env)) return null;
  return json({ ok: false, error: "Unauthorized" }, 401);
}

// ─── Hosted OAuth login page ──────────────────────────────────────────────────

export function loginHtml(error?: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
  <meta name="theme-color" content="#F4F1EA" />
  <title>Shared Living Memory</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link href="https://fonts.googleapis.com/css2?family=Lora:ital,wght@0,400;0,500;0,600&family=DM+Sans:opsz,wght@9..40,300;9..40,400;9..40,500;9..40,600&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@2.44.0/tabler-icons.min.css" />
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg: #f4f1ea; --bg-card: #fcfbf7;
      --accent: #b26641; --accent-press: #9c522f; --accent-soft: rgba(178, 102, 65, 0.1); --on-accent: #fcfbf7;
      --text-primary: #26241f; --text-secondary: #6e6b62; --text-tertiary: #a8a498;
      --border-input: rgba(38, 36, 31, 0.11); --danger: #b3261e;
      --font-serif: 'Lora', Georgia, serif; --font-sans: 'DM Sans', system-ui, sans-serif;
      --ease: cubic-bezier(0.22, 1, 0.36, 1);
    }
    body { background: var(--bg); font-family: var(--font-sans); color: var(--text-primary); min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    .auth-card { width: 100%; max-width: 400px; padding: 40px 32px; display: flex; flex-direction: column; align-items: center; animation: fade-in 0.5s var(--ease); }
    @keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }
    .brain-logo { width: 70px; height: 70px; border-radius: 50%; background: var(--accent-soft); color: var(--accent); display: flex; align-items: center; justify-content: center; margin-bottom: 24px; position: relative; }
    .brain-logo i { font-size: 33px; }
    .brain-logo::after { content: ''; position: absolute; inset: -7px; border-radius: 50%; border: 1px solid var(--accent-soft); }
    h1 { font-family: var(--font-serif); font-size: 29px; font-weight: 500; margin-bottom: 9px; letter-spacing: -0.015em; }
    p { font-size: 14px; color: var(--text-secondary); margin-bottom: 34px; text-align: center; line-height: 1.6; max-width: 300px; }
    form { width: 100%; display: flex; flex-direction: column; gap: 11px; margin-bottom: 14px; }
    input { width: 100%; padding: 14px 16px; background: var(--bg-card); border: 0.5px solid var(--border-input); border-radius: 13px; font-family: var(--font-sans); font-size: 15px; color: var(--text-primary); outline: none; transition: border-color 0.18s, box-shadow 0.18s; }
    input::placeholder { color: var(--text-tertiary); }
    input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
    button { width: 100%; padding: 15px; background: var(--accent); color: var(--on-accent); border: none; border-radius: 13px; font-family: var(--font-sans); font-size: 15px; font-weight: 600; cursor: pointer; transition: background 0.18s, transform 0.12s var(--ease); }
    button:hover { background: var(--accent-press); }
    button:active { transform: scale(0.985); }
    .auth-error { font-size: 13px; color: var(--danger); text-align: center; margin-top: 10px; min-height: 18px; }
  </style>
</head>
<body>
  <div class="auth-card">
    <div class="brain-logo"><i class="ti ti-brain"></i></div>
    <h1>Shared Living Memory</h1>
    <p>Enter your personal Shared Living Memory API key to connect to your memory layer.</p>
    <form method="POST">
      <input type="password" name="password" placeholder="Personal API key" autofocus autocomplete="current-password" />
      <button type="submit">Connect</button>
    </form>
    <div class="auth-error">${error ? error : ""}</div>
  </div>
</body>
</html>`;
}
