---
name: slm-memory-lifecycle
description: The full operating manual for Shared Living Memory — teaches agents the complete journey of a memory through all lifecycle stages (capture → recall → verify → maintain → deprecate → forget/restore). Use when working with Shared Living Memory tools, when the user asks how to use the memory system, when memories need updating or deprecation, or when evidence conflicts.
---

# SLM Memory Lifecycle

Every memory in Shared Living Memory travels through stages. This skill teaches the deterministic process for each stage — same decision tree every run, different outcomes based on the data.

The three rules that govern everything:
1. **Private by default.** Never make a memory public unless the user explicitly asks.
2. **Evidence over vibes.** Recall cites sources. If evidence conflicts, cite both sides and name the conflict.
3. **Never hard-delete implicitly.** Prefer deprecation. Forget is compliance-only and requires explicit user instruction.

---

## Stage 1: Capture — when to store a memory

### Trigger decision tree

```
User shares information
├── Is it a secret / API key / password? → NEVER store. Skip.
├── Is it a transient scratchpad thought? → Skip.
├── Is it a decision, preference, fact, source, or commitment?
│   └── Store with `remember`. Include:
│       content: One concise sentence explaining what + why it matters.
│       tags:    At least one broad tag (personal, work, task, decision, source, project-name).
│       source:  The client identity (codex, claude-desktop, chatgpt, browser).
│       visibility: Omit (defaults to private) unless user explicitly asks for public.
├── Is the user explicitly asking you to remember something?
│   └── Store with `remember`. Always tag with what the user asked for.
└── Is it a correction or addition to an existing memory?
    └── Go to Stage 4 (Maintain), not capture.
```

### Auto-capture triggers (do these without asking)

| Trigger | Action |
|---|---|
| User states a goal or preference | `remember` with tag `preference` |
| User makes a decision | `remember` with tag `decision` |
| User shares project context | `remember` with tag `context` + project name |
| User gives a commitment or task | `remember` with tag `task` |
| You discover a useful source/URL | `remember` with tag `source` + `source_url` |
| Conversation reveals something reusable | `remember` with tag `agent-response` + `codex-response` / `claude-response` |

### Ask-before-capture triggers (always ask first)

| Trigger | Action |
|---|---|
| User shares something personal/private | Ask: "Should I store this?" |
| Unclear if information is durable | Ask: "Is this worth remembering for later?" |
| Large block of text/transcript | Ask: "Should I capture a summary of this?" |

---

## Stage 2: Recall — how to search memory

### When to recall

- **Start of every conversation.** Frame with intent: "User wants to ${goal} — what should I know?"
- **Before making recommendations.** Check if already completed/rejected/superseded.
- **Before asking a clarifying question.** Check if the answer already exists in memory.
- **Every 3-4 messages.** Keep context fresh.

### How to frame a query

```
recall arguments:
  query:   Natural language with intent + topic. Not bare keywords.
           Good: "What decisions did we make about the deployment pipeline?"
           Bad:  "deployment pipeline"

  hops:    0 for direct recall (default)
           1-2 when tracing why/how (linked context could change the answer)

  as_of:   Unix ms timestamp — "what was true at that time?"
  known_at: Unix ms timestamp — "what did the team know then?"

  tag:     Filter to one tag when narrowing scope
  kind:    "episodic" for events/timeline, "semantic" for facts/knowledge
```

### Interpreting results

```
Recall returns results
├── Results found with citations
│   └── Answer from evidence. Cite the source entry IDs.
│       If multiple entries agree → strong signal.
├── Results found but evidence conflicts
│   └── Cite BOTH sides. Name the conflict explicitly.
│       "Entry A says X (from codex on 8/1). Entry B says Y (from claude on 8/2)."
├── No results found
│   └── Say so. Propose what to capture or research next.
│       Never fabricate an answer from missing evidence.
└── Graph results (hops > 0)
    └── Mark as "related · N hops". Distinguish from direct matches.
```

---

## Stage 3: Verify — checking what you found

Before acting on recalled information, verify:

1. **Is it still current?** Check `epistemic_status`. `superseded` or `retracted` = do not use as authority.
2. **Is it yours?** Check `is_owned`. You can only update/append/forget entries you own.
3. **Is it private?** Check `is_private`. Never expose another user's private entry.
4. **Are the citations real?** Check `passages` for the entry to read the source text chunks.

```
recall returns entry with ID
├── Use `passages` to read source text chunks
├── Check epistemic_status
│   ├── canonical / reviewed / qualified → authoritative, use it
│   ├── candidate / draft → use with caution, note uncertainty
│   └── superseded / retracted → do not use, find the newer version
├── Use `connections` to see linked entries
└── Use `history` to see past versions (owned entries only)
```

---

## Stage 4: Maintain — update, append, and correct

