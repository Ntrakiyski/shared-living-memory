# Task Plan

## Goal
Audit GitHub synchronization, runnable checks, and outstanding product readiness.

## Constraints
No application changes, pulls, deployments, production writes, or secret inspection.

## Steps
- [x] Compare checkout with fetched GitHub branches and pull requests.
- [x] Run documented tests and typecheck; inspect deployed health.
- [x] Review implementation and outstanding readiness gaps.

## Verification
- [x] GitHub comparison: HEAD 9b20b20, origin/main b9dffaf; behind one documentation-only commit; no open PRs.
- [x] npm ci completed; npm test passes 1124 tests in 106 files; npm run typecheck passes.
- [x] Live dashboard, /health and /ready return HTTP 200 on 2026-09-13.
- [x] GitHub CI run 31397468914 passes tests, typecheck and real Workerd bootstrap/auth smoke.
- [x] Canary run 34741628326 inspected: readiness step skipped despite successful workflow.
- [x] Source and documentation reviewed independently for readiness gaps.

## Review
Application code matches GitHub; local checkout lacks architecture documentation from b9dffaf. Original tree was clean; audit adds tasks files only, plus ignored installed dependencies/generated types.

Operational gaps: readiness check is skipped when its URL is absent; close-on-recovery has no dependency on canary; readiness only probes D1, not actual semantic capture/recall. AGENTS authentication instructions and pilot roadmap are stale. Pilot acceptance targets disagree between scorecard and plan; no completed recovery/participant evidence found. Only Notion integration is registered.

Limits: no authenticated production capture/recall or UI interaction tested; no claim that deployment matches a specific commit. Local smoke script requires setsid, unavailable on this Mac; current GitHub CI supplies successful Linux real-Workerd smoke evidence. MCP connector is unavailable in this session. No application fixes or synchronization performed because request was an audit.

## 2026-09-13 MCP credential repair
Goal: inspect Cloudflare authentication failure and issue/verify a working Jarvis credential.
Constraints: preserve memory content, use existing auth lifecycle, do not expose Cloudflare secrets.
- [ ] Inspect deployment, domain and Jarvis status.
- [ ] Repair or rotate credential through supported flow.
- [ ] Verify authenticated MCP initialization and tool listing.

### Credential recovery result
- [x] Cloudflare confirms Jarvis is active/admin; supplied secret matches neither supported stored hash form.
- [x] Recovered only Jarvis credential in D1, retaining its user ID and recording a security event. No memory content changed.
- [x] Live custom-domain MCP initialize and tools/list both HTTP 200; 24 tools returned.
Replacement credential stored outside repository with mode 0600, in ~/.config/shared-living-memory/jarvis-connection.json. Updated connection file sent to Fractals via Taildrop.
Limitation: existing rotateUserKey implementation generates a different public ID and hashes id.secret, inconsistent with resolution by stable user ID and secret hash. This code defect remains; no application deployment performed during credential recovery. Supplied key mismatch cause (copy error versus obsolete credential) cannot be determined from hashes.

## Four agent credentials
Goal: retain Jarvis and create researcher, engineer, clients with separate MCP credentials.
Constraints: Jarvis stays admin; new identities use member permissions. Secrets outside repository.
- [ ] Create three member identities using authenticated administration endpoint.
- [ ] Verify all four credentials via MCP and save connection files.
- [x] Created researcher, engineer, clients via admin API with member permissions; Jarvis credential unchanged.
- [x] All four pass live MCP initialize and tools/list; each exposes 24 tools including remember and recall.
Review: individual credentials and combined four-agents-connections.json saved outside repository with mode 0600. Combined file delivered to Fractals via Taildrop. These are separate personal-key identities, not scoped service identities. No test memories created; capture permissions were established by member-role implementation, not live content writes. Private memories are not automatically shared across identities.

## 2026-09-13 Agent feedback improvement plan
Goal: explain and plan all reported agent-use issues against current implementation.
Constraints: planning and read-only verification; no deployment, credential rotation, or production memory changes. Preserve ownership/privacy and backwards compatibility.
- [x] Trace lifecycle and deletion reports; distinguish confirmed causes from hypotheses.
- [x] Review identity, authentication, source defaults, tool exposure and integration limits.
- [x] Save phased improvement plan with acceptance checks and rollout.
- [x] Check every feedback item is covered and explain priorities to the user.

