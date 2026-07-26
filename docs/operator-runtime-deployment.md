# Operator Runtime and Hermes Deployment

**Status:** canonical deployment guide
**Applies to:** Hermes and any future automated memory operator
**Canonical behavioral contract:** [Hermes: Living Knowledge Agent Charter](research/hermes-living-knowledge-agent-charter.md)
**Last updated:** 2026-07-16

## 1. Purpose

This guide defines how an agent runtime is attached to Shared Living Memory after the Memory, Shared Knowledge Base, and Operator foundations are complete.

The key architectural decision is that **Operator is a governed product capability; Hermes is one replaceable client of it**. Hermes may plan, research, and propose, but Shared Living Memory remains the only authority for identity, visibility, policy, versioning, provenance, proposals, audit, and durable knowledge.

Replacing Hermes must require only a runtime change and service-credential rotation. It must never require moving canonical memory or teaching a new runtime how to write D1 or Vectorize directly.

## 2. Deployment boundary

```text
Hermes or another operator runtime
  ├─ disposable local working state
  ├─ source/search tools with explicit allowlists and budgets
  └─ one expiring Shared Living Memory service credential
                    │
                    │ TLS + governed MCP/API calls
                    ▼
Shared Living Memory Operator control plane
  ├─ service identity and scope validation
  ├─ policy decision: allow / proposal_required / deny
  ├─ mandatory audit envelope
  ├─ human proposal review and precondition checks
  └─ versioned domain services
                    │
                    ▼
Canonical storage (internal only): D1 + Vectorize + R2
```

| Runtime may possess | Runtime must never possess |
|---|---|
| Governed Shared Living Memory endpoint | D1 binding, database file, or database administration token |
| One scoped, expiring service credential | Vectorize token, index binding, or direct vector mutation capability |
| Approved source/search credentials | R2 bucket credentials or raw storage write access |
| Bounded local queue and cache | Cloudflare account, deployment, migration, backup, or billing credentials |
| Runtime logs with redacted IDs | Human user keys, administrator sessions, or another service's credential |

The application boundary is not optional. A repair script, fallback mode, or incident response must not grant Hermes direct storage access.

## 3. Preconditions: finish Pillars 1–3 first

Hermes is not the mechanism used to make an incomplete memory layer safe. Deployment starts only when the following contracts are implemented and verified independently of Hermes.

### Pillar 1 — Memory

- Immutable source episodes and exact raw inputs are preserved.
- Each episode maps to one document record, keeping source lineage unambiguous.
- User-visible snapshots and entry versions exist for every mutation.
- Restore creates a new identity/version lineage rather than rewriting history.
- Evidence passages and document hierarchy preserve resolvable source anchors.
- `as_of` represents valid/world time and `known_at` represents transaction/knowledge time.
- Contradiction does not silently supersede knowledge; supersession is explicit and approved.
- Research ingestion bypasses destructive smart merge; sources and evidence remain immutable/versioned.
- Hard forget is an explicit human-only compliance purge with complete artifact cleanup.

### Pillar 2 — Shared Knowledge Base

- Explicit visibility is authoritative and enforced in D1 and vector access paths.
- Private entries never leak through recall, graph, activity, export, integrations, or proposals.
- Team roles, last-admin protection, deactivation, ownership transfer, and tenant-safe integration lifecycle are verified.
- Cross-user contradictions and relationships enter a reviewable proposal flow instead of mutating another user's knowledge.

### Pillar 3 — Operator control plane

- Service identities and hashed credentials support least-privilege scopes, expiry, rotation, suspension, and revocation.
- Persisted identity, credential, and scope state is revalidated on every authenticated use.
- Policy decisions are default-deny and distinguish direct, proposal-required, and forbidden actions.
- A required pre-action audit record is persisted before any governed mutation; audit failure prevents the mutation.
- Proposals are idempotent, human-reviewed, expiry-aware, revision-checked, and executed with compare-and-set state transitions.
- Proposal review is human-only. Approved execution rechecks policy and preconditions and cannot become a generic write channel.
- The proposal inbox and operator audit trail are usable by human reviewers.

If any gate fails, remain in foundation work or read-only shadow mode.

## 4. Service identity

Create a dedicated identity named for the runtime and environment, for example `hermes-production`. It must have a named active human owner and a `propose` autonomy profile.

The default safe credential contains:

