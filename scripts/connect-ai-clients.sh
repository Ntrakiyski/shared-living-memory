#!/usr/bin/env bash
# Wires up Shared Living Memory for Claude Code and Codex CLI in one shot:
#   - appends global system instructions to ~/.claude/CLAUDE.md and ~/.codex/AGENTS.md
#   - registers the /mcp endpoint as an MCP server
#
# Authentication: PERSONAL API KEY (default). The key is read from a protected
# file or stdin — never from a command-line argument — and is never echoed.
#
# Legacy: pass --oauth to register through the OAuth login flow instead. That
# flow only works when the deployment sets MCP_OAUTH_ENABLED=true; it is
# disabled by default, in which case the personal key path is the supported one.
#
# Usage:
#   curl -fsSL <raw-url>/scripts/connect-ai-clients.sh | bash -s -- https://YOUR-WORKER-URL --key-file ~/.config/shared-living-memory/alice.key
#   printf '%s' "$SLM_KEY" | bash scripts/connect-ai-clients.sh https://YOUR-WORKER-URL
#
# Options:
#   --key-file <path>   Read the personal API key from this file (mode 0600 recommended).
#   --profile <name>    capture | review | full — the tool profile for this connection.
#   --oauth             Legacy: register through OAuth instead of a personal key.
#   --print-only        Print the registration commands instead of running them.
#   -h, --help          Show this help.

set -euo pipefail

RAW_BASE="https://raw.githubusercontent.com/Ntrakiyski/shared-living-memory/main"
INSTRUCTION_SOURCE_PATH="AGENTS.md"
INSTRUCTION_SECTION_START="<!-- shared-living-memory:mcp-client-instructions:start -->"
INSTRUCTION_SECTION_END="<!-- shared-living-memory:mcp-client-instructions:end -->"
START_MARKER="<!-- shared-living-memory:instructions:start -->"
END_MARKER="<!-- shared-living-memory:instructions:end -->"
SENTINEL_PHRASE="At the start of EVERY conversation, call recall"
PROFILE_HEADER="X-SLM-Tool-Profile"
# Codex can read the bearer token from the environment, so the key never reaches
# its configuration file or a process argument list.
BEARER_ENV_VAR="SHARED_LIVING_MEMORY_API_KEY"

WORKER_URL=""
KEY_FILE=""
PROFILE=""
USE_OAUTH=0
PRINT_ONLY=0

