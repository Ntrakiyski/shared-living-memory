# Shared Living Memory — Living Team Knowledgebase

**A governed, time-aware knowledgebase that translates between the mental maps of humans and domain agents.**

[![Built with Cloudflare Workers](https://img.shields.io/badge/Built%20with-Cloudflare%20Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![MCP Compatible](https://img.shields.io/badge/MCP-Compatible-8B5CF6)](https://modelcontextprotocol.io/)

Shared Living Memory turns scattered notes, decisions, source material, and agent context into a shared team knowledgebase that can be queried, cited, reviewed, and safely operated by humans or domain-specific AI agents.

The real product is not “memory” by itself. The real product is translation between different mental maps: helping one person or agent understand what another person or agent discovered, why it mattered to them, and how it may become useful in a different context.

This project started as a fork of [Shared Living Memory for AI](https://github.com/rahilp/second-brain-cloudflare). It now extends that idea into a multi-user, provenance-first, operator-governed team knowledgebase.

**Live deployment:** [shared-living-memory.nikolay-trakiyski.workers.dev](https://shared-living-memory.nikolay-trakiyski.workers.dev/)

## Demo

![Shared Living Memory behind-the-scenes demo](media/shared-living-memory-demo.gif)

## What it is

Shared Living Memory is not just “semantic search over notes.” It has three product layers:

1. **Shared knowledge layer** — durable, governed knowledge that humans and agents can capture, recall, cite, connect, version, and review.
2. **Translation layer** — workflows that map knowledge from one mental model into another person’s, project’s, or agent domain’s context.
3. **Living organism / Hermes layer** — external Hermes-style profiles and scheduled jobs that scout, draft, connect, and propose maintenance through governed MCP/API access.

Inside this repository, those layers show up as a knowledgebase control plane for a mixed team of people and agents:

- Users and agents can save knowledge entries through the dashboard, REST API, or MCP.
- Each entry has an owner, visibility, versions, immutable source episodes, and rollback history.
- Recall can answer using semantic search, graph expansion, citations, and temporal filters.
- Public entries form the team knowledgebase; private entries stay private.
- AI operators such as Hermes can read, draft, and propose changes through scoped service identities instead of touching storage directly.
- Consequential agent actions go through proposals, policy checks, and mandatory audit logging.

The intended end state is a living knowledgebase that behaves like a responsible team: humans contribute judgment and approval, while specialized agents scout, remember, cite, notice overlap, translate discoveries across contexts, propose maintenance, and never silently rewrite the past.

Hermes itself, domain-agent runtimes, and broader studio operating workflows are intentionally outside this repository. This repo provides the shared knowledge system, the governance boundaries, and the skills that let external agents use it well.

## User value

### For individuals

- Capture decisions, ideas, tasks, research notes, preferences, and project context in one place.
- Ask questions in natural language instead of remembering exact wording.
- See where an answer came from through source/citation cards.
- Restore or inspect previous versions when knowledge changes.
- Mark important memories as reinforced so useful knowledge stays alive.

### For teams

- Share public knowledge while preserving each person’s private workspace.
- See recent team activity and public knowledge without exposing private notes.
- Detect overlap and contradictions across users.
- Review proposed knowledge changes before they become canonical.
- Deactivate users safely while preserving public team knowledge and cleaning private artifacts.

### For translation between mental maps

- Let Nikolay capture a GitHub repository as a possible automation building block while Goria later receives an explanation grounded in her own data-quality work.
- Let one agent discover a tool, paper, or pattern and have another agent understand how it applies to its own domain.
- Preserve the original meaning of a discovery while generating new use cases for different recipients.
- Turn “this exists” into “this matters to you because...” without forcing everyone to share the same vocabulary or background.

### For agent teammates

- Create multiple Hermes-style profiles for different domains, each with its own identity, scopes, and responsibilities.
- Use one durable knowledge layer across Claude, ChatGPT, Cursor, Codex, Hermes, and any MCP-compatible client.
- Retrieve scoped context instead of relying on chat history.
- Operate through least-privilege service identities.
- Draft or propose changes without bypassing human review.
- Leave an audit trail for every governed mutation.

Example agent teammates:

- **Research Scout:** watches papers, RSS feeds, GitHub repos, and technical sources.
- **Engineering Librarian:** tracks APIs, architecture decisions, dependencies, and implementation notes.
- **Product Memory Owner:** keeps product decisions, user insights, experiments, and open questions coherent.
- **Competitive Intel Agent:** monitors competitors, market shifts, and positioning changes.
- **QA / Critic Agent:** looks for contradictions, stale assumptions, weak evidence, and missing citations.
- **Personal Chief of Staff:** turns private notes into drafts or proposals without publishing them directly.

These agents are “team members,” but governed ones: they can be proactive in their domain while Shared Living Memory enforces identity, visibility, policy, proposal review, and audit.

## Current implementation

### Layer 1 — Shared knowledge layer

Implemented foundations:

- Immutable `episodes` preserve exact source input.
- One document envelope per episode keeps source lineage unambiguous.
- `entry_snapshots` preserve user-visible state before mutations.
- Restore creates a new version instead of rewriting old history.
- `as_of` and `known_at` support bitemporal recall:
  - `as_of` = world/valid time.
  - `known_at` = when Shared Living Memory knew that state.
- Evidence passages, documents, and citation metadata flow into recall.
- Vector cleanup is durable and retryable when stale vector deletion fails.
- Every entry has explicit `owner_user_id`, `created_by_user_id`, and `visibility`.
- Private entries are enforced across D1 reads, Vectorize metadata, graph traversal, exports, integrations, and UI.
- Public entries are visible to the team.
- Relationships are typed: `relates_to`, `contradicts`, `supports`, `derives_from`, `has_limitation`, and more.
- Edge confidence and provenance distinguish explicit, inferred, and system-created relationships.
- Edge history is versioned and reversible via `edge_versions`.
- Cross-user awareness events notify users when public work overlaps.

### Layer 2 — Translation layer

The repository already provides the substrate for translation through cited recall, graph links, relationship provenance, user ownership, visibility boundaries, and agent skills. The higher-level product behavior is staged as feature work:

- **Opportunity mapping:** when a human or agent captures a discovery, the system maps it to related people, projects, domains, and possible use cases.
- **Personalized explanation:** the same knowledge can be explained differently for Nikolay, Goria, a research scout, an engineering agent, or a quality critic based on their context and goals.

These features belong in this product because they are the bridge between shared knowledge and actual usefulness. They should be built on top of the existing provenance, visibility, graph, recall, proposal, and audit foundations.

### Layer 3 — Living organism / Hermes layer

Shared Living Memory is designed so Hermes-style profiles can operate through governed service identities instead of direct storage access:

- Service identities have scoped credentials, expiry, rotation, suspension, and revocation.
- Operators are actor-scoped: human, service, or system.
- Policy returns `allow`, `proposal_required`, or `deny`.
- Consequential service actions become human-reviewable proposals.
- Proposal execution rechecks policy, payload hash, target revision, preconditions, expiry, and actor scope.
- Mandatory audit creates a requested run/event before governed mutations.
- Completion reconciliation repairs terminal audit projections after post-mutation audit failures.
- Hermes is treated as a replaceable external client of this layer, not as the canonical knowledge store.

The repo supports multiple specialized operator profiles, but full autonomous operation is intentionally staged. The safe rollout for each domain agent is:

1. Read-only shadow.
2. Private draft candidates.
3. Proposal pilot.
4. Bounded scheduled scouting/research.
5. Optional approved executor identity.

See [docs/operator-runtime-deployment.md](docs/operator-runtime-deployment.md) for the runtime boundary and rollout plan. Actual Hermes setup, profile hosting, and scheduled-job runtime configuration happen outside this repository.

## How people use it

### Web dashboard

Open the live deployment:

[https://shared-living-memory.nikolay-trakiyski.workers.dev](https://shared-living-memory.nikolay-trakiyski.workers.dev/)

The dashboard supports:

- workspace-key connection;
- user creation and login with per-user API keys;
- recall, recent memories, capture, graph, and settings views;
- temporal recall controls;
- citation cards;
- memory history and restore;
- publish/private visibility controls;
- reinforcement controls;
- service identity management for administrators;
- proposal and awareness inbox surfaces.

### Agent skills

This repo includes practical skill files that humans can hand to Codex, Hermes, or another MCP-connected agent:

- [Shared Living Memory MCP Knowledgebase](.agents/skills/shared-living-memory-mcp-knowledgebase/SKILL.md) — how people and agents should use Shared Living Memory through MCP as a governed team knowledgebase and translation layer.
- [Hermes Domain Profile Creator](.agents/skills/hermes-domain-profile/SKILL.md) — how Hermes should turn “build a scheduled job for X” into a safe domain-agent profile, with sources, cadence, scopes, outputs, proposals, and review boundaries.

Install the public MCP-use skills with the Skills CLI:

```bash
npx skills add https://github.com/Ntrakiyski/shared-living-memory -g -y
```

Only MCP-use skills are public by default. Development/maintainer skills in `.agents/skills/` are marked internal so Skills CLI and skills.sh users do not install them accidentally. If needed, install the MCP-use skills explicitly:

```bash
npx skills add https://github.com/Ntrakiyski/shared-living-memory \
  --skill shared-living-memory-mcp-knowledgebase \
  --skill hermes-domain-profile \
  -g -y
```

The MCP server also exposes `memory://onboarding`, a read-only onboarding resource that tells connected agents to install or load these skills before relying on the raw tool surface.

First-run identity setup for agents:

1. Open [the dashboard](https://shared-living-memory.nikolay-trakiyski.workers.dev/) automatically when the MCP client has browser support, or ask the human to open it.
2. Enter the workspace key.
3. Create or select a username.
4. Copy the generated user API key.
5. Give the username and user API key to the agent/MCP client.

The workspace key is the only shared secret needed to begin setup. User-scoped memory operations should use the username and user API key.

These skills are meant to reduce setup friction. The human should be able to tell Hermes:

> Read the Hermes Domain Profile Creator skill and let's build a scheduled job for `<domain or goal>`.

Then Hermes can help define the profile, sources, cadence, scopes, outputs, proposal behavior, and safety limits without needing direct storage access. The skill creates the operating specification; the actual Hermes runtime and scheduling setup stay outside this repo.

### MCP clients

Use Shared Living Memory from any MCP-compatible client. Requests are scoped by workspace key plus user credentials.

```json
{
  "mcp": {
    "shared-living-memory": {
      "type": "remote",
      "url": "https://shared-living-memory.nikolay-trakiyski.workers.dev/mcp",
      "headers": {
        "Authorization": "Bearer YOUR-WORKSPACE-KEY",
        "X-Shared-Living-Memory-User": "your-username",
        "X-Shared-Living-Memory-User-Key": "slm_your-api-key"
      }
    }
  }
}
```

Human tools include memory capture, recall, append/update, history/restore, graph connections, proposals, and visibility-aware listing.

Service/operator tool availability depends on the service identity’s scopes and current policy decision.

### Integrations

- **Notion:** connect from Settings → Integrations. Shared pages sync into versioned memory. Removed upstream pages are archived/deprecated; hard forget remains an explicit human-only compliance action.
- **Browser/CLI/iOS/Obsidian:** existing upstream capture paths can continue to send memories through the authenticated API/MCP layer.

## Technical architecture

### Runtime

- Cloudflare Workers
- Cloudflare D1
- Cloudflare Vectorize
- Workers AI
- Cloudflare KV
- Static dashboard assets
- Model Context Protocol server
- Scheduled cron maintenance

### Main bindings

| Binding | Purpose |
|---|---|
| `DB` | D1 database for entries, versions, users, proposals, audit, service identities, integrations, and graph history |
| `VECTORIZE` | Semantic vector index for recall and duplicate/relationship detection |
| `AI` | Embeddings and LLM-assisted classification/recall flows |
| `OAUTH_KV` | OAuth and integration state |
| `AUTH_TOKEN` | Workspace-level access key |

### Important modules

| Module | Role |
|---|---|
| [src/routes.ts](src/routes.ts) | REST API and dashboard routes |
| [src/mcp.ts](src/mcp.ts) | MCP tools and actor-scoped tool surface |
| [src/db.ts](src/db.ts) | Ordered migrations and schema validation |
| [src/entry-version-service.ts](src/entry-version-service.ts) | Versioned memory writes, episodes, snapshots, citations, vector cleanup |
| [src/recall.ts](src/recall.ts) | Semantic/keyword/temporal recall and citation rendering |
| [src/visibility.ts](src/visibility.ts) | Visibility transitions and vector metadata synchronization |
| [src/graph.ts](src/graph.ts) | Typed relationship graph, edge history, restore, graph expansion |
| [src/action-proposals.ts](src/action-proposals.ts) | Human-reviewed proposal lifecycle and execution |
| [src/mandatory-audit.ts](src/mandatory-audit.ts) | Fail-closed audit envelope and reconciliation |
| [src/service-identities.ts](src/service-identities.ts) | Service identity and credential lifecycle |
| [src/operator-policy.ts](src/operator-policy.ts) | Operator action policy |
| [src/awareness-events.ts](src/awareness-events.ts) | Cross-user overlap awareness |
| [src/integrations-mirror.ts](src/integrations-mirror.ts) | Tenant-safe integration mirroring |
| [src/lifecycle.ts](src/lifecycle.ts) | Scheduled compression, graph pass, contradiction/staleness jobs |

### Core data model

| Table | Purpose |
|---|---|
| `entries` | Current user-visible memory projection |
| `episodes` | Immutable source ledger |
| `documents`, `document_sections`, `passages` | Citation-grade source structure |
| `entry_snapshots` | Pre-mutation state history |
| `edges` | Current relationship graph |
| `edge_versions` | Immutable edge relationship history and restore ledger |
| `users` | Human accounts and roles |
| `user_deactivations` | Safe deactivation workflow |
| `service_identities`, `service_credentials` | Operator identities and scoped secrets |
| `action_proposals`, `proposal_events` | Human-reviewed action flow |
| `agent_runs`, `agent_events` | Operator/audit run ledger |
| `audit_completion_reconciliation` | Durable audit repair queue |
| `awareness_events` | Cross-user overlap notifications |
| `vector_cleanup_queue` | Retryable stale-vector cleanup |

## API highlights

### Memory

- `POST /capture`
- `POST /append`
- `POST /update`
- `POST /forget`
- `POST /deprecate`
- `POST /entries/:id/visibility`
- `GET /entries/:id/history`
- `POST /entries/:id/restore`
- `POST /entries/:id/reinforce`
- `GET /recall`
- `GET /list`
- `GET /export`

### Graph

- `POST /link`
- `POST /unlink`
- `GET /connections`
- `GET /graph`
- `GET /edges/:id/history`
- `POST /edges/:id/restore`

### Governance

- `GET /action-proposals`
- `POST /action-proposals`
- `POST /action-proposals/:id/review`
- `POST /action-proposals/:id/execute`
- `GET /api/service-identities`
- `POST /api/service-identities`
- credential rotation, revocation, suspension, and service-identity status routes

### Health and maintenance

- `GET /health`
- scheduled cron for graph/compression/integration/audit cleanup work
- local Workerd smoke script in [scripts/smoke-workerd.sh](scripts/smoke-workerd.sh)

## Future product features: translation between mental maps

The foundation is the shared knowledge layer. The product value comes from translation: helping one person or agent understand another person or agent's knowledge in their own context.

Planned features:

- **Opportunity mapping:** when a human or agent captures a discovery, the system maps it to related people, projects, domains, and possible use cases.
- **Personalized explanation:** the same knowledge can be explained differently for Nikolay, Goria, a research scout, an engineering agent, or a quality critic based on their context and goals.

These features should build on the existing provenance, visibility, graph, recall, proposal, and audit foundations. They should not become a separate studio workflow inside this repository.

## Local development

Install dependencies:

```bash
npm ci
```

Run locally:

```bash
AUTH_TOKEN=local-browser-test npm exec -- wrangler dev --local --port 8787
```

Open:

```text
http://127.0.0.1:8787/
```

Local Wrangler does not fully support Vectorize/AI bindings. If you see a red banner saying semantic search is disabled, that is expected in local-only mode. The deployed Cloudflare Worker should use the real bindings.

Run checks:

```bash
npm test
npx tsc --noEmit
npm run smoke:workerd
```

## Deployment

This repository deploys through Cloudflare Workers.

Required Cloudflare resources:

- D1 database: `shared-living-memory-db`
- Vectorize index: `shared-living-memory-vectors`
- Workers AI binding: `AI`
- KV namespace: `OAUTH_KV`
- secret: `AUTH_TOKEN`

The deployed project is configured in [wrangler.jsonc](wrangler.jsonc).

Deployment can happen through Cloudflare’s GitHub integration on pushes to `main`, or manually with:

```bash
CLOUDFLARE_API_TOKEN=... npm run deploy
```

Database schema is managed by ordered runtime migrations in [src/db.ts](src/db.ts). The snapshot in [db/schema.sql](db/schema.sql) is kept in sync for fresh databases and operator visibility.

## Safety principles

- Private memory must never leak through recall, graph, export, integrations, proposals, or vector metadata.
- Every meaningful mutation must be reversible or auditable.
- Hard forget is human-only and reserved for explicit compliance purge.
- Contradiction does not silently supersede knowledge.
- Agents can propose; humans approve consequential changes.
- Hermes and future operators never get direct D1, Vectorize, deployment, or migration access.
- Replacing an operator runtime should require credential rotation, not data migration.

## What this architecture is not built for

Shared Living Memory is intentionally a governed knowledgebase, not an unrestricted agent runtime. It is not designed for:

- **Unreviewed high-impact autonomy.** Agents can scout, draft, and propose; they should not silently publish major knowledge changes, delete data, change permissions, or deploy infrastructure.
- **Direct storage access by agents.** Hermes-style profiles must never receive D1, Vectorize, Cloudflare deployment, migration, or backup credentials.
- **Realtime chat state.** This is durable knowledge and provenance, not a replacement for transient conversation memory or low-latency agent scratchpads.
- **High-frequency event streaming.** It is not Kafka, an analytics warehouse, or a telemetry firehose.
- **Secret storage.** API keys, credentials, and private tokens belong in secret managers, not memory entries, proposals, or audit summaries.
- **Guaranteed truth.** The system preserves evidence, provenance, confidence, and time; humans still judge disputed claims.
- **Fully autonomous compliance actions.** Hard forget and access-control changes remain explicit human-controlled operations.
- **Studio workflow automation.** Client meetings, proposal writing, delivery process, and the broader studio operating model can use Shared Living Memory as context, but they are not implemented in this repo.

## Documentation

- [Vision](docs/VISION.md)
- [System architecture](docs/system-architecture.md)
- [Operator runtime deployment](docs/operator-runtime-deployment.md)
- [Hermes living knowledge agent charter](docs/research/hermes-living-knowledge-agent-charter.md)
- [Memory system docs](docs/memory-system/GOAL.md)
- [Shared knowledge docs](docs/pillar2-shared-knowledge/GOAL.md)
- [Changelog](CHANGELOG.md)

## Attribution

This project builds on [Shared Living Memory for AI](https://github.com/rahilp/second-brain-cloudflare) by Rahil Parikh.

[MIT License](LICENSE)