| Scope | Purpose |
|---|---|
| `memory:read` | Visibility-scoped recall and inspection |
| `memory:draft` | Constrained private draft candidate capture only |
| `memory:propose` | Request consequential memory changes through proposals |
| `proposal:read` | Inspect proposals visible to the identity's owner |
| `proposal:create` | Create idempotent, evidence-backed proposals |
| `audit:write` | Permit the server's mandatory governed audit envelope |
| `run:write` | Permit governed run/event accounting |

Do not grant these scopes to the default Hermes research credential:

- `memory:execute-approved`
- `proposal:execute-approved`

If approved execution is introduced later, provision a separate executor identity with a narrower operational purpose. Separating research/proposal creation from execution limits credential impact and makes revocation unambiguous.

Credential requirements:

- return the raw secret once at provisioning and store only its hash in Shared Living Memory;
- set an explicit expiry and rotate before it;
- inject it through the runtime secret manager, never a repository, image, prompt, memory entry, event payload, or shell history;
- transmit it only to the configured Shared Living Memory origin over TLS;
- reject a credential when the identity or credential is inactive, expired, revoked, or claims scopes beyond its persisted grant.

## 5. Action policy

| Class | Default Hermes behavior | Examples |
|---|---|---|
| Read | Direct when `memory:read` is present | Recall, inspect evidence/history, list visible proposals |
| Constrained capture | Direct only as a private + draft + epistemic-candidate entry, with no merge or auto-deprecation | Working note, source lead, research candidate |
| Consequential mutation | Create a proposal; wait for human review | Append/update/merge, restore, lifecycle change, epistemic change, publish/remove edge |
| Human review | Never available to a service identity | Approve or reject a proposal, resolve policy exception |
| Irreversible/security action | Never direct and never smuggled through a proposal | Hard forget, access-control change, credential administration, deployment, migration |

Human approval is necessary but not sufficient for execution. At execution time Shared Living Memory must recheck:

- proposal is reviewed, unexpired, and in the expected state;
- payload hash and action type still match the reviewed object;
- target identity and expected revision/preconditions still hold;
- executor identity and current scopes are valid;
- current policy still permits the approved action;
- an audit request can be persisted before mutation.

If any check fails, mark the proposal stale, expired, or failed as appropriate. Do not reinterpret it or silently generate a replacement.

## 6. Audit contract

Shared Living Memory, not Hermes, owns authoritative audit writes. Every governed mutation follows this order:

```text
authenticate actor
  → evaluate policy
  → persist requested run/event with redacted input hash
  → perform one bounded mutation
  → persist succeeded or failed result metadata
```

If the requested audit record cannot be persisted, the mutation does not run. Audit records identify the actor kind, service identity, credential, authentication method, scopes requested/granted, policy version and decision, proposal/correlation ID, target IDs, timestamps, and redacted input/result hashes. Raw credentials and private source content do not belong in audit summaries.

Use one correlation ID per bounded job and one idempotency key per proposed effect. Retries reuse those identifiers. A network timeout is not evidence that a mutation failed; query the proposal/run state before retrying.

## 7. Runtime configuration

The Hermes runtime receives only:

- the governed Shared Living Memory MCP/API endpoint;
- its service credential through a secret manager;
- an operator/runtime version label;
- source allowlists and source credentials;
- per-run time, token, request, and monetary budgets;
- concurrency, retry, and dead-letter limits;
- a kill-switch procedure owned by a human administrator.

Runtime rules:

- Restrict outbound network access to Shared Living Memory and approved source providers.
- Keep local working state bounded and disposable; encrypt it if it can contain private material.
- Never treat local cache, chat history, or a model checkpoint as canonical memory.
- Run one executive selection at a time. Parallel workers require distinct source/task leases and budgets.
- Use bounded exponential retry only for safe/idempotent calls. Never retry a mutation with a new idempotency key.
- Record model/provider/version and cost metadata without copying secrets or unrestricted private content into logs.
- Stop work when the governed endpoint is unavailable; do not fall back to a storage connection or shadow database.

## 8. Rollout order

Each stage has an explicit human owner, start/end date, budget, success metrics, and rollback trigger.

### Stage 0 — foundation acceptance

Run Pillar 1–3 integration, privacy, provenance, temporal, proposal, audit, rotation, and revocation tests. Do not provision Hermes production credentials until these pass.

### Stage 1 — read-only shadow

Grant only `memory:read`, `proposal:read`, and the audit/run scopes needed by the interface. Hermes observes approved source events and produces local candidate reports. Humans compare its proposed priorities and evidence with their own decisions. It writes no memory or proposals.

Exit when visibility tests show zero leakage and the team has a useful baseline for evidence quality, cost, and no-op behavior.

