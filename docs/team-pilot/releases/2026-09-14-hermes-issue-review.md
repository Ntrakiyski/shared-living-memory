# Hermes evaluation: issues #3–#11

Status: corrections deployed and verified in production. Evaluated release: `f95285f624c6e62a9de255e1d4de75854310d860`. Existing production memories, identities, visibility and keys are preserved. Mutating reproductions use synthetic local/staging fixtures.

## Evidence and decisions

### #3 Graph-expanded recall loses neighbors when topK is full

Confirmed implementation defect. Graph candidates were scored below the weakest direct result and the combined array was truncated to topK. A full direct list therefore excluded every graph candidate. Fix: bounded, explicit graph allocation when hops is requested, while preserving a strongest direct result, total topK limit, visibility and status checks. `hops:0` retains direct-only behavior. When the direct list is full, reserve `min(eligibleGraphCount, floor(topK / 2))` graph slots, then reuse any spare slots. `topK:1` keeps the strongest direct result. Connections retain at most eight distinct eligible visible neighbors, with all incident types/directions for those selected neighbors; depth never guarantees every reachable memory fits the bounded response.

### #4 Recall feedback has no usable event binding

Confirmed. The MCP description promises a recall event ID, but the return path does not expose a recorded event and feedback accepts invented IDs. Fix the existing event/feedback flow, binding valid feedback to the authenticated caller's real event. Do not store plaintext queries or fabricate an ID when event recording fails.

### #5 Generated insight blends conflicting recommendations and decisions

Confirmed missing context/insufficient generation guidance. Canonical status means the record is retained as authoritative knowledge; it does not make every quoted recommendation an adopted decision. Pass authorized status/source/relationship context, including directed edge provenance and require the generator to separate proposals, recommendations, actual decisions and unresolved conflicts. Inferred/system/unknown relationships are suggestions, not authoritative resolutions. This improves grounding but cannot guarantee an LLM never contradicts itself. Existing deprecated/superseded/retracted filtering remains enforced. Do not silently change real record statuses or widen visibility.

### #6 Concurrent capture conflict is caused by a changed request

The original evaluator's `scenario-replay.py` sets `source: "slm-1.1-eval"` for the first and sequential captures (lines 36–39), but omits source from the concurrent calls (lines 59–60). The content string is identical; the full write meaning is not. Explicit source is provenance and is part of the idempotency fingerprint. Omitting it uses the actor-default marker, so a conflict is correct. Never treat `idempotency_conflict` as success.

No runtime relaxation is needed. Keep one immutable request object and resend all its fields on retries. A focused real-SQLite regression passes four exact concurrent retries and rejects omission of source, retaining one entry/episode/receipt. The same test against the existing staging release passed four identical replays with one entry ID and rejected source omission with `idempotency_conflict`; its synthetic entry was erased with a complete receipt. Protected proof: `~/.config/shared-living-memory/staging-verification/issue6-proof-20260914.json`.

### #7 HTTP 200 is not sufficient to determine MCP tool success