### Decision tree: append vs update vs set_status

```
Memory needs a change
├── Adding new information without changing the existing meaning
│   └── `append` — preserves history, adds an episode
│       arguments: { id: entryId, addition: "New information" }
│
├── Replacing the current projection entirely (preference reversed, decision overturned)
│   └── `update` — replaces content, creates a new version
│       arguments: { id: entryId, content: "New content" }
│
├── Memory is no longer accurate
│   └── `set_status` with status: "deprecated"
│       The entry is removed from recall but kept for audit. Never use forget here.
│
├── Memory is confirmed/authoritative
│   └── `set_status` with status: "canonical"
│       Protects from auto-overwrite. Use for verified facts and decisions.
│
├── Epistemic confidence changed
│   └── `set_epistemic_status`
│       Valid path: candidate → reviewed → canonical → qualified → superseded → retracted
│       Returns error with valid next states if transition is invalid.
│
└── Information is for a different entry
    └── Create a NEW entry with `remember`. Link them with `link`.
```

### Epistemic state machine

```
candidate ─→ reviewed ─→ canonical ─→ qualified
                 │            │            │
                 │            │            └──→ superseded ─→ retracted
                 │            │
                 └──→ retracted (skip canonical)
```

---

## Stage 5: Link — connecting memories

### When to link

| Scenario | Link type |
|---|---|
| Entry A and B are related | `relates_to` |
| Entry A provides evidence for B | `supports` |
| Entry A contradicts B | `contradicts` (use `propose_edge` for cross-user) |
| Entry A was derived from B | `derives_from` |
| Entry A clarifies B | `clarifies` |
| Entry A evaluates B | `evaluates_on` |
| Entry A has a limitation described in B | `has_limitation` |

### Cross-user links

Use `propose_edge` when the link affects another user's entries. This creates a pending proposal requiring human approval. Never use `link` directly for cross-user edges.

```
link is between your entries
├── Yes → `link` directly
└── No (cross-user) → `propose_edge` with reason
```

---

## Stage 6: Deprecate — removing from recall without deleting

```
User says "this is wrong" or "this is outdated"
├── User explicitly asks to permanently delete
│   └── Go to Stage 7 (Forget)
├── Information is simply outdated or inaccurate
│   └── `set_status` with status: "deprecated"
│       └── Entry removed from recall. Preserved for audit.
│       └── Agent response: "Marked entry X as deprecated. It will no longer appear in recall."
└── Entry should be replaced with newer information
    └── `remember` the new information
    └── `set_status` the old entry to "superseded"
    └── `link` them with type "supersedes"
```

---

## Stage 7: Forget — permanent erasure (compliance only)

**Never invoke `forget` implicitly.** Only call when the user explicitly says "delete", "remove forever", "forget this", or "erase".

```
User says "delete this memory" or "forget this"
├── Verify intent: "This is permanent and cannot be undone. Prefer deprecation for ordinary corrections. Continue?"
├── User confirms
│   └── `forget` with { id: entryId, confirm_entry_id: entryId }
│       └── confirm_entry_id MUST match id exactly
│       └── Response: "Permanently deleted entry X and Y vector(s)"
│       └── OR: "Deletion committed; vectors queued for background cleanup (operation Z). Do not retry."
└── User wants to revert a version
    └── Use `restore` instead — creates a NEW entry from a snapshot, never rewrites history
```

### Restore (undo without delete)

```
User wants to go back to an older version
├── `history` to list snapshots for the entry
├── `restore` with { entry_id, snapshot_id? }
│   └── Creates a NEW entry. Original history preserved.
└── Never use this to "un-forget" — forget is truly permanent
```

---

## Stage 8: Feedback — improving the system

After a recall that you acted on, rate it:

```
`rate_recall` with {
  recall_event_id: from recall response metadata,
  rating: "helpful" | "not_helpful",
  reason: "irrelevant" | "missing" | "stale" | "conflicting" | "unsupported" | "too_much" | "other"
}
```

Feedback is analytics-only during the pilot. It does not change recall behavior. Rate after acting on results, not for every query.

---

---

## Governed Actions — proposals with risk and approval

For consequential mutations (cross-user changes, destructive operations, high-risk edits), use the governed action proposal flow instead of direct tool calls.

### When to use governed actions

| Scenario | Tool |
|---|---|
| Cross-user entry update | `create_action_proposal` → `review_action_proposal` → `execute_approved_action` |
| Destructive operation (visibility change, batch delete) | Governed proposal with `risk_level: "high"` |
| Change affecting multiple entries | Proposal with `target_ids` array |
| Audit-required mutation | Proposal with `idempotency_key` for retry safety |

### Proposal workflow

