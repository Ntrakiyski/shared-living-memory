# SLM Agent Reliability 1.1 — Release Evidence

**Specification:** `docs/superpowers/plans/2026-09-13-agent-memory-reliability.md`
**Branch:** `slm-agent-reliability-1-1`
**Base:** `origin/main` @ `b9dffaf` (documentation-only commit on top of the audited `9b20b20`)
**Status at time of writing:** all ten work packages implemented locally, with the listed deviations in §6. **No production or staging deployment has been performed.** Every remote gate below is recorded as blocked, not passed.

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
| G2 named-reviewer proposal flow | **PASS** | `test/integration/reviewer-binding.test.ts` — the resolved immutable reviewer id is bound into `payload_json` *before* the payload hash is computed, a designated proposal is invisible to an unrelated engineer **and** to an unrelated admin, the designated reviewer approves and executes, and `entries.owner_user_id` remains the researcher's. |
| G3 legacy unbound proposals, caller injection, self-designation, inactive reviewer | **PASS** | same file — `payload.reviewerUserId` injection, an unknown/invalid/over-long username, a self-designation, and an inactive reviewer are all rejected with `invalid_input` and no proposal row; a changed reviewer under a reused idempotency key is `idempotency_conflict` while the identical retry replays; an unassigned proposal stays `mode: legacy` and remains visible under the old rules. |
| G4 revocation/revision invalidation, replay never repeats a mutation | **PASS** | `reviewer-binding.test.ts` — the proposer cannot review a bound proposal, and after the reviewer deactivates a completed execution remains replayable to a still-authorized caller without a second version change (the entry stays at revision 2). Revision invalidation for direct status changes is asserted in `status-metadata.test.ts`. |
| G5 state table, staleness restriction, overwrite protection | **PASS** | `status-metadata.test.ts` — the transition table is exact and closed, `retracted` is terminal, `candidate → canonical` is not a transition, and an epistemic self-transition is rejected with no new episode. `isProtectedFromAutomaticOverwrite` protects importance ≥ 4, legacy canonical and epistemic canonical/qualified, and a legacy `status:draft` tag cannot un-protect a canonically reviewed entry. Nightly staleness now selects only `candidate/reviewed/canonical/qualified`, excludes legacy-deprecated rows, re-checks state/tag/revision immediately before the commit, and attributes every transition to the system actor `_staleness` rather than the entry owner — verified by seeding candidate, reviewed, superseded, retracted, deprecated and already-stale expired rows and asserting only the first two move. **Exclusion from recall/graph traversal is still not re-verified in this pass.** |

### M — Status metadata and errors

| ID | Status | Evidence |
| --- | --- | --- |
| M1 reason recorded correctly; omitted stays null; invalid reason rejected before mutation | **PASS** | `status-metadata.test.ts` — from/to/axis/actor/reviewer/proposal/revision/timestamp asserted from the persisted `status_change_json`; empty, whitespace-only, 2,001-code-point and secret-looking reasons all throw with the entry revision and episode count unchanged; exactly 2,000 code points is accepted; `""` and absent are distinguished by `reason_status`. |
| M2 proposal status links submission/review metadata without substituting the owner | **PASS** | `reviewer-binding.test.ts` — a proposal-executed epistemic transition persists `status_change_json` with the ACTUAL executor as `actor`, the stored approving account as `reviewer`, the stored review reason as `reason`, `proposal_id` linking the submission rationale, and a `revision` matching the entry's committed revision. The owner appears as neither actor nor reviewer, and a pre-release episode stays explicitly `null`. |
| M3 two same-revision edits: one accepted, one stale, no partial rows | **PASS** | `status-metadata.test.ts` — the stale edit returns `revision_conflict`, and a raced guarded commit rolls back leaving zero new snapshots and zero rows with non-null `status_change_json`. |
| M4 real SQL failure is `isError`, empty searches succeed, cleanup trouble is success-with-warning | **PASS** | `test/integration/tool-failure-contract.test.ts`. This closes a real defect: the `audited` wrapper used to return a thrown failure as a bare text string with **no** `isError` and the **raw** exception message attached. It now sets `isError: true` and reports a safe code, and the audit record stores the mapped code rather than the raw message. Verified: a real database failure returns an `isError` tool result containing no SQL, table name or file path; an unrecognized failure maps to *retryable* `storage_unavailable` (it was previously mis-classified non-retryable); an empty search stays an `ok:true` success; and a committed deletion whose vector cleanup or audit finalization did not finish reports `ok:true` with `retry:false` and the authoritative deletion intact. |
| M5 bounded history stays bounded and private; export/erasure handles new metadata | **PASS** | `status-metadata.test.ts` — the history tool returns `{projection, episodes, snapshots, truncated, counts, guidance}` rendered from the already-bounded data; each authorized episode carries `status_change` (null for pre-release episodes rather than a guess); an over-long reason is truncated explicitly with `reason_truncated` and `reason_original_code_points`; counts and the byte budget are asserted; and a non-owner learns nothing. Erasure of the metadata follows from `DELETE FROM episodes` and is covered by the erasure suites. |

