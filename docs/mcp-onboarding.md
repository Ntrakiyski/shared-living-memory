# Shared Living Memory MCP Onboarding

Shared Living Memory exposes tools for memory capture, recall, graph links, citations, history, and governed proposals. Tools are the action surface. Skills are the behavior layer that teach an agent how to use those tools well.

When an MCP client connects to Shared Living Memory, read this resource before using the tools. If the client supports installable skills, install the Shared Living Memory MCP-use skills from this repository.

## Recommended install

Install only the public MCP-use skills:

```bash
npx skills add https://github.com/Ntrakiyski/shared-living-memory -g -y
```

This repository also contains development skills for maintainers, but those are marked internal and are hidden from default `skills` discovery. The default install is intended for people who want to use Shared Living Memory through MCP, not work on the Shared Living Memory codebase.

If a client or older Skills CLI shows extra development skills, use the explicit filter:

```bash
npx skills add https://github.com/Ntrakiyski/shared-living-memory \
  --skill shared-living-memory-mcp-knowledgebase \
  --skill hermes-domain-profile \
  -g -y
```

Preview the public skill set:

```bash
npx skills add https://github.com/Ntrakiyski/shared-living-memory --list
```

## Public MCP-use skills

- `shared-living-memory-mcp-knowledgebase` — how agents should use Shared Living Memory as a governed memory and translation layer: recall first, capture durable context, cite evidence, respect privacy, use graph links, inspect history, and route consequential actions through proposals.
- `hermes-domain-profile` — how to define a safe Hermes-style domain agent or scheduled job that operates through Shared Living Memory with explicit sources, cadence, permissions, outputs, proposal behavior, and review boundaries.

## First-run identity setup

Before using memory tools, make sure the human has a user identity. The only shared secret needed to start is the workspace key. If the client has browser support, open the dashboard automatically as the first onboarding action; otherwise show the link and ask the human to open it.

1. Open the dashboard: <https://shared-living-memory.nikolay-trakiyski.workers.dev/>.
2. Enter the workspace key to connect.
3. Select an existing username or create a new username.
4. Copy the generated user API key immediately; it is shown once.
5. Ask the human to provide the username and user API key to the agent or MCP client configuration.

For MCP clients that use headers, configure:

```json
{
  "Authorization": "Bearer YOUR-WORKSPACE-KEY",
  "X-Shared-Living-Memory-User": "your-username",
  "X-Shared-Living-Memory-User-Key": "slm_your-user-api-key"
}
```

Do not store, log, or remember the workspace key or user API key as memory entries.

## Tool/resource split

- Use skills for operating behavior: when to recall, what to capture, how to tag, when to use proposals, and what safety boundaries apply.
- Use MCP tools for actions: `remember`, `recall`, `append`, `update`, `passages`, `history`, `link`, `connections`, and proposal tools.
- Use MCP resources for stable context: onboarding, usage guidance, and future read-only knowledge surfaces.

## First-use behavior for agents

1. Install or load the MCP-use skills above when possible.
2. If no username and user API key are configured, open the dashboard automatically when possible and guide the human through the identity setup above before calling tools.
3. Start every conversation with an intent-framed `recall`, not bare keywords.
4. Use `hops: 1` or `hops: 2` when tracing causes, decisions, consequences, or relationships.
5. Store only durable, valuable information; never store secrets.
6. Prefer citation-backed answers and use `passages` when evidence matters.
7. Use proposal flows for uncertain, cross-user, consequential, or governed actions.

If skills cannot be installed, follow the guidance in this resource and the `shared-living-memory-mcp-knowledgebase` skill manually.
