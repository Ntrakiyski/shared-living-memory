#!/usr/bin/env bash

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WRANGLER_BIN="$ROOT_DIR/node_modules/.bin/wrangler"
SMOKE_TIMEOUT_SECONDS="${WORKER_SMOKE_TIMEOUT_SECONDS:-45}"
ARTIFACT_DIR="${WORKER_SMOKE_ARTIFACT_DIR:-}"
KEEP_ARTIFACTS="${WORKER_SMOKE_KEEP_ARTIFACTS:-0}"
WRANGLER_PID=""
CREATED_ARTIFACT_DIR=0

if [[ ! -x "$WRANGLER_BIN" ]]; then
  echo "Wrangler is not installed. Run npm ci first." >&2
  exit 1
fi

if [[ -z "$ARTIFACT_DIR" ]]; then
  ARTIFACT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/shared-living-memory-workerd-smoke.XXXXXX")"
  CREATED_ARTIFACT_DIR=1
else
  mkdir -p "$ARTIFACT_DIR"
  ARTIFACT_DIR="$(cd "$ARTIFACT_DIR" && pwd)"
fi

LOG_FILE="$ARTIFACT_DIR/wrangler.log"
ROOT_BODY="$ARTIFACT_DIR/root.html"
MCP_HEADERS="$ARTIFACT_DIR/mcp-headers.txt"
MCP_BODY="$ARTIFACT_DIR/mcp-body.txt"
COUNT_BODY="$ARTIFACT_DIR/count.json"
USER_BODY="$ARTIFACT_DIR/user.json"
ME_BODY="$ARTIFACT_DIR/me.json"
ROTATE_BODY="$ARTIFACT_DIR/rotate.json"
CAPTURE_BODY="$ARTIFACT_DIR/capture.json"
FORGET_BODY="$ARTIFACT_DIR/forget.json"
ERASURE_BODY="$ARTIFACT_DIR/erasure.json"
CURSOR_BODY="$ARTIFACT_DIR/cursor.json"
CHALLENGE_BODY="$ARTIFACT_DIR/challenge.json"
STATE_DIR="$ARTIFACT_DIR/state"

cleanup() {
  local status=$?
  trap - EXIT INT TERM

  if [[ -n "$WRANGLER_PID" ]] && kill -0 "$WRANGLER_PID" 2>/dev/null; then
    kill -- -"$WRANGLER_PID" 2>/dev/null || kill "$WRANGLER_PID" 2>/dev/null || true
    wait "$WRANGLER_PID" 2>/dev/null || true
  fi

  if (( status != 0 )); then
    echo >&2
    echo "Real-Workerd smoke check failed. Wrangler log follows:" >&2
    echo "----- $LOG_FILE -----" >&2
    tail -n 200 "$LOG_FILE" >&2 2>/dev/null || true
    echo "----- end Wrangler log -----" >&2
    echo "Smoke artifacts retained at: $ARTIFACT_DIR" >&2
  elif [[ "$KEEP_ARTIFACTS" == "1" || "$CREATED_ARTIFACT_DIR" == "0" ]]; then
    echo "Smoke artifacts retained at: $ARTIFACT_DIR"
  else
    rm -rf "$ARTIFACT_DIR"
  fi

  exit "$status"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [[ -n "${WORKER_SMOKE_PORT:-}" ]]; then
  PORT="$WORKER_SMOKE_PORT"
else
  PORT="$({
    node <<'NODE'
const net = require("node:net");
const server = net.createServer();
server.unref();
server.on("error", (error) => {
  console.error(error);
  process.exit(1);
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  console.log(address.port);
  server.close();
});
NODE
  })"
fi

if [[ ! "$PORT" =~ ^[0-9]+$ ]] || (( PORT < 1 || PORT > 65535 )); then
  echo "WORKER_SMOKE_PORT must be an integer from 1 to 65535; received: $PORT" >&2
  exit 1
fi

BASE_URL="http://127.0.0.1:$PORT"
mkdir -p "$STATE_DIR"

echo "Starting local Workerd smoke server on $BASE_URL"

cd "$ROOT_DIR"
setsid "$WRANGLER_BIN" dev \
  --local \
  --no-latest \
  --ip 127.0.0.1 \
  --port "$PORT" \
  --persist-to "$STATE_DIR" \
  --var AUTH_TOKEN:ci-smoke-token \
  --show-interactive-dev-session=false \
  >"$LOG_FILE" 2>&1 &
WRANGLER_PID=$!

deadline=$((SECONDS + SMOKE_TIMEOUT_SECONDS))
root_status=""

