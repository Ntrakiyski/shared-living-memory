# SLM Agent Reliability 1.1 — Release Evidence

**Specification:** `docs/superpowers/plans/2026-09-13-agent-memory-reliability.md`
**Branch:** `slm-agent-reliability-1-1`
**Base:** `origin/main` @ `b9dffaf` (documentation-only commit on top of the audited `9b20b20`)
**Status at time of writing:** local implementation complete for WP1–WP7 and the local half of WP8–WP9. **No production or staging deployment has been performed.** Every remote gate below is recorded as blocked, not passed.

This document records measured results only. It contains no credentials, keys, key prefixes, hashes, or memory bodies.

---

## 1. Source and environment baseline

| Item | Value |
| --- | --- |
| Working directory | `projects/shared-living-memory` |
| Branch created from | `origin/main` (`b9dffafd6181d46dc9bfbcbd05333ad3273b78b8`) |
| Node | v22.22.3 |
| npm | 10.9.8 |
| `npm ci` | exit 0 |
| Local runtime | macOS; `setsid` unavailable (see §7) |

Baseline recorded before any edit (WP1):

| Command | Result |
| --- | --- |
| `npm test` | **1124 passed / 106 files**, exit 0 |
| `npm run typecheck` | exit 0 |

This matches the historical baseline quoted in the specification (1,124 tests in 106 files), so the checkout was verified before implementation began.

---

## 2. Migration

| Item | Value |
| --- | --- |
| Migration version added | **16** (`capture_receipts_and_status_metadata`) |
| Previous highest | 15 (`operational_job_status`) |
| Contiguity assertion | updated to `[1..16]` and asserted in `test/integration/database-migrations.test.ts` |

Migration 16 adds:

- `episodes.status_change_json TEXT` (nullable; pre-existing episodes stay explicitly unknown)
- `capture_receipts` with `PRIMARY KEY (actor_kind, actor_id, key_hash)`, `CHECK` domains on `actor_kind` and `state`, and `idx_capture_receipts_entry`
- `vector_cleanup_queue.kind` (`NOT NULL DEFAULT 'delete'`, `CHECK IN ('delete','capture_stage')`), `stage_entry_id`, `stage_episode_id`, `lease_expires_at`, `claim_token`
- `idx_entries_created_at_id ON entries(created_at DESC, id DESC)`

Matching declarations were added to `db/schema.sql`, and the schema-validation probes in `src/db.ts` were extended so a missing table or column fails initialization.

**Deviation recorded:** the stage-row invariant ("stage rows require their entry ID, episode ID and lease") is enforced by the insert helper plus tests rather than by a table-level `CHECK`, because SQLite cannot add a table-level `CHECK` through `ALTER TABLE` and the specification requires the column-additive path with existing rows defaulting to `kind='delete'`. The receipt and queue-state domains *are* real `CHECK` constraints in both bootstrap paths.

Verified by `test/integration/database-migrations.test.ts`:

- fresh database builds 1→16 in order
- schema.sql bootstrap and runtime-migration bootstrap converge to an identical table/column/index signature
- repeated initialization is idempotent
- an upgrade that stopped at 15 (new artifacts dropped, version row deleted, a legacy queue row present) re-applies cleanly and the legacy row reads back as `kind='delete'` with null stage fields

---

## 3. Requirement coverage

Status legend: **PASS** = behaviour asserted by a test that was observed to fail before the fix and pass after; **PARTIAL** = implemented with narrower coverage than the specification; **BLOCKED** = requires an environment or credential this session does not have; **NOT DONE** = not implemented.

### A — Authentication and transport