usage() {
  sed -n '2,24p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --key-file)
      [[ $# -ge 2 ]] || { echo "Error: --key-file needs a path" >&2; exit 1; }
      KEY_FILE="$2"; shift 2 ;;
    --profile)
      [[ $# -ge 2 ]] || { echo "Error: --profile needs a value" >&2; exit 1; }
      PROFILE="$2"; shift 2 ;;
    --oauth) USE_OAUTH=1; shift ;;
    --print-only) PRINT_ONLY=1; shift ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "Error: unknown option." >&2; usage >&2; exit 1 ;;
    *)
      if [[ -z "$WORKER_URL" ]]; then
        WORKER_URL="$1"
      else
        # Never echo the value: it could be a key pasted by mistake.
        echo "Error: unexpected extra argument. Pass exactly one worker URL." >&2
        exit 1
      fi
      shift ;;
  esac
done

if [[ -z "$WORKER_URL" ]]; then
  read -rp "Enter your Shared Living Memory worker URL (e.g. https://your-worker.workers.dev): " WORKER_URL
fi

# Trim trailing slash(es)
while [[ "$WORKER_URL" == */ ]]; do WORKER_URL="${WORKER_URL%/}"; done

if [[ ! "$WORKER_URL" =~ ^https?:// ]]; then
  echo "Error: worker URL must start with http:// or https:// (got: $WORKER_URL)" >&2
  exit 1
fi

if [[ -n "$PROFILE" && "$PROFILE" != "capture" && "$PROFILE" != "review" && "$PROFILE" != "full" ]]; then
  echo "Error: --profile must be capture, review or full (got: $PROFILE)" >&2
  exit 1
fi

# Append exactly one /mcp, never two.
case "$WORKER_URL" in
  */mcp) MCP_URL="$WORKER_URL" ;;
  *) MCP_URL="${WORKER_URL}/mcp" ;;
esac

echo "Worker URL: $WORKER_URL"
echo "MCP endpoint: $MCP_URL"
if [[ "$USE_OAUTH" == 1 ]]; then
  echo "Auth: OAuth (legacy)"
else
  echo "Auth: personal API key"
fi
[[ -n "$PROFILE" ]] && echo "Tool profile: $PROFILE"
echo

fetch() {
  curl -fsSL "$1"
}

fetch_client_instructions() {
  local document
  document="$(fetch "${RAW_BASE}/${INSTRUCTION_SOURCE_PATH}")" || return 1
  awk -v start="$INSTRUCTION_SECTION_START" -v end="$INSTRUCTION_SECTION_END" '
    $0 == start { capture = 1; next }
    $0 == end { capture = 0 }
    capture { print }
  ' <<< "$document"
}

# ─── Append instructions idempotently ────────────────────────────────────────
append_instructions() {
  local target_file="$1"
  local label="$2"

  mkdir -p "$(dirname "$target_file")"
  touch "$target_file"

  if grep -qF "$START_MARKER" "$target_file" 2>/dev/null; then
    echo "[$label] Already configured (marker found in $target_file) — skipping."
    return
  fi

  if grep -qF "$SENTINEL_PHRASE" "$target_file" 2>/dev/null; then
    echo "[$label] Looks like you already pasted these instructions manually into $target_file — skipping to avoid duplicating."
    return
  fi

  local body
  if ! body="$(fetch_client_instructions)" || [[ -z "$body" ]]; then
    echo "[$label] Could not fetch instruction block from ${RAW_BASE}/${INSTRUCTION_SOURCE_PATH} — skipping." >&2
    return
  fi

  {
    echo
    echo "$START_MARKER"
    echo "$body"
    echo "$END_MARKER"
  } >> "$target_file"

  echo "[$label] Appended instructions to $target_file"
}

# ─── Secret handling ─────────────────────────────────────────────────────────
# The key is never accepted as an argument value, never echoed, and never written
# anywhere by this script.
read_secret() {
  if [[ -n "$KEY_FILE" ]]; then
    if [[ ! -f "$KEY_FILE" ]]; then
      echo "Error: key file not found: $KEY_FILE" >&2
      exit 1
    fi
    local mode
    mode="$(stat -f '%Lp' "$KEY_FILE" 2>/dev/null || stat -c '%a' "$KEY_FILE" 2>/dev/null || echo '')"
    if [[ -n "$mode" && "$mode" != "600" && "$mode" != "400" ]]; then
      echo "Warning: $KEY_FILE has mode $mode; 600 is recommended." >&2
    fi
    tr -d '\r\n' < "$KEY_FILE"
    return
  fi

  if [[ -t 0 ]]; then
    echo "Error: provide the personal API key on stdin or with --key-file." >&2
    echo "       Example: printf '%s' \"\$SLM_KEY\" | $0 $WORKER_URL" >&2
    exit 1
  fi
  tr -d '\r\n'
}

print_only() {
  echo "── Commands (run these yourself) ──"
  echo
  echo "  export $BEARER_ENV_VAR='<personal-api-key>'"
  echo "  codex mcp add shared-living-memory --url \"$MCP_URL\" --bearer-token-env-var $BEARER_ENV_VAR"
  echo "  claude mcp add --transport http shared-living-memory \"$MCP_URL\" \\"
  echo "    --header \"Authorization: Bearer <personal-api-key>\""
  if [[ -n "$PROFILE" ]]; then
    echo "  # add --header \"$PROFILE_HEADER: $PROFILE\" to either client"
  fi
  echo
  echo "Or write a mode-0600 connection file with the secure exporter:"
  echo "  node scripts/export-mcp-connection.mjs --url \"$WORKER_URL\" --out <path>"
}

if [[ "$PRINT_ONLY" == 1 ]]; then
  print_only
  exit 0
fi

API_KEY=""
if [[ "$USE_OAUTH" == 0 ]]; then
  API_KEY="$(read_secret)"
  if [[ -z "$API_KEY" ]]; then
    echo "Error: the personal API key was empty." >&2
    exit 1
  fi
fi

echo "── Global instructions ──"
append_instructions "$HOME/.claude/CLAUDE.md" "Claude Code"
append_instructions "$HOME/.codex/AGENTS.md" "Codex CLI"
echo

# ─── Register MCP server ──────────────────────────────────────────────────────
if [[ "$USE_OAUTH" == 1 ]]; then
  echo "── MCP server registration (LEGACY: OAuth — requires MCP_OAUTH_ENABLED=true) ──"
  echo "   If OAuth issuance is disabled on the deployment, use a personal API key instead."
else
  echo "── MCP server registration (personal API key) ──"
fi

if command -v claude >/dev/null 2>&1; then
  if claude mcp get shared-living-memory >/dev/null 2>&1; then
    echo "[Claude Code] 'shared-living-memory' MCP server is already registered — skipping."
  else
    claude_args=(--transport http shared-living-memory "$MCP_URL")
    if [[ "$USE_OAUTH" == 0 ]]; then
      # Claude Code has no environment indirection for headers, so the key is
      # passed once to its own CLI. This script never prints it and never reads
      # the client's configuration afterwards.
      claude_args+=(--header "Authorization: Bearer ${API_KEY}")
      [[ -n "$PROFILE" ]] && claude_args+=(--header "${PROFILE_HEADER}: ${PROFILE}")
      echo "[Claude Code] Note: Claude Code stores this header in its own local config."
    fi
    if claude mcp add "${claude_args[@]}"; then
      if [[ "$USE_OAUTH" == 1 ]]; then
        echo "[Claude Code] Registered 'shared-living-memory'. You'll be prompted to authorize in your browser on first use."
      else
        echo "[Claude Code] Registered 'shared-living-memory'."
      fi
    else
      echo "[Claude Code] Failed to register 'shared-living-memory' — add it manually with:" >&2
      echo "  claude mcp add --transport http shared-living-memory \"$MCP_URL\" --header \"Authorization: Bearer <key>\"" >&2
    fi
  fi
else
  echo "[Claude Code] 'claude' CLI not found on PATH — skipping."
fi

if command -v codex >/dev/null 2>&1; then
  if codex mcp get shared-living-memory >/dev/null 2>&1; then
    echo "[Codex CLI] 'shared-living-memory' MCP server is already registered — skipping."
  else
    codex_args=(shared-living-memory --url "$MCP_URL")
    if [[ "$USE_OAUTH" == 0 ]]; then
      # Codex reads the token from the environment at runtime, so the key is
      # never written into the Codex configuration file.
      codex_args+=(--bearer-token-env-var "$BEARER_ENV_VAR")
    fi
    if codex mcp add "${codex_args[@]}"; then
      if [[ "$USE_OAUTH" == 1 ]]; then
        echo "[Codex CLI] Registered 'shared-living-memory' and started the OAuth login flow."
      else
        echo "[Codex CLI] Registered 'shared-living-memory'."
      fi
    else
      echo "[Codex CLI] Failed to register 'shared-living-memory' — add it manually with:" >&2
      echo "  codex mcp add shared-living-memory --url \"$MCP_URL\" --bearer-token-env-var $BEARER_ENV_VAR" >&2
    fi
  fi
else
  echo "[Codex CLI] 'codex' CLI not found on PATH — skipping."
fi

echo
echo "── Done ──"
echo "Reminders:"
if [[ "$USE_OAUTH" == 1 ]]; then
  echo "  • Legacy OAuth: on first use you'll be prompted in your browser for the workspace key"
  echo "    (AUTH_TOKEN). This only works when the deployment sets MCP_OAUTH_ENABLED=true."
else
  echo "  • Codex CLI reads its token from \$$BEARER_ENV_VAR. Export it in your shell profile:"
  echo "      export $BEARER_ENV_VAR='<your personal API key>'"
  echo "    Claude Code stored the Authorization header in its own local config."
  echo "  • For a mode-0600 connection file instead, use the secure exporter:"
  echo "      node scripts/export-mcp-connection.mjs --url \"$WORKER_URL\" --out <path>"
fi
if [[ -n "$PROFILE" ]]; then
  echo "  • Tool profile '$PROFILE' is a convenience subset of the same key; the key holder"
  echo "    can always select 'full' on another connection."
fi
echo "  • Prefer the personal API key for new connections. The legacy workspace-key +"
echo "    user-header flow (Authorization: Bearer <workspace-key> plus"
echo "    X-Shared-Living-Memory-User / X-Shared-Living-Memory-User-Key) remains supported"
echo "    but is labelled legacy."
echo "  • Also using the ChatGPT or Claude apps (not Codex CLI / Claude Code)? Their"
echo "    personalization / custom-instruction settings are account-level and have no"
echo "    public write API — paste the 'Shared Living Memory MCP Client Instructions' block"
echo "    from AGENTS.md into ChatGPT's Settings → Personalization → Custom Instructions,"
echo "    and a similar block into claude.ai's profile preferences, by hand."