```
Agent identifies a governed change needed
├── `create_action_proposal` with:
│   action_type: one of entry.create | entry.append | entry.update | entry.restore |
│                entry.status.set | entry.epistemic-status.set | edge.publish | edge.remove
│   payload_json: JSON string of the exact mutation payload
│   target_ids: [list of entry IDs affected]
│   risk_level: "low" | "medium" | "high" | "critical"
│   reason: Why this change is needed (human-readable)
│   idempotency_key: Unique key for retry safety
│   visibility_scope: "private" (your review only) | "team" (any admin can review)
│   expected_revision: Current revision of the target entry (optimistic lock)
│   expires_at: Optional Unix ms — auto-stale after this time
│
├── Human reviews: `list_action_proposals` to check status
├── Human approves: `review_action_proposal` with { proposal_id, decision: "approve", reason }
│   or rejects: `review_action_proposal` with { proposal_id, decision: "reject", reason }
│
└── Agent executes: `execute_approved_action` with { proposal_id }
    └── Only executable after human approval
```

### Service identities cannot review/approve

Only human users with the admin role can approve proposals. Service identities can create and execute but never approve.

---

## Cross-User Relationships — propose before linking

Never use `link` directly between entries owned by different users. Use the proposal flow.

```
You want to connect two entries
├── Both entries are owned by you
│   └── `link` directly with { source_id, target_id, type }
│
├── One or both entries are owned by other users
│   └── `propose_edge` with { source_id, target_id, type, reason }
│       └── Creates a pending proposal requiring human approval
│       └── Use `list-proposals` to check status
│       └── Admin approves with `approve-proposal` or rejects with `reject-proposal`
│
└── The relationship is uncertain or needs discussion
    └── `propose_edge` even if you own both — the proposal serves as documentation
```

---

## Visibility Transitions — private ↔ public

Visibility changes have consequences. Always confirm before changing.

```
User wants to change visibility
├── Private → Public
│   ├── Warn: "This will make the memory visible to the entire team. Current content, source, and citations will be exposed. Continue?"
│   ├── User confirms → `update` with new visibility
│   └── The entry becomes discoverable in team recall and graph
│
├── Public → Private
│   ├── Warn: "This will remove the memory from team recall and graph. Others who already saw it may have stored references."
│   ├── User confirms → `update` with new visibility
│   └── The entry is removed from team-visible indexes (may be briefly stale in Vectorize)
│
└── Private entry linked to by a public entry
    └── The private content is NOT exposed. Only the link metadata (IDs, type) is visible.
```

---

## History-Before-Mutation — inspect before you change

Before any mutation on an existing entry, check its history to avoid overwriting someone else's work.

```
You're about to append/update/status-change an entry
├── `history` with { entry_id }
│   ├── Lists all immutable episodes (append events)
│   ├── Lists all snapshots (pre-update state captures)
│   └── Shows revision numbers for optimistic concurrency
│
├── Check the last episode
│   ├── Same actor as you? → Proceed with append/update
│   └── Different actor? → Check if your change conflicts. Use `connections` to understand context.
│
└── Revision changed since you last read?
    └── The entry was modified. Re-read it with `recall` first, then proceed.
```

---

## Bitemporal Recall — time-aware search

Shared Living Memory tracks two timelines. Use both for precise queries.

```
`recall` with temporal filters:
  as_of:    "What was the truth at this point in time?"
            Example: query for a decision as_of the meeting date, not today.
            Use when: asking "what was the project status on July 15?"

  known_at: "What did the team know at this point in time?"
            Example: query for what was known before a new discovery.
            Use when: asking "what did we know before the incident on Aug 1?"

  after:    Only entries created after this timestamp
  before:   Only entries created before this timestamp
```

---

## Quick-reference: tool decision matrix

| I want to... | Use this tool |
|---|---|
| Store new information | `remember` |
| Add to existing entry | `append` |
| Replace entire entry | `update` |
| Search memory | `recall` |
| Time-travel search | `recall` with `as_of` / `known_at` |
| Browse by time | `list_recent` |
| Mark as outdated | `set_status` status:"deprecated" |
| Mark as authoritative | `set_status` status:"canonical" |
| Change confidence level | `set_epistemic_status` |
| Connect two entries (same owner) | `link` |
| Propose cross-user link | `propose_edge` |
| Approve/reject a proposed link | `approve-proposal` / `reject-proposal` |
| See linked entries | `connections` |
| Read source citations | `passages` |
| See past versions | `history` |
| Restore old version | `restore` |
| Change visibility (private ↔ public) | `update` with visibility field |
| Permanent deletion | `forget` with `confirm_entry_id` |
| Rate search quality | `rate_recall` |
| Keep memory salient | `reinforce` |
| Propose governed mutation | `create_action_proposal` |
| Review a governed proposal | `review_action_proposal` |
| Execute approved proposal | `execute_approved_action` |
| List pending proposals | `list-proposals` / `list_action_proposals` |