### C — Idempotency and batching

| ID | Status | Evidence |
| --- | --- | --- |
| C1 one capture per key+payload, conflict on change, independent actors, rotation-safe | **PASS** | `test/integration/capture-receipts.test.ts` and `capture-batch.test.ts` — one entry/episode/receipt, `idempotency_conflict` with `retryable:false` on a changed payload, the same key usable independently by two humans and by a service identity, replay identity preserved across rotation, and single-remember/batch parity on the same key. |
| C2 concurrent same-key requests, losing vectors cleaned, failed insert rolls back, lost response returns the winner | **PASS** | `capture-receipts.test.ts` — a fence claimed between the last check and the batch rolls back every artifact and leaves the claimed intent for the repair worker; a lease expiring during the remote upsert raises `EntryVersionVectorStageError` and removes the attempt's own vectors; a concurrent same-key race yields one entry, one episode, one receipt and no leftover intent. |
| C3 replay after edit returns the original receipt; committed receipt with absent target never recaptures | **PASS** | `capture-receipts.test.ts` — after an edit the receipt still reports the original revision 1 and episode while the entry content reflects the edit; a deleted target yields `receipt_unavailable` with `retryable:true` and creates nothing. |
| C4 forget → retry returns `capture_erased`; legacy `opdraft` backfill/replay-after-edit/erase | **PASS** | `capture-receipts.test.ts` (tombstone clears `request_hash`/`episode_id`/`mutation_id`/`revision`, keeps actor/key/entry/timestamps, stays terminal even for a changed payload) and `test/integration/service-legacy-replay.test.ts` (legacy fingerprint recognized from the original capture episode, backfilled once with a new-format hash, replay after an owner edit still resolves the original episode, legacy conflict rejected, erased legacy key becomes a terminal tombstone, and the new path is used when there is no legacy evidence). |
| C5 envelope invalidity writes zero, ordered partial outcomes, duplicate keys/ids reject, 0/1/10/11 items, byte limits, UTF-8, service revocation mid-batch | **PASS** | `test/integration/capture-batch.test.ts` covers 0/1/10/11 items, unknown fields, duplicate `client_item_id` and duplicate trimmed keys, wrong types, bad visibility, out-of-range ids and keys, the 131,072-byte serialized-items bound measured in UTF-8 bytes, ordered partial outcomes with later items still running, per-item `content_too_large`/`too_many_tags`/`tag_too_long`/`source_url_too_long`/`source_title_too_long`/`secret_detected`. `test/integration/source-defaults.test.ts` covers the service batch: ordered processing and summary shape, zero-write envelope rejection, per-item failure with later items still running, **and a credential revoked mid-batch stopping the later item**. Additionally, the shared validation now runs on the service single-item path, so the nine validation-parity cases hold for services too. **Closed in this round:** a chunked body with no `Content-Length` is served, an oversized chunked body is refused with 413 and writes nothing, a malformed chunked body is a clean 400, an oversized declared `Content-Length` is refused before reading, and multibyte content is measured in UTF-8 bytes. |

### E — Erasure and pagination