### Improvement-plan review
Saved docs/superpowers/plans/2026-09-13-agent-memory-reliability.md, covering all five feedback areas, batch capture, status vocabulary, concurrency, pagination and client isolation. Verified report ID is a real researcher-owned public entry; history succeeds as researcher and is hidden from Jarvis. Reproduced exact erasure SQL failure locally at Workerd limit five. Existing owner-submitted proposal flow already supports personal-admin review; no new promotion subsystem proposed. Targeted lifecycle checks: 54 passed in five files. Plan checked for secret leakage, stale assumptions, compatibility, role-policy caveats and coverage. No application code, credentials, permissions or memory content changed. Full staging workflow remains an implementation acceptance gate.

## 2026-09-13 One-release execution specification
Goal: replace staged releases and open choices with a decision-complete implementation specification for less-capable execution models.
Constraints: one production release, internal work packages only; documentation changes only; no copy-paste source-code package. Preserve all feedback coverage and current keys.
- [x] Resolve remaining protocol, identity, governance, batch, migration and release-policy choices against source.
- [x] Rewrite the plan with fixed contracts, file ownership, ordered tasks and acceptance matrix.
- [x] Review contradictions, unsafe shortcuts, missing decisions and source/path references.
- [x] Deliver the expanded document and a ready-to-use executor prompt inside it.

### One-release specification review
Replaced the multi-release plan with SLM Agent Reliability1.1, a single enabled production release with ten internal work packages. Expanded to21 main sections and30 acceptance scenario groups, approximately11,559 words. Fixed current-key compatibility, designated-reviewer binding, exact personal profile sets10/16/29, two status axes, atomic metadata, batch10/128KiB, idempotency/erasure tombstones, staged-vector cleanup fencing, cursor/error contracts, metadata/auth/export handling, maintenance, staging safety, load/latency gates and compatible recovery. Service migration, service approval and shared-database tenancy are explicitly excluded rather than unresolved implementation choices.

Independent source reviews found and resolved staleness resurrection, hidden pattern confidence promotion, legacy fingerprint compatibility, raw-recall measurement, ownership of race tests, mutation-bearing GET maintenance behavior and source-default hashing gaps. Validation confirmed section/work-package/scenario counts, paired code fences, no placeholder markers and no live key material. Only the plan and task documentation changed; no code or deployment performed. Section0 contains the executor assignment; all source edits belong to a later authorized implementation task.

## 2026-09-13 Independent release implementation review

### Goal
Verify the reported implementation against the fixed release specification and identify concrete release blockers.

### Constraints
Review only: preserve the branch and existing edits; no push, deployment, credentials changes or production writes. MCP connector unavailable; use repository evidence.

### Steps
- [x] Confirm branch, working tree and release evidence.
- [x] Review correctness, compatibility, specification coverage and test evidence independently.
- [x] Run local tests and typecheck; distinguish local proof from deployed gates.
- [x] Report verified findings and the next release action.

### Verification
- [x] Findings have file/line evidence.
- [x] Local command outcomes recorded.
- [x] Remaining infrastructure gates stay explicitly unmeasured.

### Review
Review complete. Saved docs/team-pilot/releases/agent-reliability-1-1-review.md with 14 actionable findings, fixed correction requirements and regression scenarios. Independently reproduced 1,447 passing tests/129 files and typecheck exit 0, including Wrangler warning that envs is ignored. Independent real-SQLite probes exposed lost-response vector deletion, orphan artifacts after a lost fence, stale replay revisions, incorrect recall ownership/revision and unbounded structured history. A loopback HTTP probe reproduced a false-positive whoami canary. Remote gate CLIs are unconditional failure stubs, so missing infrastructure is not their only blocker. No implementation, deployment, credential or remote changes. One production release retained.

## 2026-09-13 Implement independent review corrections

### Goal
Fix all 14 reviewed findings and the maintenance generation deviation; prove the corrected local/runtime behavior and finish executable release verification.

### Constraints
One production release. Preserve current keys, ownership, policy, working branch and existing changes. No production deployment or writes. Use synthetic fixtures for destructive/race checks. Retain fixed performance gates; never substitute mocks for measured staging evidence.

### Steps
- [x] Repair capture receipts, attempt fences and replay revisions (1, 2, 12).
- [x] Repair MCP/REST descriptors, bounds, service batching and proposal permissions (5–8, 13, 14).
- [x] Finish staging preflight/load scripts and correct effective Wrangler config (3, 4).
- [x] Repair real-Workerd erasure and monitoring, restore safe maintenance generation (9–11).
- [ ] Run targeted regressions, full tests/typecheck, Linux Workerd smoke and available isolated staging verification; update release evidence.

### Verification
- [x] Every review finding mapped to a regression and passing implementation.
- [x] Full suite/typecheck and actual Workerd erasure results recorded.
- [x] Gate CLIs tested through actual synthetic HTTP fixtures.
- [ ] Deployment safety and any remaining external blockers accurately recorded.

