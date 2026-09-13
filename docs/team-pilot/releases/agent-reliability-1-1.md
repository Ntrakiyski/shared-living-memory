# SLM Agent Reliability 1.1 — Release Evidence

**Updated:** 2026-09-13. **Candidate:** `f95285f624c6e62a9de255e1d4de75854310d860` on `slm-agent-reliability-1-1`, based on `origin/main` at `b9dffafd6181d46dc9bfbcbd05333ad3273b78b8`. Release version: `1.1.0`.

**Current status:** production is live and verified at Worker **`bbc2b528-c70d-4272-96fe-1ed65a974278`**, source **`f95285f624c6e62a9de255e1d4de75854310d860`**. All four unchanged keys pass MCP identity, profiles, browsing and semantic recall; all 25 original entries and seven user/authentication records are preserved. [Linux CI](https://github.com/Ntrakiyski/shared-living-memory/actions/runs/34765494261) passes **1,529 tests**, typecheck and Workerd. The first activation's browse failure and original benchmark failures remain recorded below. Scheduled monitoring remains unconfigured.

The [specification](../../superpowers/plans/2026-09-13-agent-memory-reliability.md) remains the acceptance contract. The [independent review](agent-reliability-1-1-review.md) preserves the original defects and measured probes; its appended resolution section identifies the correction candidate. This update supersedes the earlier blanket completion claims and the claim that staging work required infrastructure alone. The verification CLIs and staging configuration required code corrections, which are now implemented.

This evidence contains no credentials, key prefixes, key hashes or memory bodies. Record deployed Worker versions separately from source commits.

### Publication-history identity

GitHub secret protection rejected the initial push because a synthetic invalid-reason test contained a credential-shaped literal in five historical fixture versions. The unpublished history was sanitized without bypassing protection: the test constructs the same synthetic value at runtime. **All 64 commits and their metadata were retained; 58 commit identities changed.** The only changed final-tree file is `test/integration/status-metadata.test.ts`; `src/`, `scripts/`, packages, lockfile and Wrangler configuration are byte-identical.

The original head **`6366069a3694f736ed99362ba39328c80923916d` maps to `82f9515a80fe4cd6208da65f7cf28d2cdecdc181`**. The complete commit map, rewrite proof and original-history backup are retained under `~/.config/shared-living-memory/staging-verification/history-sanitization-20260913T143529Z/`. Historical commit references and physical Workers' `SLM_RELEASE_ID` values below intentionally retain their original SHAs; they are not relabelled as deployments of the new hash.

## 1. Verified candidate checks

**Latest GitHub CI passed** for final compatibility source **`f95285f624c6e62a9de255e1d4de75854310d860`**: [run 34765494261](https://github.com/Ntrakiyski/shared-living-memory/actions/runs/34765494261), on Ubuntu, including **1,529 tests in 134 files**, typecheck and real-Workerd smoke. The focused listing/recall check passed **29/29 tests**, including three real-SQLite regressions for missing-owner names and genuine storage failures. This is a runtime change to the shared descriptor, so earlier `82f9515` benchmark results retain their original source attribution.

**Earlier GitHub CI passed** for verifier/test-only commit **`06cccadd1c18f9ce581503251732eb011ad94c88`**: [run 34765210407](https://github.com/Ntrakiyski/shared-living-memory/actions/runs/34765210407), including **1,526 tests**, typecheck and real-Workerd smoke. Together with the earlier workflow-only commit, it leaves the activated runtime source, public assets, package/lockfile and Wrangler configuration byte-identical to `82f9515`. That earlier CI run predates the runtime descriptor correction above.

**Earlier workflow-only GitHub CI passed** for `e75a3b88ca76bf3b3fea71e1901d4759f785abef`: [run 34763415564](https://github.com/Ntrakiyski/shared-living-memory/actions/runs/34763415564), on Ubuntu, including `npm ci`, typecheck, **1,526 tests in 134 files** and real-Workerd smoke. The pushed commit changes only `.github/workflows/pilot-canary.yml` and `test/unit/canary-workflow.test.ts`; runtime source, scripts, configuration, packages and lockfile remain byte-identical to the deployed `82f9515` candidate. Physical staging release IDs are unchanged.

**Earlier exact-runtime GitHub CI passed** for `82f9515a80fe4cd6208da65f7cf28d2cdecdc181`: [run 34763165686](https://github.com/Ntrakiyski/shared-living-memory/actions/runs/34763165686), completed **2026-09-13 14:38:02 UTC**, on Ubuntu. `npm ci`, typecheck, **1,525 tests in 134 files**, and the real-Workerd smoke all passed. The branch was published from the Mac to `origin/slm-agent-reliability-1-1` with the owner's authorization.

The earlier comparison run below used a **Linux Docker container with `node:22-bookworm`** and remains separate from the actual GitHub run above. The full run used pre-rewrite source `6366069a3694f736ed99362ba39328c80923916d`; the runtime-equivalent mapping is documented above. Dependencies are unchanged. After rewriting, all **20 status-metadata tests** passed against `82f9515`; this focused fixture check is separate from the earlier full Linux run.

| Command | Measured result |
| --- | --- |
| `npm ci` | earlier verified exit 0; dependency set unchanged |
| `npm test` | exit 0; **1,525 tests passed in 134 files**, 23.67 seconds |
| `npm run typecheck` | exit 0; includes Wrangler-generated types and TypeScript checking |
| `npm run smoke:workerd` | exit 0; real Workerd, including unconditional E1 erasure of the owned entry and all five seeded child artifact types, erasure-receipt checks and unrelated-entry survival |

The E1 smoke no longer depends on `WORKER_SMOKE_EXPECT_AI=1`. It seeds synthetic artifacts into isolated local D1 and asserts their existence before deletion, so unavailable local AI cannot silently skip the erasure acceptance case. The original macOS `setsid` limitation does not invalidate this Linux execution; the actual GitHub Actions result is now separately identified above.

The earlier contract/privacy integration check at the initial correction candidate also passed: `npm test -- test/unit/mcp-private-artifacts.test.ts test/integration/agent-contract-regressions.test.ts` returned **27 passed in two files**; `npx tsc --noEmit` and `git diff --check` returned exit 0. This targeted evidence supplements, rather than replaces, the complete Linux run.

## 2. Corrections and regression evidence

“Fixed” below means implemented in the candidate and exercised by the passing suite. It does not claim that a live staging or production gate has run.

| Review findings | Correction | Regression evidence |
| --- | --- | --- |
| 1, 2, 12: capture authority, fencing and replay revisions | Ambiguous commit recovery distinguishes this attempt's committed entry/episode from another winner before vector cleanup. Artifact guards bind to the exact attempted receipt identity. Current projection revision is separate from the original receipt revision for new, legacy and recovered captures. | `capture-receipts.test.ts`, `service-legacy-replay.test.ts`, `agent-contract-regressions.test.ts`: lost response after COMMIT, claimed losing stage beside an existing winner, retained winning vectors, single authoritative artifact set and capture → edit → cross-transport retry. |
| 5–8, 13, 14: results, bounds, permissions and service REST batch | Shared serializers use authorized current descriptors and truthful created/replayed outcomes. History uses one bounded object for text and structured output. Opt-in REST listing shares bounded pagination. REST batch resolves verified actors and dispatches services through existing private-draft policy with per-item revalidation. | `agent-contract-regressions.test.ts`, `mcp-listing-contract.test.ts`, `status-metadata.test.ts`, `browse-pagination.test.ts`, `mcp-private-artifacts.test.ts`, `capture-batch.test.ts`: real handler calls, multibyte bounds, owner/scope checks, revocation during a batch and source privacy. |
| 3, 4: effective staging configuration and executable verification | Wrangler uses `env.staging`; preflight reads the installed Wrangler parser's effective bindings, then validates remote binding and authenticated identity evidence. The load CLI executes workloads, records timings and performs manifest-scoped cleanup. | `staging-cli.test.ts`, `staging-scripts.test.ts`, `semantic-scripts.test.ts`: executable CLI requests against synthetic HTTP fixtures, effective-configuration rejection and failure paths. Live results remain separate gates. |
| 9–11: runtime erasure and operational checks | Workerd erasure is unconditional. Discovery requires successful HTTP/protocol/MCP results and the structured principal/deployment contract. Canary recovery closes only matching workflow-owned incidents after that stage succeeds, even when the other stage is skipped. | Linux Workerd smoke; `mcp-protocol-smoke-cli.test.ts`, `canary-workflow.test.ts`, `semantic-scripts.test.ts`: explicit transport/tool failures, wrong deployment, missing configuration and stage-specific recovery. |

The contract corrections also close adjacent specification gaps found during integration:

- Both personal and service single `remember` and batch items use the same remember-shaped data with `capture_mode: "create_only"` or `"smart"`. A post-commit descriptor-read failure preserves success and the original receipt with an explicit metadata warning. Safe error envelopes cover direct owner, transition, revision and storage failures.
- `list_recent` entries are **flat descriptors plus content/created_at/source**, as §4.4 specifies. Recall keeps `matches[].entry`; historical bodies carry their own content revision/state while the descriptor reports the current projection. MCP and opt-in REST listing share Unicode-safe 2,048-byte excerpts and the **131,072-byte complete data budget**, including cursor overhead. The cursor comes from the final emitted row. Tests walk **55 tied rows**, change page sizes and force byte truncation without skips or repeats. Legacy unpaged REST `/list` keeps its array shape.
- Structured history stays within **4,096 serialized data bytes**, with the same bounded episodes, snapshots, counts and truncation markers used for text. Batch data stays within **32,768 bytes** with all item labels and safe outcomes retained.
- `whoami` reports actual service kind and current scope/autonomy-derived capabilities. Entry permissions match existing owner-submission policy without granting services direct edits or review authority. Optional `expected_revision` on personal append/update is validated and enforced on both MCP and REST before semantic work; omitted preconditions retain existing caller behavior.
- Maintenance permits grounded `POST /chat` generation through complete SSE while domain writes remain guarded. The real handler regression asserts completion and zero domain writes. This replaces the earlier documented chat-blocking deviation.

### Additional fixes found by live staging

Commit `a06492da153f1ffa812abf542aa0a6dc06878c9e` replaces dynamic JSON-tag `LIKE` predicates with exact `json_each` membership in recall, listing, compression selection and digest cooldown checks. A valid 50-character tag exceeded D1's 50-byte LIKE-pattern limit once quotes/wildcards were added, causing HTTP 500; escaped wildcard and JSON characters also failed exact matching. [Exact tag-filter regressions](../../../test/integration/exact-tag-filters.test.ts) and [tagged recall regressions](../../../test/integration/recall-versioning.test.ts) enforce the D1 limit and test literal `%`, `_`, quotes/backslashes and private-entry exclusion. Keyword search and short static status/system filters are unchanged.

The same commit gives the semantic fixture a bounded **90-second index-propagation warm-up**, outside measured requests. The raw latency workload now measures **default recall** with `include_insight:false, topK:5`, without a tag shortcut or post-filtering that could hide contamination. Neither change relaxes the 3,000/10,000 ms request p95 gates or the requirement for zero semantic-unavailable responses in the measured run.

Commit `a979c3023896521e664aa453b4e5b12a36eb00cb` repairs a second staging finding: an erasure receipt could remain `stale` after its cleanup queue row disappeared. Every bounded cleanup drain now reconciles both `pending_cleanup` and `stale` receipts, including when the queue is empty. An atomic guard requires the entry projection and all operation cleanup rows to be absent before completion; failed deletion or a surviving projection cannot be marked complete. [Erasure-repair regressions](../../../test/integration/erasure-repair.test.ts) cover the stale-alert race, finalization failure followed by an empty drain, bounded repair and retained capture-stage intents. Live repair measurements are recorded in §5.

Commit `8a987357b15e37ad3d383536b6057ff44de06319` fixes a separate live literal-tag capture failure: Vectorize returned **`VECTOR_UPSERT_ERROR 40018`** for quotes/dots in generated `tag_*` metadata keys. The sole unused dynamic-key writer is removed; the tags array and owner/privacy metadata remain intact. A [strict real-SQLite capture/replay regression](../../../test/integration/capture-receipts.test.ts) failed before the correction and passed afterward while enforcing the provider's metadata-key restrictions. The same logical literal-tag fixture was then created successfully through a diagnostic preview. This confirms that diagnostic path, not a final deployed release gate.

Commit `6366069a3694f736ed99362ba39328c80923916d` fixes the live recovery MCP contract: the shared maintenance guard previously refused writes with text-only `isError`, leaving the verifier with generic `tool_error`. It now returns the common structured `maintenance_read_only` error for every blocked personal/service tool and alias, with `retryable:true` matching REST. [Maintenance regressions](../../../test/integration/maintenance-mode.test.ts) reproduce the actual handler-to-load-client failure, verify bounded keyed retries and assert no domain side effects.

The same commit corrects the [chat verifier](../../../test/integration/staging-cli.test.ts) for the supported `[N]` and `[Source N]` citation forms and provider events carrying a numeric `response` plus a string delta. It still requires complete SSE, a nonempty answer and citation numbers within 1–8. **Exact cited-source membership is not verified because `/chat` does not return its source manifest.** Citation syntax/range checks must not be reported as that stronger proof.

Final compatibility commit **`f95285f624c6e62a9de255e1d4de75854310d860`** makes `owner.username` nullable when a legacy entry's stored owner ID has no user row. It retains that ID, target permissions and the private-entry boundary; actual owner-query failures still propagate as storage failures. Three [real-SQLite listing/recall regressions](../../../test/integration/mcp-listing-contract.test.ts) cover public missing-owner reads, exclusion of the private sibling and a genuine query failure. Specification §4.3 documents the nullable name. No owner ID, user row or stored content is repaired.

## 3. Retained acceptance coverage and scope

The passing candidate suite retains coverage for authentication rotation with stable ownership, personal/legacy authentication, exact tool profiles, designated-reviewer audience and immutable binding, status reasons and revision conflicts, overwrite protection, staleness and recall/graph eligibility, erasure tombstones, batch validation, source attribution, secure connection exports and isolated Client A/B stores. The correction tests strengthen these paths; the old suite's success alone was insufficient to detect the reviewed bugs.

| Acceptance group | Local evidence | Deployed evidence |
| --- | --- | --- |
| A1–A5; G1–G5 | Rotation, identity/profile, reviewer-binding, ownership, status and recall-eligibility suites; actual handler descriptor/capability checks | All four unchanged personal credentials, profiles and permission boundaries pass on final production |
| M1–M5; C1–C5 | Status metadata, safe failures, bounded history, atomic receipts, replay and batch suites | Real staging retry/recovery and concurrent-write scenarios recorded in §5; four-writer target passes |
| E1–E5 | Migration and erasure suites, unconditional Linux Workerd E1, receipt tombstones, erasure repair and >50-row bounded pagination | Final-source staging is empty with 1,629 complete erasure receipts and zero cleanup jobs; historical counts in §5 |
| O1–O5 | Export/setup, source defaults, client isolation, executable staging CLI fixtures, monitoring and maintenance suites | Semantic/load/latency checks and four-account recovery are attributed to their actual sources in §5; final-source MCP lifecycle passes. Scheduled monitoring remains unconfigured |

The following remain intentional, specification-permitted choices:

- `passages` retains legacy text because §4.4 does not require changing that tool. This is not an unfinished structured-result item.
- Existing streaming `POST /chat` retains SSE, as allowed by §4.1; maintenance generation is now available.
- The dashboard uses the documented designated-reviewer MCP recipe rather than a new proposal editor, as §12 allows.
- Migration 16's stage-row invariant is enforced by the insert helper and regression tests. SQLite's additive `ALTER TABLE` path cannot introduce the proposed table-level CHECK on existing rows; receipt and queue-state domains do have schema CHECK constraints.

WP1–WP8 have implementation and verification evidence. WP9 measurements are recorded across the named runs: the four-writer target and separate corrected generated-answer measurement pass; the original report remains failed. WP10 production compatibility and recovery-artifact preparation are recorded. Scheduled monitoring is still unconfigured, so this document does not claim every operational release gate is complete.

## 4. Migration and compatible recovery

An authenticated query against the actual staging D1 database confirmed ordered migrations **1–16**; the proof is saved with the protected staging verification records. Migration **16**, `capture_receipts_and_status_metadata`, follows version 15 and adds nullable `episodes.status_change_json`, actor/key-scoped `capture_receipts`, durable capture-stage fields on `vector_cleanup_queue`, and `idx_entries_created_at_id`. `db/schema.sql` and runtime migrations are checked for convergence; fresh initialization, repeat initialization and upgrade from 15 are covered. Legacy cleanup rows default to `kind='delete'`; pre-existing status reasons remain unknown rather than invented.

Deployed environments must explicitly set `SLM_DEPLOYMENT_ID`, `SLM_ENVIRONMENT`, `SLM_PUBLIC_BASE_URL`, `SLM_RELEASE_ID` and `SLM_WRITE_MODE`. The staging environment now uses Wrangler's supported configuration shape. A missing required identity field or invalid write mode fails readiness; configuration labels alone do not prove resource isolation.

The verified compatible recovery artifact is Worker **`ab3a4318-8545-46e1-a50b-a69ff6ed0244`**, physical source `6366069a3694f736ed99362ba39328c80923916d`, with `SLM_WRITE_MODE=read-only`. It has the same runtime implementation as mapped candidate `82f9515`; the exact four-account recovery verifier passed. An old pre-receipt writer is not a valid rollback target. Recovery preserves receipts, status metadata, owner identities and existing credentials; reads and grounded chat remain available while new domain mutations and scheduled mutation starts are refused.

A mode change does not cancel calls already accepted by an older enabled isolate. Before any separately authorized restore, observe in-flight calls and stage-intent reconciliation draining. Record outstanding `vector_cleanup_queue`, `pending_cleanup` erasure receipts and audit reconciliation work from the deployed target; local tests do not establish that live queues are empty.

## 5. Staging verification, 2026-09-13

**Final-source staging verification passed:** `f95285f624c6e62a9de255e1d4de75854310d860`, enabled Worker **`05272192-0b57-4e42-9a52-2244bf511341`**. The authenticated effective-binding preflight passed. Full MCP smoke passed initialize, 29-tool discovery, whoami, private keyed capture, recall, confirmed forget with complete erasure receipt, and retained tombstone. At **2026-09-13 15:26:02 UTC**, staging had **zero entries, zero cleanup queue rows and 1,629 erasure receipts, all complete**.

**Benchmarked deployed candidate:** `82f9515a80fe4cd6208da65f7cf28d2cdecdc181`, enabled Worker **`0ddcfd4b-616d-441b-9bb1-98300815da30`**. Its authenticated effective-binding preflight passed; the full MCP lifecycle smoke exited **0**, and the semantic canary exited **0** with **`CANARY_OK`, five checks** and all four attributable fixtures cleaned with complete receipts. The private probe became visible after **23,189 ms** and the public-decoy probe after **4,246 ms** of propagation warm-up; these are not latency-benchmark p95 values.

The finite **load-v2** run executed from **2026-09-13 14:39:04.193 to 15:02:12.771 UTC** on this exact candidate, using embedding model `@cf/baai/bge-small-en-v1.5` and generation model `@cf/meta/llama-4-scout-17b-16e-instruct`. The protected `load-v2-report.json` is preserved with **`ok:false`, `generated_latency_request_failed`**. Its completed scenario results and subsequent diagnostics are distinguished below.

**Recovery passed:** the original exact acceptance verifier exited **0** on read-only Worker **`ab3a4318-8545-46e1-a50b-a69ff6ed0244`**, physical source `6366069a3694f736ed99362ba39328c80923916d`. All **four unchanged staging keys** authenticated; their fixture reads and complete chat worked, MCP/REST writes were blocked, and **all four committed capture receipts were retained**. Enabled mode was restored as Worker **`89530c30-f45a-4c1a-b1a5-792f8376972f`**, physical source `6366069`, and authenticated binding preflight passed; all four recovery fixtures were then deleted with complete receipts. The final pre-benchmark staging check reported **zero entries, zero cleanup queue rows and 598 erasure receipts, all complete**. These observations are staging-only and do not assert production-key verification.

**Prior enabled source `8a98735`:** Worker **`351128be-5251-439f-8218-94b432e029be`** passed the authenticated effective-binding preflight, full MCP lifecycle smoke and **all five semantic-canary checks**. Its first preflight failed closed during rollout propagation; the later authenticated identity and effective bindings matched. Private paraphrase visibility took **4,655 ms** and public-decoy visibility **37,287 ms** during propagation warm-up. Live **50-character** and **55-character literal-tag** checks proved owner access, **zero private-entry results for peers**, and complete attributable cleanup. These passes belong to the enabled `8a98735` version, not to `6366069`.

The first recovery attempt on the `8a98735` source, read-only Worker `ab59f071-c8b9-4431-9792-8cd1f6c99d07`, correctly blocked a write but failed the exact error-contract gate because the response omitted structured content. The correction preserves the refusal and supplies the required machine-readable code; the unchanged exact acceptance verifier subsequently passed on the corrected recovery version above.

On the earlier **`a979c30`** version, Worker `f9b6f50e-e6db-42b6-ad18-d60d4e2b1686`, full MCP lifecycle and all five semantic checks also passed. Private paraphrase visibility took **46.074 seconds**, and all four semantic fixtures were cleaned with complete receipts. None of these propagation warm-up durations is a measured-request latency p95.

Verified staging resources are D1 `a8f3a16c-b9e9-4c4f-bfe6-262344d142a0`, KV `de7e0490e13e4e7685969b4c883eb0ef`, and Vectorize `shared-living-memory-staging-vectors`; each is distinct from production. Required `owner_user_id` String and `is_private` Bool metadata indexes were listed before the first upsert. Four synthetic personal-key principals use one admin and three member roles. On the first candidate, all **12** profile checks passed, capture=10, review=16 and full=29 for each account. Those staging checks did not change production deployments, data or credentials.

### First-candidate results and failure retained

The first corrected candidate, `debe0707160a08c886b5608953d0a8b0a3848510`, was deployed as `c18672c2-7c4f-4508-b96d-284afa3c3fb2`. Its readiness/binding checks and full MCP lifecycle smoke passed: private keyed capture, recall, confirmed deletion, complete authoritative receipt, absent entry, retained tombstone and refused erased-key retry. These results belong to that version, not the current candidate.

Its initial semantic canary exited **14**, `CANARY_SEMANTIC_ZERO_RESULTS`, and cleaned attributable fixtures. A follow-up probe observed paraphrase visibility after **62 seconds** while exact keyword retrieval worked earlier. Tagged recall independently failed with HTTP 500; staging logs identified D1's `LIKE or GLOB pattern too complex` error. The bounded warm-up and exact tag-filter fixes above address these measured conditions; final semantic acceptance still requires a completed run.

| First-candidate independent-write scenario | Accepted writes | Measured evidence |
| --- | --- | --- |
| Concurrency 1, run 1 | 100/100 | p95 **1,786.17 ms** |
| Concurrency 1, run 2 | 100/100 | p95 **1,933.03 ms** |
| Concurrency 1, run 3 | 100/100 | p95 **1,857.20 ms** |
| Concurrency 4, run 1 | **99/100; gate failed** | **31 retries, 32 tool errors**; one `storage_unavailable` capture exhausted **four attempts in 9,981 ms** |

The underlying provider failure was not recorded, so no provider root cause is claimed. Later concurrency-four diagnostics of **32 captures** and **100 captures** each passed with **zero retries**. Those diagnostic successes do not replace the failed scenario or the complete final-candidate acceptance run. The completed load-v2 scenario results are recorded below; its overall result remains failed.

### Completed load-v2 measurements; original failure preserved

Each write scenario had 10 separate warm-ups followed by 100 measured logical captures, repeated three times. All acknowledged captures had matching final entries and receipts, with **zero duplicate effects and zero lost acknowledged writes**.

| Concurrent writers | Accepted across three measured runs | Retries and p95 per run |
| --- | --- | --- |
| 1 | **300/300**, each run 100/100 | 0 retries; p95 **1,808.044709 / 1,827.072792 / 1,919.757625 ms** |
| 4 | **300/300**, each run 100/100 | **0 / 5 / 18 retries**; p95 **1,887.398750 / 3,210.557000 / 3,666.850541 ms** |
| 8 | **296/300**, runs 96/100, 100/100, 100/100 | **76 / 32 / 11 retries**; four exhausted `storage_unavailable` captures in run one; no acknowledged-write loss or duplicate effect |

The supported operating ceiling remains **four concurrent writers**. The eight-writer results are reported as overload evidence, not an eight-writer guarantee. The same-owner revision race produced **one accepted edit and three conflicts**, with **three cross-owner denials**. Four separate owners had matching entries/receipts. Repeated-key and simulated-lost-response scenarios preserved identity with no duplicated effect.

Both latency modes used four concurrent requests, **10 excluded warm-ups and exactly 100 measured requests**. Timings include the full round trip; the original latency samples had zero retries.

| Mode | Original acceptance | Measured p95 |
| --- | --- | --- |
| Default raw recall, `include_insight:false, topK:5` | **100/100**, no reported errors; **passes ≤3,000 ms** | **2,530.912208 ms** (first attempt 2,530.910958 ms) |
| Generated `/chat`, complete SSE | **98/100** measured and **9/10** warm-ups accepted by the original verifier; `chat_grounding_missing` failures | **4,612.784708 ms** (first attempt 4,612.783667 ms), within ≤10,000 ms, but **the original acceptance run failed** |

A separate 100-request generated-answer diagnostic accepted **84/100** under the original verifier. All **16 rejected responses contained valid grouped citations**, and offline replay through the corrected verifier accepted **16/16**. Commit `06cccadd1c18f9ce581503251732eb011ad94c88` fixes that grouped-citation parser and adds a regression. A **fresh corrected-verifier diagnostic at concurrency four passed 100/100**, with p95 **5,068.614 ms**, below the unchanged 10,000 ms threshold. This is a new measurement, not a rewritten original result. The original load report remains unchanged at 98/100 generated acceptance and overall failure; its error codes alone do not retroactively prove the rejected answer bodies valid. The first diagnostic also remains recorded as 84/100, with its offline replay reported separately. Exact cited-source membership remains outside this verifier's proof because chat does not return its source manifest.

### Authoritative cleanup and repair evidence

All **439** attributable first-run entries were deleted with complete erasure receipts. During further repair verification, the operator invoked the actual scheduled handler through official Wrangler remote `test-scheduled` against the staging bindings and found a stale receipt whose cleanup queue was already absent. That observation led to the guarded receipt-reconciliation fix in `a979c30`.

After **two bounded repair drains**, staging reported **zero cleanup queue rows**, **583 erasure receipts, all complete**, and **583 erased capture receipts**. **Four committed recovery fixtures** were retained at that checkpoint, then verified and erased after the successful recovery gate described above. These are cumulative observed staging counts, not additional deletions to add to the 439 first-run entries. No production fixture was deleted. The original load-v2 report recorded **957 complete and 36 pending** erasures, with zero failed cleanup calls. Later reconciliation completed all **993 attributable load entries**; the cumulative staging erasure count is now **1,596, all complete**. At **15:18:47 UTC**, the staging cleanup queue was verified **empty**, with **32 temporary diagnostic entries** still present and all **1,596 erasure receipts complete**. All **32 temporary diagnostic entries** were subsequently cleaned with complete receipts; entry/tombstone checks found **no mismatches**.

### Pilot Canary syntax fixed; monitoring unconfigured

The original Pilot Canary definition failed GitHub validation because `runner.temp` appeared in job-level `env` at lines 154–155. **Actionlint 1.7.7 reproduced both original context errors and passes the corrected workflow** in `e75a3b8`; all **10 targeted workflow tests** and TypeScript checking pass. The correction is confined to the workflow and its regression test, so it does not change the benchmarked runtime.

**Scheduled monitoring is not configured.** Read-only repository inventory returned no Actions secrets and no Actions variables. No monitoring secrets were added, no canary was manually dispatched and no issue was created. Required monitoring credentials/configuration must be supplied and the scheduled operational path verified before claiming monitoring is active; passing syntax and main CI establish code validity only.

### Remaining operational gap

**Scheduled monitoring remains unconfigured.** Pilot Canary syntax and regressions pass, but repository Actions secrets/variables are empty. Dedicated monitoring credentials/configuration and an operational run are still required. Production deployment and compatibility checks have passed; this gap does not represent an unresolved key, memory or MCP read failure.

Required latency thresholds have not been relaxed. A correct executable driver or passing synthetic fixture is not a remote latency result. Do not rotate existing production keys, delete production fixtures or overwrite connection profiles as part of a read-only compatibility check.

## 6. Authorized production rollout and verified compatibility correction

The owner explicitly authorized the production rollout. The initial enabled production Worker **`12d32970-e81b-493d-b329-3247dc90f653`** was activated with **`SLM_RELEASE_ID=82f9515a80fe4cd6208da65f7cf28d2cdecdc181`**. The prior baseline active Worker was **`7866cdfa-f172-4520-bdc8-3768577ababf`**. A production backup contains **25 entries** at migration **15**, passes integrity checking and has SHA-256 **`055e13c2b7821883226c21b203ad6194beaa8c251ba13cbe0ce7b40913991cec`**. The backup is retained in protected operator storage, not in the repository.

Final-source compatible read-only recovery **`25b5db1a-1a56-4506-9d50-9189fa540ab5`**, source **`f95285f624c6e62a9de255e1d4de75854310d860`**, is **uploaded but inactive**. The earlier `82f9515` recovery upload was `93e89c67-52df-4e74-8175-98cb08e4795f`; it is retained here as historical preparation, not the final corrected artifact. This is distinct from the staging recovery version and from the old active production baseline. The production postcheck returned **overall false** because browsing failed. All four original credentials passed initialize/whoami and profiles **10/16/29**, and owned history passed for Jarvis, Researcher and Engineer; Clients had no owned baseline entry to test. Both domains returned readiness **200**; ordered migration **16** passed. The **25 entry records and seven user authentication hashes are byte-exactly preserved** against the backup baseline.

The browse failure is a new release regression exposed by real legacy data: one public entry already had a stored owner ID with no corresponding user row. `listingEntry`/`loadEntryDescriptor` treated the absent username as `storage_unavailable`. The shared descriptor correction is implemented in **`f95285f624c6e62a9de255e1d4de75854310d860`** and allows **`owner.username: null`**, retaining the stored ID, target permissions and private boundary. Specification §4.3 has been updated to describe that case; no entry ownership or user record will be repaired. Final-source staging/CI passed before activation. The correction is now active as Worker **`bbc2b528-c70d-4272-96fe-1ed65a974278`**, source **`f95285f624c6e62a9de255e1d4de75854310d860`**, and the repeated production verifier exited **0** at **15:26:58 UTC**.

The final postcheck verified both production domains' dashboard and `/ready` responses as **200**; all four original credentials passed initialize, whoami, profiles **10/16/29**, listing and semantic recall. Listing and recall preserved private boundaries. The legacy public entry reports its original owner ID with a null username and no non-owner mutation/history permission. Owned history passed for the three principals with existing owned entries; Clients had no owned baseline fixture. All **25** baseline entries retained their content, tags, source, owner, visibility, revision and vector IDs; all **seven** baseline users retained their identity and authentication fields. Migrations **1–16**, actual Cloudflare bindings, required deployment variables and retained secret names were verified, then the active Worker was checked again at **100% traffic**. No production test memories, deletions or key rotations were performed.

The final recovery upload's actual production bindings, retained secret names, final source and `read-only` mode were also checked through Cloudflare's control plane. It remains inactive; production traffic remains on the verified enabled version. Detailed baseline, failed-first-postcheck and final-success proofs are retained in protected `~/.config/shared-living-memory/production-release/` storage.

This is **one authorized rollout followed by a post-activation compatibility correction**. The failed first postcheck is retained rather than presented as a clean activation. Monitoring remains unconfigured. No release tag or branch merge has been performed.

## 7. Historical audit retained

The original implementation baseline was recorded on macOS with Node v22.22.3 and npm 10.9.8. `npm ci` exited 0; before edits, `npm test` passed **1,124 tests in 106 files** and `npm run typecheck` exited 0. The original evidence recorded **1,445 tests in 129 files** after implementation. The independent review at `e531aa1` reran **1,447 tests in 129 files** and typecheck successfully, then reproduced the defects preserved in the review report. Those historical green suites did not prove the missing contracts or remote drivers correct.

The original macOS Workerd command failed because `setsid` was absent. A manually shimmed run exercised AI-independent phases only. That historical result is superseded for local runtime evidence by the unconditional Linux Docker smoke in §1; neither result is presented as an unrecorded GitHub Actions run.

The original test-change audit covered ten pre-existing files. Migration assertions widened `[1..15]` to `[1..16]`; status/deprecation assertions changed from booleans to committed-version data; readiness gained metadata/failure cases; deactivation gained tombstone checks; smart merge gained explicit protected/unprotected cases; remaining changes were fixtures and required fields. That audit describes the original implementation, not the larger correction diff.

The correction audit additionally replaces outdated text-only success/failure assertions with exact structured contracts, corrects reversed permission assertions and adds actual-handler privacy/revision/budget regressions. The legacy-source privacy fixture now seeds the users required by authoritative descriptor reads; its existing privacy assertions are retained and structured-output privacy assertions are added. No privacy assertion was removed to conceal metadata failure. The initial correction commit `debe0707` changed **36 files, 2,595 insertions and 801 deletions** and passed 1,497 tests in 132 files on Linux. Subsequent commits `a06492d`, `a979c30`, `8a98735` and `6366069` contain the staging-discovered tag/propagation, receipt-repair, vector-metadata and recovery-contract/verifier corrections described above. The earlier full Docker run remains attributed to original source `6366069`; the mapped `82f9515` publication, focused 20-test fixture rerun and subsequent actual GitHub CI with 1,525 passing tests are recorded separately above. Workflow-only commit `e75a3b8` adds one regression and passes its own GitHub CI with 1,526 tests, without changing deployed runtime files.
