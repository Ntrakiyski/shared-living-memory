<p align="center">
  <img src="./assets/readme/hero.svg" width="100%" alt="Shared Living Memory — one governed memory layer for a team and its AI agents">
</p>

<p align="center">
  <a href="https://shared-living-memory.nikolay-trakiyski.workers.dev"><strong>Open the live deployment</strong></a>
  ·
  <a href="#quick-start">Quick start</a>
  ·
  <a href="#connect-an-ai-agent">Connect an agent</a>
  ·
  <a href="docs/team-pilot/operator-runbook.md">Operator runbook</a>
</p>

Shared Living Memory gives a small team and its AI agents **one durable place to preserve decisions, research, sources, preferences, and project context**. Knowledge can move between ChatGPT, Claude, Codex, Cursor, Hermes, or another MCP client without losing who created it, who may see it, where it came from, or how it changed.

It is not another notes app. It is a **governed knowledge layer** for people and agents that need to share context without turning it into an anonymous vector-search dump.

## The value

| Without a shared memory layer | With Shared Living Memory |
| --- | --- |
| Re-explain the same context in each chat, document, and handoff | Capture once, then recall from the dashboard, REST API, or any MCP client |
| Search returns text without enough trust to act on it | Recall returns the author, visibility, source, matched passage, and citation context |
| Shared knowledge and private notes become mixed together | Human memories are private by default; team sharing is deliberate and visible |
| Corrections silently overwrite what used to be known | Append, update, history, snapshots, temporal recall, and restore preserve change over time |
| Agents accumulate broad access and mutate knowledge directly | Personal and service identities operate through scopes, proposals, revision checks, and audit boundaries |

## How it works

<p align="center">
  <img src="./assets/readme/how-it-works.svg" width="100%" alt="Three stages: capture knowledge, govern and retrieve it with identity and provenance, then recall it with evidence">
</p>

1. **Capture** — people and agents save useful knowledge through the dashboard, REST, or MCP.
2. **Govern** — each entry keeps an owner, private/public scope, provenance, epistemic status, revision, episodes, and snapshots.
3. **Retrieve** — recall combines semantic, keyword, tag, graph, and temporal paths while excluding deprecated, superseded, or retracted knowledge from current answers.
4. **Use with evidence** — results identify the author and scope and cite the passage that actually matched, so another person or agent can judge the answer rather than merely trust it.

## What it enables

| Capability | Why it matters |
| --- | --- |
| **Shared team memory** | Public entries become reusable team knowledge while each person keeps a private workspace. |
| **Context across AI tools** | The same governed knowledge is available through MCP instead of being trapped in one chat history. |
| **Translation between mental maps** | A discovery captured by one person or domain agent can be explained in the context of another person, project, or specialty. |
| **Trustworthy correction** | Append, update, status changes, history, and restore let knowledge evolve without rewriting the past. |
| **Explicit relationships** | Link supporting, contradicting, derived, limiting, or generally related knowledge into a navigable graph. |
| **Operable erasure and offboarding** | Confirmed permanent deletion, metadata-only receipts, private-data export, and user deactivation provide clear lifecycle boundaries. |

## Connect an AI agent

Shared Living Memory exposes an MCP server. Use a **personal API key** as the bearer token:

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

## Quick start

### Run locally

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

Then open `http://localhost:8787`, create the first administrator, and copy the generated personal API key when it is shown.

### Verify the project

```bash
npm test
npm run typecheck
```

The current pilot-readiness implementation is backed by **1,124 tests across 106 files**, a clean TypeScript typecheck, health/readiness endpoints, and a scheduled production canary.

## Technical foundation

| Boundary | Implementation |
| --- | --- |
| Application | Cloudflare Worker with dashboard, REST API, MCP endpoint, and scheduled lifecycle jobs |
| Durable authority | Cloudflare D1 — current projections, immutable episodes, snapshots, relationships, identities, and governance state |
| Retrieval index | Cloudflare Vectorize — 384-dimensional cosine index that can be rebuilt from D1 |
| AI | Workers AI for embeddings and grounded answer generation |
| Identity | Personal HMAC-SHA-256 API keys plus scoped service identities |
| Privacy | Private-by-default human capture, owner-aware reads, scoped vector metadata, and content-free operational logs |

**Core invariant:** D1 is authoritative. Vectorize accelerates retrieval, but it is disposable and rebuildable. Audits and metrics store identifiers, hashes, counts, and timings—not memory bodies, raw queries, credentials, or model prompts.

## Pilot scope

The repository is prepared for a bounded **3–5 person internal team pilot**. The completed readiness plan covers safe capture/export, semantic retrieval, trustworthy citations, permanent erasure, human identity and key lifecycle, MCP onboarding, visibility and correction UX, privacy-safe recall feedback, observability, recovery, and launch rehearsal.

- [Pilot implementation plan](docs/superpowers/plans/2026-08-01-team-pilot-readiness.md)
- [Participant guide](docs/team-pilot/participant-guide.md)
- [Operator runbook](docs/team-pilot/operator-runbook.md)
- [Evaluation scorecard](docs/team-pilot/evaluation-scorecard.md)

## Project boundaries

Shared Living Memory is intentionally **not** a general note-taking product, a general-purpose vector database, or an autonomous agent runtime. External agents such as Hermes use it through governed MCP/REST access; they do not bypass its identity, visibility, history, or audit rules.

## License

[MIT](LICENSE)