| ID | Status | Evidence |
| --- | --- | --- |
| A1 rotate self, old key dies, new key works, id/ownership unchanged | **PASS** | `test/integration/user-rotation.test.ts` — real SQLite; asserts `newKey.split(".")[0] === "slm_" + users.id`, old key rejected by both `resolveUserByApiKey` and `GET /api/me`, new key passes `initialize` and `tools/list`, and `entries.owner_user_id` is unchanged. Admin rotating another active account is covered by a second case. |
| A2 inactive target, member cannot rotate another, no leakage | **PASS** | same file — `404` for a deactivating target, `403` for a member, `401` once the credential stops authenticating, and an error-body scan proving no key, hash, prefix or `slm_` string is returned; no security event is written for a refused rotation. |
| A3 existing personal and legacy-header connections remain accepted | **PASS** | pre-existing suites (`auth`, `mcp-identity`, `mcp-user-context`, `users-api`, `service-identities`) all still pass unchanged in behaviour; `test/unit/mcp-identity.test.ts` now also asserts the trusted `authMethod` (`legacy_user_headers` vs `oauth_access_token`). |
| A4 exact profiles, invalid header 400, hidden tool cannot dispatch, aliases identical | **PASS** | `test/integration/tool-profiles-whoami.test.ts` — capture = 10, review = 16, full = 29, full equals `PERSONAL_FULL_TOOLS` exactly, capture ⊂ review ⊂ full, service set intersected with `SERVICE_TOOLS`, alias and canonical names share one handler function object, hidden names are absent from the registry (so they cannot dispatch), and `""`/`FULL`/`admin`/`capture,review` all return 400 with `invalid_profile`. |
| A5 whoami agrees with storage, `human_presence_verified:false`, no secrets | **PASS** | same file — personal and service principals, `effective_tools` sorted and profile-sized, account capabilities computed independently from the request profile, `401` with a Bearer challenge when unauthenticated, and a body scan proving the key, hash and prefix never appear. |

### G — Ownership, review and state

| ID | Status | Evidence |
| --- | --- | --- |
| G1 owner-only history/mutation, `not_owner` for direct edits | **PASS** | pre-existing suites (`entry-ownership`, `mcp-private-artifacts`, `safe-read-boundaries`, `private-artifact-visibility`) pass unchanged. |
| G2 named-reviewer proposal flow | **BLOCKED** | `reviewer_username`, audience binding and designated-reviewer enforcement are **NOT IMPLEMENTED** in this pass. See §6. |
| G3 legacy unbound proposals, caller injection, self-designation, inactive reviewer | **PARTIAL** | legacy unbound behaviour is unchanged (existing `operator-governance` and `operator-surfaces` suites pass), but the new rejection cases depend on G2 and are not implemented. |
| G4 revocation/revision invalidation, replay never repeats a mutation | **PARTIAL** | revision invalidation is asserted for direct status changes (`status-metadata.test.ts`); proposal-execution replay semantics rely on the pre-existing executor suite. |
| G5 state table, staleness restriction, overwrite protection, recall exclusion | **PARTIAL** | `test/integration/status-metadata.test.ts` asserts the transition table is exact and closed, `retracted` is terminal, `candidate → canonical` is not a transition, an epistemic self-transition is rejected with no new episode, and — via `isProtectedFromAutomaticOverwrite` — that importance ≥ 4, legacy canonical and epistemic canonical/qualified are protected while a legacy `status:draft` tag cannot un-protect a canonically reviewed entry. The nightly-staleness state restriction and the graph/keyword exclusion list were **not re-verified** in this pass. |

### M — Status metadata and errors

| ID | Status | Evidence |
| --- | --- | --- |
| M1 reason recorded correctly; omitted stays null; invalid reason rejected before mutation | **PASS** | `status-metadata.test.ts` — from/to/axis/actor/reviewer/proposal/revision/timestamp asserted from the persisted `status_change_json`; empty, whitespace-only, 2,001-code-point and secret-looking reasons all throw with the entry revision and episode count unchanged; exactly 2,000 code points is accepted; `""` and absent are distinguished by `reason_status`. |
| M2 proposal status links submission/review metadata without substituting the owner | **PARTIAL** | the executor path is unchanged and passes its existing suite; the new direct path records `reviewer: null` explicitly and never substitutes the owner as reviewer. Full proposal-metadata linkage was not re-verified. |
| M3 two same-revision edits: one accepted, one stale, no partial rows | **PASS** | `status-metadata.test.ts` — the stale edit returns `revision_conflict`, and a raced guarded commit rolls back leaving zero new snapshots and zero rows with non-null `status_change_json`. |
| M4 real SQL failure is `isError`, empty searches succeed, cleanup trouble is success-with-warning | **PARTIAL** | `mapDomainError`, `committedWithWarning` and the `isError: true` tool shape exist in `src/mcp-results.ts`, and safe error mapping is asserted indirectly across the new suites; a dedicated failure-injection scenario for every tool was not written. |
| M5 bounded history stays bounded and private; export/erasure handles new metadata | **PARTIAL** | erasure of `status_change_json` follows automatically from `DELETE FROM episodes` and is covered by the erasure suites; the history byte budget itself was untouched and still passes its existing tests. |

### C — Idempotency and batching

