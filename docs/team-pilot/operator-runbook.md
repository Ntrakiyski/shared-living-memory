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
# Liveness (no auth)
curl https://staging.example.test/health

# Readiness (DB probe)
curl https://staging.example.test/ready

# Pilot metrics (admin only)
curl https://staging.example.test/pilot-metrics?days=14 \
  -H "Authorization: Bearer slm_admin_key"
```

## Recovery

1. **Restore Worker**: `wrangler rollback --name shared-living-memory`
2. **D1 Time Travel**: `wrangler d1 time-travel restore shared-living-memory-db`
3. **Rebuild Vectorize**: Request reindex through the dashboard or API
4. **Verify**: Run `scripts/mcp-protocol-smoke.mjs` and `scripts/release-preflight.sh`
5. **Rotate keys**: Rotate all admin personal keys after any recovery

## Break-glass

If both administrators are unavailable, Cloudflare Dashboard operator access
can be used to read D1 directly. Every use requires immediate workspace-key
rotation, personal-key rotation for all admins, and incident review.
