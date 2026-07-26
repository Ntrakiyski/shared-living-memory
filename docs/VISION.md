# VISION.md

## The Living Memory Organism

A self-evolving knowledge partner that operates your memory, catches what you miss, and proposes what you haven't thought of yet. Memory becomes a team member — not a static database, but a living system that learns, proposes, and operates.

---

## Four Pillars

### 1. Memory
The foundation. A persistent, semantically-searchable knowledge layer that any agent can read and write via MCP. Every memory is citable — traceable back to its source. Every fact is time-aware — you can query what was true when. Memories naturally decay unless reinforced, keeping the knowledge base relevant.

**What this means:**
- Connect through any chat interface (Claude, GPT, Hermes, any MCP-compatible agent)
- Every recalled fact links back to its source paper, section, page
- Temporal tracking — "what did we believe in March?" has an answer
- Spaced repetition — old knowledge fades, useful knowledge persists
- Snapshots before every mutation — rollback is always possible

**Deliverables:**
- Episodes table — immutable raw content preserved alongside entries
- Evidence passages — sub-entry citation granularity (paper, section, page)
- Bitemporal facts — `valid_from`/`valid_to` + `recorded_at` on knowledge
- Retention decay — spaced repetition scoring with configurable half-life
- Snapshot table — pre-change backups before every mutation
- `restore` MCP tool — rollback to any previous snapshot

### 2. Shared Knowledge Base
The team layer. Multiple users and agents share a collective memory with visibility enforcement. You see your own private entries plus the team's public knowledge. When someone captures a decision, makes a discovery, or ingests a paper — the whole team benefits. The shared memory is a window into the team's collective intelligence.

**What this means:**
- See what your team is remembering, working on, and deciding
- Contradictions across the team are caught and surfaced — "this conflicts with what teammate X decided 2 months ago"
- Typed relations — not just "related to" but `contradicts`, `derives_from`, `supports`
- Confidence scores on every relationship — know how certain the system is
- Cross-user awareness — when your work overlaps with a teammate's, you both know

**Deliverables:**
- Typed relations — `contradicts`, `derives_from`, `supports`, `evaluates_on`, `has_limitation`
- Confidence scores on all edges — 0.0–1.0 per relationship
- Cross-user contradiction detection — "this conflicts with teammate X's entry from March"
- Team activity visibility — see what the team is capturing and deciding
- Visibility enforcement — private entries stay private, public entries shared

### 3. Operator
The governed control plane for any agent that operates the memory. It sits between an operator runtime and Shared Living Memory's storage services, enforcing identity, scope, policy, approval, and audit rules on every action. Hermes is the first intended operator runtime, but it is a replaceable client of this layer — never the memory's canonical store or a privileged database process.

**What this means:**
- Any compatible agent can operate the memory through governed MCP/API tools — not just one vendor or runtime
- Every operator authenticates as a dedicated, scoped service identity that humans can rotate, suspend, or revoke
- Operator follows autonomy levels: automatic (read and constrained private draft), gated (all consequential knowledge changes), never (hard delete and access-control changes)
- All mutations go through policy-enforced application tools — no direct D1, Vectorize, or R2 access
- Every governed mutation has a fail-closed audit envelope in `agent_runs` and `agent_events`
- Governance: operators propose, humans approve; execution rechecks policy and preconditions

**Deliverables:**
- [Canonical Hermes charter](research/hermes-living-knowledge-agent-charter.md) — defined agent ↔ memory boundary
- Service identities — least-privilege scopes, expiry, rotation, suspension, and revocation
- Autonomy levels — automatic / gated / never, enforced per action
- Governed MCP/API interface — actor-neutral tools for agents to operate memory
- Mandatory audit logging — every governed mutation tracked to `agent_runs` and `agent_events`
- Proposal inbox — gated actions surface to humans before execution

### 4. Autonomous Operations
The operator as a team partner — not just memory, but a colleague. The system actively searches for new information, scrapes sources, tests assumptions, proposes actions, and expands the knowledge base overnight. It monitors for contradictions, extracts claims from papers, identifies gaps, and surfaces what you haven't asked for. The memory evolves itself while you sleep.

**What this means:**
- Nightly scouting — watches your arXiv feeds, GitHub repos, RSS sources
- Research execution — spawns subagents to fill knowledge gaps
- Contradiction monitoring — continuous scanning for conflicts across the corpus
- Evidence extraction — pulls claims from papers and links them to existing knowledge
- Stale detection — proposes deprecation for entries with no recalls in 90+ days
- Morning digest — surfaces proposals to human reviewers before acting
- Background processing queue — async extraction with retry, not fire-and-forget

**Deliverables:**
- Extraction queue table — D1-backed async processing with retry + dead-letter
- Nightly cron orchestration — sentinel, planning, research, validation, digest
- Source monitoring — RSS/arXiv/GitHub polling with deduplication
- Research agenda — prioritized open questions with scoring formula
- Stale detection — Hermes proposes deprecation for unreinforced entries
- Morning digest — daily summary of proposals, contradictions, new discoveries
- Knowledge proposals — structured inbox for human review of agent actions

---

## Why Now

| Today | What We're Building |
|-------|-------------------|
| You write notes, system stores them | System watches sources and writes notes for you |
| You search when you need something | System surfaces what's relevant before you ask |
| Compressed digests overwrite originals | Every claim links back to its source — auditable |
| "When did we decide this?" — no answer | "What was true in March?" — temporal query |
| Old entries sit forever or get compressed | Spaced repetition — useful knowledge stays, stale fades |
| Contradictions caught on write only | Continuous monitoring across entire corpus |
| Passive storage | Active agent with priorities, budgets, governance |

The competitors built better shovels. We're building the gardener.

---

## Delivery Sequence

The operator product and the Hermes runtime are deliberately separate deliverables:

1. **Pillar 1 — Memory:** establish immutable provenance, versioned state, temporal recall, evidence, and reversible user-visible history.
2. **Pillar 2 — Shared Knowledge Base:** establish explicit visibility, team ownership, role governance, and tenant-safe integrations.
3. **Pillar 3 — Operator control plane:** establish service identities, policy decisions, mandatory audit, human-reviewed proposals, and governed execution.
4. **Deploy Hermes last:** connect Hermes through the same governed MCP/API surface available to any replacement operator. Follow the [operator runtime and deployment guide](operator-runtime-deployment.md).
5. **Pillar 4 — Autonomous Operations:** expand schedules and unattended work only after the Hermes shadow/pilot stages meet the safety and quality gates.

Hermes must not be used to compensate for missing guarantees in Pillars 1–3. Replacing Hermes must require a credential rotation and runtime change, not a data migration or storage rewrite.
