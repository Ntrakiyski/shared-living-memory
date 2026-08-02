---
name: slm-team-translation
description: The translation layer for Shared Living Memory — teaches agents how to explain one person's knowledge in another person's context. Use when bridging mental maps between team members, when a user asks "what does X know about Y", or when context-switching between different people's perspectives.
---

# SLM Team Translation

The real product of Shared Living Memory is **translation between different mental maps** — explaining one person's knowledge in another person's context. This skill teaches the deterministic process for cross-person knowledge bridging.

## When to translate

| Trigger | Action |
|---|---|
| User asks "what does Alice know about X?" | Translate Alice's memories for the current user |
| User asks "what should I know before talking to Bob?" | Translate relevant team knowledge into prep context |
| You're switching between projects/people | Check what's publicly shared, bridge the gap |
| Multiple entries from different people on the same topic | Synthesize across perspectives |

## Translation process

### Step 1: Gather source knowledge

```
recall with tag or user filter to find the source person's perspective
├── Use `recall` with query about the topic
├── Filter by the source person's entries (check owner_username in results)
├── Use `connections` to find linked context
└── Use `passages` for source text from their entries
```

### Step 2: Understand source intent

For each relevant entry from the source person, identify:
- **What they captured** — the explicit content
- **Why they captured it** — tags, source, and context clues
- **Their confidence** — epistemic status (canonical = confirmed, draft = tentative)
- **What they linked to** — connections reveal their mental model

### Step 3: Map to recipient context

```
recall with the recipient's perspective
├── What does the recipient already know about this topic?
├── What projects/domains does the recipient work in?
├── What problems is the recipient currently solving?
└── What terminology does the recipient use?
```

### Step 4: Build the bridge

For each piece of source knowledge, produce:

```
1. Source knowledge — what was captured, by whom, and their confidence
2. Why the source cared — their intent or mental model
3. Recipient context — what the recipient already knows
4. Bridge — how the source's knowledge maps to the recipient's problems
5. New use cases — uses the source may not have imagined
6. Risks — missing evidence, conflicts, outdated information
7. Suggested links — relationships worth adding between the two perspectives
```

### Step 5: Output format

```text
## What {source person} knows about {topic}

{entry summary}
Source: {source person} · {date} · {epistemic status}
Why they captured it: {intent}

## What this means for {recipient}

{bridged explanation in recipient's context}

## New opportunities

{what the recipient could do with this}

## Gaps and risks

{conflicts, missing evidence, outdated claims}

## Suggested captures

{what the recipient should store after reading this}
```

## Multi-person synthesis

When bridging across 3+ people:

```
For each person:
├── `recall` with their perspective (use tag or content clues)
├── Identify their unique angle on the topic
└── Note their confidence level

Then synthesize:
├── Agreed facts (multiple canonical entries agree)
├── Disputed areas (entries contradict or differ)
├── Knowledge gaps (nobody has captured this yet)
└── Suggested proposals (use `propose_edge` to connect contradictory entries)
```

## Safety rules for translation

1. **Never expose private entries.** Only use entries visible to the recipient. Check `is_private` flag.
2. **Never fabricate connections.** Only link entries that genuinely relate.
3. **Always cite sources.** "According to {person}'s entry from {date}..."
4. **Respect epistemic status.** A draft from one person is not equal to a canonical entry from another.
5. **Propose, don't declare.** For cross-user links, use `propose_edge`, not `link`.
