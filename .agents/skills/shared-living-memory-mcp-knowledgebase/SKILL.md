---
name: shared-living-memory-mcp-knowledgebase
description: "Use when an agent or human wants to connect to Shared Living Memory through MCP and use it as a living team knowledgebase: capture knowledge, recall with citations, respect privacy, create links, inspect history, and translate knowledge between different people or agent domains. Also loads when memory tools are invoked, when the user mentions Shared Living Memory, or when a memory lifecycle decision is needed."
---

# Shared Living Memory MCP Knowledgebase

Use this skill after Shared Living Memory is connected through MCP, or when helping a human/agent decide how to use the knowledgebase safely.

Shared Living Memory is a governed team knowledgebase. Treat entries as durable knowledge with owners, visibility, provenance, versions, citations, relationships, and audit boundaries.

**For the full memory lifecycle operating manual (when to use each tool, decision trees, stage transitions), load `slm-memory-lifecycle`.** This skill covers setup, core concepts, and safety rules.

## Memory lifecycle

```
CAPTURE → RECALL → VERIFY → MAINTAIN → LINK → DEPRECATE → FORGET/RESTORE
```

Every entry follows this path. See `slm-memory-lifecycle` for the detailed decision tree at each stage.

## First-run identity setup

Before using memory tools, make sure the human has a user identity. The workspace key is only the workspace/transport key; useful agent memory requires a username and user API key. If the client has browser support, open the dashboard automatically as the first onboarding action; otherwise show the link and ask the human to open it.

1. Open <https://shared-living-memory.nikolay-trakiyski.workers.dev/>.
2. Ask the human to enter the workspace key in the dashboard (first-time bootstrap) or sign in with their personal API key.
3. For first-time setup: have them create an administrator username and copy the generated API key immediately; it is shown once.
4. For existing workspaces: the human signs in with their personal API key directly.
5. Ask them to provide the username and user API key to the agent or MCP client configuration.

For header-based MCP clients, use:

```json
{
  "Authorization": "Bearer YOUR-WORKSPACE-KEY",
  "X-Shared-Living-Memory-User": "your-username",
  "X-Shared-Living-Memory-User-Key": "slm_your-user-api-key"
}
```

The personal-bearer path (API key as the Bearer token, no separate user headers) is also supported for clients that prefer a single credential. Never call `remember` with the workspace key or user API key. Secrets are setup credentials, not memories.

## Core product frame

The real product is translation between different mental maps.

1. **Shared knowledge layer** — humans and agents capture what they know.
2. **Translation layer** — explain one person/agent's knowledge in another person/agent's context.
3. **Living organism / Hermes layer** — proactive agents scout, draft, link, and propose maintenance through governed tools.

Do not treat Shared Living Memory as a dumping ground. Every useful write should improve future recall, translation, or decision quality.

## Before using tools

Identify:

- actor: human user or service/domain agent;
- purpose: capture, recall, translate, link, inspect, or propose;
- audience: who should benefit from this knowledge later;
- visibility: private or public;
- source: where the knowledge came from;
- confidence: fact, hypothesis, preference, idea, draft, or decision.

If visibility is unclear, default to private or ask.

## Capture workflow

Use `remember` / capture when knowledge is worth preserving.

Good captures include:

- decisions and why they were made;
- discovered tools/repos/articles and possible uses;
- source-backed claims and citations;
- client/project context;
- personal preferences and working style;
- open questions and hypotheses.

When capturing, include:

- concise summary;
- why it matters;
- source URL or origin when available;
- tags such as project, domain, person, tool, status, or epistemic state;
- intended audience if shared.

Avoid storing:

- secrets, API keys, passwords, tokens;
- raw private transcripts unless explicitly allowed;
- low-value scratchpad thoughts;
- claims without context when source is available.

## Recall workflow

Use recall to answer from evidence, not vibes.

When recalling:

1. Ask a specific question.
2. Include relevant tags/projects/people when known.
3. Use temporal filters when the question is about what was believed at a past time.
4. Prefer cited answers.
5. If evidence conflicts, cite both sides and name the conflict.
6. If evidence is insufficient, say so and propose what to capture or research next.

Useful recall prompts:

- "What do we know about `<topic>` and what are the strongest sources?"
- "What did `<person>` believe about `<topic>` around `<date>`?"
- "What public knowledge connects to this private project?"
- "What changed since last time?"
- "What should I read before deciding?"

## Translation between mental maps

When translating knowledge from one person/agent to another, produce:

1. **Source knowledge** — what was captured and by whom.
2. **Why the source actor cared** — their intent or mental model.
3. **Recipient context** — what the recipient already knows or is trying to do.
4. **Bridge** — how the source knowledge maps to the recipient's problems.
5. **New use cases** — uses the source actor may not have imagined.
6. **Questions** — what the recipient should explore next.
7. **Suggested links/proposals** — relationships worth adding or reviewing.

Example:

> Nikolay saved this repo as an automation building block. For Goria, it may be useful as an evaluation workflow tool because it connects to her notes on data quality and model assessment. Possible uses: clean dataset reports, benchmark dashboards, and experiment QA. Questions: Does it support repeatable metrics? Can it export audit-friendly results?

## Relationship workflow

Use links to make knowledge reusable.

Good relationship types:

- `relates_to` — general connection;
- `supports` — evidence strengthens another entry;
- `contradicts` — evidence conflicts;
- `derives_from` — one item came from another;
- `has_limitation` — caveat or boundary;
- `evaluates_on` — benchmark/evaluation relationship;
- `clarifies` — explanation improves understanding.

Do not create a relationship just because two entries share a keyword. Explain the reason.

For cross-user or consequential links, prefer proposal/review if available.

## History and restore

Before updating or replacing important knowledge:

1. Inspect current state and history.
2. Preserve source and reasoning.
3. Prefer append for new information.
4. Use update only when replacing the current projection is intended.
5. Restore only as a new version, never as a rewrite of the past.

## Safety rules

- Never ask for or store secrets.
- Never expose another user's private entries.
- Never use public visibility without a clear sharing reason.
- Never treat an agent draft as canonical without review.
- Never hard-delete unless a human explicitly asks for compliance purge.
- Never claim truth beyond the cited evidence.

## Output patterns

For ordinary recall:

```text
Answer
Evidence
What is uncertain
Suggested next action
```

For translation:

```text
Source actor's meaning
Recipient-specific meaning
New opportunities
Risks / missing evidence
Suggested links or captures
```

For capture proposal:

```text
Proposed entry
Visibility
Tags
Source
Why it matters
Related entries to link
```
