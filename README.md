<!-- PROJECT HERO -->
<div align="center">
  <img src="assets/readme-hero.svg" alt="Shared Living Memory — a governed team knowledgebase running on Cloudflare Workers" width="100%"/>
</div>

---

## What is Shared Living Memory?

**A governed, multi-user knowledgebase that runs entirely on Cloudflare's edge.** Every entry has an owner, a visibility scope, versioned episodes, immutable snapshots, bitemporal lookup, and citation-backed recall. D1 is the single durable authority; Vectorize is a rebuildable retrieval index.

It is designed for teams of 3&ndash;5 people who want shared knowledge, not a search engine. The real product is **translation between different mental maps** &mdash; explaining one person's knowledge in another person's context.

### What it is not

- Not a note-taking app
- Not a general-purpose vector database
- Not an autonomous agent platform
- Not a replacement for Notion, Obsidian, or Google Docs

---

## Architecture

<div align="center">
  <table>
    <tr>
      <td align="center"><b>API</b></td>
      <td align="center"><b>Auth</b></td>
      <td align="center"><b>Storage</b></td>
      <td align="center"><b>Retrieval</b></td>
      <td align="center"><b>AI</b></td>
    </tr>
    <tr>
      <td align="center">REST + MCP</td>
      <td align="center">HMAC-SHA-256<br/>personal API keys</td>
      <td align="center">D1 (SQLite at edge)<br/>single durable authority</td>
      <td align="center">Vectorize<br/>384-dim cosine<br/>rebuildable from D1</td>
      <td align="center">Workers AI<br/>embeddings + LLM</td>
    </tr>
  </table>
</div>

**Key invariant:** D1 is authoritative. Vectorize can be completely rebuilt from the current D1 state. Logs, audits, and metrics store identifiers, counts, timings, and hashes &mdash; never memory bodies, query text, credentials, or model prompts.

---

## Proven

| | |
|---|---|
| **Test suite** | 1,124 tests across 106 files |
| **Type safety** | Full TypeScript, `tsc --noEmit` clean |
| **Coverage** | 79% statements &middot; 70% branches &middot; 86% functions |
| **CI** | GitHub Actions: typecheck + full suite + dependabot |
| **Deployment** | [shared-living-memory.nikolay-trakiyski.workers.dev](https://shared-living-memory.nikolay-trakiyski.workers.dev) |
| **Canary** | 5-minute pilot canary with automated incident issues |

---

## Quick start

```bash
git clone https://github.com/Ntrakiyski/shared-living-memory.git
cd shared-living-memory
npm install              # uses legacy-peer-deps (.npmrc)
cp .dev.vars.example .dev.vars
npm run dev              # wrangler dev --local
```

```bash
npm test                 # all 1,124 tests (vitest)
npm run typecheck        # wrangler types + tsc --noEmit
```

### First admin bootstrap

```bash
# Check if workspace needs bootstrap
curl http://localhost:8787/api/bootstrap-status

# Create the first administrator (requires workspace key)
curl -X POST http://localhost:8787/api/bootstrap \
  -H "Authorization: Bearer YOUR-WORKSPACE-KEY" \
  -H "Content-Type: application/json" \
  -d '{"username":"admin"}'
# {"ok":true,"username":"admin","key":"slm_xxxxx.yyyyyyyy"}
```

---

## MCP integration

Shared Living Memory is an MCP server. Connect any MCP-capable client with a personal API key:

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

**Agent skills**: `.agents/skills/shared-living-memory-mcp-knowledgebase/SKILL.md` contains the authoritative AI agent instructions for using Shared Living Memory through MCP.

### MCP tools

| Tool | Description |
|---|---|
| `remember` | Capture a durable memory |
| `recall` | Semantic + temporal search with citations |
| `append` | Add new information without replacing |
| `update` | Replace the current entry projection |
| `set_status` | Mark deprecated, outdated, or canonical |
| `link` / `unlink` | Manage explicit graph relationships |
| `connections` | Inspect one-hop neighbor entries |
| `history` / `restore` | Inspect versions and restore from snapshots |
| `forget` | Permanent compliance erasure (requires confirmation) |
| `rate_recall` | Feedback for pilot metrics (analytics only) |

---

## Pilot readiness (August 2026)

The `codex/slm-team-pilot-readiness` branch delivers a 10-task implementation plan for a limited 3&ndash;5 person team pilot:

| # | Task | Status |
|---|---|---|
| 1 | Safe capture and export | Done |
| 2 | Restore production semantic retrieval | Done |
| 3 | Make recall, citations, and answers trustworthy | Done |
| 4 | Complete permanent erasure and remove content from audit | Done |
| 5 | Reliable identity, administration, and human key lifecycle | Done |
| 6 | Make the documented MCP journey real | Done |
| 7 | Make correction, attribution, and visibility understandable | Done |
| 8 | Add privacy-safe recall receipts, feedback, and evaluation | Done |
| 9 | Stage, observe, secure, and recover the service | Done |
| 10 | Rehearse and document the pilot launch | Done |

Full plan: [docs/superpowers/plans/2026-08-01-team-pilot-readiness.md](docs/superpowers/plans/2026-08-01-team-pilot-readiness.md)

---

## Key design decisions

**Privacy by default.** New human memories are private. Publishing to the team is always deliberate and visible.

**D1 is authoritative.** Vectorize is a rebuildable index. A Vectorize outage never leaves searchable content after the D1 projection is gone.

**Content-free audits.** Mandatory audit events store operation IDs, result counts, timings, and SHA-256 hashes &mdash; never raw content, query text, credentials, or model prompts.

**Personal API keys only.** The workspace key is a transport gate. Every user authenticates with their own HMAC-SHA-256 hashed API key. No passwords.

**Optimistic revision checks.** Two concurrent edits cannot silently overwrite each other. Every mutation carries a revision token.

**Versioned, immutable history.** Append creates a new episode. Update creates a new version. Restore creates a new entry from a snapshot. History is never rewritten.

---

## Documentation

| Document | Audience |
|---|---|
| [Participant Guide](docs/team-pilot/participant-guide.md) | Pilot users |
| [Operator Runbook](docs/team-pilot/operator-runbook.md) | Administrators |
| [Evaluation Scorecard](docs/team-pilot/evaluation-scorecard.md) | Decision makers |
| [Architecture Plan](docs/superpowers/plans/2026-08-01-team-pilot-readiness.md) | Contributors |
| [Agent Skill](.agents/skills/shared-living-memory-mcp-knowledgebase/SKILL.md) | AI agents |

---

## License

MIT
