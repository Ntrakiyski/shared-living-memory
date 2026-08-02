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

echo "Real-Workerd smoke check passed: public root=200, real-user D1 count=200, unauthenticated /mcp=401 with Bearer challenge."