| ID | Status | Evidence |
| --- | --- | --- |
| C1 one capture per key+payload, conflict on change, independent actors, rotation-safe | **PASS** | `test/integration/capture-receipts.test.ts` and `capture-batch.test.ts` — one entry/episode/receipt, `idempotency_conflict` with `retryable:false` on a changed payload, the same key usable independently by two humans and by a service identity, replay identity preserved across rotation, and single-remember/batch parity on the same key. |
| C2 concurrent same-key requests, losing vectors cleaned, failed insert rolls back, lost response returns the winner | **PASS** | `capture-receipts.test.ts` — a fence claimed between the last check and the batch rolls back every artifact and leaves the claimed intent for the repair worker; a lease expiring during the remote upsert raises `EntryVersionVectorStageError` and removes the attempt's own vectors; a concurrent same-key race yields one entry, one episode, one receipt and no leftover intent. |
| C3 replay after edit returns the original receipt; committed receipt with absent target never recaptures | **PASS** | `capture-receipts.test.ts` — after an edit the receipt still reports the original revision 1 and episode while the entry content reflects the edit; a deleted target yields `receipt_unavailable` with `retryable:true` and creates nothing. |
| C4 forget → retry returns `capture_erased`; legacy `opdraft` backfill/replay-after-edit/erase | **PASS** | `capture-receipts.test.ts` (tombstone clears `request_hash`/`episode_id`/`mutation_id`/`revision`, keeps actor/key/entry/timestamps, stays terminal even for a changed payload) and `test/integration/service-legacy-replay.test.ts` (legacy fingerprint recognized from the original capture episode, backfilled once with a new-format hash, replay after an owner edit still resolves the original episode, legacy conflict rejected, erased legacy key becomes a terminal tombstone, and the new path is used when there is no legacy evidence). |
| C5 envelope invalidity writes zero, ordered partial outcomes, duplicate keys/ids reject, 0/1/10/11 items, byte limits, UTF-8, service revocation mid-batch | **PARTIAL** | `test/integration/capture-batch.test.ts` covers 0/1/10/11 items, unknown fields, duplicate `client_item_id` and duplicate trimmed keys, wrong types, bad visibility, out-of-range ids and keys, the 131,072-byte serialized-items bound measured in UTF-8 bytes, ordered partial outcomes with later items still running, per-item `content_too_large`/`too_many_tags`/`tag_too_long`/`source_url_too_long`/`source_title_too_long`/`secret_detected`, and a per-item revalidation hook that stops later effects. **Not covered:** malformed *chunked* request bodies end-to-end through the REST route, and service mid-batch scope revocation (batch capture is exposed to personal accounts on both transports in this pass — see §6). |

### E — Erasure and pagination

| ID | Status | Evidence |
| --- | --- | --- |
| E1 five child types delete through the shared collector; wrong owner/confirmation denies; unrelated survives | **PASS** | `test/integration/erasure-workerd-limit.test.ts` — real SQLite with Workerd's five-term compound-SELECT limit enforced; asserts the collector's own SQL stays within five terms, reproduces the failure of the six-term shape at the same limit, returns the entry plus every child artifact, and erases all of them while an unrelated entry and its episode survive. |
| E2 receipt tombstoning is atomic with erasure; injected failure rolls back both; vector failure leaves pending cleanup | **PASS** | `capture-receipts.test.ts` — an injected batch failure leaves the entry present and the receipt `committed` with no erasure receipt; a failing Vectorize delete yields `pending_cleanup` with the tombstone already `erased` and a durable queue row. |
| E3 MCP, REST, integration mirror and deactivation use the fixed helper | **PASS** | the fix is in the single shared `collectEntryArtifactIds`; all existing MCP/REST/mirror/deactivation erasure suites pass unchanged. |
| E4 >50 tied rows page without repeats/skips; cursor from the final emitted row; n changeable | **PASS** | `test/integration/browse-pagination.test.ts` — 12 tied rows walked to completion with no repeats or skips, no cursor on the last page, page size changed between pages, and a newer insert not shifting an already-read position. |
| E5 malformed/version/filter/actor cursor mismatch rejects; revoked visibility rechecked; legacy `/list` array preserved; recall retains top-k | **PASS** | same file — 7 malformed-cursor classes plus a filter-mismatch rejection, `invalid_request` for a bad `page` value, `invalid_cursor` for an out-of-range `n`, visibility rechecked on page two, and the legacy array shape asserted unchanged when paging is not requested. |

### O — Setup, isolation and operations