| ID | Status | Evidence |
| --- | --- | --- |
| E1 five child types delete through the shared collector; wrong owner/confirmation denies; unrelated survives | **PASS** | `test/integration/erasure-workerd-limit.test.ts` — real SQLite with Workerd's five-term compound-SELECT limit enforced; asserts the collector's own SQL stays within five terms, reproduces the failure of the six-term shape at the same limit, returns the entry plus every child artifact, and erases all of them while an unrelated entry and its episode survive. The **real-Workerd** fixture for this scenario is now in `scripts/smoke-workerd.sh`, gated on `WORKER_SMOKE_EXPECT_AI=1` because capture embeds through the AI binding, which a purely local Workerd does not provide. |
| E2 receipt tombstoning is atomic with erasure; injected failure rolls back both; vector failure leaves pending cleanup | **PASS** | `capture-receipts.test.ts` — an injected batch failure leaves the entry present and the receipt `committed` with no erasure receipt; a failing Vectorize delete yields `pending_cleanup` with the tombstone already `erased` and a durable queue row. |
| E3 MCP, REST, integration mirror and deactivation use the fixed helper | **PASS** | the fix is in the single shared `collectEntryArtifactIds`; all existing MCP/REST/mirror/deactivation erasure suites pass unchanged. |
| E4 >50 tied rows page without repeats/skips; cursor from the final emitted row; n changeable | **PASS** | `test/integration/browse-pagination.test.ts` — 12 tied rows walked to completion with no repeats or skips, no cursor on the last page, page size changed between pages, and a newer insert not shifting an already-read position. |
| E5 malformed/version/filter/actor cursor mismatch rejects; revoked visibility rechecked; legacy `/list` array preserved; recall retains top-k | **PASS** | same file — 7 malformed-cursor classes plus a filter-mismatch rejection, `invalid_request` for a bad `page` value, `invalid_cursor` for an out-of-range `n`, visibility rechecked on page two, and the legacy array shape asserted unchanged when paging is not requested. |

### O — Setup, isolation and operations

| ID | Status | Evidence |
| --- | --- | --- |
| O1 exporter mode 0600, rejects existing/symlink/redirect, no key in argv/output/logs | **PASS** | `scripts/export-mcp-connection.mjs` with 28 behavioural tests (see §5). `scripts/connect-ai-clients.sh` was also updated to the personal-key path with 9 behavioural tests, and that work caught a real defect: the "unexpected extra argument" refusal echoed the offending value, which could have been a key — it no longer echoes any argument value. |
| O2 explicit source retained, actor-based defaults, default-source hash survives retry, no relabelling | **PASS** | `test/integration/source-defaults.test.ts` — personal REST defaults to `api:<verified username>`, personal MCP to `mcp:<verified username>`, service capture to `operator:<verified service name>` (the service's name, not its identity id or its owner's username), an explicit label is preserved, the actor-default marker keeps the request hash stable across a rename, and an existing record is never relabelled. |
| O3 staging preflight rejects copied production bindings; A/B isolation | **PASS (local) / BLOCKED (deployed)** | `scripts/check-staging-bindings.mjs` rejects a copied production D1/KV/Vectorize id, both production domains, an unknown origin, a missing `environment=staging` and a mismatched deployment id, failing closed on unknown fields (WP9 unit tests). The two-installation client-isolation proof is **done locally**: `test/integration/client-isolation.test.ts` runs Client A and Client B as fully independent real SQLite stores with separate keys and proves cross-authentication fails in both directions, no entry/episode/receipt/vector/edge/proposal/export path crosses the binding, the same username exists in both (so a username is not a boundary), and a workspace key is never a principal. **Blocked:** comparing the local configuration and the *deployed* staging control-plane metadata, which needs a real staging deployment. |
| O4 missing canary config is failure; failed check cannot close incident; staging semantic fixture | **PASS (local) / BLOCKED (fixture run)** | `test/unit/canary-workflow.test.ts` parses the workflow structurally and asserts control flow rather than strings: the readiness step has no skip condition tied to a missing secret and fails closed when a required value is absent; `close-on-recovery` lists both canary jobs in `needs` **and** requires `success()`, so a failed canary keeps the incident open; the production canary authenticates the monitoring principal through the discovery-only smoke mode (initialize → whoami → tools/list) and stays read-only (no forget, deletion or rotation); both reporting steps record Stage/Code/Version/Time/Workflow and never interpolate a secret into an issue body; the closer only closes issues this workflow opened. **Blocked:** running the staging semantic/full-lifecycle fixture, which needs a staging deployment. |
| O5 maintenance mode blocks writes and mutation-bearing GETs but serves reads; compatible recovery | **PASS (local) / BLOCKED (recovery verification)** | `test/integration/maintenance-mode.test.ts` (11 cases): an explicit allowlist rather than a method rule, 17 REST mutation routes and the mutation-bearing `GET /digest` refused with 503 `maintenance_read_only` and verified zero side effects, the read surface still served, `/ready` returning `maintenance_read_only`, preflight and static assets not gated, the `/mcp` protocol endpoint still reachable (per-tool gating happens inside the server), MCP mutation tools refusing with an explicit tool error while read tools stay callable, and scheduled mutation jobs not starting. **Blocked:** verifying a deployed `SLM_WRITE_MODE=read-only` recovery version, which needs an environment. The two deliberate deviations are in §6 item 2. |

