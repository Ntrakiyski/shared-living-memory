<p align="center">
  <img src="./assets/readme/hero.svg" width="100%" alt="Shared Living Memory keeps decisions, client context, research, and AI findings reusable across a growing team">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/runtime-cloudflare_workers-A6E9CC?style=flat-square&labelColor=1E1B16" alt="Runtime: Cloudflare Workers">
  <img src="https://img.shields.io/badge/storage-D1_%2B_Vectorize-A6E9CC?style=flat-square&labelColor=1E1B16" alt="Storage: D1 + Vectorize">
  <img src="https://img.shields.io/badge/license-MIT-A6E9CC?style=flat-square&labelColor=1E1B16" alt="License: MIT">
  <a href="https://github.com/Ntrakiyski"><img src="https://img.shields.io/badge/fractals-studio-FA5C2C?style=flat-square&labelColor=1E1B16" alt="Fractals Studio"></a>
</p>

<p align="center">
  <a href="https://shared-living-memory.nikolay-trakiyski.workers.dev"><strong>Open the live deployment</strong></a>
  ·
  <a href="#one-decision-reused-across-the-whole-team">See the team workflow</a>
  ·
  <a href="#connect-an-ai-agent">Connect an agent</a>
  ·
  <a href="#run-locally">Run locally</a>
</p>

Important knowledge is created all day—in client calls, project chats, documents, code reviews, and conversations with AI. As the team grows, that knowledge becomes fragmented. People repeat the same explanations, new teammates rebuild context from old threads, and handoffs carry the final answer but lose the reasoning behind it.

**Shared Living Memory adds one governed knowledge layer behind those tools.** Decisions, client context, research, sources, preferences, and operating know-how can be captured once and reused by people and agents without losing ownership, privacy, history, or evidence.

It is designed to reduce repeated explanations, shorten onboarding, preserve decision rationale through handoffs, and keep human and AI work aligned with the team's current knowledge.

## What changes as the team grows

| Team moment | What the shared layer preserves |
| --- | --- |
| A project moves to a new owner | The decision, the reason behind it, its source, and the current status move with the work. |
| A new teammate joins | They can retrieve current context and follow the evidence instead of asking several people to reconstruct it. |
| Someone starts work in an AI tool | The agent retrieves governed team knowledge instead of depending on copied chat history or a manually attached document. |
| An assumption or decision changes | The current answer can change without erasing what was previously known or why it changed. |
| A teammate or agent leaves | Public team knowledge can remain useful while private data, credentials, and access follow explicit offboarding rules. |

## One decision, reused across the whole team

Consider a client approving a scope change:

1. A project owner captures the decision, the reasoning, the source, and who may see it.
2. Engineering asks about the scope from an MCP-connected agent and receives the current decision with its citation.
3. Sales or operations asks the same question and receives an explanation in the context of their work.
4. A new teammate joins later and can see both the current answer and how it evolved.
5. If the decision is reversed, the previous state remains in history while outdated or retracted knowledge stops appearing as current truth.

The value is not only that the decision was stored. **The reasoning survives every handoff.**

## How the shared layer works

<p align="center">
  <img src="./assets/readme/how-it-works.svg" width="100%" alt="Knowledge is captured during work, kept trustworthy with ownership and history, and reused by people and AI tools with evidence attached">
</p>

1. **Capture during work** — people and agents save useful decisions, client context, research, sources, and discoveries through the dashboard, REST API, or MCP.
2. **Keep it trustworthy** — every important item keeps its owner, visibility, provenance, status, revision, immutable episodes, and version snapshots.
3. **Reuse it in context** — people and agents ask from the tools they already use and receive the current answer with the author, scope, source, and matched evidence attached.

## More than searchable notes

Search can return matching text. Shared Living Memory is designed to return **usable context**.

A useful answer needs more than the memory body:

- **Original meaning** — who captured it, what they meant, and why it mattered.
- **Recipient context** — how the same knowledge applies to another role, project, or agent domain.
- **Evidence** — the source and matched passage that support the answer.
- **Change awareness** — whether the knowledge is current, superseded, deprecated, retracted, or contradicted.
- **A path back** — links, history, snapshots, and related entries that let someone inspect rather than blindly trust the result.

This is the translation layer between different mental maps. An engineering decision can be explained for sales. A research repository saved by one person can be mapped to another team's current project. An AI finding can remain a proposal until a human reviews it instead of silently becoming shared truth.

## Why the team can rely on it

| Guardrail | Behavior |
| --- | --- |
| **Clear ownership** | Every entry belongs to a human or scoped service identity; shared knowledge never becomes anonymous by default. |
| **Private by default** | New human memories begin private. Publishing to the team is a deliberate visibility change. |
| **Citation-backed recall** | Results identify the author, visibility, source, and passage that actually matched the query. |
| **Versioned truth** | Append, update, history, temporal recall, and restore preserve how knowledge changed without rewriting the past. |
| **Status-aware retrieval** | Deprecated, superseded, or retracted knowledge is excluded from current answers while remaining inspectable in history. |
| **Governed agents** | Service identities use explicit scopes, revision checks, proposals, and audit boundaries instead of unrestricted database access. |
| **Erasure and offboarding** | Permanent deletion requires confirmation; private export, deactivation, transfer, and cleanup follow explicit lifecycle rules. |
| **Content-free operations** | Logs, audits, and metrics store identifiers, hashes, counts, and timings—not memory bodies, raw queries, credentials, or model prompts. |