### Review
Runtime candidate6366069a3694f736ed99362ba39328c80923916d passes Linux Docker all1525tests/134files, typecheck and actual Workerd smoke; locked dependencies unchanged. Its deployed read-only Workerab3a4318-8545-46e1-a50b-a69ff6ed0244 passed all4 unchanged staging credentials, reads, complete grounded chat, blocked MCP/REST writes and retained receipts. Restored enabled Worker89530c30-f45a-4c1a-b1a5-792f8376972f passes authenticated effective-binding preflight. Prior enabled8a98735 fullMCP, five semantic checks and long/literal-tag owner/privacy/cleanup proofs passed; all16 migrations proven. Final load/latency matrix remains pending. All598 attributable fixture erasures complete; zero entries and zero cleanup queue rows at14:33UTC.

User authorized branch push from this Mac. GitHub credentials were scoped to the repository owner without changing global auth. Push protection rejected a synthetic Stripe-shaped test literal in unpublished history; sanitization preserves all64 commits and a protected local backup, without bypassing protection. Final source mapping and GitHubCI will be recorded after successful push. No production deployment, data or key changes.

## 2026-09-13 Authorized production rollout

### Goal
Deploy the corrected reliability release from this Mac and verify the four existing agents against production.

### Constraints
The user explicitly authorized branch publishing and production deployment. Preserve existing memory content, ownership and credentials. Keep original failed evidence; do not relabel it as passing. Use staging for all synthetic writes and deletions.

### Steps
- [x] Push the branch with scoped owner authentication and obtain Linux CI.
- [x] Verify isolated staging, recovery, four-writer capture, latency and cleanup.
- [x] Back up production D1 and upload a compatible read-only recovery version.
- [x] Activate production and check existing identities, tool profiles, schema and data.
- [x] Reproduce and fix the legacy missing-owner display failure found during the production postcheck.
- [x] Verify the final source in CI and staging, activate its production correction and repeat compatibility checks.
- [x] Commit the final evidence and confirm the branch is published.

### Verification
The original load report remains failed on generated-answer citation validation. A separately captured diagnostic proved grouped-citation false negatives, and the corrected verifier passed a fresh 100/100 complete answers at concurrency four, p95 5068.614 ms. Raw recall passed 100/100, p95 2530.912208 ms. One/four-writer scenarios passed 600/600 measured captures. Eight-writer stress passed 296/300; four writers remain the supported target. All 1628 staging erasures were complete with zero entries and zero queued cleanup at 15:22:54 UTC.

Initial production version 12d32970-e81b-493d-b329-3247dc90f653 retained all 25 original entries and all 7 user/auth-hash rows exactly, applied migration 16, and passed both domains' readiness plus four original keys, initialization, 10/16/29 profiles and owned history. The overall postcheck failed on browsing a pre-existing public entry whose owner account is missing. No data repair or ownership reassignment was attempted. The shared display fix returns a null username and preserves ID-based permissions, with 29 passing real-SQLite tests and typecheck.

### Review
Final source f95285f624c6e62a9de255e1d4de75854310d860 passes GitHub Linux CI run 34765494261: 1529 tests/134 files, typecheck and actual Workerd smoke. Staging version 05272192-0b57-4e42-9a52-2244bf511341 passes authenticated bindings and the full MCP capture/recall/erasure lifecycle; its 1629 cumulative erasures are complete with zero entries/queue. Final enabled production version bbc2b528-c70d-4272-96fe-1ed65a974278 passes all four unchanged credentials, initialization, whoami, semantic recall, browsing/private boundaries, owned history, 10/16/29 profiles, both domains/readiness, migration 16 and exact preservation of the 25 entries and 7 user/auth rows. The legacy public owner name is explicitly null; owner ID and permissions remain correct. Protected final-recovery version 25b5db1a-1a56-4506-9d50-9189fa540ab5 is uploaded without activation. No production test memories, deletions or key rotations occurred. Scheduled GitHub monitoring remains unconfigured and is not claimed operational.

## 2026-09-13 Scientist connection delivery

Goal: issue a working Scientist MCP credential and send it to Fractals through Taildrop, as explicitly requested.
Constraints: retain the existing scientist member identity and its memories; replace only its credential. Store keys outside Git with owner-only permissions.
- [x] Confirm the active scientist identity and online Fractals Tailscale device.
- [x] Issue and save the new Scientist connection; verify MCP identity and tools.
- [x] Transfer the connection file through Taildrop and record the result.