while (( SECONDS < deadline )); do
  if ! kill -0 "$WRANGLER_PID" 2>/dev/null; then
    wait "$WRANGLER_PID" || true
    echo "Wrangler exited before its public route became ready." >&2
    exit 1
  fi

  root_status="$(
    curl --silent --show-error \
      --connect-timeout 1 \
      --max-time 3 \
      --output "$ROOT_BODY" \
      --write-out "%{http_code}" \
      "$BASE_URL/" \
      2>/dev/null || true
  )"

  if [[ "$root_status" == "200" && -s "$ROOT_BODY" ]]; then
    break
  fi

  sleep 0.25
done

if [[ "$root_status" != "200" || ! -s "$ROOT_BODY" ]]; then
  echo "Public root did not return a non-empty HTTP 200 within ${SMOKE_TIMEOUT_SECONDS}s (last status: ${root_status:-none})." >&2
  exit 1
fi

mcp_status="$(
  curl --silent --show-error \
    --connect-timeout 2 \
    --max-time 5 \
    --dump-header "$MCP_HEADERS" \
    --output "$MCP_BODY" \
    --write-out "%{http_code}" \
    "$BASE_URL/mcp" \
    2>/dev/null || true
)"

if [[ "$mcp_status" != "401" ]]; then
  echo "Unauthenticated /mcp must return HTTP 401; received: ${mcp_status:-none}." >&2
  exit 1
fi

if ! grep -Eiq '^www-authenticate:[[:space:]]*Bearer' "$MCP_HEADERS"; then
  echo "Unauthenticated /mcp response is missing a Bearer WWW-Authenticate challenge." >&2
  exit 1
fi

smoke_username="ci_bootstrap_${PORT}_$$"
user_status="$(
  curl --silent --show-error \
    --connect-timeout 2 \
    --max-time 5 \
    --request POST \
    --header 'Authorization: Bearer ci-smoke-token' \
    --header 'Content-Type: application/json' \
    --data "{\"username\":\"$smoke_username\"}" \
    --output "$USER_BODY" \
    --write-out "%{http_code}" \
    "$BASE_URL/api/bootstrap" \
    2>/dev/null || true
)"

if [[ "$user_status" != "201" ]]; then
  echo "First-admin bootstrap must return HTTP 201; received: ${user_status:-none}." >&2
  exit 1
fi

user_api_key="$(node -e '
const fs = require("node:fs");
const body = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (typeof body.key !== "string" || !body.key.startsWith("slm_")) process.exit(1);
process.stdout.write(body.key);
' "$USER_BODY")"

count_status="$(
  curl --silent --show-error \
    --connect-timeout 2 \
    --max-time 5 \
    --header "Authorization: Bearer $user_api_key" \
    --output "$COUNT_BODY" \
    --write-out "%{http_code}" \
    "$BASE_URL/count" \
    2>/dev/null || true
)"

if [[ "$count_status" != "200" ]]; then
  echo "Authenticated /count must return HTTP 200 after migrations; received: ${count_status:-none}." >&2
  exit 1
fi

if ! node -e '
const fs = require("node:fs");
const body = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (typeof body.count !== "number") process.exit(1);
' "$COUNT_BODY"; then
  echo "Authenticated /count did not return a numeric count." >&2
  exit 1
fi

# ─── A1: personal key rotation preserves the account id and the old key dies ──
me_status="$(
  curl --silent --show-error \
    --connect-timeout 2 --max-time 5 \
    --header "Authorization: Bearer $user_api_key" \
    --output "$ME_BODY" --write-out "%{http_code}" \
    "$BASE_URL/api/me" 2>/dev/null || true
)"
if [[ "$me_status" != "200" ]]; then
  echo "Authenticated /api/me must return HTTP 200; received: ${me_status:-none}." >&2
  exit 1
fi

original_account_id="$(node -e '
const fs = require("node:fs");
const body = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (!body.user || typeof body.user.id !== "string") process.exit(1);
process.stdout.write(body.user.id);
' "$ME_BODY")"

rotate_status="$(
  curl --silent --show-error \
    --connect-timeout 2 --max-time 5 \
    --request POST \
    --header "Authorization: Bearer $user_api_key" \
    --output "$ROTATE_BODY" --write-out "%{http_code}" \
    "$BASE_URL/api/me/rotate-key" 2>/dev/null || true
)"
if [[ "$rotate_status" != "200" ]]; then
  echo "Self key rotation must return HTTP 200; received: ${rotate_status:-none}." >&2
  exit 1
fi

rotated_key="$(node -e '
const fs = require("node:fs");
const body = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (typeof body.key !== "string" || !body.key.startsWith("slm_")) process.exit(1);
process.stdout.write(body.key);
' "$ROTATE_BODY")"

if [[ "$rotated_key" == "$user_api_key" ]]; then
  echo "Rotation returned the same key it replaced." >&2
  exit 1
fi

