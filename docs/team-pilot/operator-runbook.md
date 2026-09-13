# Operator Runbook — Shared Living Memory Team Pilot

## Bootstrap

A fresh workspace has no active users. The first operator visits the dashboard,
enters the workspace key + their chosen username, and receives a one-time
personal API key. This key is the only administrator credential.

```bash
# Verify bootstrap status
curl https://staging.example.test/api/bootstrap-status
# {"needs_bootstrap":true}

# Bootstrap the first admin (requires workspace key)
curl -X POST https://staging.example.test/api/bootstrap \
  -H "Authorization: Bearer YOUR-WORKSPACE-KEY" \
  -H "Content-Type: application/json" \
  -d '{"username":"admin"}'
# {"ok":true,"username":"admin","key":"slm_xxxxx.yyyyyyyy"}
```

## Creating users

After bootstrap, all user management requires an admin personal key.

```bash
curl -X POST https://staging.example.test/api/users \
  -H "Authorization: Bearer slm_admin_key" \
  -H "Content-Type: application/json" \
  -d '{"username":"alice","role":"member"}'
```

## Key rotation

Users can rotate their own key; admins can rotate any user's key.

```bash
# Self
curl -X POST https://staging.example.test/api/me/rotate-key \
  -H "Authorization: Bearer slm_old_key"

# Admin
curl -X POST https://staging.example.test/api/users/ALICE_ID/rotate-key \
  -H "Authorization: Bearer slm_admin_key"
```

## Deactivation

Requires a replacement custodian (admin), private export acknowledgement,
and two-phase execution.

```bash
curl -X POST https://staging.example.test/api/users/ALICE_ID/deactivate \
  -H "Authorization: Bearer slm_admin_key" \
  -H "Content-Type: application/json" \
  -d '{"transfer_to_user_id":"ADMIN_ID","private_export_acknowledgement":"completed","batch_size":10}'
```

## Health monitoring

```bash
# Liveness + non-secret deployment metadata (no auth, no database query)
curl https://YOUR-DEPLOYMENT/health
# {"ok":true,"status":"ok","deployment":{...},"missing_configuration":[]}

# Readiness: requires valid deployment metadata, a responsive D1 and write_mode=enabled
curl https://YOUR-DEPLOYMENT/ready
# 200 {"ok":true,"status":"ready",...}
# 503 {"ok":false,"status":"maintenance_read_only",...}
# 503 {"ok":false,"status":"not_ready","reason":"configuration_error","missing_configuration":[...]}

# Verify the authenticated identity this connection is using
curl https://YOUR-DEPLOYMENT/api/whoami -H "Authorization: Bearer slm_personal_key"

# Pilot metrics (admin only)
curl https://YOUR-DEPLOYMENT/pilot-metrics?days=14 \
  -H "Authorization: Bearer slm_admin_key"
```

`SLM_DEPLOYMENT_ID`, `SLM_ENVIRONMENT`, `SLM_PUBLIC_BASE_URL` and `SLM_RELEASE_ID`
must be configured on every deployment. While any of them is missing, `/ready`
answers `503 not_ready` with `reason: configuration_error` and lists the missing
names — that is the intended fail-closed behavior, not a bug.

## Incident: enable read-only maintenance

Set `SLM_WRITE_MODE=read-only` on the deployment and redeploy, or change the
variable in the Cloudflare dashboard and let the isolate recycle.

In read-only mode:

- `/ready` answers `503 maintenance_read_only`, while **read tools keep working**:
  static assets, `/health`, `/api/whoami`, `/api/me`, `/count`, `/list`, `/recall`,
  `/export`, owner-authorized history/passages/entry reads, graph reads, proposal
  and service listings, and the shared session handlers.
- every application, admin, memory, governance and credential mutation is refused
  with `503 maintenance_read_only` **before any side effect**.
- `GET /digest` is refused, because it compresses memories.
- MCP protocol negotiation still works; `whoami`, `recall`, `list_recent`,
  `passages`, `history`, `connections` and the proposal listing tools remain
  callable, and every mutation tool answers with an explicit
  `maintenance_read_only` tool error.
- scheduled content, graph, integration, erasure and offboarding mutation jobs do
  not start.
- `commitEntryVersion` and `eraseEntryArtifacts` refuse on their own, so a
  background or internal caller cannot bypass the gate.

`POST /chat` is refused in this mode.

## Recovery

Recovery is a **compatible** roll-forward, never a downgrade. An older build
cannot maintain capture receipts or erased-key tombstones, so reverting to a
pre-receipt writer can resurrect permanently deleted content.

1. **Stop new writes.** Set `SLM_WRITE_MODE=read-only` and redeploy, or switch to
   the prepared recovery version, which is the *same* implementation with that
   variable set. Confirm `/ready` answers `503 maintenance_read_only`.
2. **Observe in-flight work before touching data.** Let accepted calls finish on
   the old isolate — a configuration change does not cancel a request that is
   already running. Check that staged capture intents have drained
   (`vector_cleanup_queue` rows with `kind = 'capture_stage'` returning to zero)
   and that no deactivation, integration or erasure job is mid-flight.
   **Unresolved activity blocks a restore.**
3. **Diagnose before restoring.** `/health` reports the deployment metadata and
   `/ready` distinguishes `maintenance_read_only` from `not_ready`
   (`configuration_error`, storage failure). Check the canary incident issue,
   which records the failing stage, code, version, time and workflow run.
4. **Restore data only after confirming the exact recovery point and its impact.**
   D1 Time Travel is the only supported data restore:
   `wrangler d1 time-travel restore <database> --timestamp <ISO-8601>`.
   Never wipe D1 and never rebuild authority from Vectorize — D1 is the
   authority; a Vectorize-only rebuild cannot recreate receipts, tombstones,
   status metadata or immutable history.
5. **Reconcile operational state after the restore.**
   - accepted capture receipts remain authoritative; do not re-capture a keyed
     write whose receipt exists.
   - `capture_receipts` rows in state `erased` stay erased: a later replay of that
     key must still answer `capture_erased`.
   - let the repair schedule drain `vector_cleanup_queue` and confirm it reaches
     zero, including `capture_stage` intents.
   - confirm `pending_cleanup` erasure receipts either reach `complete` or are
     reported to the operator as unresolved pending cleanup.
6. **Verify the four established personal credentials still authenticate** —
   Jarvis, researcher, engineer and clients. Recovery must not rotate, re-export
   or overwrite them. Run `scripts/mcp-protocol-smoke.mjs --discovery-only`
   against the deployment for each principal and confirm `whoami` returns the
   expected account, then run `scripts/release-preflight.sh`.
7. **Resume writes.** Set `SLM_WRITE_MODE=enabled` and confirm `/ready` returns
   `200 ready`. Only then resume normal operation.

## Break-glass

If both administrators are unavailable, Cloudflare Dashboard operator access can
be used to read D1 directly. Every use requires immediate workspace-key rotation,
personal-key rotation for the affected admins, and incident review. Note that
rotating an admin key replaces only its secret: the account id and every entry it
owns are preserved, so ownership and history stay intact.