Review: Scientist already existed as an active member. Rotated only its key through the administrator API, retaining its ID. Verified MCP initialize, whoami, all 29 full-profile tools (including remember/remember_batch/recall) and browsing. Saved scientist-connection.json outside Git with mode 0600. Taildrop reported the file sent successfully to the verified online Fractals device at 18:32:40 Sofia time. The old Scientist key is invalid; other agent credentials and memory content were untouched.

## 2026-09-13 Hermes release evaluation assignment

Goal: send Hermes the live release and Scientist file details, with realistic linking, research, older-session and performance testing instructions.
- [x] Connect through SSH to niko@fractals and inspect the supported Hermes CLI.
- [x] Deliver the assignment to ~/.hermes/tasks/slm-release-evaluation-20260913/assignment.md on Fractals.
- [x] Start a dedicated Hermes conversation without interrupting existing sessions or overriding its model/configuration.
- [x] Verify the named session exists and its systemd user service is running.

Review: Hermes session 20260913_183526_901ee2, titled SLM 1.1 live-release evaluation, is running under hermes-slm-release-evaluation-20260913.service with a 2700-second budget. The brief includes the actual production source/version, Scientist Taildrop file and invalidated old key, linking/traversal/proposal/privacy scenarios, bounded older-session summaries, measured end-to-end timings and known monitoring gap. It protects existing memories, keys and original sessions. Requested final report.md beside the assignment plus a response to Niko in the Hermes task. Tests are delegated and running, not claimed complete.

## 2026-09-14 Hermes issues #3–#11

Goal: verify all nine reported issues, fix confirmed defects at their shared cause, and explain intentional privacy/protocol behavior with evidence.
Constraints: preserve existing local notes, credentials, ownership, visibility and real memories. Use synthetic local/staging fixtures for mutation tests. Do not weaken private-data concealment or treat HTTP 200 alone as MCP success. Existing publishing/deployment authorization continues; verify corrected code before release.
- [x] Read all issue bodies and the evaluator's exact harness; map each to code and reproduction.
- [x] Fix graph selection/edge results, recall feedback/insight, and any confirmed capture/protocol defects with focused regressions.
- [x] Explain intentional privacy and compatibility contracts; document precise issue dispositions.
- [x] Run full tests/typecheck/Workerd and appropriate staging checks; publish and verify production corrections.
- [x] Report outcomes, measured limits and any remaining issue clearly.

### Review
Verified all nine original issue reports against source and Hermes's actual harness/logs. Fixed graph result starvation, distinct directional edge output/exact deletion count, real caller-bound recall feedback, insight evidence/provenance guidance, structured MCP refusals and compatible entry-ID aliases. Explained changed-source replay conflicts (#6), valid MCP HTTP200 execution envelopes (#7), private existence concealment (#8) and visibility boundaries (#10). Source 723c4ba passes 1580tests/138files, typecheck, Linux Workerd and GitHub CI 34822566584. Isolated staging passes seven scenario checks plus full MCP lifecycle; all fixtures erased, zero entries/queue. Production 8e301237-9b5b-4ae0-a144-5f629800afe9 verifies all five unchanged agent credentials/profiles, semantic recall, browsing/history, domains/readiness and exact preservation of 52 entry / 7 user-auth rows. Compatible inactive read-only recovery a007975a-065d-4a56-b695-c35c5b51c202 verified. One real conflict-answer sample correctly distinguished recommendation from decision in 3904 ms; this is not a benchmark or guarantee of model infallibility. Full issue dispositions and evidence are in docs/team-pilot/releases/2026-09-14-hermes-issue-review.md.

## 2026-09-14 Hermes generated-answer follow-up

Goal: investigate the reported generation latency increase and remaining trial/recommendation wording without weakening evidence safeguards.
Constraints: compare actual requests and returned content; keep existing production records/keys unchanged; no model change or latency claim from unmatched samples.
- [x] Inspect the retest report, harness and actual before/after samples.
- [x] Measure evidence and answer sizes and isolate whether a minimal correction is justified.
- [x] Verify any correction with relevant tests and bounded live evidence, or document why no deployment is warranted.
- [x] Record findings and the remaining measurement limits.

### Review
Independently verified all nine GitHub issues closed with the reported dispositions. Inspected actual old/new remote timing scripts: retest appended a follow-up question, and fixed graph selection changes generation evidence, so the claimed like-for-like comparison is confounded. Six alternating current-release calls from Fractals all passed, with original-query median 6133.21 ms and follow-up median 6458.66 ms (three each), range 5207.05–7228.49 ms. Same five returned IDs and response evidence sizes in this run. Residual trial-as-decision wording remains an acknowledged quality limitation. No code, model, prompt, production records or credentials changed; no unsupported claim of a latency fix. Evidence and next valid measurement design added to the issue review.