### Stage 2 — private draft candidates

Add `memory:draft`. Allow only bounded private draft candidate capture. Verify that no path can merge, supersede, publish, relabel visibility, or modify an existing entry.

Exit when audit coverage is complete and reviewers accept the draft quality without privacy or lineage failures.

### Stage 3 — proposal pilot

Add `memory:propose` and `proposal:create`. Enable a small set of evidence-backed action types and the human proposal inbox. Keep all execution human-controlled.

Exit when proposal acceptance, rejection reasons, stale-precondition handling, citation precision, duplicate rate, and reviewer load meet agreed thresholds.

### Stage 4 — bounded schedules

Enable source watch, research, contradiction/staleness diagnosis, and a morning digest one workflow at a time. Keep hard budgets, idempotent leases, dead letters, and a human kill switch. Run for at least 30 days before considering broader autonomy.

### Stage 5 — optional approved executor

Only if there is a demonstrated operational need, create a separate approved-executor identity and allowlist the smallest implemented action set. Human approval remains mandatory. Do not add execution scopes to the Hermes research credential.

Pillar 4 autonomous operations expand from Stage 4/5 evidence. They do not begin merely because the runtime can stay online unattended.

## 9. Credential operations

### Provision

1. An active administrator creates the service identity with a named owner and default-safe scopes.
2. Set an expiry and capture the one-time secret directly into the runtime secret manager.
3. Verify identity name, credential prefix, environment, scopes, expiry, and owner out of band.
4. Start in the rollout stage's reduced scope set, not the final hoped-for scope set.

### Rotate

1. Create a replacement credential with equal or narrower scopes and a new expiry.
2. Deploy the replacement through the secret manager.
3. Verify one governed read and its attributed audit event using the new credential.
4. Revoke/retire the previous credential and verify it is denied.
5. Investigate any later use attempt for the old credential prefix.

### Revoke or suspend

1. Revoke the credential or suspend/revoke the entire identity from a human administrator session.
2. Disable the scheduler and terminate active runtime jobs.
3. Verify subsequent authentication is denied and no new mutations or proposals appear.
4. Preserve audit and proposal history. Do not delete evidence during containment.
5. Rotate any source credential that may also have been exposed and complete incident review before re-provisioning.

Revocation is the primary kill switch. A deployment rollback that leaves a valid credential running elsewhere is not containment.

## 10. Operational acceptance and monitoring

Before advancing a stage, review at least:

- unauthorized mutation, private-data leak, hard-delete attempt, and audit-gap counts — target zero;
- service authentication failures, expired/revoked credential use, and scope-denial reasons;
- requested versus terminal audit-event completeness;
- proposal acceptance/rejection rate, stale/expired rate, and reviewer latency;
- citation coverage and reviewer-confirmed citation precision;
- duplicate, unsupported, and ungrounded draft rate;
- cost per accepted contribution and per no-op run;
- queue age, retry count, dead letters, and concurrency lease conflicts;
- runtime version, policy version, model/provider version, and source-policy version.

Pause the runtime and revoke its identity on any privacy breach, unauthorized mutation, missing required audit, unexplained credential use, repeated idempotency failure, or attempt to reach internal storage.

## 11. Replaceability test

At every major release, run the same operator contract tests with a second generic MCP/API client:

1. authenticate with a separate least-privilege service identity;
2. perform visibility-scoped reads;
3. create one constrained private draft candidate;
4. create an idempotent proposal and observe human review;
5. verify audit attribution and revoke the credential;
6. confirm no canonical memory migration or storage access was required.

If this test fails, Hermes has become hidden infrastructure rather than a replaceable team member. Fix the Operator boundary before expanding autonomy.

## 12. Production sign-off

- [ ] Pillars 1–3 acceptance gates pass without Hermes.
- [ ] Canonical charter and this guide are approved by the human owner.
- [ ] Runtime has no D1, Vectorize, R2, Cloudflare, deployment, or human credentials.
- [ ] Service identity uses the rollout stage's least-privilege scopes and an explicit expiry.
- [ ] Rotation and revocation are tested end to end.
- [ ] Required audit fails closed before mutation.
- [ ] Proposal review and execution precondition checks are tested.
- [ ] Privacy/visibility tests cover recall, graph, activity, export, integrations, proposals, and audit summaries.
- [ ] Budgets, allowlists, concurrency, retries, dead letters, and kill switch are configured.
- [ ] Reviewer ownership and weekly metrics review are scheduled.
- [ ] A second client passes the replaceability test.