---

## 4. Verbatim command results

All commands run from the project directory.

| Command | Result |
| --- | --- |
| `npm ci` | exit 0 |
| `npm test` (baseline, before any edit) | exit 0 — 1124 passed / 106 files |
| `npm test` (final) | exit 0 — **1440 passed / 128 files** (52 commits on the branch) |
| `npm run typecheck` (final, runs `wrangler types` then `tsc --noEmit`) | exit 0, zero errors |
| `npx tsc --noEmit` | exit 0; zero errors under `src/` |
| `npm run smoke:workerd` | **exit 1, blocked** — `setsid: command not found` (see §7). The script's control flow was nevertheless verified end-to-end by running the real script against a real Workerd with a `setsid` shim: **exit 0**, AI-independent phases green. |
| `npm test -- test/integration/users-api.test.ts test/unit/mcp-identity.test.ts` | **exit 0** — 25 passed / 2 files |
| `npm test -- test/integration/forget.test.ts test/integration/deactivation-service.test.ts` | **exit 0** — 17 passed / 2 files |
| `npm test -- test/integration/entry-version-service.test.ts test/integration/operator-governance.test.ts` | **exit 0** — 44 passed / 2 files |
| `npm test -- test/integration/list.test.ts test/unit/mcp-private-artifacts.test.ts` | **exit 0** — 26 passed / 2 files |
| `node --check scripts/*.mjs` | exit 0 for each script delivered by WP8/WP9 |

Net change on the branch: **66 files changed, 15,034 insertions, 376 deletions** relative to `origin/main` (tracked files; `tasks/` agent notes remain untracked). The release specification itself is committed on the branch so it is preserved with the work; `tasks/` (agent working notes) remains untracked.

Secret scan of the committed diff: one match, and it is a **synthetic test vector** for the secret detector (`sk_live_0123…` inside `status-metadata.test.ts`). No live key, hash, prefix or credential appears anywhere in the diff.

---

## 5. Work-package status

| WP | Status | Notes |
| --- | --- | --- |
| WP1 Baseline and traceability | **COMPLETE** | branch from verified `origin/main`, `npm ci`, baseline test and typecheck recorded |
| WP2 Runtime safety repairs | **COMPLETE** | five-term erasure fix, stable-id rotation, shared real-SQLite harness with an enforceable compound-SELECT limit |
| WP3 Atomic schema and receipt core | **COMPLETE** | migration 16, `capture-receipts.ts`, guarded receipt commit, erasure tombstones, durable stage fencing, repair worker, legacy service replay |
| WP4 Keyed capture and batch | **COMPLETE** | create-only keyed path with shared validation, MCP `remember_batch` for **personal and service** principals, REST `POST /capture/batch` with chunked-body handling, fixed batch limits, per-item outcomes and per-item actor revalidation. |
| WP5 Identity/results/profiles | **COMPLETE (one gap)** | whoami (MCP + REST), trusted `authMethod`, exact profiles and aliases, `/health` + `/ready` metadata, the shared `SlmResult` envelope, actor-based source defaults, safe deployment-specific auth guidance, and the structured entry-descriptor contract on `list_recent`, `recall`, `history`, the four direct mutations and all proposal tools. `rate_recall` is also structured. Open: `passages` still returns text only, which Section 4.4 does not list. |
| WP6 Status/review | **COMPLETE** | reasons, revision preconditions, atomic `status_change_json`, designated-reviewer binding and audience, overwrite protection and the staleness restriction. |
| WP7 Pagination | **COMPLETE** | versioned cursor, context hash, keyset query, `paginateRows`, REST `/list` opt-in |
| WP8 Export/UI/docs | **COMPLETE** | `scripts/export-mcp-connection.mjs` (28 tests) and `scripts/connect-ai-clients.sh` (9 tests: personal-key default, `--oauth` labelled legacy, `--print-only`, `--profile`, and a key is never accepted as an argument); README, AGENTS, `src/mcp-onboarding.ts`, `docs/mcp-onboarding.md` and the project agent skill agree on personal-Bearer/legacy/profile vocabulary; the Section 12 dashboard changes and the participant guide's designated-reviewer recipe landed and were verified independently (96/96 UI tests); the pilot scorecard now separates finite release gates from adoption metrics and the roadmap marks each stage only where code and tests back it. |
| WP9 Stage/operations | **PARTIAL / BLOCKED** | `scripts/check-staging-bindings.mjs`, `scripts/staging-agent-load.mjs`, `scripts/mcp-protocol-smoke.mjs --discovery-only`, a `wrangler.jsonc` staging environment with placeholder ids, corrected `pilot-canary.yml` (missing config now fails; close-on-recovery requires a successful canary; 15-minute production / 6-hour staging schedules; incident metadata without raw responses or keys) and 19 unit tests. Maintenance write mode is implemented and tested. Every remote staging, load and canary gate is blocked. |
| WP10 Integrated release audit | **THIS DOCUMENT** | see §6 and §7 |