The [MCP 2025-06-18 tools contract](https://modelcontextprotocol.io/specification/2025-06-18/server/tools#error-handling), matching the evaluator's negotiated protocol, distinguishes protocol errors from execution errors inside successful protocol responses. Tool execution failures use `result.isError:true`; SLM additionally supplies `result.structuredContent.ok:false` and a stable error code. HTTP 200 can correctly carry such a failure.

The original evaluator's own log has `is_error:true` for idempotency and stale-revision conflicts, so the blanket claim that all cases lack a flag is incorrect. Its helper's `out.error` examines only the top-level JSON-RPC error. However, link/propose_edge visibility and missing-entry refusals really do show `is_error:false`: those handlers require correction. Parse the JSON-RPC result, execution flag and structured envelope, not prose or transport status alone.

### #8 Missing and inaccessible records intentionally look alike

Do not reveal whether another principal's private record exists. A guessed nonexistent ID and an inaccessible ID must have the same safe error. Where the caller can already read an entry but cannot mutate it, a permission-specific explanation is safe. Improve the machine-readable error contract without opening an existence oracle.

### #9 Connections direction, relationship collapse and unlink counts

Confirmed graph-introspection defects. Connections must enumerate distinct incident relationships rather than reuse a node-deduplicating traversal. Preserve type and source/target direction. Unlink must count deleted logical edge rows, not trigger-generated audit changes. The graph changes pass 157 tests across 11 focused suites, including ten new real-SQLite regressions and a REST shape assertion. Direction/source/target fields are additive; `unlink` remains order-agnostic and its count now reflects actual deleted relationships.

### #10 Private/public cross-visibility edges are intentionally refused

The current graph policy requires compatible endpoint visibility. A proposal does not bypass that boundary, and its reviewer must not learn about someone else's private entry. Keep the refusal and explain it correctly. For shareable provenance, create an explicitly reviewed public summary containing only material authorized for the shared audience, then link that public record to public evidence. Private working material can retain links to other permitted private records. A visibility-aware private overlay graph would require a separate product/security design; this patch does not introduce one implicitly.

### #11 Identifier aliases help; machine results should not be parsed with prose regexes

The naming inconsistency is real. Accept `id` and `entry_id` where an existing single-entry tool uses one spelling, preserve old callers and reject conflicting values. The result shapes describe different operations: recall returns multiple matches; history returns one projection and its versions. Recall already exposes `result.structuredContent.data.matches[i].entry.entry_id` and `.revision`; history exposes `result.structuredContent.data.projection.revision`. The evaluator used a prose regex for `current revision N` against JSON history, which produced null and then a valid input-validation failure. Use structured data and do not coerce a missing revision into a valid precondition.

## Verification

- Source and original remote evaluator scripts/logs inspected; issue #6 source mismatch and issue #7 mixed flags verified independently.
- #6 real-SQLite suite: 34 tests passed. Existing deployed staging: four exact retries replay, changed provenance conflicts, complete fixture erasure.
- Integrated candidate: 1,580 tests / 138 files pass; `npm run typecheck` and real Linux `npm run smoke:workerd` pass. Candidate staging and production checks passed below.
- Fresh production backup verifies SQLite integrity, 52 entries and 7 user records; all five existing personal credentials authenticate. No production data or keys changed.

### Candidate live evidence

Candidate source: `723c4bad55a3729b74f65c372ec23d1453abcea1`. [Linux CI](https://github.com/Ntrakiyski/shared-living-memory/actions/runs/34822566584) passed dependency install, typecheck, all 1,580 tests and real Workerd smoke.

The full MCP private capture/recall/erasure lifecycle also passed. Staging was left with zero entries, an empty repair queue, and all 1,637 cumulative erasure receipts complete.

Staging version `d8a74001-aaf9-4f2f-bc04-76d19ec7513f` passed authenticated Cloudflare binding isolation and seven live scenario checks: distinct incident directions, exact logical unlink count, a graph neighbor in a full topK=2 result, real event feedback with invented/foreign IDs rejected, private/missing error indistinguishability, ID alias compatibility/conflict refusal, and real model generation. All six synthetic scenario memories were erased with complete receipts.

The real generated answer correctly distinguished the rejected Aster/weekly-review recommendation from the adopted Birch/monthly-review decision, citing both sources. This one end-to-end insight request took 3,904 ms; it is a functional sample, not a p95 benchmark or an LLM correctness guarantee.

Compatible read-only recovery version `a007975a-065d-4a56-b695-c35c5b51c202` is uploaded and its production bindings verified, without activation. No production memory content, entry ownership, visibility, revisions, vector IDs, user identities or credential hashes were changed by the release.

### Production verification

Active production version: `8e301237-9b5b-4ae0-a144-5f629800afe9`, running tested source `723c4bad55a3729b74f65c372ec23d1453abcea1`. Both the custom domain and Workers domain return HTTP 200 for the dashboard and `/ready`; the five required deployment variables and production D1/KV/Vectorize bindings match. The existing AUTH_TOKEN secret binding remains present.

Jarvis, Researcher, Engineer, Clients and Scientist all authenticate with their unchanged saved keys and pass MCP initialization, identity/release checks, semantic recall, recent-entry browsing, and the exact capture/review/full profiles (10/16/29 tools). Owned history succeeds for every account with an existing owned entry. Read results were checked against ownership/public visibility.

The post-deployment SQL comparison exactly matches all 52 pre-deployment entry rows across ID, owner, content, tags, source, visibility, revision and vector IDs, and all seven user rows including credential hashes/prefixes and status. Migration history remains 1–16. Recall/audit telemetry can change through normal reads; it is not claimed byte-identical. The protected backup and verification evidence live under `~/.config/shared-living-memory/production-release-20260914/` outside Git.

The GitHub issues remain open for Hermes to retest. This review supplies the individual dispositions without claiming every report was a server defect.