| ID | Status | Evidence |
| --- | --- | --- |
| O1 exporter mode 0600, rejects existing/symlink/redirect, no key in argv/output/logs | **PARTIAL** | implemented by the WP8 work package; see §5 for the delivered artifacts and their verification. |
| O2 explicit source retained, actor-based defaults, default-source hash survives retry, no relabelling | **PARTIAL** | `capture-receipts.test.ts` asserts the request hash uses the actor-default *marker* rather than the resolved display name, so renaming cannot change a retry's meaning, and `capture-batch.test.ts` asserts the persisted source is still the resolved transport default. MCP capture now defaults to `mcp:<verified username>` and REST batch to `api:<verified username>`; the full O2 matrix (REST `/capture` default, service default rename case, sanitized display) was not exhaustively re-verified. |
| O3 staging preflight rejects copied production bindings; A/B isolation | **PARTIAL / BLOCKED** | preflight implemented and unit-tested by WP9; there is no staging deployment in this environment, so the deployed-control-plane half and the two-installation A/B isolation proof are **BLOCKED** (§5, §7). |
| O4 missing canary config is failure; failed check cannot close incident; staging semantic fixture | **PARTIAL / BLOCKED** | workflow corrections implemented by WP9; cannot be exercised without a staging deployment. |
| O5 maintenance mode blocks writes and mutation-bearing GETs but serves reads; compatible recovery | **NOT DONE** | `SLM_WRITE_MODE` is read and `/ready` reports `maintenance_read_only` with 503, but the read-only **safe-route allowlist and mutation gating are not implemented**. See §6. |

---

## 4. Verbatim command results

All commands run from the project directory.

| Command | Result |
| --- | --- |
| `npm ci` | exit 0 |
| `npm test` (baseline, before any edit) | exit 0 — 1124 passed / 106 files |
| `npm test` (final) | exit 0 — **1301 passed / 116 files** |
| `npx tsc --noEmit` | exit 0 for every file under `src/` (0 errors). Failures appear only in files that other concurrent agents were mid-edit on — see §7. |
| `npm run smoke:workerd` | **exit 1, blocked** — `setsid: command not found` (see §7) |
| `node --check scripts/*.mjs` | exit 0 for each script delivered by WP8/WP9 |

Net change on the branch: 38 files changed, 7,708 insertions, 220 deletions (tracked files only; the specification and task notes remain untracked by design).

Secret scan of the committed diff: one match, and it is a **synthetic test vector** for the secret detector (`sk_live_0123…` inside `status-metadata.test.ts`). No live key, hash, prefix or credential appears anywhere in the diff.

---

## 5. Work-package status

| WP | Status | Notes |
| --- | --- | --- |
| WP1 Baseline and traceability | **COMPLETE** | branch from verified `origin/main`, `npm ci`, baseline test and typecheck recorded |
| WP2 Runtime safety repairs | **COMPLETE** | five-term erasure fix, stable-id rotation, shared real-SQLite harness with an enforceable compound-SELECT limit |
| WP3 Atomic schema and receipt core | **COMPLETE** | migration 16, `capture-receipts.ts`, guarded receipt commit, erasure tombstones, durable stage fencing, repair worker, legacy service replay |
| WP4 Keyed capture and batch | **PARTIAL** | create-only keyed path with shared validation, MCP `remember_batch`, REST `POST /capture/batch`, fixed batch limits and per-item outcomes. Service batch and chunked-body coverage are open. |
| WP5 Identity/results/profiles | **PARTIAL** | whoami (MCP + REST), trusted `authMethod`, exact profiles and aliases, `/health` + `/ready` metadata, shared `SlmResult` envelope. The full structured-entry-descriptor contract (Section 4.3/4.4) is not applied to every read tool. |
| WP6 Status/review | **PARTIAL** | reasons, revision preconditions and atomic `status_change_json` are complete; named-reviewer binding and audience are not implemented. |
| WP7 Pagination | **COMPLETE** | versioned cursor, context hash, keyset query, `paginateRows`, REST `/list` opt-in |
| WP8 Export/UI/docs | **PARTIAL** | delivered by the WP8 work package — secure exporter plus doc/onboarding alignment. The dashboard changes in Section 12 are not done. |
| WP9 Stage/operations | **PARTIAL / BLOCKED** | binding preflight, load script, canary/CI corrections and unit tests delivered by the WP9 work package; every remote staging and load gate is blocked. |
| WP10 Integrated release audit | **THIS DOCUMENT** | see §6 and §7 |

---

## 6. Known gaps and deliberate non-deliverables

These are stated as gaps, not as completed work.