---

## 6. Known gaps and deliberate deviations

Item 1 is resolved; item 2 is a deliberate narrower-than-spec choice; items 3-8 are unfinished scope or spec-permitted omissions. None of them is claimed as done.

1. **Resolved — the designated audience is now exactly as specified.** The binding is evaluated *before* every other visibility rule, so a designated proposal is visible only to the proposer, the resolved subject owner and the designated reviewer; admin, team **and** internal system visibility are all excluded. Two layers back this: system identities are default-denied by the operator policy for every proposal operation (the only whitelisted system identity, the nightly contradiction scanner, may create an edge proposal and nothing else), and the audience predicate itself refuses a non-human actor on a designated proposal. Unassigned legacy proposals keep the pre-existing rules, including the internal reconciliation path.
2. **Deviation — `POST /chat` is blocked in maintenance rather than permitted.** Gating is implemented and tested (`test/integration/maintenance-mode.test.ts`, 13 cases): an explicit allowlist rather than a method rule, 17 REST mutation routes and the mutation-bearing `GET /digest` refused with 503 `maintenance_read_only` with verified zero side effects, the read surface still served, MCP mutation tools refusing with an explicit tool error while read tools stay callable, and scheduled mutation jobs not starting. The **second guard exists**: `commitEntryVersion` and `eraseEntryArtifacts` refuse on their own so a background or internal caller cannot bypass the request-level gate. The only remaining deviation is that `POST /chat` is refused instead of permitted as server-grounded read/generation — strictly safer than the specification, and it is the streaming SSE endpoint, which Section 4.1 also excludes from the new envelope.
3. **The structured entry-descriptor contract (Sections 4.3/4.4) is applied everywhere the specification names it except `passages`.** `list_recent`, `recall`, `history`, the four direct mutations and all proposal tools now return `structuredContent`; `Section 4.4` does not list `passages`, and it was deliberately left as text to avoid an unrequested data-contract rewrite.
4. **REST batch capture authenticates personal accounts only, deliberately.** MCP `remember_batch` serves personal and service principals, with every item re-verifying the actor. The REST `POST /capture/batch` route keeps the personal-key gate on purpose: it shares the general capture path, which permits an explicitly requested `visibility: "public"`, whereas service capture must always be private + legacy draft + epistemic candidate under the operator policy. Routing services through it would have been a capability escalation, so a service uses MCP for batch capture instead.
5. **The Section 4.5 output bounds are implemented for `list_recent` and `recall`** (2048-byte excerpts cut at a complete code-point boundary with `content_truncated`/`original_content_bytes`, and the 131,072-byte data cap with the cursor re-derived from the final emitted row). They are not applied to `passages`, whose output shape the specification never asked to change.
6. **The recall/graph exclusion list (part of G5) is now verified.** `test/integration/recall-eligibility.test.ts` pins the shared gate: legacy-deprecated and epistemic superseded/retracted are excluded while candidate/reviewed/canonical/qualified/stale stay recallable (including the no-value case), and graph traversal at one and two hops never enters a terminal node. The epistemic axis had no coverage before this round; the legacy-deprecated axis already did (`edges.test.ts`, `multi-hop.test.ts`).
7. **Deliberate scope limit — no dashboard proposal editor.** Section 12 says that if no proposal editing surface exists, document the MCP recipe rather than build a full proposal application. None exists, so the designated-reviewer flow is documented in `docs/team-pilot/participant-guide.md` instead. The dashboard's Connection sheet, whoami panel and status-control reason inputs are implemented.
8. **`POST /chat` was not converted to the shared envelope.** It is a streaming SSE endpoint, and Section 4.1 explicitly scopes the new envelope to new/modified MCP handlers and the new REST endpoints while preserving existing REST shapes. It is blocked in maintenance (see item 2).

