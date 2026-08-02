import { TEST_USER_API_KEY } from "./test-principal";

const BASE = "http://localhost";
const TOKEN = "test-token";

export function req(
  method: string,
  path: string,
  opts: { body?: unknown; token?: string | null; userCredentials?: { username: string; key: string } } = {}
): Request {
  const { body, userCredentials } = opts;
  // /api/bootstrap is the only route that still gates on the workspace key.
  const isBootstrapRoute = method === "POST" && path === "/api/bootstrap";
  const hasExplicitToken = Object.prototype.hasOwnProperty.call(opts, "token");
  const token = hasExplicitToken
    ? opts.token
    : (userCredentials || isBootstrapRoute ? TOKEN : TEST_USER_API_KEY);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token !== null) headers["Authorization"] = `Bearer ${token}`;
  if (userCredentials) {
    headers["X-Shared-Living-Memory-User"] = userCredentials.username;
    headers["X-Shared-Living-Memory-User-Key"] = userCredentials.key;
  }
  return new Request(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}