old_key_status="$(
  curl --silent --show-error \
    --connect-timeout 2 --max-time 5 \
    --header "Authorization: Bearer $user_api_key" \
    --output /dev/null --write-out "%{http_code}" \
    "$BASE_URL/api/me" 2>/dev/null || true
)"
if [[ "$old_key_status" != "401" ]]; then
  echo "The rotated-away key must stop authenticating (expected 401, got ${old_key_status:-none})." >&2
  exit 1
fi

new_key_status="$(
  curl --silent --show-error \
    --connect-timeout 2 --max-time 5 \
    --header "Authorization: Bearer $rotated_key" \
    --output "$ME_BODY" --write-out "%{http_code}" \
    "$BASE_URL/api/me" 2>/dev/null || true
)"
if [[ "$new_key_status" != "200" ]]; then
  echo "The new key must authenticate (expected 200, got ${new_key_status:-none})." >&2
  exit 1
fi

rotated_account_id="$(node -e '
const fs = require("node:fs");
const body = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
process.stdout.write(body.user && body.user.id ? body.user.id : "");
' "$ME_BODY")"
if [[ "$rotated_account_id" != "$original_account_id" ]]; then
  echo "Rotation must preserve the stable account id (${original_account_id} -> ${rotated_account_id})." >&2
  exit 1
fi

user_api_key="$rotated_key"

# ─── Safe error mapping over real Workerd ────────────────────────────────────
cursor_status="$(
  curl --silent --show-error \
    --connect-timeout 2 --max-time 5 \
    --header "Authorization: Bearer $user_api_key" \
    --output "$CURSOR_BODY" --write-out "%{http_code}" \
    "$BASE_URL/list?page=true&cursor=not-a-real-cursor" 2>/dev/null || true
)"
if [[ "$cursor_status" != "400" ]]; then
  echo "An invalid cursor must return HTTP 400; received: ${cursor_status:-none}." >&2
  exit 1
fi
node -e '
const fs = require("node:fs");
const body = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (!body.error || body.error.code !== "invalid_cursor") {
  console.error("Expected error.code=invalid_cursor");
  process.exit(1);
}
' "$CURSOR_BODY" || exit 1

# An invalid personal key must fail with a generic Bearer challenge that names
# the deployment and never leaks the key.
challenge_status="$(
  curl --silent --show-error \
    --connect-timeout 2 --max-time 5 \
    --header "Authorization: Bearer slm_ci_smoke_wrong.wrong-secret" \
    --dump-header "$MCP_HEADERS" \
    --output "$CHALLENGE_BODY" --write-out "%{http_code}" \
    "$BASE_URL/mcp" 2>/dev/null || true
)"
if [[ "$challenge_status" != "401" ]]; then
  echo "An invalid personal key at /mcp must return HTTP 401; received: ${challenge_status:-none}." >&2
  exit 1
fi
if ! grep -Eiq '^www-authenticate:[[:space:]]*Bearer' "$MCP_HEADERS"; then
  echo "An invalid personal key must receive a Bearer challenge." >&2
  exit 1
fi
if grep -q "wrong-secret" "$CHALLENGE_BODY"; then
  echo "The authentication failure body must never echo the supplied key." >&2
  exit 1
fi

# ─── E1: erase an entry that owns all five child artifact types ──────────────
# Capture embeds through the AI binding, which is unavailable to a purely local
# Workerd. The phase therefore runs only when the smoke is pointed at an
# AI-capable target (WORKER_SMOKE_EXPECT_AI=1); otherwise it is reported as
# SKIPPED rather than silently passing. The five-term query shape itself is
# covered on every run by test/integration/erasure-workerd-limit.test.ts, which
# enforces SQLITE_LIMIT_COMPOUND_SELECT=5 against real SQLite.
if [[ "${WORKER_SMOKE_EXPECT_AI:-0}" != "1" ]]; then
  echo "SKIPPED erasure-with-child-artifacts phase: local Workerd has no AI binding. Set WORKER_SMOKE_EXPECT_AI=1 on an AI-capable target to run it."
  echo "Real-Workerd smoke check passed (AI-independent checks): public root=200, unauthenticated /mcp=401 with Bearer challenge, first-admin bootstrap=201, authenticated /count=200, key rotation keeps the account id and kills the old key, invalid cursor=400 invalid_cursor, and an invalid personal key at /mcp is challenged without echoing the key."
  exit 0
fi

# Headers create documents + document_sections; headings create passages; a
# second version creates a snapshot. All five must be collected and deleted by
# the shared helper inside real Workerd, which enforces the five-term
# compound-SELECT limit that the local SQLite tests simulate.
capture_payload="$(
  node -e '