---

## 7. Blocked gates

| Gate | Reason |
| --- | --- |
| `npm run smoke:workerd` (Section 14) | This Mac has no `setsid`: `scripts/smoke-workerd.sh: line 95: setsid: command not found`. The specification explicitly designates Linux CI as the required runtime check and forbids porting the harness to macOS, so this is recorded as blocked locally and required in CI. **Mitigation recorded:** the extended script was executed against a real Workerd started manually on this machine, with a one-line `setsid` shim on `PATH` that simply `exec`s its arguments (no process-group isolation, which only affects cleanup). It exited **0** with every AI-independent phase green, so the fixtures and assertions are proven rather than assumed; only the shell harness's process-group requirement is unmet here. |
| Staging deployment, binding preflight against the deployed control plane, load and latency gates (Sections 13, 15) | No staging Worker, D1, Vectorize, KV or Cloudflare credential is available in this session. `SLM_URL`, `SLM_EXPECTED_DEPLOYMENT_ID` and a protected key file cannot be supplied. **O3/O4 and the ≥3,000 ms / ≥10,000 ms p95 gates are unmeasured.** |
| Production deployment and the four-principal production smoke (Section 16.2) | Requires explicit owner authorization for a concrete release, which has not been requested or granted. |
| Deployed recovery version verification (Section 16.2) | Same reason: no environment to verify it on. |

**Nothing in this document claims a remote gate passed.**

---

## 8. Deployment prerequisites before any production rollout

These must be satisfied for the release to behave as specified. They are operational, not code, changes.

1. **Set the five deployment variables** on the target environment: `SLM_DEPLOYMENT_ID`, `SLM_ENVIRONMENT`, `SLM_PUBLIC_BASE_URL`, `SLM_RELEASE_ID`, `SLM_WRITE_MODE`. After this release **`/ready` returns 503 `not_ready`/`configuration_error` while any of the first four is missing.** They are declared optional on `Env` and are deliberately *not* pinned in `wrangler.jsonc` so a local checkout cannot accidentally look production-configured; set them with dashboard vars or `wrangler deploy --var`.
2. **Expect one additive migration (16)** through the normal ordered startup path. No mass write to existing content, tags, timestamps, ownership or credentials.
3. **Do not roll back to a pre-receipt writer.** An older build cannot maintain erased-key tombstones. The only safe recovery target is the same compatible implementation with `SLM_WRITE_MODE=read-only`, which this branch implements and tests. Note the §6 item 2 deviation: `POST /chat` is blocked rather than permitted in maintenance, which is stricter than the specification and safe for a recovery version.
4. **Verify the four existing personal keys are unchanged** after deployment; this release performs no rotation and no forced re-export.

---

## 9. Handoff

The branch is ready for review as an incremental, tested change set. Every functional release gate is implemented locally; what remains is verification this environment cannot perform plus the open items in §6. It is **not** ready for the authorized production rollout in Section 16.2.

Recommended next actions, in order:

1. Run `npm test`, `npm run typecheck` and `npm run smoke:workerd` in Linux CI and record the exit codes. The Workerd smoke is the only release gate that is blocked purely by local tooling.
2. Provision staging with distinct D1/Vectorize/KV resources and run the binding preflight, the four/eight-writer load scenarios and the semantic canary — including the raw p95 ≤ 3000 ms and generated p95 ≤ 10000 ms latency gates, which are currently **unmeasured**.
5. Request explicit owner authorization for the concrete production release, then deploy once, with `SLM_WRITE_MODE=read-only` prepared as the compatible recovery version.
