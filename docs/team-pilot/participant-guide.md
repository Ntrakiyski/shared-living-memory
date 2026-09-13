# Participant Guide — Shared Living Memory Team Pilot

## What is Shared Living Memory?

A governed team knowledgebase. You capture what you know, recall it with
citations, and connect related ideas. Private by default; team-public only
when you choose to share.

## Getting started

1. Open the dashboard URL provided by your administrator.
2. Sign in with your personal API key (received from your admin).
3. Never share your personal API key — it identifies you to the system.

## Capturing memory

Use the **Remember** tab or type `/remember` in the recall/search field.

Tag with `#project-name` or `#topic` to organize. Use `#task` for action
items, `#decision` for decisions. Private entries have a lock icon; public
entries have a globe icon.

## Recalling knowledge

Use the **Recall** tab. Ask natural-language questions. Results show source
citations when available. Use the time-aware recall controls to query what
was known at a past point in time.

## Correction

- **Edit** changes the current entry text (versioned).
- **Append** adds new information without replacing what's there.
- **Mark outaded** removes the entry from current recall without deleting it.
- **Permanently delete** is a compliance operation — never use it for
  ordinary corrections.

## Proposing changes with a designated reviewer

When you want to change another account's public entry, or make a change that
deserves independent review, submit a **governed action proposal** through MCP.
There is no dashboard proposal editor: this flow is an MCP recipe. A proposal
with a designated reviewer is visible only to the proposer, the subject owner,
and that one reviewer, and only that reviewer may approve or reject it. A
proposal with no designated reviewer keeps the legacy behaviour and may be
reviewed by the broader team.

```text
1. Owner captures a public candidate and reads back its entry_id E and revision R.
2. Owner calls create_action_proposal:
   action_type: "entry.epistemic-status.set"
   payload_json: {"entryId": E, "status": "reviewed"}
   target_ids: [E]
   expected_revision: R
   reviewer_username: "jarvis"
   visibility_scope: "team"
   reason: "evidence reviewed; ready for review"
   idempotency_key: "propose-reviewed-<E>"
3. The designated reviewer lists only proposals they may see, checks the
   evidence, then approves or rejects with a reason and executes the approved action.
   Ownership stays with the original owner.
4. To promote from reviewed to canonical, repeat at the newly returned revision.
```

A bound reviewer is resolved once to its account ID and is fixed for the life
of the proposal. Selecting yourself or the subject owner as reviewer is
rejected — this path requires a separate reviewing account.

## Rating recall

After a recall, you'll see a recall event ID. Rate it as helpful or
not_helpful through the dashboard or the MCP `rate_recall` tool. Feedback is
anonymous — it only counts toward pilot metrics, never identifies you.

## Leaving the pilot

Before the pilot ends, export your private data through the export endpoint.
Your administrator will deactivate your account, which permanently purges
your private memory, transfers your public entries to a custodian, and
preserves your username on public entries as the original author.
