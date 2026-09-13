# SLM Agent Reliability 1.1 — Single-Release Execution Specification

> Execution instructions for agentic workers: use superpowers:executing-plans. This document replaces the earlier five-release plan in its entirety. Implement its work packages in order on one release branch. There is one production release, after every required gate passes. Internal commits and staging deployments are checkpoints, not independent product releases.

**Goal:** Make the existing four-agent installation dependable for authentication, capture, curation, retrieval, retries and erasure without changing its owners or invalidating its four working keys.

**Architecture:** Keep the Cloudflare Worker, D1, Vectorize, OAuthProvider, immutable entry-version service and action-proposal system. Add explicit MCP results, two small shared modules, one additive database migration and bounded batch capture. Fix shared functions instead of bypassing ownership or patching individual callers.

**Stack:** Existing TypeScript, Zod, MCP SDK/agents, Node.js 22 CI, Vitest, SQLite and Workerd. No new runtime dependency. No framework rewrite.

**Release version:** 1.1.0. During implementation update package.json, the root version in package-lock.json, and MCP server version together without upgrading dependencies. Do not publish a GitHub release or tag before deployment authorization.

**Status:** Specification only. No application code, production keys, roles or memory content changed while writing this document. Source baseline is local 9b20b20; fetched origin/main b9dffaf adds documentation only. Recheck this at execution start.

## 0. Copy this assignment to the execution model

> Implement SLM Agent Reliability 1.1 exactly as specified in docs/superpowers/plans/2026-09-13-agent-memory-reliability.md. Read the entire document and the project's AGENTS.md before editing. This is one production release. Work packages are implementation checkpoints, not permission to deploy partial functionality. Preserve the existing four credentials, account IDs, ownership, private history, and legacy MCP names. Follow the fixed decisions, contracts, file map, migration and test matrix. Do not invent alternate authentication, status models, permission rules, queues, tenancy, retry semantics or dependencies. Important snippets show invariants, not complete patches. Implement the surrounding integration yourself using the existing code. First record the baseline and requirement checklist; then complete each work package and its tests. Never weaken a test or privacy boundary to make a failure disappear. Record command exit codes and evidence. A missing external credential blocks only its dependent remote step; finish all independent local work. Ask the owner only for an actual access/authorization blocker or a documented contradiction, not for decisions already made here. Do not deploy until all release gates pass and the final concrete deployment has the owner's authorization. Deliver the tested branch, release evidence, and connection/runbook changes. Never print or commit live keys.

### Interpretation rules

- MUST and MUST NOT are mandatory. Numerical limits and error behavior are part of the contract.
- A work package is complete only when its named tests and observable acceptance checks pass. Producing files is not completion.
- Examples use synthetic IDs unless explicitly marked as diagnostic evidence. Never use a real diagnostic entry as a destructive test fixture.
- When adding an argument to an existing shared function, search every caller and update it deliberately. Optional defaults are specified below; do not guess them.
- Existing code is authority for behavior this specification does not change. This specification is authority for the requested changes. The old authentication prose in AGENTS.md must be corrected, not reintroduced.
- Do not ask the user to select implementation alternatives. All scope and product choices are fixed in Section 1. Stop only under Section 18.

## 1. Decisions already made

### 1.1 Release scope

Implement authentication repair, erasure repair, honest errors, whoami, structured memory results, correct exports/onboarding, source attribution, designated-reviewer proposals, status rationale, revision preconditions, tool profiles, batch/idempotent capture, browsing cursors, staging/load verification, operational monitoring, and client-isolation documentation/template validation in this one release.

Existing service-key retry defects are included because they share the new capture-receipt invariant. Do not leave a known delete-then-retry resurrection path behind.

Do NOT implement service-account migration, autonomous service review, shared-database tenancy, billing, client portals, a new general ACL engine, queueing, distributed locks, a new router, a new status system or an embedding-model change. Do NOT provision a real client's deployment without a real client request. The client-isolation deliverable is an exact runbook plus tested separate staging boundaries.

### 1.2 The four current identities

Jarvis stays an admin account. Researcher, engineer and clients stay member accounts. All four current personal keys remain accepted without re-export or rotation. Their user IDs and memory owners do not change.

These credentials authenticate account principals internally called `human`. That does NOT prove a human reviewed an action. New user-facing text says "account approval" and includes `human_presence_verified: false`; it must not claim autonomous Jarvis activity is human review. Do not rewrite historical actor-kind values or silently turn these accounts into services.

Existing service credentials remain supported with existing scopes/autonomy rules. Services can submit and execute permitted approved proposals, but cannot approve/reject. No new service review scope is added.

### 1.3 Ownership and review

Public current content is readable across accounts. Direct content/status mutations and raw history remain owner-only. Admin is not universal entry-edit permission.

Cross-owner curation uses owner-submitted action proposals. Add an optional designated reviewer selected by username and bound to its resolved immutable user ID. Researcher/engineer submissions intended for Jarvis use `reviewer_username: "jarvis"`. No new global Jarvis ACL or ownership transfer is introduced.

Old proposals and new proposals without a designated reviewer retain existing review behavior. They are explicitly described as legacy/unassigned. A designated proposal is visible only to its proposer, resolved subject owner and designated reviewer; generic admin/team visibility cannot override this rule. Only the designated reviewer may approve/reject it.

### 1.4 Status model

Keep both stored axes and the existing transition table. `lifecycle_status` is the legacy overwrite/retention marker; `epistemic_status` is confidence/review state. Do not auto-synchronize the axes or rewrite old rows. Protect epistemic canonical/qualified entries from automatic overwrite even if their legacy tag is absent or draft.

### 1.5 Capture and retries

Unkeyed personal `remember` retains existing deduplication/merge behavior. A capture with `idempotency_key`, including every batch item, is explicitly CREATE-ONLY: create a candidate, never auto-merge/replace/deprecate or suppress it based on semantic similarity. This avoids hidden multi-entry side effects on retry. This difference MUST be in the schema descriptions and guides.

Batch limit is fixed at 10 items and 131,072 bytes of serialized items JSON, superseding the old plan's provisional 20-item/256-KiB proposal. Every item needs its own retry key. Process sequentially; partial success is explicit.

Capture receipts and erased-key tombstones do not automatically expire. A replay must never recreate erased content. There is no generic retry middleware for writes.

### 1.6 Tool profiles and client isolation

Profiles are `capture`, `review`, `full`, selected by `X-SLM-Tool-Profile`. Omitted means full. They restrict the current connection's exposed/callable set; they are NOT a reduction in the underlying credential's privileges because the key holder can select full. Existing authorization remains mandatory.

The clients identity is an internal role only. Client isolation uses separate Worker deployments with separate D1, Vectorize, KV and keys. Tags and usernames are not tenant boundaries.

## 2. Evidence the implementer must not misinterpret

The feedback's example ID is a real researcher-owned public entries row in candidate state. Read-only live history succeeded as researcher and returned not-found as Jarvis. This proves the ownership distinction for history, not the original actor of every reported failed edit. Do not create a candidate-to-entry conversion table.

`collectEntryArtifactIds` has six top-level SELECT terms. Workerd configures a five-term compound SELECT limit. The exact SQL failed in an in-memory database with that limit and succeeded at five terms. This is query shape, not a 500-memory limit.

`rotateUserKey` generates a new public ID without changing users.id and hashes id.secret; the resolver looks up stable users.id and hashes secret. The working recovery key bypassed this defect; the function itself still needs repair.

The existing proposal executor already supports owner submission, review, execution, revision preconditions and reviewer/reason records. The new work makes those contracts visible, adds reviewer binding, and links direct status history correctly.

The existing service `history` tool already exists in src/mcp.ts and uses governedRead plus loadOwnedMcpHistory. Reuse it.

A previous full suite passed 1,124 tests in 106 files. A later targeted lifecycle run passed 54 tests in five files. These are historical baselines, not permission to skip testing this release. The existing SQL mocks and local SQLite defaults missed the Workerd query limit.

## 3. Repository, branch and file ownership

Working directory: projects/shared-living-memory. Never run build/deploy/Git commands from the Autonomous workspace root.

At execution start run `git remote -v`, `git status --short --branch`, `git fetch origin --prune`, and inspect the new diff. Create one branch named `slm-agent-reliability-1-1` from the verified GitHub main using an isolated worktree if this checkout has unrelated work. Preserve this document and task notes. Never stash, reset or discard someone else's changes. If branch already exists, inspect and resume it rather than replacing it.

Use Node 22 as in CI, `npm ci`, `npm test`, `npm run typecheck`, `npm run smoke:workerd`. There is no lint command. Generate worker-configuration.d.ts through Wrangler, never hand-edit it.

### File map