## Use it where work already happens

**Dashboard**  
Humans can capture, recall, correct, link, inspect history, manage visibility, and administer the workspace.

**MCP**  
AI assistants and domain agents can use the same governed knowledge through personal or scoped service identities.

**REST API**  
Internal tools, automations, and integrations can capture or retrieve knowledge without bypassing the same ownership and privacy model.

## Connect an AI agent

Use a **personal API key** as the bearer token for an MCP-capable client:

```json
{
  "mcpServers": {
    "shared-living-memory": {
      "url": "https://shared-living-memory.nikolay-trakiyski.workers.dev/mcp",
      "headers": {
        "Authorization": "Bearer slm_YOUR_USER_API_KEY"
      }
    }
  }
}
```

The checked-in agent skill at [`.agents/skills/shared-living-memory-mcp-knowledgebase/SKILL.md`](.agents/skills/shared-living-memory-mcp-knowledgebase/SKILL.md) defines the intended capture, recall, privacy, history, linking, and translation behavior.

<details>
<summary><strong>Available MCP tools</strong></summary>

| Tool | Purpose |
| --- | --- |
| `remember` | Capture durable knowledge |
| `recall` | Semantic and temporal retrieval with citations |
| `append` | Add information without replacing the current entry |
| `update` | Create a new current projection |
| `set_status` | Mark knowledge canonical, outdated, deprecated, or otherwise governed |
| `link` / `unlink` | Manage explicit graph relationships |
| `connections` | Inspect one-hop related entries |
| `history` / `restore` | Inspect versions and restore from an immutable snapshot |
| `forget` | Permanently erase an entry with explicit confirmation |
| `rate_recall` | Record privacy-safe helpful/not-helpful pilot feedback |

</details>

## Technical foundation

| Boundary | Implementation |
| --- | --- |
| Application | Cloudflare Worker with dashboard, REST API, MCP endpoint, and scheduled lifecycle jobs |
| Durable authority | Cloudflare D1 for current projections, immutable episodes, snapshots, relationships, identities, and governance state |
| Retrieval index | Cloudflare Vectorize with a 384-dimensional cosine index that can be rebuilt from D1 |
| AI | Workers AI for embeddings and server-grounded answer generation |
| Identity | Personal HMAC-SHA-256 API keys plus scoped service identities |
| Privacy | Owner-aware reads, private-by-default capture, scoped vector metadata, and content-free operational logs |

**Core invariant:** D1 is authoritative. Vectorize accelerates retrieval, but it is disposable and rebuildable. Removing an entry from the durable authority does not depend on the vector index remaining healthy.

## Current validation scope

The product direction is a shared memory layer for a growing team. The current repository is prepared for a bounded **3–5 person internal pilot**, rather than claiming organization-wide production readiness.

The pilot-readiness implementation currently includes:

- **1,124 tests across 106 files**
- a clean TypeScript typecheck
- health and readiness endpoints
- a scheduled production canary with incident handling
- safe bootstrap, personal-key rotation, and user lifecycle controls
- permanent erasure with metadata-only receipts
- participant, operator, recovery, and evaluation documentation

## Run locally

```bash
git clone https://github.com/Ntrakiyski/shared-living-memory.git
cd shared-living-memory
npm install
cp .dev.vars.example .dev.vars
npm run dev
```

`.dev.vars` needs one workspace bootstrap secret:

```dotenv
AUTH_TOKEN=replace-with-a-secure-workspace-key
```

Open `http://localhost:8787`, create the first administrator, and copy the generated personal API key when it is shown.

### Verify the project

```bash
npm test
npm run typecheck
```

## Documentation

| Document | Purpose |
| --- | --- |
| [Participant guide](docs/team-pilot/participant-guide.md) | How a teammate captures, recalls, corrects, rates, exports, and leaves the pilot |
| [Operator runbook](docs/team-pilot/operator-runbook.md) | Bootstrap, administration, staging, incidents, recovery, and offboarding |
| [Evaluation scorecard](docs/team-pilot/evaluation-scorecard.md) | Pilot gates and metrics used to decide whether to expand, revise, or stop |
| [Pilot implementation plan](docs/superpowers/plans/2026-08-01-team-pilot-readiness.md) | Architecture, constraints, tasks, and acceptance criteria |
| [Agent skill](.agents/skills/shared-living-memory-mcp-knowledgebase/SKILL.md) | Operating instructions for humans and AI agents using the MCP knowledgebase |

## Project boundaries

Shared Living Memory is not intended to replace the team's documents, project tracker, or communication tools. It sits behind them as the durable context layer.

It is also not a general-purpose vector database or an autonomous agent runtime. External agents use it through governed MCP or REST access and do not bypass identity, visibility, history, or audit rules.

## License

[MIT](LICENSE)

---

<p align="center"><sub>Built by <a href="https://github.com/Ntrakiyski">Fractals</a></sub></p>
