<#
.SYNOPSIS
  Wires up Shared Living Memory for Claude Code and Codex CLI in one shot:
    - appends global system instructions to ~/.claude/CLAUDE.md and ~/.codex/AGENTS.md
    - registers the /mcp endpoint as an MCP server via OAuth (no token ever stored here)

.USAGE
  iex "& { $(irm <raw-url>/scripts/connect-ai-clients.ps1) } -WorkerUrl https://YOUR-WORKER-URL"
#>

param(
  [string]$WorkerUrl
)

$ErrorActionPreference = "Stop"

$RawBase = "https://raw.githubusercontent.com/Ntrakiyski/shared-living-memory/main"
$InstructionSourcePath = "AGENTS.md"
$InstructionSectionStart = "<!-- shared-living-memory:mcp-client-instructions:start -->"
$InstructionSectionEnd = "<!-- shared-living-memory:mcp-client-instructions:end -->"
$StartMarker = "<!-- shared-living-memory:instructions:start -->"
$EndMarker = "<!-- shared-living-memory:instructions:end -->"
$SentinelPhrase = "At the start of EVERY conversation, call recall"

if ([string]::IsNullOrWhiteSpace($WorkerUrl)) {
  $WorkerUrl = Read-Host "Enter your Shared Living Memory worker URL (e.g. https://your-worker.workers.dev)"
}

$WorkerUrl = $WorkerUrl.TrimEnd("/")

if ($WorkerUrl -notmatch "^https?://") {
  Write-Error "Worker URL must start with http:// or https:// (got: $WorkerUrl)"
  exit 1
}

$McpUrl = "$WorkerUrl/mcp"

Write-Host "Worker URL: $WorkerUrl"
Write-Host "MCP endpoint: $McpUrl"
Write-Host ""

function Get-ClientInstructions {
  $document = Invoke-RestMethod -Uri "$RawBase/$InstructionSourcePath" -ErrorAction Stop
  $startIndex = $document.IndexOf($InstructionSectionStart)
  $endIndex = $document.IndexOf($InstructionSectionEnd)
  if ($startIndex -lt 0 -or $endIndex -lt 0 -or $endIndex -le $startIndex) {
    throw "Instruction block markers not found in $RawBase/$InstructionSourcePath"
  }
  $contentStart = $startIndex + $InstructionSectionStart.Length
  return $document.Substring($contentStart, $endIndex - $contentStart).Trim()
}

function Append-Instructions {
  param(
    [string]$TargetFile,
    [string]$Label
  )

  $dir = Split-Path -Parent $TargetFile
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  if (-not (Test-Path $TargetFile)) { New-Item -ItemType File -Path $TargetFile -Force | Out-Null }

  $existing = Get-Content -Raw -ErrorAction SilentlyContinue $TargetFile
  if ($null -eq $existing) { $existing = "" }

  if ($existing.Contains($StartMarker)) {
    Write-Host "[$Label] Already configured (marker found in $TargetFile) - skipping."
    return
  }

  if ($existing.Contains($SentinelPhrase)) {
    Write-Host "[$Label] Looks like you already pasted these instructions manually into $TargetFile - skipping to avoid duplicating."
    return
  }

  try {
    $body = Get-ClientInstructions
  } catch {
    Write-Warning "[$Label] Could not fetch instruction block from $RawBase/$InstructionSourcePath - skipping."
    return
  }

  $block = "`n$StartMarker`n$body`n$EndMarker`n"
  Add-Content -Path $TargetFile -Value $block
  Write-Host "[$Label] Appended instructions to $TargetFile"
}

Write-Host "-- Global instructions --"
Append-Instructions -TargetFile (Join-Path $env:USERPROFILE ".claude\CLAUDE.md") -Label "Claude Code"
Append-Instructions -TargetFile (Join-Path $env:USERPROFILE ".codex\AGENTS.md") -Label "Codex CLI"
Write-Host ""

Write-Host "-- MCP server registration (OAuth - no token needed here) --"

if (Get-Command claude -ErrorAction SilentlyContinue) {
  $alreadyRegistered = $false
  try { claude mcp get shared-living-memory *> $null; $alreadyRegistered = $true } catch { $alreadyRegistered = $false }

  if ($alreadyRegistered) {
    Write-Host "[Claude Code] 'shared-living-memory' MCP server is already registered - skipping."
  } else {
    try {
      claude mcp add --transport http shared-living-memory $McpUrl
      Write-Host "[Claude Code] Registered 'shared-living-memory'. You'll be prompted to authorize in your browser on first use."
    } catch {
      Write-Warning "[Claude Code] Failed to register 'shared-living-memory' - you can add it manually with:`n  claude mcp add --transport http shared-living-memory `"$McpUrl`""
    }
  }
} else {
  Write-Host "[Claude Code] 'claude' CLI not found on PATH - skipping."
}

if (Get-Command codex -ErrorAction SilentlyContinue) {
  $alreadyRegistered = $false
  try { codex mcp get shared-living-memory *> $null; $alreadyRegistered = $true } catch { $alreadyRegistered = $false }

  if ($alreadyRegistered) {
    Write-Host "[Codex CLI] 'shared-living-memory' MCP server is already registered - skipping."
  } else {
    try {
      codex mcp add shared-living-memory --url $McpUrl
      Write-Host "[Codex CLI] Registered 'shared-living-memory' and started the OAuth login flow."
    } catch {
      Write-Warning "[Codex CLI] Failed to register 'shared-living-memory' - you can add it manually with:`n  codex mcp add shared-living-memory --url `"$McpUrl`""
    }
  }
} else {
  Write-Host "[Codex CLI] 'codex' CLI not found on PATH - skipping."
}

Write-Host ""
Write-Host "-- Done --"
Write-Host "Reminders:"
Write-Host "  - On first use you'll be prompted in your browser to enter your workspace key (AUTH_TOKEN) -"
Write-Host "    that's the one-time OAuth handshake. (If you connect both Claude Code and"
Write-Host "    Codex in the same browser session, you may only be asked once.)"
Write-Host "  - Also using the ChatGPT or Claude apps (not Codex CLI / Claude Code)? Their"
Write-Host "    personalization / custom-instruction settings are account-level and have no"
Write-Host "    public write API - paste the 'Shared Living Memory MCP Client Instructions' block"
Write-Host "    from AGENTS.md into ChatGPT's Settings -> Personalization -> Custom Instructions,"
Write-Host "    and a similar block into claude.ai's profile preferences, by hand."