| Responsibility | Existing files to modify |
| --- | --- |
| Authentication, deployment metadata and profile transport | src/auth.ts, src/index.ts, src/api-handler.ts, src/config.ts, src/types.ts, wrangler.jsonc, package.json, package-lock.json |
| MCP contracts, tools, capture, pagination | src/mcp.ts, src/ingest.ts, src/operator-memory.ts, src/recall.ts, src/tags.ts, src/routes.ts |
| Atomic versions, status, review, erasure | src/entry-version-service.ts, src/lifecycle.ts, src/action-proposals.ts, src/erasure.ts, src/vector-cleanup.ts, src/deactivation.ts, src/db.ts, db/schema.sql |
| Setup/UI/docs | public/index.html, scripts/connect-ai-clients.sh, src/mcp-onboarding.ts, docs/mcp-onboarding.md, README.md, AGENTS.md, .agents/skills/shared-living-memory-mcp-knowledgebase/SKILL.md, docs/team-pilot/* |
| Release verification | .github/workflows/ci.yml, .github/workflows/pilot-canary.yml, scripts/smoke-workerd.sh, scripts/mcp-protocol-smoke.mjs, scripts/staging-semantic-canary.mjs, relevant existing tests |

New implementation files are limited to `src/mcp-results.ts` (common result/error shapes), `src/capture-receipts.ts` (receipt lookup/hash/commit descriptors), `scripts/export-mcp-connection.mjs`, `scripts/staging-agent-load.mjs`, `scripts/check-staging-bindings.mjs`, and scenario tests for those units. No new registry framework, generic transaction callbacks, or generalized permissions layer. If test helpers need sharing, extract the existing SQLite helper rather than introducing a new mocking framework.

Only create source files when executing this plan; this specification is not a source-code package.

## 4. Public MCP and REST contracts

### 4.1 Shared result envelope

New/modified MCP handlers return `structuredContent` and retained readable `content`. `src/mcp-results.ts` defines the shared envelope, safe domain-error mapping and serializer. Use object output schemas supported by the installed SDK. Keep existing text useful to clients negotiating 2024-11-05; do not require a new protocol version for basic operation.

```ts
type SlmResult<T> =
  | { ok: true; data: T; request_id: string; warnings: string[] }
  | { ok: false; error: {
      code: string; message: string; retryable: boolean;
      details?: Record<string, unknown>;
    }; request_id: string };
```

`request_id` is a server-generated UUID for this request. Never trust a client-selected actor ID or include a token in it. Successful no-results reads are ok:true with an empty array. Failed tools set `isError:true`; a string beginning "Error" is insufficient. In mixed batch results, the envelope is ok:true but each item carries its own outcome; do not set isError merely because some items failed.

For post-commit cleanup/audit failures return ok:true with a truthful committed state and warning. Do not tell a caller a write failed when it committed.

Do not rewrite every old REST JSON shape. Existing successful REST responses retain their fields. Add optional revision/reason inputs consistently; new batch and whoami REST endpoints use the shared envelope. `/list` compatibility is specified in Section 11.

### 4.2 Error table

| Code | Meaning / safe details | Retry |
| --- | --- | --- |
| invalid_request / invalid_cursor / invalid_profile | Invalid bounded input; identify field, never echo its content | false |
| invalid_credentials / forbidden / not_found_or_inaccessible / not_owner | Auth failure; hidden existence remains hidden; not_owner only for already-visible current entries | false |
| revision_conflict / invalid_transition / idempotency_conflict | Visible revision or valid next states only; no raw SQL, hashes or credentials | false until caller changes action |
| capture_erased / receipt_unavailable | Erased capture is terminal; missing committed target is never recaptured | false for erased; true for temporary receipt inconsistency |
| storage_unavailable / semantic_unavailable / rate_limited | Sanitized operational failure; return retry_after_ms only when known | true only under operation-specific retry rules |

Preserve specific capture validation codes: content_too_large, too_many_tags, tag_too_long, source_url_too_long, source_title_too_long, secret_detected. Tool error details contain field names/limits, not rejected strings.

HTTP rules: transport credential failure 401; invalid profile/envelope 400; authenticated forbidden action 403 on REST; stale revision/idempotency conflict 409 on REST; oversized input 413; unavailable dependency 503. MCP tool domain failures remain valid tool results with isError:true. Preserve JSON-RPC errors for malformed protocol requests and unknown/disallowed tool names as produced by the SDK; do not turn every failure into HTTP 200 JSON-RPC success.

External authentication errors remain deliberately generic. The server cannot know whether an unknown key came from another workspace. For personal-key MCP failures use a plain Bearer challenge and a safe message naming the deployment; retain standards-compliant OAuth behavior when MCP_OAUTH_ENABLED=true. Do not reimplement OAuthProvider token verification or perform a second independent authentication lookup to guess a failure reason.

### 4.3 Entry descriptor

Every capture/read descriptor has these named fields, never a bare ambiguous `id` alone:

```ts
{
  entry_id: string,
  revision: number,
  owner: { id: string, username: string },
  visibility: "private" | "public",
  lifecycle_status: "canonical" | "draft" | "deprecated" | null,
  epistemic_status: "candidate" | "reviewed" | "canonical" |
                    "qualified" | "stale" | "superseded" | "retracted",
  permissions: {
    read_current: boolean, read_history: boolean,
    mutate_directly: boolean, submit_change_proposal: boolean
  }
}
```

Calculate permissions using verified actor + owner + current policy, not role name alone. Service read_history is allowed only for the service owner's entry and current memory:read authorization. Proposal approval/execution permission is proposal-specific and must not be asserted as a blanket per-entry ability.

Capture includes the outcome, entry metadata and original receipt as fixed below when the operation produced or replayed a revision. A duplicate result identifies `matched_entry`, not a fabricated new entry. A replay identifies the original committed revision; it must not pretend that revision is the current entry state after later edits. The entry descriptor revision is the current authorized revision; the receipt revision is the original committed capture revision. If a current read fails after a confirmed commit, return entry:null and the committed receipt with a metadata_unavailable warning; do not turn the capture into a failure.

Ordinary legacy capture outcomes map explicitly: stored/flagged/contradiction candidate → created; merged → merged; replaced → replaced; blocked → duplicate. Preserve explanatory warnings for conflict drafts and similar public memories. Never expose another owner's private match.

### 4.4 Exact data objects by operation

Use these exact outer data fields; existing domain objects may gain only additive safe fields. Do not choose alternate names independently in each handler.

- remember: `{outcome, capture_mode, entry, receipt, matched_entry}`. outcome is created/merged/replaced/duplicate/replayed. capture_mode is smart/create_only. entry is an EntryDescriptor or null; receipt is null for duplicates/legacy outcomes lacking a committed descriptor, otherwise `{entry_id, episode_id, revision}` for the operation's commit. matched_entry is a visible EntryDescriptor for duplicate, otherwise null. Do not expose internal mutation IDs containing request hashes.
- remember_batch: `{items, summary}`. Each item has client_item_id, status, and either data with the remember shape or error with the common safe error fields. summary is `{created, replayed, failed}`. Envelope-invalid requests have no items result and write nothing.
- recall: `{matches, insight, semantic_available, retrieval_mode}`. Each match contains `{entry, content, score, hop, source, citations}` with the EntryDescriptor, current authorized text, existing score/hop semantics, sanitized source metadata and existing citation fields. insight is string or null; matches is empty on a valid no-result search. Do not introduce unsupported evidence links.
- list_recent: `{entries, next_cursor}`. Each list entry combines the EntryDescriptor with content, created_at and sanitized source. history: retain the existing bounded `{projection, episodes, snapshots, truncated, counts, guidance}` data object, adding status_change to authorized episode metadata. Direct mutations: `{entry_id, episode_id, revision, changed:true}` from the committed version result; add no fabricated IDs if an existing operation has no episode and use null explicitly.
- create/list/review/execute action proposals: preserve existing mapped proposal/result fields inside `{proposal}`, `{proposals}`, `{proposal}`, or `{execution}` respectively. Add audience and designated_reviewer to mapped proposals. Scope-aware filtering MUST happen before list limits, not after fetching the first N arbitrary proposals. whoami's fixed fields are defined in Section5.

The full-profile aliases return exactly the same structured envelope and error code as their canonical handler. All changed callers and tests use these names. Keep unchanged tools' legacy text; do not create unrelated data-contract rewrites.

### 4.5 Response bounds and history

New MCP and opt-in REST listing data is capped at131072 UTF-8 bytes. Each content excerpt is at most2048 UTF-8 bytes, cut at a complete Unicode code-point boundary, with content_truncated and original_content_bytes. If the page still exceeds the data budget, emit fewer rows and set next_cursor from the FINAL EMITTED row. Never advance past an omitted row. Legacy REST array output retains its old shape/content until the caller opts into paging.

Batch data is capped at32768 UTF-8 bytes. Successful descriptors contain no captured content or raw source strings; retain every item label, outcome, receipt handle and safe error. Human-readable text stays within the corresponding byte budget and uses summaries rather than duplicating full raw content. A preflight serializer/test must prove worst-case allowed metadata fits this bound; never silently omit a failed item to fit.


Keep the existing 4,096-byte serialized history-data budget and 50-episode/50-snapshot fetch bounds. Construct bounded structured history first, then render equivalent text. Include returned/total counts and truncated:true when applicable. Status rationale truncation must be explicit; raw history still requires ownership. Do not accidentally make structuredContent an unbounded copy of data omitted from text.

History includes permitted status_change metadata on each episode. Do not add cross-owner historical content access. Proposal reviewers see the proposal they are authorized to view, not an owner's entire history.

## 5. Identity, profile and source contracts

### 5.1 whoami

Add MCP `whoami` with an empty strict input object for both personal and service branches. Add authenticated REST GET `/api/whoami` with the same data. It is read-only except normal content-free audit telemetry. Reuse the verified actor resolution for REST whoami/batch instead of testing token prefixes as authority: personal/legacy credentials go through existing auth, service keys through resolveServiceCredential plus verifyServiceActor. Place the shared request-to-ActorContext helper in src/api-handler.ts (it already owns this composition) and export it for the new REST routes; src/mcp.ts must not import routes, so avoid introducing a cycle. MCP still uses OAuthProvider-authenticated props and revalidation, not client-injected props. A failed resolver returns the common401/503 boundary.

Return these exact data keys: principal:{id,name,kind}, credential_type, auth_method, owner (null for personal, {id,username} for service), role, scopes, capabilities, tool_profile, effective_tools, default_visibility, deployment and human_presence_verified:false. deployment contains {id,environment,canonical_url,release_id,write_mode}. effective_tools is sorted lexically. capabilities contains read_public, read_owner_private, direct_mutation_scope (owned_entries/private_drafts/none), proposal_review (account_policy/none), and erase_owned_entries. Compute broad account capabilities independently from request profile; effective_tools is the actual request subset. Per-target permissions still apply.

Propagate trusted authMethod:personal_api_key from resolveExternalToken into the verified ActorContext; verified legacy headers report legacy_user_headers, actual OAuth principals oauth_access_token, and verified services service_api_key. Derive credential_type from that trusted path, not token appearance or principal.kind. Do not label an OAuth access token a personal API key or run duplicate authentication just for whoami.

For personal credentials: principal.kind remains `human` to match stored actor type; credential_type is `personal_api_key`; role is verified admin/member; scopes is []; capabilities explain actual rights. User-facing labels say account principal. Service name comes from service_identities.name, not its owner username. Service credential_type is `service_api_key`; role:null, owner identifies its existing owner account. Return no key, key hash, prefix, credential secret, bootstrap token or other account's credentials.

New deployment vars: `SLM_DEPLOYMENT_ID`, `SLM_ENVIRONMENT`, `SLM_PUBLIC_BASE_URL`, `SLM_RELEASE_ID`, `SLM_WRITE_MODE`. Production values are `slm-fractals-production`, `production`, `https://memory.fractals-solutions.com`, exact release commit SHA, and `enabled`. Staging values are `slm-fractals-staging`, `staging`, its verified Worker URL, the candidate SHA and `enabled`. Test fixtures use `test` and a synthetic URL. No identity is inferred solely from the request Host header.

`/health` adds these nonsecret metadata fields without database queries. `/ready` preserves the database probe: return200 only for valid configuration, responsive D1 and write_mode=enabled; return503 with status maintenance_read_only in read-only mode, or not_ready for configuration/storage failure. Read tools remain usable in maintenance even though readiness is503. Missing required deployment metadata fails readiness after this release; liveness can still report configuration_error without secrets.

### 5.2 Exact profiles

Read `X-SLM-Tool-Profile` in api-handler before server construction; missing → full; exact lowercase capture/review/full only; empty/other value → invalid_profile. Include the header in the CORS allowlist. Export it persistently in client config for reduced profiles.

Personal capture profile, exactly 10 tools: whoami, remember, remember_batch, recall, list_recent, passages, history, connections, create_action_proposal, list_action_proposals.

Personal review profile, exactly 16 tools: all capture tools plus append, update, set_status, set_epistemic_status, review_action_proposal, execute_approved_action.

Personal full profile: existing 24 tools plus whoami, remember_batch, list_edge_proposals, approve_edge_proposal, reject_edge_proposal, totaling 29. The new edge names call the same handlers as list-proposals, approve-proposal, reject-proposal. Old names remain only in full. Do not collapse edge proposals and action proposals or change either payload to the other's format.

For services, intersect profile names with the existing service implementations and currently authorized scope/autonomy operations. Do not add personal-only capabilities. Service history already exists. whoami is available to every valid principal; invalid/revoked service credentials fail before tool discovery.

Registration must exclude profile-disallowed tools so tools/list and tools/call agree. Do not access SDK private fields. Keep stable lexical tools/list ordering; aliases never duplicate backend logic. Unknown tool calls do not execute a hidden handler. A key may choose another profile on a separately configured connection; therefore profiles are labeled convenience subsets, not restricted keys. Server authorization remains enforced on every tool invocation.

Recommended new exports: Jarvis=review, researcher=capture, engineer=capture, clients=capture. Old exports with no profile remain full and work. Do not silently resend, rotate or overwrite their credential files during implementation.

### 5.3 Source attribution

Explicit valid source labels are preserved as declared provenance. If omitted, personal MCP capture defaults to `mcp:<verified username>`, personal REST capture to `api:<verified username>`, and service capture on either transport to `operator:<verified service name>`. Source is not proof of actor identity. Structured results distinguish declared source from verified owner and actor.

Hash the explicit source declaration or stable actor-default marker as specified in Section8, and persist the initially resolved label. Replay returns that original capture provenance; transport changes or later display-name changes do not rewrite it. Keep original raw source for existing records; no speculative historical relabeling. Render all labels using existing output sanitizers/text-safe UI paths. Test personal and service defaults and explicit source_url/source_title.

## 6. Authentication repair and connection export

### 6.1 Personal rotation invariant

Rotate only the secret; preserve stable users.id and ownership. Reuse generateApiKey for random secret material, and the existing HMAC function and pepper compatibility rules.

```ts
const { secret } = generateApiKey();
const fullKey = `slm_${operatorUserId}.${secret}`;
const keyHash = await hmacKey(secret, AUTH_PEPPER);
```

Keep user update and security event atomic. Reject inactive/deactivating targets with the documented existing route failure semantics consistently; for this release rotation requires status=active, aligning it with authentication. Do not create an unusable new key for a deactivating account. An admin may rotate another active user; members may rotate only themselves. Old key fails immediately, new key works with both `/api/me` and MCP initialize/tools/list.

No forced production rotation is part of this release. Never retrieve or display stored hashes as if they were usable keys.

### 6.2 Export and docs

Canonical export contains standard mcpServers configuration plus nonsecret SLM metadata identifying username, principal_id, deployment_id and canonical URL. MCP headers contain `Authorization: Bearer <key>` and, if selected, X-SLM-Tool-Profile. No workspace bootstrap key or redundant username header in the default personal/service config.

`scripts/export-mcp-connection.mjs` accepts `--url`, `--profile`, `--out`, and either `--key-file` or secret stdin. Reject both secret sources together. Never accept a key in argv. Validate absolute HTTPS URL, no URL userinfo, no query/fragment, and trim trailing slash. Allow HTTP only for literal localhost/127.0.0.1/::1 with an explicit `--local` flag. Preserve a verified base-path prefix if supplied; append `/mcp` once, not twice. Disable cross-origin redirect following before sending any Authorization header.

Before writing, authenticate whoami and verify configured profile and principal. Construct metadata from the response. Create an owner-only parent directory if it is newly made; do not chmod a user's existing Downloads directory. Open the output with exclusive create, mode 0600; reject symlink/existing-file replacement. Verify resulting mode on POSIX. Report output path and identity, never print key or full config. Do not add an overwrite flag in this release.

Dashboard: show personal-key login and canonical MCP setup; clearly distinguish first-admin bootstrap. Offer the correct JSON download, but state that browser downloads cannot guarantee Unix permissions and link the secure CLI method. Download only on user action; show key once and clear transient display state when dismissed. Do not print live secrets in devtools or telemetry.

Update README, AGENTS, MCP resource, guide, project agent skill, and client setup script together. Personal Bearer is default; legacy workspace+user-header compatibility remains tested and labeled legacy. OAuth-disabled routes say that OAuth issuance is disabled and personal keys are accepted; invalid keys receive a generic safe deployment-specific next step.

## 7. Lifecycle, status rationale and reviewer binding

### 7.1 Retain exact state transitions

The allowed epistemic transitions remain:

```text
candidate  -> reviewed
reviewed   -> canonical
canonical  -> qualified, superseded
qualified  -> canonical, superseded
stale      -> reviewed, retracted
superseded -> retracted
retracted  -> no transitions
```

This table governs requested account/service transitions. Nightly maintenance has one explicit exception: candidate/reviewed/canonical/qualified → stale. Restrict every staleness candidate query AND its final guarded write to those four states; legacy-deprecated entries are also excluded. Never convert superseded/retracted back to stale. Record system actor _staleness and the existing detector reason.

Do not add a candidate→canonical shortcut or undocumented retraction paths. Return `invalid_transition` with allowed_next_states for an owned/authorized visible target. Legacy lifecycle values remain canonical/draft/deprecated. For old rows without a lifecycle tag return lifecycle_status:null, not a fabricated draft.

Normal recall excludes legacy deprecated OR epistemic superseded/retracted through the existing shared eligibility gate. Do not invent a different graph/keyword/vector rule. Owner history/export remain available until explicit erasure.

Centralize automatic overwrite protection in src/tags.ts:

```ts
importance >= 4 || getStatus(tags) === "canonical" ||
  epistemicStatus === "canonical" || epistemicStatus === "qualified"
```

Apply to every automatic replacement/merge caller and associated protected-conflict labels. Include epistemic_status in the relevant source queries. Explicit authorized versioned correction is still possible; a legacy draft tag cannot remove epistemic canonical protection. Do not mark all historical entries canonical as a shortcut.

### 7.2 Reasons and revisions

Add optional `expected_revision` to personal append, update, set_status and set_epistemic_status and corresponding REST inputs. It is an integer ≥0. Supplied value is checked before expensive generation and still guarded in the final D1 commit. Omitted preserves existing behavior with the internal compare-and-swap guard. Do not silently retry stale full-content replacement.

Add optional `reason` to both direct status tools/REST. If supplied: trim, require 1–2,000 Unicode code points, reject high-confidence secrets through the existing detector. Omitted remains null for legacy compatibility; neither the server nor a profile fabricates a reason. New docs/UI always request a reason. The new dashboard status form requires its reason field before enabling submit; all MCP profiles and legacy REST inputs retain identical optional-reason backend validation.

### 7.3 Atomic status metadata

Add nullable `episodes.status_change_json TEXT` and include it in the existing guarded version commit, not a separate asynchronous audit write. Use this exact schema for new status mutations:

```ts
{
  version: 1,
  axis: "lifecycle" | "epistemic",
  from: string | null,
  to: string,
  reason: string | null,
  reason_status: "provided" | "not_provided",
  actor: { kind: "human" | "service" | "system", id: string },
  reviewer: { kind: "human", id: string } | null,
  proposal_id: string | null,
  revision: number,
  recorded_at: number
}
```

Add an explicit optional statusChange input to CommitEntryVersionInput, containing only axis, reason, actor, reviewer and proposal ID supplied by trusted server handlers. Derive from/to, next revision and timestamp in the version service using loaded/current and proposed state. Direct status uses verified actor, reviewer:null (no independent review). Proposal status uses actual executor as actor and stored approving account as reviewer; its reason is the stored review_reason. The submission rationale remains linked through proposal_id. No request may submit arbitrary actor/reviewer metadata.

An explicit statusChange axis must match the field being assigned. Legacy lifecycle reassertion allows from===to and keeps a new revision; epistemic self-transitions remain invalid. Kind-tag-only classification with kind:status changes neither axis and stores status_change_json:null. Every actual axis change, including maintenance, integration archival, classification/backfill and pattern review, supplies trusted actor metadata; never infer the actual actor from entry ownership. Fixed system actor IDs are _staleness, _classification, _compression, _pattern_derivation and _integration_sync for those respective jobs. Do not create login users for these names. Manual explicit owner status/pattern-review actions use the authenticated account; automatic classifier work uses _classification even when a human initiated its batch. Actor metadata is not a substitute for existing owner/policy authorization.

`/patterns/resolve` confirmation changes only legacy lifecycle status to canonical and preserves epistemic_status. It records a lifecycle event. Confidence promotion follows the explicit transitions; pattern confirmation must not silently promote the second axis.

Insert status metadata in the same D1 batch as episode, snapshot and projection update. A CAS conflict or failed metadata insert leaves none of those changes. Old null metadata stays unknown. Newly submitted proposal and review reasons use the same trimmed1–2000-code-point and secret-detection rules. Existing persisted legacy reasons are not retroactively rejected on execution; preserve their permissioned meaning and apply explicit output bounds. reason_status is derived from null versus present reason. The metadata is permissioned memory-domain content, not safe to log as a free-form string. Erasure of the episode removes it; export includes it only within existing authorized content scope.

### 7.4 Named-reviewer proposal contract

Add optional `reviewer_username` to create_action_proposal and its REST equivalent. Validate the existing username grammar and length 1–32, normalize case once, resolve an active personal account once. Store its immutable ID as authoritative `payload_json.reviewerUserId` BEFORE calculating payload_hash/idempotency identity. No new reviewer table or schema column. Reject caller-supplied payload.reviewerUserId; the top-level username is the only public input channel.

If the selected reviewer cannot be resolved, return invalid_request with "Reviewer must be an active account"; do not provide an unauthenticated directory. For designated proposals, selecting the proposer/subject owner as reviewer is rejected: this path requires a separate reviewing account. Omission preserves legacy unassigned/self-review behavior; make that distinction explicit in audience metadata.

Bound proposal audience is proposer, subject owner, designated reviewer. Apply this before generic admin/team logic in get/list/review/execute and request replay; other users see not_found_or_inaccessible. Only the bound reviewer may approve/reject, and it must still be active before a new effect. A proposer or subject owner may execute after approval only when the existing execution policy/scopes permit it. Never grant a service approval rights.

Private-entry proposals still cannot be team-visible. Explicitly binding a private proposal shares that proposal's authorized payload with the named reviewer; it does not publish the entry or grant raw history. Show `audience.mode: designated` and viewer IDs/names already authorized, not misleading "entire team" text. New examples in this release use public researcher/engineer submissions to Jarvis.

Binding and payload hash are immutable after creation. Reject an attempt to reuse the same proposal idempotency key with a changed reviewer. Recheck binding, active reviewer and target preconditions before NEW mutation. Already-executed results remain replayable to currently authorized viewers even if reviewer later deactivates; do not execute again or erase the completed audit record.

### 7.5 Exact curation sequence

1. Researcher creates a public candidate and obtains entry_id E/revision R from structured data.
2. Researcher calls create_action_proposal with action_type `entry.epistemic-status.set`, payload_json encoding `{entryId:E,status:"reviewed"}`, target_ids:[E], expected_revision:R, reviewer_username:"jarvis", visibility_scope:"team", nonempty reason and unique idempotency_key.
3. Jarvis lists only proposals it may see, checks supplied evidence, approves/rejects with a reason, then explicitly executes the approved action. Ownership remains researcher.
4. To make it canonical, researcher submits a second proposal at the newly returned revision with status:"canonical"; Jarvis repeats review/execution. No direct cross-owner mutation is granted.
5. Changed owner/revision/visibility or expiry invalidates a pending action. Before a new effect require target owner and designated reviewer active; service-originated proposals also require active proposing service and owner. Revalidate executor credential/scopes. Rotation of the original submitting credential alone does not invalidate its proposal. Return the existing stale/expired state through the common error mapper. Do not refresh preconditions automatically on the agent's behalf.

## 8. Keyed capture and batch contract

### 8.1 Input and mode selection

Personal remember gains optional idempotency_key. Services retain the existing parameter but use the repaired receipt behavior. Unkeyed personal capture keeps its legacy flow. Keyed personal capture and every batch item use a shared create-only candidate path, with personal requested visibility preserved. Service capture always remains private + legacy draft + epistemic candidate under current policy. An explicit service public request is rejected, not silently granted.

Create-only mode performs shared input/secret validation, hashtag normalization, provenance resolution, embeddings and one immutable capture commit. It does NOT call automatic merge, replacement, contradiction deprecation or duplicate suppression. Different keys may intentionally create similar memories. Same key is the retry identity, not semantic deduplication. Do not call captureEntry's smart-merge path and merely cache its output afterward.

Raw content must contain non-whitespace text. Keep exact raw input in the episode and existing normalized materialization behavior in the projection. Source/URL/title sanitization and evidence creation must match the ordinary capture path. No LLM-based content merge or second memory mutation is hidden inside a keyed call.

### 8.2 Batch schema and validation order

Add MCP remember_batch and authenticated REST POST `/capture/batch`. Use the same application handler. Batch params are an object containing only `items`; items is an ordered array of 1–10 objects:

```ts
{
  client_item_id: string,        // 1–64 Unicode code points, unique within batch
  idempotency_key: string,       // trimmed, 1–240 Unicode code points
  content: string,
  tags?: string[],
  source?: string,
  source_url?: string,
  source_title?: string,
  visibility?: "private" | "public"
}
```

Before ANY item write: authenticate/authorize; validate outer shape, count, object keys/types, unique client_item_id, unique trimmed idempotency keys, and `TextEncoder().encode(JSON.stringify(items)).byteLength <= 131072`. Use submitted items JSON, including keys and field overhead, for that bound. Limit the serialized batch request body to 262144 bytes while reading it; do not fully buffer an arbitrarily large body first. Tests include chunked bodies and multibyte characters.

Envelope/type/key/count/aggregate-size failures reject the entire request with zero writes. Content-specific validation runs per item, returns an item failure and proceeds to later items. Shared per-item bounds are 32768 UTF-8 bytes across existing payload strings, maximum 25 tags, 64 Unicode code points/tag, source URL 2048 code points, source title 512 code points. Check secret detector on every accepted content/source/tag field for personal and service capture; the current service helper bypasses this and must be fixed.

Process items sequentially in input order. Revalidate service activity/scopes before each effect, so revocation during a batch stops later item effects. Do not run Promise.all over captures or dispatch background writes after returning success. A transient item failure does not cause an unkeyed automatic retry inside the server.

### 8.3 Batch result

Return all item outcomes in original order, including client_item_id, `status: created|replayed|failed`, and the original receipt/entry descriptor or safe error envelope. Summary counts created, replayed and failed sum to items.length. A valid batch with all item failures is still a processed batch with explicit failed items; it is not reported as stored successfully in text.

Clients may retry the full batch with identical per-item keys or retry only failed items. Reordering items does not change identity. client_item_id is a presentation label and not part of request hashing. Reusing a key via single remember finds the same receipt as via batch. Changed content under the same key returns idempotency_conflict. No batch-wide atomicity is promised.

### 8.4 Receipt storage, hashing and permanent erasure

Create ONE table in schema and the next runtime migration:

```text
capture_receipts
  actor_kind TEXT NOT NULL CHECK IN ('human','service')
  actor_id TEXT NOT NULL
  key_hash TEXT NOT NULL
  request_hash TEXT NULL
  entry_id TEXT NOT NULL
  episode_id TEXT NULL
  mutation_id TEXT NULL
  revision INTEGER NULL
  state TEXT NOT NULL CHECK IN ('committed','erased')
  created_at INTEGER NOT NULL
  erased_at INTEGER NULL
  PRIMARY KEY(actor_kind, actor_id, key_hash)
  INDEX(entry_id)
```

No cascading foreign key to entries: tombstones must survive deletion. Store no raw retry key, content, source label, tags, cached response, credential or free-form reason. Retain the original entry ID only as erasure metadata, matching existing erasure receipts. `erased` state clears request_hash, episode_id, mutation_id and revision. Retain actor namespace/key digest/entry ID/timestamps. No expiry, vacuum job, or reuse of erased keys in this release.

Use existing sha256Hex and stableJson. Key namespace is authenticated actor.kind + stable actor.actorId, never credential ID or caller-supplied user ID. key_hash hashes the trimmed key; composite primary key supplies the namespace. Credential rotation therefore preserves retry identity.

request_hash covers normalized write meaning: exact raw content, deduplicated/sorted normalized tags, source declaration (explicit value or actor-default marker), source URL/title or null, effective visibility, content type and mode:create-only. Exclude client_item_id, timestamps, request ID and generated artifact IDs. Expand service forced-private/draft rules before hashing. The default-source marker identifies actor-default semantics rather than a mutable display name, so account/service renaming cannot change a prior retry's meaning. Store the originally resolved source on the first capture and never rewrite it on replay.

### 8.5 Receipt algorithm and concurrent/ambiguous completion

`src/capture-receipts.ts` owns normalization, receipt lookup and descriptors. Add a specific optional captureReceipt input to commitEntryVersion; do not introduce generic transaction hooks.

1. Authorize first. Load receipt by actor namespace/key digest. Erased state returns capture_erased BEFORE comparing payload hash. It never creates anything. Same committed hash returns ORIGINAL IDs/revision even after later edits. Different hash conflicts. A committed receipt whose entry is absent never falls through to capture; return receipt_unavailable and flag reconciliation.
2. With no receipt, generate fresh entry/episode IDs and stage episode-scoped vectors as the version service already does. Stage receipt metadata alongside the intended entry commit.
3. Insert the unique receipt in the SAME transactional D1 batch as entry, episode, documents, passages and projection. A unique-key race must roll back the losing batch. Do not write a success receipt before its entry exists, or write it after commit as a separate operation.
4. On batch failure, read the receipt and authoritative attempted episode before deleting any staged vectors. If the receipt belongs to this completed attempt, report committed/replayed success. If another attempt won, return its same-hash receipt or a conflict and clean only the losing attempt's unreferenced vectors. Never delete a winner's vectors.
5. If D1 is unreachable and completion cannot be determined, return a retryable storage_unavailable with commit_state:unknown and guidance to retry the SAME key. Do not claim rollback or delete possibly committed vectors. Durable stage intent defined below is the recovery authority; console logs alone are not sufficient. Once D1 is available, reconcile against receipt/episode before cleanup. Do not broaden this into automatic non-idempotent replay.

Every receipt lookup, including insert-race/error/legacy-backfill recovery, applies erased-state precedence before hash comparison. Read receipt and authorized current projection consistently in one query/snapshot. Erasure committed before that read returns capture_erased; erasure afterward may linearize after a read-only replay. No replay has a creation side effect.

### 8.5a Durable stage intent and cleanup fencing

Reuse vector_cleanup_queue with additive columns: kind TEXT NOT NULL DEFAULT 'delete' (delete|capture_stage), stage_entry_id TEXT NULL, stage_episode_id TEXT NULL, lease_expires_at INTEGER NULL, claim_token TEXT NULL. Its existing id is the unique attempt ID; vector_ids lists this attempt's planned IDs. Existing delete jobs retain current behavior. Capture-stage jobs MUST NOT enter the unconditional delete branch.

Before the first vector upsert, persist a capture_stage row with planned IDs and a600000ms lease. If that insert fails, perform no remote upsert. Use database time for lease comparisons. Check the fence before each upsert and before commit. The capture transaction may commit only while that exact intent exists, is unclaimed and unexpired; it inserts the receipt and all authority/artifacts and removes the intent atomically. Guard all fresh artifact inserts on successful receipt ownership for this attempt, so a failed fence cannot leave partial rows. Inspect affected-row counts; zero is a retryable abandoned attempt, not success.

The repair worker selects expired capture_stage intents, atomically sets claim_token if unclaimed, and then checks attempted episode/receipt. Claiming permanently fences the original attempt from committing. Confirmed committed vectors are preserved; confirmed abandoned vectors are deleted; unavailable D1 defers the job. A crash after claim leaves the claimed row retryable by a later repair pass; deletion is idempotent. A capture attempt that completes an in-flight vector operation after discovering a lost fence must retain/re-enqueue cleanup for those IDs and never commit. Do not remove an intent merely because its lease expired; remove it only after confirmed safe cleanup or confirmed committed authority.

For already-claimed rows the repair worker repeats the authoritative check before every remote deletion attempt. Do not use local in-memory timers as the only cleanup record. Extend C2 with Worker termination after staging, commit-versus-repair races, late upsert completion, and recovery-worker crash after claim. This is a specific guard for capture staging, not a general lease/queue framework.

Extend the existing vector-cleanup mechanism for known uncommitted staged IDs after D1 recovery; an unreachable cleanup queue is reported as pending operational cleanup, never as successful cleanup. Read paths must continue checking D1 authority so an uncommitted vector cannot expose a memory.

### 8.6 Legacy service captures and account lifecycle

Old service keys derive `opdraft:` IDs without receipts. A new lookup for a service key with no receipt MUST first compute the old deterministic ID and inspect original capture episode provenance, not the current episode. Compute the old fingerprint with the exact old normalization (including order-preserving tags); for omitted source use source recorded on the original capture episode, not a renamed principal’s current label. Compare only this old fingerprint with the old mutation ID. After it matches, backfill a NEW-format request hash. Never compare the new normalized hash directly with an old mutation ID. Until first backfill, old order-sensitive tag semantics remain; document/test this legacy exception. A later edit must not make the original capture unrecognizable.

If old erasure_receipts contains that entry ID, create/read an erased capture tombstone and return capture_erased. If a matching original capture exists, backfill its committed receipt guarded on the entry still existing; a concurrent erase wins as erased. If the original hash differs, conflict. If neither legacy capture nor erasure evidence exists, use the new capture path. Never backfill receipt hashes by guessing unavailable raw user input.

Erasure and receipt backfill must be ordered atomically: include guards for entry existence and existing erasure receipt in the insert and inspect changed-row results. Test concurrent legacy replay/erase. Do not create a new entry if a legacy erasure guard lost a race.

Account deactivation denies new/replayed operations through auth before receipt lookup. Its private purge tombstones corresponding captures using shared erasure. Preserve metadata-only tombstones while the account record exists; no new account-deletion policy is invented here.

## 9. Erasure and database transaction rules

### 9.1 The six-term fix

In collectEntryArtifactIds remove only the first SELECT of the already-known entry ID and its first binding. Keep five child queries. Return `new Set([entryId, ...results.map(row => row.id)])`. Check caller semantics for nonexistent entry IDs; entry ownership/existence still comes from the existing erasure authority checks, not this helper.

Fix once in src/erasure.ts. Verify MCP forget, REST forget, legacy forgetEntry, integration mirror removal and deactivation private purge. Do not weaken confirmation or catch the SQL error and pretend deletion succeeded.

### 9.2 New artifact participation

In the SAME D1 deletion batch, tombstone all capture_receipts matching entry_id and clear their nullable non-tombstone fields. Deleting episodes removes status_change_json. Existing proposal scrub/deletion must cover designated-reviewer payload metadata consistently with other proposal metadata. Keep metadata-only erasure receipts and cleanup jobs.

Treat artifacts added by this release as part of export/offboarding/recovery checks. Do not expose request hashes in ordinary account exports or MCP results; receipts are operational identifiers, not new memory content.

### 9.3 Truthful completion

Existing erasure outcomes remain complete, pending_cleanup, not_found. After a successful content deletion, failed vector deletion reports committed with cleanup pending; after a successful mutation but failed audit finalization, report committed with reconciliation pending. The tool must not recommend retrying the content deletion. Before-commit failures return a sanitized tool error with a correlation ID.

No raw database exception is sent to the caller. Logs receive code, operation, candidate IDs and request ID only. Do not log memory text or raw reason fields under an error object.

## 10. Migration and compatibility manifest

The new result/helper interfaces must use these fixed responsibilities: mcp-results exports the shared envelope builder/error mapper; capture-receipts exports normalized-key/request hashing, authorized receipt lookup and a typed commit descriptor. The commit descriptor carries actor kind/ID, key_hash, request_hash and capture-attempt ID; generated entry/episode/revision values are supplied inside commitEntryVersion, not accepted from clients. Keep generation and transaction ownership in the existing version service. Callers may not construct a success receipt after it returns.

Add one ordered migration following version 15 in src/db.ts, plus matching declarations in db/schema.sql. At this source baseline it is version 16. If another migration was added before execution, append at the next version without modifying an existing applied migration; record the final number in release evidence.

This migration adds episodes.status_change_json, capture_receipts and its index, the five capture-stage columns on vector_cleanup_queue described in Section8.5a, and the `(created_at DESC,id DESC)` entry-list index if an equivalent does not already exist. Add CHECK constraints for allowed receipt/queue states; stage rows require their entry ID, episode ID and lease. Old queue rows default to kind=delete and keep nullable stage fields. Update vector-cleanup.ts queries so future unclaimed stage leases cannot starve due deletion work or enter unconditional deletion. Use the existing column-aware migration helper so repeated startup and concurrent initializers are safe. Update schema validation probes and migration tests. New status metadata defaults NULL; receipts start empty and legacy service backfill is on demand. No mass write to old content, tags, timestamps, ownership or credentials.

Commit version safety: receipt insertion/status metadata and authoritative mutation share the same guarded batch. Exercise before-batch race injection and simulated failure at receipt/status insertion. Zero changed projections must not leave an orphan committed receipt or status episode. Respect D1's existing 100-bound-parameter batching and Workerd's five-term compound SELECT limit.

Existing APIs remain compatible: default MCP profile full; all old names accepted in full; existing personal keys unchanged; unkeyed capture behavior retained; omitted expected_revision/reason accepted; old proposal behavior retained when no reviewer binding; legacy REST `/list` array preserved. New fields are additive, but failures now correctly set isError.

Compatibility does NOT mean rolling back blindly to a pre-receipt writer. The old writer cannot maintain erased-key tombstones. The recovery rule in Section 16 explicitly prohibits that unsafe rollback.

## 11. Stable browsing and ranked recall

Implement cursor helpers alongside buildEntryFilterQuery in src/tags.ts, reusing the /activity base64url convention without changing /activity's existing cursor format.

New cursor payload:

```ts
{
  v: 1,
  last_created_at: number,
  last_id: string,
  context_hash: string
}
```

last_created_at is a nonnegative safe integer; last_id length 1–200; encoded token maximum 2048 characters; context_hash is SHA-256 hex. Reject malformed base64/JSON, extra keys, wrong types/version/length or mismatched context with invalid_cursor. Do not silently fall back to page one.

Context hash covers authenticated actor kind/ID, resolved owner account, and normalized tag/after/before/user/visibility filters. Exclude page size so callers may change it within limits. Normalize absent/empty tag to null, nonempty tag with existing lowercase tag semantics, timestamps to nonnegative safe integer milliseconds; reject after>before. REST user/visibility filters retain their existing meaning and are included in the hash. A cursor is a navigation token, not proof of authorization; no signing secret is needed because all query authority is re-evaluated.

Use `ORDER BY created_at DESC, id DESC` and strict boundary:

```sql
created_at < ? OR (created_at = ? AND id < ?)
```

Apply parentheses with all other conditions, reuse bound parameters, fetch n+1, emit n, and emit next_cursor only if an extra row exists. Keep n=10 default, range1–50, and existing inclusive after/before filters. Newer inserted rows do not shift already-read positions. This is NOT a frozen snapshot: deletion and visibility changes affect later pages. Recheck auth/scope/visibility every page, including after revocation.

MCP list_recent returns structured `{entries,next_cursor}` plus readable text. REST `/list` without page/cursor retains its array; `page=true` on first page or any cursor opts into `{entries,next_cursor}`. Reject invalid page values. Do not change unrelated consumers without checking them.

Recall remains ranked top-k, default5, range1–20, hops0–3. Add optional include_insight:boolean default true to MCP recall and corresponding REST query parameter (exact true/false strings only); pass skipInsight:!include_insight to recallEntries. This exposes the existing raw-retrieval path without internal benchmark-only APIs. Do not add offset or cursor pagination to semantic rankings. Structured results explicitly identify semantic_available and retrieval_mode `hybrid|keyword_fallback`; no-results success is distinct from dependency failure. When keyword fallback is returned, explain fallback without claiming all failures mean a missing index. Preserve citations, graph authorization and status eligibility.

## 12. Dashboard and documentation deliverables

Dashboard tasks: correct personal login/bootstrap copy, show canonical connection URL/profile, whoami identity/deployment, source default, status axes and valid next transitions, revision conflicts, reason input on status controls, named reviewer field on existing proposal UI, and explicit effective proposal audience. If a proposal has no existing dashboard editing surface, document the MCP recipe rather than build a new full proposal application. Do not add a new frontend framework or rewrite the dashboard.

Every added form control needs a visible label, keyboard access and error text tied to the control. Render untrusted source/reason text through textContent or existing escaping; never inject raw HTML. Do not show private history to solve a reviewer usability complaint.

Update README, AGENTS, MCP resource markdown, project agent skill and all participant/operator guides to agree on URL/auth, ID types, two status axes, profile limits, batch mode, retry keys, erased behavior, pagination and source semantics. One source string/module owns in-product onboarding content; test the generated/static counterpart for drift instead of maintaining contradictory examples.

Participant recipe MUST include owner capture, structured ID/revision, owner history, named-reviewer submission, approval/execution, new revision, explicit deprecation/supersession distinction and permanent-delete confirmation. Explain that new bindings restrict audience whereas unassigned legacy team proposals retain broader review behavior.

Scorecard changes: historical roadmap tasks must be marked implemented only with matching code/tests; distinguish proposed features from delivered ones. Finite release regression gates are separate from ongoing adoption metrics. Remove conflicting current targets while preserving historical docs as dated history.

New evidence document at implementation time: `docs/team-pilot/releases/agent-reliability-1-1.md`. It records commit SHA, migration version, test commands/statuses, staging and production version IDs, binding safety proof, profile inventories, functional results, load metrics, unresolved operational cleanup, and recovery version. It contains no credentials or user memory bodies.

## 13. Staging isolation and client boundary contract

Use an explicitly configured staging Worker, `shared-living-memory-staging`, and distinct resource names: `shared-living-memory-staging-db`, `shared-living-memory-staging-vectors`, and a separate OAuth KV namespace. IDs are discovered/created through authenticated Cloudflare tooling and recorded in staging configuration; do not invent IDs or copy production IDs. Existing production binding IDs in wrangler.jsonc are the denylist baseline.

Configure a Wrangler staging environment with explicit D1/Vectorize/KV/vars/assets binding declarations; do not rely on environment inheritance for sensitive resources. Set required Vectorize metadata indexes as documented by the project. Staging has its own bootstrap and temporary account keys.

`scripts/check-staging-bindings.mjs` must compare the effective local configuration AND the deployed staging version's control-plane binding metadata with production. Reject any shared D1 ID, KV namespace ID, Vectorize index name/account pair, production script name, or production deployment ID. Require environment=staging and matching expected stage origin/deployment ID from an authenticated whoami response. Missing/unknown fields fail closed. A healthy `/ready` or hostname substring is not sufficient proof.

Destructive/load scripts require explicit `SLM_URL`, `SLM_EXPECTED_DEPLOYMENT_ID`, protected `SLM_KEY_FILE`, and a passing binding preflight. Parse URL exactly; no embedded credentials, fragments or cross-origin redirects. Refuse both known production origins and any origin not matching the verified manifest before the first write. Support JSON and SSE MCP responses; assert HTTP status, JSON-RPC error and tool isError separately. Do not use regex extraction of memory IDs from prose once structured results exist.

For client-isolation acceptance, use two isolated local/staging fixture installations representing Client A and B. Prove A's key cannot authenticate to B and that no graph/vector/proposal/export/history path crosses bindings. Do not provision actual clients or import confidential data as a test.

The client onboarding runbook requires separate Worker/D1/Vectorize/KV/bootstrap/agent keys for each real client. Fractals staff use explicit separate connections. No cross-client aggregation or automatic public sharing. The shared clients account remains an internal placeholder role, not a client security boundary.

## 14. Functional acceptance matrix

These scenario IDs are mandatory. Extend existing scenario files where appropriate; do not create one trivial file per assertion. Each scenario must exercise behavior, not search source strings. Failed scenarios block the single release.

### Authentication and transport (A)

- A1 Create account → rotate self → old key fails → new key passes /api/me and MCP initialize/tools/list; ID and owners unchanged. Admin rotation of another active account also passes.
- A2 Inactive/deactivating target cannot rotate/authenticate; member cannot rotate another account; malformed/foreign/old key errors contain no key/hash/user-existence leak.
- A3 Existing personal and legacy-header connections remain accepted; workspace bootstrap key alone remains insufficient for user memory; existing service scopes/revocation still enforced.
- A4 Missing profile yields personal full29; capture10/review16 exact lists; invalid header fails400; selected-profile hidden tool cannot dispatch; registered aliases share identical behavior.
- A5 whoami identity/owner/scope/profile/deployment fields agree with authenticated storage for all four synthetic names and a service actor; human_presence_verified is false; no secret fields appear.

### Ownership, review and state (G)

- G1 Researcher remembers E → same-owner history/append/update works; Jarvis reads current public E but receives actionable not_owner for direct edits/history. Private E and nonexistent E remain indistinguishable to Jarvis.
- G2 Researcher submits reviewed proposal bound to Jarvis → engineer and unrelated admin cannot list/review/execute it; Jarvis approves with reason and executes; owner remains researcher; actual actor/reviewer recorded. Repeat at new revision for canonical.
- G3 Legacy unbound proposals keep previous behavior; caller injection of reviewerUserId, self designation, inactive reviewer and changed reviewer under reused proposal key are rejected.
- G4 Revocation/target revision/visibility changes before new effect stop execution; replay of a completed proposal never repeats mutation, including after reviewer deactivation when caller remains authorized.
- G5 State table rejects candidate→canonical and every invalid transition; nightly staleness never revives terminal/deprecated entries and pattern confirmation never silently promotes confidence; epistemic canonical/qualified protects automatic overwrite; legacy draft cannot undo that protection; deprecated/superseded/retracted are consistently excluded by recall and graph traversal.

### Status metadata and errors (M)

- M1 Direct status with reason records correct from/to/actor/revision; omitted reason stays null; supplied empty, >2000-codepoint or secret reason rejects before mutation.
- M2 Proposal status links persisted submission/review metadata and executor, without substituting owner as reviewer. Old null metadata remains unknown.
- M3 Two edits by the SAME authorized owner of the same client revision accept one, reject the stale one, and leave no partial episode/snapshot/passages/receipt. Inject metadata-insert failure and verify complete rollback.
- M4 Real SQL failure returns isError:true/safe code; empty searches succeed; committed deletion with cleanup/audit trouble is success-with-warning, never retryable failure.
- M5 Bounded history remains bounded in structured/text outputs and private to owner; export/erasure includes or removes new status metadata correctly.

### Idempotency and batching (C)

- C1 Same key+payload via single/batch produces one capture; changed payload conflicts; two different actors may use same key independently; rotation and principal display-name change preserve replay.
- C2 Concurrent same-key requests yield one entry/episode/receipt; losing vectors are safely cleaned. Receipt insert failure rolls back all D1 artifacts; simulated response loss after commit returns winning receipt without deleting committed vectors.
- C3 Replay after edit returns original capture receipt without reverting content; current_revision is separate. Committed receipt with absent target never creates content.
- C4 Forget → retry same key, single and batch, returns capture_erased; test deactivation purge and legacy opdraft backfill/replay-after-edit/erase races. No new vectors/episodes/entries appear after erased replay.
- C5 Envelope invalidity writes zero items; mixed valid/content-invalid items produce ordered partial outcomes; duplicate trimmed keys/client IDs reject envelope; test 0/1/10/11 items, exact/over byte limits, UTF-8, malformed chunked bodies and service scope revocation mid-batch.

### Erasure and pagination (E)

- E1 Real Workerd fixture with all five child types deletes cleanly through shared collection; wrong owner/confirmation mismatch denies; unrelated memory/artifact survives.
- E2 Receipt tombstoning is atomic with erasure; injected failure rolls back both. Vector delete failure leaves a durable pending-cleanup receipt and completed authoritative deletion.
- E3 MCP, REST, integration mirror removal and deactivation use the fixed helper; no caller implements an alternate SQL workaround.
- E4 >50 entries with timestamp ties and large multibyte content page within output budget without repeats/skips among unchanged accessible rows; next_cursor uses the final emitted row; new inserts/deletes follow documented non-snapshot behavior; n can change between pages.
- E5 Malformed/version/filter/actor cursor mismatch rejects; revoked visibility is rechecked; old REST /list returns array, opt-in returns envelope; recall retains top-k limits and accurate fallback labeling.

### Setup, isolation and operations (O)

- O1 CLI exported config authenticates; mode0600 verified; existing/symlink outputs and cross-origin redirect rejected; keys absent from argv/output/logs; dashboard does not promise browser chmod.
- O2 Explicit source retained; defaults use verified principal labels; sanitized display and default-source hash survive retry; no old record relabeled.
- O3 Staging preflight rejects copied production binding even with a staging hostname/label; test unknown origin and both production domains; isolated Client A/B authentication and content boundaries hold.
- O4 Missing canary config is failure; failed check cannot close incident; full staging semantic fixture validates citations/status/privacy and safely erases only its own generated IDs.
- O5 Maintenance mode blocks memory/admin/proposal writes, mutation-bearing GET /digest and scheduled mutations but serves read tools; recovery uses compatible code, retains receipts, and verifies the four unchanged personal credentials.

### Exact check commands

From project directory, initial targeted commands:

```sh
npm test -- test/integration/users-api.test.ts test/unit/mcp-identity.test.ts
npm test -- test/integration/forget.test.ts test/integration/deactivation-service.test.ts
npm test -- test/integration/entry-version-service.test.ts test/integration/operator-governance.test.ts
npm test -- test/integration/list.test.ts test/unit/mcp-private-artifacts.test.ts
```

Run the new receipt/batch/profile/export scenario tests as implemented, then `npm test`, `npm run typecheck`, and `npm run smoke:workerd` in Linux CI. Exit0 required for every command. Node/SQLite experimental warnings may be recorded but actual failures may not be ignored. Do not change tests solely to match a new erroneous output or omit Workerd because mocks pass. The current Mac lacks setsid used by smoke-workerd; Linux CI is the required runtime check. Do not spend this release porting the shell harness to macOS.

## 15. Load, latency and monitoring gates

`scripts/staging-agent-load.mjs` uses existing HTTP/MCP paths and Node stdlib. It accepts the verified stage manifest/protected key files, no raw key argv. Generate disposable tagged fixtures and record IDs in a mode0600 local cleanup manifest. Never query/delete all entries sharing a broad tag. Cleanup only known IDs created by this run, with explicit confirmation and final receipt checks.

Run independent-write scenarios at concurrency1,4,8 with 100 logical writes each, fixed ~1KiB content, and unique keyed captures. Add four concurrent connections authenticated as the SAME entry owner, submitting the same expected_revision; exactly one succeeds and three return revision_conflict. Separately test four distinct identities writing their own entries and cross-owner direct edits returning not_owner. Add repeated same-key requests and a simulated lost response. Run each concurrency scenario three times; record warm-up separately from measured samples. Record accepted writes, final rows, receipts, duplicates, conflicts, retry count, HTTP/tool errors, p50/p95 timings and model/binding/Worker version.

Required correctness: zero lost acknowledged writes, zero duplicate retry effects, zero cross-owner private leaks, no partial provenance, and predictable revision conflicts. Four-writer scenario is the initial supported operating target. Eight-writer results must be reported accurately; overload may reject/retry safely but cannot corrupt data. No invented throughput guarantee.

Measure raw recall through REST/MCP recall with include_insight:false,topK:5 and generated answers through POST /chat through complete SSE completion, not first token. Use real staging AI/Vectorize at four concurrent requests, ten excluded warm-ups per mode followed by exactly100 measured requests per mode. Compute nearest-rank p95 over full roundtrip including retries, and separately report first-attempt timings/retry counts. Required release gates are raw p95≤3000ms and generated p95≤10000ms. A finite semantic test run must have zero semantic-unavailable responses. If targets fail, profile and fix within scope; do not silently lower thresholds. If an external AI incident prevents measurement, remote acceptance is blocked, not passed. Correctness/privacy failure always blocks release.

No new application rate limiter is included. Use the fixed four-writer supported client target and existing platform backpressure; surface429/503 with safe retry metadata. If this cannot meet the correctness gates, stop the release and report the measured contradiction rather than invent an unreviewed quota or queue. Clients use at most three retries with delays500ms,1000ms,2000ms plus up to250ms jitter for reads/keyed captures only. Honor a larger valid Retry-After, bounded to30000ms; beyond that return control to operator. Never automatically retry unkeyed remember, append, update or forget.

Production canary schedule: every15 minutes, read-only readiness + authenticated whoami/MCP tool discovery. Required secrets point to one dedicated existing/approved monitoring principal; missing configuration fails and cannot close incidents. Staging semantic/full-lifecycle canary: every6 hours and on every release candidate, with isolated credentials/resources and bounded cleanup. This reduces pointless high-frequency AI calls and tests the actual lifecycle without production deletions.

Set `close-on-recovery` needs:canary and require that job's success. Required env checks run even when values are absent. Incident records include failed stage/code, workflow link, version and time, never raw responses or keys. Reconcile the pilot scorecard with these technical gates; retain adoption/helpfulness metrics as product observations, not substitutes for correctness.

## 16. Deployment and recovery, one release only

### 16.1 Maintenance contract

Implement `SLM_WRITE_MODE: enabled|read-only`, default enabled for legacy local fixtures but explicitly configured for every deployed environment. Invalid value fails readiness. A small shared predicate in src/config.ts is sufficient; no maintenance service.

In read-only mode reject application/admin mutations with503 and `maintenance_read_only`. REST uses an explicit safe-route allowlist, not method alone: serve static assets, /health, /ready, /api/whoami, /api/me, /count, /list, /recall, owner-authorized history/passages/entry reads, graph reads, exports, and already-authorized proposal/service/user listings, plus login/logout session handling. Test the fixed list below against actual handler side effects and record the caller inventory; do not expand the list autonomously. GET /digest is expressly blocked because it calls compressTag. The fixed safe GET path set is /health, /ready, /api/bootstrap-status, /api/whoami, /api/me, /api/users, /api/service-identities, /action-proposals, /awareness-events, /count, /tags, /stats, /list, /team-activity, /edge-proposals, /export, /recall, /erasure-status, /pilot-metrics, /connections, /entry, /graph and /integrations; safe parameterized GET paths are /entries/:id/history, /entries/:id/hierarchy and /edges/:id/history. Every existing auth/visibility check remains. HEAD for those paths may omit the body without invoking a write. Unknown API routes and all mutation routes reject before side effects; OPTIONS may return CORS without invoking a handler. POST /chat is permitted only as server-grounded read/generation with all content mutation guards active. MCP protocol negotiation/resource reads remain available; tools/call allows whoami, recall, list_recent, passages, history, connections, list_action_proposals, list_edge_proposals and list-proposals only. Rate_recall and every mutation tool reject. Normal content-free telemetry/schema validation may still write; memory/governance/credential changes may not. Scheduled content/graph/integration/offboarding/erasure mutation jobs do not start. Check deep shared mutation functions as a second guard for background/internal callers. In maintenance, recall/chat must skip optional derived-memory/proposal writes while retaining retrieval/generation and content-free telemetry; do not launch a write promise and discard it afterward. Any GET whose implementation unexpectedly writes domain state stays blocked until that side effect is removed or explicitly gated.

Read-only mode applies to new requests and scheduled starts on the recovery version. Previously accepted calls on an older enabled isolate may finish; do not claim that a configuration change cancels them. Before any data restore, observe in-flight work and stage-intent reconciliation draining; unresolved activity blocks restore. Accepted receipts remain authoritative.

### 16.2 Release checklist

- [ ] Complete all work packages/tests, source review, secret scan and requirement matrix. Verify exact branch diff includes no unrelated project edits or keys.
- [ ] Deploy candidate only to verified isolated staging; migrate through normal ordered startup, run all functional/load/semantic checks and retry/erase recovery cases. Record deployed version/hash, not just local commit.
- [ ] Prepare a recovery version from the SAME compatible implementation with SLM_WRITE_MODE=read-only. It includes rotation/erasure/receipt safety and can serve legacy keys. Verify it on staging before production. Do not designate an old pre-receipt writer as a safe rollback target.
- [ ] Produce concrete deployment evidence: commit SHA, config/binding diff, migration plan, verified backup/recovery material, secret names only, four-account compatibility checks, canary configuration, recovery version, and remaining issues (must be zero for required gates).
- [ ] Once the owner authorizes this concrete release, deploy it once to production. Run read-only production checks of both custom domain and workers.dev alias, /health,/ready, all four principals' initialize/whoami/tools/list and one existing nonsecret fixture read. No production fixture deletion, key rotation or profile-file overwrite without the corresponding explicit action request.

If production checks fail, switch to the tested compatible read-only recovery version, stop new writes, and investigate. Do not downgrade to code that ignores capture receipts/status metadata. Keep additive schema and current keys. Restore data only after separately confirming the exact recovery point and impact; never wipe D1 or rebuild authority from Vectorize. Resume writes only after the failing gate is fixed and retested.

One release means one enabled production rollout. Recovery/maintenance is emergency protection, not permission to ship unfinished packages as separate releases.

## 17. Ordered implementation work packages

Each package uses a focused test → observed failure → minimal implementation → passing test cycle. Commit completed units on the release branch for review; none may deploy independently to production. Reuse helpers already named in the file map. Review every shared-function caller before editing.

1. **WP1 Baseline and traceability.** Read AGENTS/lessons/spec, verify remote/worktree, install locked dependencies, run baseline tests/typecheck, create the implementation evidence checklist covering A1–O5. Record discrepancies without changing expected behavior. Output: baseline and exact branch SHA.
2. **WP2 Runtime safety repairs.** Implement six-term erasure fix, stable-ID rotation and safe error mapping; extend Workerd smoke. Output: A1–A3, E1/E3 and M4 before-commit cases passing.
3. **WP3 Atomic schema and receipt core.** Add migration/status column/receipt table, receipt descriptors and guarded commit integration, erasure tombstones and legacy service replay recovery. Output: migration fresh/upgrade/repeat tests and C1–C4, E2 passing against real SQLite plus Workerd limit.
4. **WP4 Keyed capture and batch.** Shared validation/create-only path, per-item limits/errors, REST/MCP batch and single-key parity. Output: C5 and all batch retry cases, no scope bypass for services.
5. **WP5 Identity/results/profiles.** whoami, structured entry/results, bounded history, source defaults, exact profiles and aliases. Output: A4/A5, G1, M5, O2 and inventories.
6. **WP6 Status/review.** Expected revision inputs, status_change_json propagation, overwrite protection, reviewer_username binding/audience, documented proposal flow. Output: G2–G5, M1–M3 including races/revocation/privacy.
7. **WP7 Pagination.** Cursor helpers/shared query, MCP envelope and REST opt-in compatibility. Output: E4/E5 across ties, filtered/auth changes and old clients.
8. **WP8 Export/UI/docs.** Secure CLI exporter, bounded dashboard improvements, matching onboarding/skills/guides. Output: O1 plus four-profile setup walkthrough and no contradictory auth/status prose.
9. **WP9 Stage/operations.** Binding preflight, corrected monitoring, semantic/load scripts, client-isolation fixtures, maintenance and compatible recovery. Output: O3–O5 and complete load/latency evidence.
10. **WP10 Integrated release audit.** Full suite/typecheck/Workerd, all staging scenarios, secret scan, compatibility diff, failure-injection review, final requirement coverage. Output: concrete single-release deployment package and readiness for the authorized rollout in Section16.

WP numbers are sequence, not dates or releases. Do not skip a failing predecessor by marking it as a future improvement. No architecture decisions remain for the executor to select.

## 18. Stop conditions and prohibited shortcuts

Stop only the dependent operation and state the exact blocker when required Cloudflare/staging access is absent, a binding points at production, a source change contradicts a security invariant, a required check repeatedly fails without understood cause, or production rollout authorization is absent. Continue independent implementation/testing. Unexpected API output is a reason to inspect the installed tool's actual schema, not guess fields or send credentials elsewhere.

Prohibited shortcuts: deleting owner predicates; letting admin read all history; treating source labels as authenticated identity; claiming a profile is a restricted credential; writing receipts after commit; recreating erased captures; catching SQL failure as successful deletion; blindly retrying writes; expiring tombstones; collapsing both status enums; returning full private content in structured output; claiming tests passed from a command whose exit code was discarded; lowering acceptance thresholds without owner decision; clearing secrets by printing them; pushing/deploying unrelated changes.

A product behavior outside this specification is not required merely because an implementation model finds it interesting. Conversely, complexity is not permission to omit a listed requirement. Escalate only a genuine contradiction with a concise evidence-backed question after completing independent work.

## 19. Feedback-to-deliverable coverage

| Feedback concern | Fixed deliverable | Gates |
| --- | --- | --- |
| Candidate IDs and promotion | Typed entry/revision/permissions; owner history; existing two-step proposal review | G1–G5, A5 |
| whoami, auth errors, exports | Verified account/deployment/profile; safe auth; rotation; secure CLI and aligned docs | A1–A5, O1 |
| forget and review reasoning | Five-term erasure; atomic receipts/status metadata; safe completion and reason contracts | E1–E3, M1–M5 |
| Tool names/count/source | Exact request profiles, aliases, distinct proposal kinds, actor-based defaults | A4, O2 |
| Batch, pagination, concurrency, clients | Create-only retry semantics; cursors; measured writers; separate deployment boundary | C1–C5, E4/E5, O3–O5 |

Preserve positives throughout: author ownership, citations, explicit permanent-erasure confirmation, useful bootstrap probes and immutable history. One additional defect discovered during planning, legacy service replay after deletion, is explicitly covered by C4.

## 20. Specification review and handoff record

The implementation agent must append actual evidence to the release document, not change this specification into a self-congratulatory completion report. Every requirement group receives test IDs and measured result links. Record externally blocked checks as blocked, never passed.

This specification was grounded in the repository, the received agent feedback, a read-only comparison of the same entry under two principals, runtime-limit reproduction, and review of every shared erasure/lifecycle path. Planning did not run production mutations or change credentials. Future implementers must re-run tests after their edits; historical baseline results do not certify the new release.

Primary references:

- Workerd SQLite limit: https://github.com/cloudflare/workerd/blob/main/src/workerd/util/sqlite.c%2B%2B#L1304
- SQLite configurable/default limits: https://www.sqlite.org/limits.html
- Cloudflare D1 limits/concurrency: https://developers.cloudflare.com/d1/platform/limits/
- MCP structured tool output and compatibility: https://modelcontextprotocol.io/specification/2025-06-18/server/tools

Final executor deliverable: tested release branch + docs/team-pilot/releases/agent-reliability-1-1.md + corrected operator/participant setup + protected connection export capability + verified isolated-stage evidence + concrete authorized-production deployment/recovery procedure. Do not hand off an untested collection of patches or ask the next model to decide the architecture.