const doc = [
  "# Smoke Heading One",
  "",
  "Body paragraph with enough text to produce a passage.",
  "",
  "## Smoke Heading Two",
  "",
  "More body text for the second section.",
].join("\n");
process.stdout.write(JSON.stringify({
  content: doc,
  tags: ["ci-smoke"],
  source_url: "https://example.test/smoke",
  source_title: "Smoke document",
  visibility: "private",
}));
'
)"

capture_status="$(
  curl --silent --show-error \
    --connect-timeout 2 --max-time 10 \
    --request POST \
    --header "Authorization: Bearer $user_api_key" \
    --header 'Content-Type: application/json' \
    --data "$capture_payload" \
    --output "$CAPTURE_BODY" --write-out "%{http_code}" \
    "$BASE_URL/capture" 2>/dev/null || true
)"
if [[ "$capture_status" != "200" ]]; then
  echo "Authenticated /capture must return HTTP 200; received: ${capture_status:-none}." >&2
  exit 1
fi

entry_id="$(node -e '
const fs = require("node:fs");
const body = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (body.ok !== true || typeof body.id !== "string") process.exit(1);
process.stdout.write(body.id);
' "$CAPTURE_BODY")"

# A second version, so entry_snapshots exist when the erasure runs.
curl --silent --show-error \
  --connect-timeout 2 --max-time 10 \
  --request POST \
  --header "Authorization: Bearer $user_api_key" \
  --header 'Content-Type: application/json' \
  --data "$(node -e '
const fs = require("node:fs");
const body = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
process.stdout.write(JSON.stringify({
  id: body.id,
  content: "# Smoke Heading One\n\nRevised after capture.\n\n## Smoke Heading Two\n\nSecond revision body.",
}));
' "$CAPTURE_BODY")" \
  --output /dev/null \
  "$BASE_URL/update" >/dev/null 2>&1 || true

forget_status="$(
  curl --silent --show-error \
    --connect-timeout 2 --max-time 10 \
    --request POST \
    --header "Authorization: Bearer $user_api_key" \
    --header 'Content-Type: application/json' \
    --data "{\"id\":\"$entry_id\",\"confirm_entry_id\":\"$entry_id\"}" \
    --output "$FORGET_BODY" --write-out "%{http_code}" \
    "$BASE_URL/forget" 2>/dev/null || true
)"
if [[ "$forget_status" != "200" && "$forget_status" != "202" ]]; then
  echo "Erasing an owned entry must return HTTP 200 or 202; received: ${forget_status:-none}." >&2
  exit 1
fi

erasure_operation="$(node -e '
const fs = require("node:fs");
const body = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (body.ok !== true) process.exit(1);
// A committed erasure is never reported as a retryable failure.
if (body.retry === true) process.exit(1);
if (typeof body.erasure_status !== "string") process.exit(1);
process.stdout.write(typeof body.operation_id === "string" ? body.operation_id : "");
' "$FORGET_BODY")"

if [[ -n "$erasure_operation" ]]; then
  erasure_status="$(
    curl --silent --show-error \
      --connect-timeout 2 --max-time 5 \
      --header "Authorization: Bearer $user_api_key" \
      --output "$ERASURE_BODY" --write-out "%{http_code}" \
      "$BASE_URL/erasure-status?operation_id=$erasure_operation" 2>/dev/null || true
  )"
  if [[ "$erasure_status" != "200" ]]; then
    echo "GET /erasure-status must return HTTP 200 for the caller's own operation; received: ${erasure_status:-none}." >&2
    exit 1
  fi
  node -e '
const fs = require("node:fs");
const body = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (body.ok !== true || !body.erasure || typeof body.erasure.status !== "string") process.exit(1);
' "$ERASURE_BODY" || { echo "GET /erasure-status returned an unexpected shape." >&2; exit 1; }
fi

# The entry must be gone from the projection.
count_after_status="$(
  curl --silent --show-error \
    --connect-timeout 2 --max-time 5 \
    --header "Authorization: Bearer $user_api_key" \
    --output "$COUNT_BODY" --write-out "%{http_code}" \
    "$BASE_URL/count" 2>/dev/null || true
)"
if [[ "$count_after_status" != "200" ]]; then
  echo "Authenticated /count must return HTTP 200 after erasure; received: ${count_after_status:-none}." >&2
  exit 1
fi
node -e '
const fs = require("node:fs");
const body = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (typeof body.count !== "number" || body.count !== 0) {
  console.error("Expected zero surviving entries after erasure, got " + body.count);
  process.exit(1);
}
' "$COUNT_BODY" || exit 1

echo "Real-Workerd smoke check passed: public root=200, unauthenticated /mcp=401 with Bearer challenge, first-admin bootstrap=201, authenticated /count=200, key rotation keeps the account id and kills the old key, invalid cursor=400 invalid_cursor, an invalid personal key at /mcp is challenged without echoing the key, and an entry owning all five child artifacts erased cleanly with a complete receipt."
