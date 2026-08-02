#!/usr/bin/env bash
set -Eeuo pipefail

SLM_URL="${SLM_STAGING_URL:?SLM_STAGING_URL is required}"
SLM_KEY="${SLM_STAGING_ADMIN_KEY:?SLM_STAGING_ADMIN_KEY is required}"

if [[ "$SLM_URL" =~ shared-living-memory\.nikolay-trakiyski\.workers\.dev ]]; then
  echo "Refusing production hostname. Provide a staging URL." >&2
  exit 1
fi

echo "=== Release preflight: $SLM_URL ==="

echo "  Health..."
health=$(curl -sf "$SLM_URL/health" || true)
if [[ -z "$health" ]]; then echo "  FAIL: /health unreachable"; exit 1; fi
echo "  OK"

echo "  Readiness..."
ready=$(curl -sf "$SLM_URL/ready" || true)
if [[ -z "$ready" ]]; then echo "  FAIL: /ready unreachable"; exit 1; fi
echo "  OK"

echo "  Bootstrap status..."
bootstrap=$(curl -sf "$SLM_URL/api/bootstrap-status" || true)
echo "  $bootstrap"

echo "  Auth (GET /api/me)..."
auth=$(curl -sf -H "Authorization: Bearer $SLM_KEY" "$SLM_URL/api/me" || true)
if [[ -z "$auth" ]]; then echo "  FAIL: /api/me returns empty"; exit 1; fi
echo "  OK"

echo "  Users list..."
users=$(curl -sf -H "Authorization: Bearer $SLM_KEY" "$SLM_URL/api/users" || true)
if [[ -z "$users" ]]; then echo "  FAIL: /api/users returns empty"; exit 1; fi
echo "  OK"

echo "  Metrics..."
metrics=$(curl -sf -H "Authorization: Bearer $SLM_KEY" "$SLM_URL/pilot-metrics?days=1" || true)
echo "  $metrics"

echo "=== Preflight passed ==="
