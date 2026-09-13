# Lessons

## 2026-09-13 - Check dependency availability before verification

Mistake: Initial test and typecheck commands could not find vitest and wrangler.
Why it happened: This checkout had no installed dependencies.
Rule for next time: Check for local executables and run npm ci before verification on a fresh checkout.
Example check: test -x node_modules/.bin/vitest

## 2026-09-13 - Verify credentials against the actual MCP endpoint
Mistake: Asserted user-provided MCP credentials were sufficient before checking them live.
Why it happened: Confused supported authentication format with validity of a specific key.
Rule for next time: Verify MCP initialization and tool listing before claiming connection works; keep credentials outside tracked files.
Example check: Both initialize and tools/list return HTTP 200 and valid protocol results.

## 2026-09-13 - Separate reported symptoms from runtime causes
Mistake: Initial feedback summary repeated the candidate-ID interpretation before tracing ownership and runtime limits.
Why it happened: The report mixed valid observations with inferred causes.
Rule for next time: Compare the same entry under both relevant principals, inspect authoritative metadata, and reproduce database errors under the actual platform limits before choosing a fix.
Example check: Owner history succeeds while non-owner history is hidden; a six-term query fails at Workerd's five-term limit even in an empty database.

## 2026-09-13 - Match the requested release and executor model
Mistake: Proposed several releases and deferred design choices when the user wanted one release executed by less-capable models.
Why it happened: Optimized for incremental delivery before establishing the desired handoff format.
Rule for next time: When asked for an execution-only handoff, fix product and engineering decisions upfront, distinguish internal work packages from releases, and specify tests and stop conditions without requiring implementers to design the system.
Example check: No optional implementation branches or multiple-release language remain in the final release contract.

## 2026-09-13 - Verify executable gates and ambiguous commits

Mistake: The implementation handoff described remote checks as blocked only by missing infrastructure, but their CLIs had unconditional failure stubs; passing tests also missed committed-response-loss and combined race failures.
Why it happened: Helper-level assertions and local success counts were treated as broader completion evidence.
Rule for next time: Trace every gate entrypoint to actual request execution and test combined failure windows after COMMIT as well as before it. Verify effective deployment config with the platform parser.
Example check: Supplying a synthetic valid staging server must execute requests, and a capture whose successful database response is lost must retain its committed vectors.

## 2026-09-13 - Treat validation as a hard dependency

Mistake: A commit command followed a failing whitespace check because shell commands were separated by newlines.
Why it happened: Sequential execution was mistaken for conditional execution.
Rule for next time: Use a checked exit status or && for a mutation that depends on validation.
Example check: git diff --cached --check && git commit. The affected local commit was corrected before deployment.

## 2026-09-13 - Keep benchmark isolation separate from query selection

Mistake: The raw-recall load probe added a fixture tag, selecting an exhaustive tag-vector path instead of normal retrieval.
Why it happened: Fixture isolation was implemented as a query modifier.
Rule for next time: Send the specified ordinary query, then validate every result against recorded authorized fixture IDs without filtering failures away.
Example check: The raw benchmark sends only query, topK=5 and include_insight=false; unexpected IDs fail the gate.

## 2026-09-13 - Exercise provider constraints on valid domain inputs

Mistake: Exact SQL tag filtering passed locally, but a valid quoted tag still failed live capture.
Why it happened: An unused per-tag Vectorize metadata key copied user text into a provider-restricted object key.
Rule for next time: Trace accepted input through every provider boundary; remove unused derived metadata instead of adding escaping machinery.
Example check: A quoted and dotted tag captures and replays with provider metadata-key restrictions enforced, then owner and non-owner recall are checked on staging.

## 2026-09-13 - Validate operational errors and the real stream format

Mistake: Recovery checks exposed text-only MCP maintenance errors and a verifier that rejected valid numbered chat citations.
Why it happened: Handler tests checked the human text without its structured envelope; stream fixtures represented only one citation syntax.
Rule for next time: Exercise the actual handler through the operational client and capture a provider-shaped SSE fixture before enforcing its contract.
Example check: Maintenance returns structured maintenance_read_only without side effects; complete chat accepts supported numbered citations and rejects uncited output.

## 2026-09-13 - Keep secret-detection fixtures out of published history

Mistake: GitHub push protection rejected a realistic synthetic Stripe key literal in a security regression.
Why it happened: A current-diff scan for project credentials did not cover provider-shaped test secrets in every unpublished commit.
Rule for next time: Construct secret-shaped test inputs at runtime and scan unpublished history before public pushes; preserve a local backup when sanitizing history, never bypass push protection.
Example check: The runtime invalid-reason test still exercises a Stripe-shaped token, while no contiguous matching literal exists in branch history.

## 2026-09-13 - Validate workflow context and the repository account

Mistake: Git selected a different logged-in GitHub account, and GitHub rejected a workflow using runner.temp at job-env scope.
Why it happened: Available credentials were confused with the repository owner; workflow string tests did not validate GitHub context availability.
Rule for next time: Scope authentication to the verified repository owner without changing global auth, and validate workflow edits with actionlint plus the real GitHub result.
Example check: Owner-scoped push succeeds; runner paths resolve at step scope and the workflow passes actionlint.


## 2026-09-13 - Verify legacy ownership before releasing richer descriptors

Mistake: A public production entry with a missing historical user made the new MCP listing fail.
Why it happened: Fresh staging fixtures all had current owner accounts; the descriptor treated missing display metadata as a database outage.
Rule for next time: Validate upgraded reads against legacy relationship shapes. Keep authoritative owner IDs and permission checks, but represent unavailable display names explicitly as null.
Example check: A synthetic orphan-owned public entry remains readable beside normal entries; its private counterpart remains hidden and no mutation or history permission is granted.

## 2026-09-13 - Resume interrupted collaborators explicitly

Mistake: Sending a message did not restart an agent interrupted by a side question.
Why it happened: Message delivery was mistaken for task resumption.
Rule for next time: Check agent status after interruptions and use followup_task to resume work.
Example check: The agent is running before waiting for its next result.
