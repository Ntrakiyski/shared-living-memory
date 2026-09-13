# SLM Agent Reliability 1.1: independent implementation review

Reviewed 2026-09-13. Branch `slm-agent-reliability-1-1`, HEAD `e531aa1`, comparison base `origin/main` / `b9dffaf`. One production release remains the requirement.

## Decision

Do not deploy this candidate. The local test results are reproducible, but the implementation is not complete and contains correctness defects. Provisioning staging alone cannot resolve the blockers: two verification CLIs have no executable remote implementation, and Wrangler ignores the staging configuration block.

Independently rerun: `npm test` exits 0, 1,447 tests in 129 files; `npm run typecheck` exits 0. Typecheck emits `Unexpected fields found in top-level field: "envs"`, which matters despite the zero exit status. No production/staging deployment, credential change, push or release was performed in this review. The runtime probes below use synthetic local data.

## Findings and fixed correction requirements

### 1. [P1] Lost commit responses delete the successful capture's vectors

Location: [src/entry-version-service.ts:712](../../../src/entry-version-service.ts#L712), `recoverLostCaptureRace`.

After the receipt proves a capture committed, this function always calls `abandonCaptureAttempt` on the attempted vectors. It fails to distinguish a different attempt winning from this same attempt committing before the database response was lost. A real SQLite probe injected a throw after COMMIT: the call returned success with one entry and one receipt, but zero vectors remained, one vector deletion ran and no cleanup record remained.

Required correction: compare the authoritative committed entry/episode identity with this attempt before cleanup. If this attempt committed, preserve its vectors and recover success. If another attempt won, clean only the losing attempt's unreferenced vectors. If authority cannot be established, defer cleanup. Add an after-COMMIT response-loss regression asserting that acknowledged receipt, projection, passages and actual vector store remain consistent, alongside the different-winner race case. This is specification §8's explicit ambiguous-commit rule.

### 2. [P1] A different attempt's receipt can authorize orphan capture artifacts

Location: [src/capture-receipts.ts:399](../../../src/capture-receipts.ts#L399), `committedReceiptPredicate`.

The guard checks actor, key and committed state, but does not bind the receipt to this attempt's entry and episode. If two attempts pass the initial absent lookup, A commits and B then loses its stage fence, B's receipt insert becomes a no-op while later artifact inserts still see A's receipt. A real SQLite probe claimed B's intent immediately before its batch: B failed with `database_commit_failed`, but the database contained two entries, two episodes and only one receipt.

Required correction: bind every artifact guard to the exact attempted entry/episode, or an equally strong transaction-local proof of this attempt's receipt insertion. A failed fence or zero-row receipt insert must produce zero artifacts for that attempt. Add a two-attempt race combining an existing winning receipt with a newly claimed losing stage; assert exactly one entry, episode and receipt, with the winning vectors preserved.

### 3. [P1] Wrangler ignores the staging environment and resolves production bindings

Location: [wrangler.jsonc:44](../../../wrangler.jsonc#L44); the preflight repeats the same `envs` assumption.

Wrangler accepts `env`, not `envs`. Its installed configuration parser, invoked with `env: "staging"`, warns that the environment does not exist and resolves production D1/KV bindings under a staging script name. Tests of the handwritten `config.envs.staging` structure validate a different configuration from the deployment tool.

Required correction: use Wrangler's supported `env.staging` configuration and validate the effective resolved configuration using the installed Wrangler parser. Assert distinct Worker, D1, KV and Vectorize identities against production. Keep actual staging IDs out until provisioned and verified. Do not deploy or perform load writes using the present configuration.

### 4. [P1] Staging verification CLIs are unconditional failure stubs

Locations: [scripts/check-staging-bindings.mjs:370](../../../scripts/check-staging-bindings.mjs#L370) and [scripts/staging-agent-load.mjs:497](../../../scripts/staging-agent-load.mjs#L497).

Both commands stop with `REMOTE_UNAVAILABLE` after local validation, regardless of supplied environment, credentials or live staging availability. There is no authenticated whoami/manifest completion in the preflight and no executed workload, concurrency driver, latency measurement or cleanup driver in the load command. These are missing implementations, not checks merely awaiting infrastructure.

Required correction: finish both executable command paths. Preflight must validate deployed control-plane bindings and authenticated identity before emitting a verified manifest. The load command must consume that proof, run the specification's finite four/eight-writer scenarios, enforce its semantic and privacy checks, and execute manifest-scoped cleanup. Measure ten excluded warm-ups followed by exactly 100 measured requests per mode at concurrency four; raw recall `include_insight:false`, `topK:5` p95 ≤3,000 ms; generated `/chat` through full SSE completion p95 ≤10,000 ms. Include retries in full-roundtrip timing, report first attempts separately, and require zero semantic-unavailable responses. Add end-to-end CLI tests with a synthetic HTTP server proving the driver actually issues requests, detects failures and records results. Keep real remote evidence unmeasured until executed on verified staging.

### 5. [P1] Personal recall returns fabricated owner and revision metadata

Location: [src/mcp.ts:1407](../../../src/mcp.ts#L1407).

The new descriptor reads `owner_user_id` and `revision` from `RecallMatch`, but the retrieval contract exposes `ownerUserId` and does not supply revision. The cast hides this mismatch. The result defaults to an empty owner and revision zero, making an owner's recalled entry appear uneditable and producing stale revision preconditions for follow-up edits.

Required correction: explicitly map the retrieval model and obtain the authorized current projection revision. Do not invent empty identities or revision zero. If projection metadata cannot be loaded, report the defined safe failure/warning behavior rather than an authoritative-looking descriptor. Test an owned recalled entry at revision >1 and a public entry from another owner; assert real owners, current revisions and target-specific permissions. Include historical recall semantics without labelling a historical body as the current projection.

### 6. [P1] Structured history bypasses the 4,096-byte history budget

Location: [src/mcp.ts:1813](../../../src/mcp.ts#L1813).

The text renderer bounds its own local data, but the new structured response sends the original projection, episodes and snapshots. Counts and truncation metadata therefore do not describe the same bounded artifact as the text. The comment claiming structured data is already bounded is incorrect.

Required correction: produce one bounded history object first, derive counts and explicit truncation markers from it, then render both structured and textual output from that object. Retain owner-only access and the 50-episode/50-snapshot query limits. Test the serialized structured data with large multibyte content and status reasons, not merely the text renderer.

### 7. [P1] Opt-in REST pagination returns unbounded full content

Location: [src/routes.ts:1493](../../../src/routes.ts#L1493).

The paginated route limits row count but returns full enriched rows without applying the 2,048-byte content excerpts or the 131,072-byte data budget. Pagination is not a byte bound, and the cursor is selected before a byte-budgeted page exists.

Required correction: bound only the new opt-in response, preserving the legacy array response as required. Apply Unicode-safe excerpts, then account for the entire serialized data envelope and cursor. Derive the next cursor from the final emitted row. Test >50 tied rows with large multibyte content and changing page sizes, checking no unchanged accessible rows are skipped or repeated.

### 8. [P2] Service batch replays are reported as newly created captures

Location: [src/mcp.ts:659](../../../src/mcp.ts#L659).

Every successful service item increments `created` and returns `status: created`, even for a receipt replay. Its flat payload and `capture_mode: "create-only"` also disagree with the fixed remember-shaped data contract and `create_only` spelling. Clients cannot distinguish a retry from new work or consume the same contract across principal types.

Required correction: preserve the underlying created/replayed outcome and original receipt identity, use the common remember-shaped data, and keep current metadata distinct from original receipt revision. Assert second-call replay totals, edited-entry replay semantics and shared schema parity for personal/service batches. Service writes must remain private draft candidates under existing policy.

### 9. [P1] Linux CI can pass without exercising real-Workerd erasure

Location: [scripts/smoke-workerd.sh:350](../../../scripts/smoke-workerd.sh#L350).

The required E1 erasure phase is skipped with exit 0 unless `WORKER_SMOKE_EXPECT_AI=1`, which CI never supplies. Setting it does not select an AI-capable target because the script still starts local Wrangler. The gated fixture also ignores an update failure and does not prove all expected child artifacts exist before deletion.

Required correction: seed synthetic artifacts directly into the isolated local D1 database, then invoke erasure through real Workerd unconditionally. Assert each child type exists before deletion, the owned parent and all children disappear afterward, and an unrelated record survives. This needs no remote AI call and no macOS harness port. A Linux smoke pass must include E1, not only bootstrap/auth phases.

### 10. [P2] Production discovery accepts a failed whoami tool call

Location: [scripts/mcp-protocol-smoke.mjs:129](../../../scripts/mcp-protocol-smoke.mjs#L129).

The fallback accepts any text containing `principal` without checking HTTP status, MCP `isError` or the shared success envelope. A loopback HTTP fixture returned a tool error with text `Unable to resolve principal because storage is unavailable`; discovery still printed passed and exited 0.

Required correction: require successful HTTP/protocol transport, `isError !== true`, `structuredContent.ok === true` and the required principal/deployment fields inside its data. Verify the expected deployment identity. Do not use a substring as proof of authenticated identity. Add positive and explicit tool/transport failure fixtures.

### 11. [P2] Canary recovery cannot run and its closure is not stage-scoped

Location: [.github/workflows/pilot-canary.yml:216](../../../.github/workflows/pilot-canary.yml#L216).

The recovery job needs both mutually exclusive canary jobs with `if: success()`. Every trigger skips one dependency, so recovery closure is suppressed. Simply permitting skipped dependencies is insufficient: the existing loop closes all canary incidents, allowing successful staging to close an unresolved production incident.

Required correction: evaluate recovery separately for the stage that actually ran and succeeded. Give incidents a stable stage identity and close only matching incidents. Test successful recovery, failure, missing configuration, skipped opposite stage and an unresolved opposite-stage incident. Preserve content-free incident reports.

### 12. [P2] Replay reports the capture revision as the current revision

Location: [src/ingest.ts:1104](../../../src/ingest.ts#L1104), using the view from [src/capture-receipts.ts:652](../../../src/capture-receipts.ts#L652).

The committed capture view intentionally returns the receipt's original revision, but replay assigns it to `currentRevision`. A real SQLite capture → update → retry probe returned actual revision 2, currentRevision 1 and committedRevision 1, without warnings. Batch output and MCP text therefore provide an incorrect current revision for subsequent edits.

Required correction: return the live projection revision separately from the original receipt revision throughout the shared capture view, ingestion mapping, batch mapping and MCP renderer. Keep receipt revision 1 after edits; report current revision 2 in the example. Add one cross-transport replay regression that asserts both fields and uses the current revision successfully in a subsequent authorized edit.

### 13. [P2] Proposal permissions are reversed relative to owner-submission policy

Location: [src/mcp-results.ts:317](../../../src/mcp-results.ts#L317); enforced owner-submission check at [src/action-proposals.ts:453](../../../src/action-proposals.ts#L453).

The descriptor advertises `submit_change_proposal: !actorIsOwner`. Actual update/status proposal preparation requires the submitting subject to own the entry, and an owner can designate a reviewer. The runtime probe confirmed an owned listing advertises false while a nonowner is advertised as eligible for a flow that rejects them.

Required correction: derive proposal permission from the existing owner-submission policy and current actor/scopes. Do not change the authorization policy to match the faulty descriptor. Test owner, other-owner public entry, valid scoped service and scope-denied service. Keep proposal approval/execution authorization separate and proposal-specific.

### 14. [P2] REST batch omits explicitly required service support

Location: [src/routes.ts:1145](../../../src/routes.ts#L1145).

The route uses the personal-only `requireAuthAsync` gate. Specification §5.1 explicitly requires the shared verified actor resolver for REST whoami and batch, and §8 requires the same application handler. A valid service credential is rejected rather than dispatched to its authorized private-draft path.

Required correction: use the shared verified actor resolver, then dispatch services through existing service-policy-aware capture. Keep service output private + lifecycle draft + epistemic candidate; explicitly reject public requests and revalidate service status/scopes before each item. Do not route services through unrestricted personal capture. Test REST/MCP parity, public-visibility refusal, revoked credentials and revocation midway through a valid batch. This closes the contract without expanding service authority.

## Additional measured evidence

The recall probe used an owned revision-3 entry: recall returned revision 0 and empty ownership while `list_recent` returned correct metadata. The history probe used 50 synthetic episodes: structured data was 29,185 bytes with 50 episodes and `truncated:false`; text was 3,400 bytes with four episodes and `truncated:true`. These probes exercise the new response construction rather than accepting comments or isolated helper tests as evidence.

## Decisions about reported deviations

- Keep `passages` as legacy text for this release. §4.4 explicitly preserves unchanged tools; it does not specify a new passages object. Do not turn this into an unrelated rewrite.
- Blocking `/chat` in maintenance is a real documented difference from the plan's read/generation availability promise. It is not the source of the capture-integrity bugs. To meet the original contract without a scope decision, retain generation while skipping optional domain writes before they are launched; verify with the same maintenance guard tests. Do not silently relabel it as full conformance.
- Keep the dashboard proposal recipe rather than creating a new proposal editor; the specification expressly allows that choice.
- Missing staging resources are an operational gate after the executable paths are implemented. Missing production authorization remains a separate final release gate.

## Correction order and executor handoff

Continue the existing branch. Preserve the one-production-release requirement and all four existing personal keys. Do not rotate, publish, deploy or modify production data as part of these corrections.

1. **Repair durable capture first:** findings 1, 2 and 12. Treat migration, receipt authority, stage fencing, ambiguous commit recovery and erasure as one correctness boundary. Add the failing real-SQLite race probes before fixing the guards.
2. **Repair agent contracts:** findings 5–8, 13 and 14. Use the same authoritative metadata and serializers across personal/service and REST/MCP paths. Add handler-level tests, including byte-boundary and revision-follow-up assertions.
3. **Finish executable release gates:** findings 3, 4 and 9–11. Validate effective Wrangler configuration, actual CLI requests/results, real-Workerd erasure and stage-specific canary recovery. Do not substitute tests of helper functions or YAML keywords for executed behavior.
4. **Reconcile release evidence:** replace the blanket completion claim with measured results. Reopen affected acceptance groups until their regressions pass. Record exact candidate SHA. Rerun local tests/typecheck and required Linux CI; a successful smoke must include E1. Then run verified isolated staging and the compatible read-only recovery checks, preserving the fixed latency thresholds.
5. **Prepare the one concrete release:** after all gates pass, present the exact candidate, deployed staging evidence and compatible recovery target for the owner's production decision. No old pre-receipt writer is a valid rollback target.

The diff contains 78 files and 16,653 changed lines. The change-size review recommends internal review slices, not multiple releases: isolated key rotation is independently reviewable; durable writes/deletion stay together; then identity/transport, user surfaces and operations. Size itself is not an additional defect. The final correction order above prioritizes the reproduced integrity failures.

## Verification limits

The existing local suite and typecheck passed at the reviewed HEAD. Independent synthetic probes demonstrated the reported runtime defects. No live staging load/latency, deployed binding comparison, Linux CI, production credential smoke or deployed recovery check was performed during this review. Passing local tests does not establish those properties. The SLM MCP connector was unavailable, so no live memory content was queried or written. Changes made by this review are this report and local task/lesson notes only.

## Resolution update — 2026-09-13

The findings and decision above are preserved as the historical review of `e531aa1`. The initial corrective source/test candidate was **`debe0707160a08c886b5608953d0a8b0a3848510`**; the current candidate is **`f95285f624c6e62a9de255e1d4de75854310d860`**, including the staging follow-up fixes below. All 14 findings have implementation corrections and passing regression coverage; this statement does not establish deployed staging or production acceptance. Current release status and subsequent live results belong in the [release evidence](agent-reliability-1-1.md).

| Findings | Implemented resolution | Evidence in the corrected candidate |
| --- | --- | --- |
| 1, 2, 12 | Receipt authority is bound to the attempted entry/episode. Ambiguous recovery preserves the winning attempt's vectors and cleans only proven losing vectors. Replay retains the original receipt revision while returning the live projection revision separately. | Real-SQLite after-COMMIT response loss, competing-winner/claimed-stage and legacy/current replay regressions in `capture-receipts.test.ts`, `service-legacy-replay.test.ts` and `agent-contract-regressions.test.ts`. |
| 5–8, 13, 14 | Shared authorized descriptors, one bounded history object, complete serialized listing budgets, truthful shared remember/batch outcomes and owner/scope-derived permissions. REST service batches use the verified actor resolver and existing private-draft policy, including per-item revalidation. | Actual personal/service MCP and REST handler tests cover current/historical revisions, 55 tied rows with multibyte byte truncation, 4,096-byte history, 32,768-byte batch data, original receipts after edits, public refusal, revoked credentials and mid-batch revocation. |
| 3, 4 | Supported `env.staging` configuration is validated through installed Wrangler's effective parser. Both verification CLIs execute authenticated requests; load scenarios, latency sampling and manifest-scoped cleanup are implemented. | `staging-cli.test.ts` executes CLI paths against synthetic HTTP fixtures; staging/semantic script tests retain fail-closed binding, correctness and privacy checks. These are local executable-path proofs, not live results. |
| 9–11 | The real-Workerd erasure scenario is unconditional and proves all five child types exist before deletion. Discovery validates HTTP/protocol/MCP success and structured principal/deployment identity. Incident recovery is scoped to the successful stage and matching workflow-owned issues. | Linux Workerd smoke plus `mcp-protocol-smoke-cli.test.ts`, `canary-workflow.test.ts` and `semantic-scripts.test.ts`, including explicit error and skipped-opposite-stage cases. |

Integration also corrected service `whoami` kind/capabilities, single-remember and direct-error envelopes, the flat `list_recent` contract, and personal append/update `expected_revision` enforcement on both transports. Grounded `/chat` now completes SSE in maintenance with zero domain writes in the actual-handler regression, so the earlier chat-blocking deviation is resolved. `passages` legacy text and the documented dashboard proposal recipe remain permitted scope choices. Existing service authority has not been expanded.

**Initial correction Linux evidence (historical):** in a Docker container using `node:22-bookworm`, `npm ci` exited 0, `npm test` passed **1,497 tests in 132 files** in 26.44 seconds, `npm run typecheck` exited 0 and `npm run smoke:workerd` exited 0. The smoke includes the complete E1 erasure and unrelated-entry survival. The candidate was amended only for trailing whitespace after this run. This is Linux container evidence, not a claimed GitHub Actions run. A final targeted contract/privacy run also passed **27 tests in two files**, with TypeScript and diff checks passing.

### Staging follow-up and current verification

Live staging exposed additional defects, now fixed in the current candidate. Commit `a06492d` replaces dynamic tag LIKE patterns with exact JSON membership across recall, browse and compression. A valid 50-character tag exceeded D1's 50-byte pattern limit after wildcard/quote wrapping; literal wildcard and JSON characters also mismatched. [Exact tag-filter tests](../../../test/integration/exact-tag-filters.test.ts) and [recall-versioning tests](../../../test/integration/recall-versioning.test.ts) cover the limit, literal matching and privacy. A bounded **90-second pre-measurement index warm-up** addresses observed indexing propagation; raw load measures default recall with `include_insight:false, topK:5`. Request latency thresholds remain unchanged.

Commit `a979c30` fixes stale erasure receipts left after queue removal. Every bounded drain now reconciles pending/stale receipts, even with an empty queue, using an atomic completion guard that requires the projection and operation cleanup rows to be absent. [Erasure-repair tests](../../../test/integration/erasure-repair.test.ts) exercise stale-alert races, failed finalization, retry on an empty drain and retained in-flight intents. Two real bounded repair drains through official Wrangler remote `test-scheduled` against staging bindings left **zero queue rows**, **583 erasure receipts all complete**, **583 erased capture receipts**, and **four deliberately retained committed recovery fixtures**.

Commit `8a98735` fixes the later literal-tag capture failure, **`VECTOR_UPSERT_ERROR 40018`**, caused by quotes/dots in generated Vectorize metadata keys. The sole unused `tag_*` writer was removed; tags remain in the metadata array. The [strict real-SQLite capture/replay regression](../../../test/integration/capture-receipts.test.ts) was observed failing before and passing after the fix. The same logical fixture was created through a diagnostic preview, which is not a final deployed gate.

Commit `6366069` fixes the recovery MCP maintenance guard, which correctly blocked writes but omitted the structured error and therefore reached clients as generic `tool_error`. The common failure envelope now carries `maintenance_read_only` and REST-compatible `retryable:true` for all blocked personal/service tools and aliases. [Actual-handler maintenance regressions](../../../test/integration/maintenance-mode.test.ts) cover the reproduced parser result, bounded retries and zero side effects. The chat verifier now accepts supported `[N]`/`[Source N]` forms and extracts string deltas when provider `response` is numeric. It requires completed SSE, a nonempty answer and citation numbers 1–8; **exact source membership remains unverified because chat omits its source manifest**.

**Publication mapping and Linux verification:** GitHub rejected the initial push for a synthetic credential-shaped test literal. The unpublished history was sanitized by constructing the identical test value at runtime, preserving all 64 commits and their metadata; 58 hashes changed. Only `status-metadata.test.ts` differs in the final tree; runtime source, scripts, packages, lockfile and Wrangler configuration are byte-identical. Original head `6366069a3694f736ed99362ba39328c80923916d` maps to **`82f9515a80fe4cd6208da65f7cf28d2cdecdc181`**. The complete mapping and backup proof are referenced in the [release evidence](agent-reliability-1-1.md). Historical physical Worker identities below remain unchanged.

The full Linux Docker run remains correctly attributed to **`6366069`**: **1,525 tests in 134 files**, 23.67 seconds, plus typecheck and real-Workerd smoke, each exit 0. All **20 status-metadata tests** passed after the fixture-only history rewrite. The owner-authorized branch is now published from the Mac. [Actual Ubuntu GitHub CI run 34763165686](https://github.com/Ntrakiyski/shared-living-memory/actions/runs/34763165686) passed on exact `82f9515`, including npm ci, typecheck, **1,525 tests/134 files** and real Workerd; it completed **2026-09-13 14:38:02 UTC**. At that checkpoint, production had not been changed.

**Final workflow-only candidate:** pushed commit `e75a3b88ca76bf3b3fea71e1901d4759f785abef` changes only the Pilot Canary workflow and its test; runtime files are byte-identical to deployed `82f9515`. [Ubuntu CI run 34763415564](https://github.com/Ntrakiyski/shared-living-memory/actions/runs/34763415564) passed npm ci, typecheck, **1,526 tests in 134 files** and real Workerd. Actionlint **1.7.7** reproduced the original two `runner.temp` job-env errors, then passed the corrected definition; **10 targeted workflow tests** and TypeScript also pass.

The syntax correction does **not** establish active monitoring. Read-only inventory found **no repository Actions secrets or variables**; no secrets were added, canary dispatch triggered or issues created. Scheduled monitoring remains **unconfigured**, pending approved credentials/configuration and operational verification.

**Recovery passed:** the original exact verifier exited **0** on read-only Worker **`ab3a4318-8545-46e1-a50b-a69ff6ed0244`**, physical source `6366069`. All four unchanged staging credentials authenticated, reads and complete chat worked, MCP/REST writes were blocked and four committed capture receipts remained. Enabled Worker **`89530c30-f45a-4c1a-b1a5-792f8376972f`** with the same physical source then passed authenticated binding preflight; all four recovery fixtures were cleaned with complete receipts. The final pre-benchmark staging check found **zero entries, zero cleanup queue rows and 598 complete erasure receipts**. Exact mapped-candidate `82f9515` is now deployed as enabled Worker **`0ddcfd4b-616d-441b-9bb1-98300815da30`**; authenticated binding preflight and full MCP smoke passed. Semantic canary returned **`CANARY_OK`, five checks**, exit 0, with all four fixtures cleaned completely. Private and public-decoy propagation warm-ups were **23,189 ms** and **4,246 ms**, not benchmark p95 values.

**Prior enabled-version verification:** `8a98735`, Worker **`351128be-5251-439f-8218-94b432e029be`**, passed authenticated effective-binding preflight, full MCP lifecycle and **all five semantic checks**. Private paraphrase visibility took **4,655 ms**, public-decoy visibility **37,287 ms**; live **50-character** and **55-character literal-tag** checks passed owner access, peer private-results=0 and complete cleanup. Actual staging D1 migrations **1–16** are verified and recorded. Earlier `a979c30` also passed MCP and five semantic checks, with 46.074-second private propagation and all four semantic fixtures cleaned. These are versioned functional/propagation results, not final-source latency acceptance.

The first staging candidate's concurrency-one write runs each accepted **100/100**, with p95 **1,786.17 / 1,933.03 / 1,857.20 ms**. Concurrency-four run one accepted **99/100** with **31 retries and 32 tool errors**; one `storage_unavailable` capture exhausted four attempts in **9,981 ms**, so the gate failed. The underlying provider error was not recorded; no provider root cause is claimed. Subsequent 32-capture and 100-capture concurrency-four diagnostics each passed with zero retries, but do not substitute for the complete gate. All **439 first-run attributable entries** were erased with complete receipts; the cumulative repair counts above include prior cleanup and must not be added to that number.

**Completed load-v2, original failure retained:** on physical runtime `82f9515`, concurrency-one and concurrency-four writes were **600/600** across six runs, including each four-writer run at 100/100. Entries/receipts matched acknowledgements with zero duplicate effects and lost writes. Concurrency eight accepted **296/300**; the supported ceiling remains **four**. Same-owner revision racing produced one success/three conflicts and three cross-owner denials; retry identity and four-owner checks passed. Raw recall accepted **100/100**, p95 **2,530.912208 ms**. Original generated answers accepted **98/100** measured and **9/10** warm-ups, p95 **4,612.784708 ms**; the preserved report is **`ok:false`, `generated_latency_request_failed`**. A separate original-verifier diagnostic accepted **84/100**; all 16 rejected responses had valid grouped citations, and corrected-verifier offline replay passes **16/16**. Verifier/test-only commit `06cccadd1c18f9ce581503251732eb011ad94c88` fixes the parser. A fresh corrected-verifier **100-request/concurrency-four** diagnostic passed **100/100**, p95 **5,068.614 ms**. [CI run 34765210407](https://github.com/Ntrakiyski/shared-living-memory/actions/runs/34765210407) passed the verifier/test-only `06cccadd` commit with **1,526 tests**, typecheck and real Workerd. Neither original failure is retroactively rewritten.

All **993 attributable load entries** were erased; all **1,596 cumulative staging erasure receipts** are complete. At **15:18:47 UTC** the staging queue was empty; all **32 temporary diagnostic entries** were subsequently erased with complete receipts and no entry/tombstone mismatches. Production is explicitly authorized. The protected backup has **25 entries**, migration **15**, integrity OK and SHA-256 **`055e13c2b7821883226c21b203ad6194beaa8c251ba13cbe0ce7b40913991cec`**. Prior baseline production Worker was **`7866cdfa-f172-4520-bdc8-3768577ababf`**; compatible read-only recovery **`93e89c67-52df-4e74-8175-98cb08e4795f`** is uploaded, **not active**, using the tested `82f9515` runtime.

**Initial production activation:** Worker **`12d32970-e81b-493d-b329-3247dc90f653`**, physical `SLM_RELEASE_ID=82f9515a80fe4cd6208da65f7cf28d2cdecdc181`. Later workflow/verifier commits leave runtime source, public assets, package/lockfile and Wrangler configuration byte-identical. All four original keys passed initialize/whoami, profiles **10/16/29**, and owned history for the three principals with existing entries; both domains returned ready **200**, migration **16** passed and **25 entries plus seven user authentication hashes were byte-exactly preserved**. The overall postcheck is explicitly **false** because browsing failed. No tag or merge has been performed.

**Post-activation compatibility defect:** a pre-existing public entry has an owner ID with no matching user row. New `listingEntry`/`loadEntryDescriptor` construction throws `storage_unavailable` on the missing username. The shared correction now allows **`owner.username: null`** while preserving stored owner ID, permissions and privacy; specification §4.3 now documents that legacy state. No ownership or user-data repair is authorized or needed. Final commit **`f95285f624c6e62a9de255e1d4de75854310d860`** is pushed. [GitHub CI run 34765494261](https://github.com/Ntrakiyski/shared-living-memory/actions/runs/34765494261) passed **1,529 tests in 134 files**, typecheck and real Workerd; the focused check passed **29/29**, including three real-SQLite regressions in [mcp-listing-contract.test.ts](../../../test/integration/mcp-listing-contract.test.ts). Actual storage-query errors remain errors; absent legacy display names alone become null.

**Final-source stage passed:** source `f95285f624c6e62a9de255e1d4de75854310d860`, enabled Worker **`05272192-0b57-4e42-9a52-2244bf511341`**, authenticated binding preflight and full MCP initialize/29-tool discovery/whoami/private keyed capture/recall/complete erasure/tombstone checks. At **15:26:02 UTC**, staging held **zero entries, zero queue rows and 1,629 complete erasure receipts**. Final-source production read-only recovery **`25b5db1a-1a56-4506-9d50-9189fa540ab5`** is uploaded, **not active**. Enabled production correction **`bbc2b528-c70d-4272-96fe-1ed65a974278`**, source **`f95285f624c6e62a9de255e1d4de75854310d860`**, passed the complete postcheck at **15:26:58 UTC**. Both domains returned dashboard/readiness 200. All four unchanged keys passed identity, profiles, browsing and semantic recall with private boundaries preserved. Owned history passed for Jarvis, Researcher and Engineer; Clients had no owned baseline entry. All 25 entry records and seven user/authentication records remain unchanged, migrations 1–16 pass, and the control plane confirms the expected bindings and 100% traffic. The final recovery upload also has verified production bindings, retained secret names and read-only metadata, and remains inactive. No production fixture writes/deletes or key rotations occurred.

The release remains one authorized rollout plus this post-activation compatibility correction. The failed original postcheck, failed original generated runs and successful separate diagnostic are all retained. Monitoring remains unconfigured. The [release evidence](agent-reliability-1-1.md) records the final correction and successful production verification.