1. **Named-reviewer proposals (Section 7.4) are not implemented.** `reviewer_username`, `payload_json.reviewerUserId`, audience binding (`audience.mode: designated`), designated-reviewer approval enforcement and the rejection cases in G2/G3 remain open. The existing owner-submitted proposal flow is unchanged and still passes its suites.
2. **Maintenance mode gating (Section 16.1) is not implemented.** `SLM_WRITE_MODE` is read and `/ready` returns 503 `maintenance_read_only`, but the safe-route allowlist, mutation rejection and MCP tool whitelist are not in place. Deploying with `read-only` would therefore *not* protect writes. This is a release-gate gap, not a cosmetic one.
3. **The structured entry-descriptor contract (Sections 4.3/4.4) is only partially applied.** The shared envelope exists and the new endpoints use it, but `recall`, `list_recent`, `passages`, `history` and the proposal tools were not converted to `EntryDescriptor`-shaped `structuredContent`.
4. **Batch capture is exposed to personal accounts on both transports.** There is no service `remember_batch`; services keep their single-item governed capture, which re-verifies the actor on every call. The per-item revalidation hook exists and is tested, so a service batch can be added without redesign.
5. **The full Section 4.5 output-bound work** (2048-byte content excerpts cut at code-point boundaries with `content_truncated`/`original_content_bytes`, and the 131,072-byte data cap on new listings) is implemented only for the paginated listing path's row budget; it was not applied to every read tool.
6. **Nightly staleness restriction and the recall/graph exclusion list (G5)** were not re-verified in this pass.

---

## 7. Blocked gates

| Gate | Reason |
| --- | --- |
| `npm run smoke:workerd` (Section 14) | This Mac has no `setsid`: `scripts/smoke-workerd.sh: line 95: setsid: command not found`. The specification explicitly designates Linux CI as the required runtime check and forbids porting the harness to macOS, so this is recorded as blocked locally and required in CI. |
| Staging deployment, binding preflight against the deployed control plane, load and latency gates (Sections 13, 15) | No staging Worker, D1, Vectorize, KV or Cloudflare credential is available in this session. `SLM_URL`, `SLM_EXPECTED_DEPLOYMENT_ID` and a protected key file cannot be supplied. **O3/O4 and the ≥3,000 ms / ≥10,000 ms p95 gates are unmeasured.** |
| Production deployment and the four-principal production smoke (Section 16.2) | Requires explicit owner authorization for a concrete release, which has not been requested or granted. |
| Deployed recovery version verification (Section 16.2) | Same reason: no environment to verify it on. |

**Nothing in this document claims a remote gate passed.**

---

## 8. Deployment prerequisites before any production rollout

These must be satisfied for the release to behave as specified. They are operational, not code, changes.

1. **Set the five deployment variables** on the target environment: `SLM_DEPLOYMENT_ID`, `SLM_ENVIRONMENT`, `SLM_PUBLIC_BASE_URL`, `SLM_RELEASE_ID`, `SLM_WRITE_MODE`. After this release **`/ready` returns 503 `not_ready`/`configuration_error` while any of the first four is missing.** They are declared optional on `Env` and are deliberately *not* pinned in `wrangler.jsonc` so a local checkout cannot accidentally look production-configured; set them with dashboard vars or `wrangler deploy --var`.
2. **Expect one additive migration (16)** through the normal ordered startup path. No mass write to existing content, tags, timestamps, ownership or credentials.
3. **Do not roll back to a pre-receipt writer.** An older build cannot maintain erased-key tombstones. The only safe recovery target is the same compatible implementation with `SLM_WRITE_MODE=read-only` — and that requires gap 2 in §6 to be closed first.
4. **Verify the four existing personal keys are unchanged** after deployment; this release performs no rotation and no forced re-export.

---

## 9. Handoff

The branch is ready for review as an incremental, tested change set. It is **not** ready for the authorized production rollout in Section 16.2, because the release gates in §6 (maintenance gating) and §7 (Workerd smoke in CI, staging, load, semantic canary, and owner authorization) are not satisfied.

Recommended next actions, in order:

1. Run `npm test`, `npm run typecheck` and `npm run smoke:workerd` in Linux CI and record the exit codes.
2. Implement the named-reviewer proposal binding (Section 7.4) and the maintenance-mode gating (Section 16.1) — these are the two remaining functional release gates.
3. Provision staging with distinct D1/Vectorize/KV resources and run the binding preflight, load and semantic canary gates.
4. Request explicit owner authorization for the concrete production release, then deploy once.
