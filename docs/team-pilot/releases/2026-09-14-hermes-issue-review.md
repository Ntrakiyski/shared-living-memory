# Hermes evaluation: issues #3–#11

Status: investigation and corrections in progress. Evaluated release: `f95285f624c6e62a9de255e1d4de75854310d860`. Existing production memories, identities, visibility and keys are preserved. Mutating reproductions use synthetic local/staging fixtures.

## Evidence and decisions

### #3 Graph-expanded recall loses neighbors when topK is full

Confirmed implementation defect. Graph candidates were scored below the weakest direct result and the combined array was truncated to topK. A full direct list therefore excluded every graph candidate. Fix: bounded, explicit graph allocation when hops is requested, while preserving a strongest direct result, total topK limit, visibility and status checks. `hops:0` retains direct-only behavior. When the direct list is full, reserve `min(eligibleGraphCount, floor(topK / 2))` graph slots, then reuse any spare slots. `topK:1` keeps the strongest direct result. Connections retain at most eight distinct eligible visible neighbors, with all incident types/directions for those selected neighbors; depth never guarantees every reachable memory fits the bounded response.

### #4 Recall feedback has no usable event binding

Confirmed. The MCP description promises a recall event ID, but the return path does not expose a recorded event and feedback accepts invented IDs. Fix the existing event/feedback flow, binding valid feedback to the authenticated caller's real event. Do not store plaintext queries or fabricate an ID when event recording fails.

### #5 Generated insight blends conflicting recommendations and decisions

Confirmed missing context/insufficient generation guidance. Canonical status means the record is retained as authoritative knowledge; it does not make every quoted recommendation an adopted decision. Pass authorized status/source/relationship context and require the generator to separate proposals, recommendations, actual decisions and unresolved conflicts. This improves grounding but cannot guarantee an LLM never contradicts itself. Existing deprecated/superseded/retracted filtering remains enforced. Do not silently change real record statuses or widen visibility.

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
- Integrated candidate: 1,580 tests / 138 files pass; `npm run typecheck` and real Linux `npm run smoke:workerd` pass. Live candidate staging and deployment checks remain pending.
- Fresh production backup verifies SQLite integrity, 52 entries and 7 user records; all five existing personal credentials authenticate. No production data or keys changed.
