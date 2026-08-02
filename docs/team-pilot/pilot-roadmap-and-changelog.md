# Shared Living Memory — Team Pilot Roadmap & Changelog

> Companion to `docs/superpowers/plans/2026-08-01-team-pilot-readiness.md`. This is the
> "what do I do next" view: every stage has user stories, concrete deliverables, and
> the observable change for the team. The `[x]`/`[ ]` markers reflect the `codex/slm-team-pilot-readiness`
> branch, not `main`.

## Changelog — what the current version does

### Live on main / production today

| Area | What it does today |
|---|---|
| Multi-user memory | A workspace with per-person accounts (`slm_` keys). Entries can be `private` (owner only) or public to the team. Keys are stored only as hashes. |
| Versioned history | Every change is an immutable episode; edits/status changes keep history, with bitemporal lookup and restore-from-snapshot. |
| Semantic recall | Embeddings (Workers AI, 384-dim) into Vectorize; natural-language search, duplicate detection, contradiction proposals, graph edges and connections. |
| Citations | Recall returns matched passages and episodes so a result can point at evidence. |
| MCP server | Agents (Codex, Claude Code, generic MCP) get `remember`, `recall`, `list_recent`, `append`, `update`, `set_status`, `forget`, `restore`, `link`, and governed action proposals. |
| Dashboard | Web capture, recall, history, export, admin of users/roles. |
| Integrations | Notion mirroring and a nightly compression/graph/lifecycle job. |
| Governance | Mandatory audit for governed service actions; role/deactivation endpoints are admin-only. |

### On the `codex/slm-team-pilot-readiness` branch (not yet merged to main)

| Stage | What changed |
|---|---|
| **1. Safe capture and export** (done, reviewed) | Capture is **private by default** in REST, MCP, and the dashboard; duplicate 409s keep your input and say "not stored"; failed writes never show "Kept"; payload/size/tag/URL limits; a narrow credential detector blocks keys/tokens; `source_url`/`source_title` supported; export is now explicit `my_data` vs `team_public` (no private revisions leak into team export); legacy source metadata is sanitized. |
| **2. Restore semantic retrieval** (done, one fix pending review) | Canonical entry + passage vector IDs rebuilt through one staging path; reindex deletes only stale vectors; legacy/null lineage fails closed; new production-like race/erasure regressions. **Last open item:** a passage-only atomicity bug is fixed locally and needs the final review sign-off. |
| **3. Trustworthy recall and answers** (done) | Recall excludes `superseded`/`retracted` entries (and `status:deprecated`) everywhere — dense, keyword, tag, and graph-expansion paths share one eligibility filter. Passage-vector hits carry their `passageId` through to citations: the exact passage the vector matched is cited first (not just the newest chunk), and `/recall` exposes `matched_passage_id`. `/chat` is now server-grounded: client-supplied `memories` is rejected, evidence comes from server-side recall only, and a no-match query answers without calling the LLM. Every recall card (MCP + REST) labels its author and scope (`[yours · private]` / `[by user · public]`). |

---

## Roadmap — stage by stage

Legend: each stage = one mergeable slice. **Gate rule:** a stage with a `▶` gate must pass before the next stage starts.

### Stage 1 — Safe capture and export
**Status:** `[x]` done on branch · not merged to main

- **User story:** "As a teammate, I can save a memory privately by doing nothing extra, and I'm never told my note was saved when it actually failed."
- **Deliverables:** private-default capture everywhere; truthful error/duplicate UI; size/secret guards; explicit `my_data` / `team_public` export; leak-free team export.
- **What the team sees after this stage:** saving a note is private unless I deliberately publish; bad saves never lie; exports are clearly labeled.

### Stage 2 — Restore production semantic retrieval
**Status:** `[x]` implemented · ⏳ one fix under final review

- **User story:** "As a teammate, my recall finds my private notes and team knowledge, never other people's private notes, and the system can't silently lose the index."
- **Deliverables:** Vectorize `owner_user_id` / `is_private` metadata indexes; canonical rebuild; staging two-user canary; atomic projection persistence.
- **What the team sees:** semantic recall works for real data instead of returning empty; a rebuild never leaves D1 pointing at deleted vectors.
- ▶ **Gate:** reviewer sign-off on the atomicity fix (passage-only race regression) before the branch merges.

### Stage 3 — Trustworthy recall and answers
**Status:** `[x]` done on branch · not merged to main

- **User stories:**
  - "As a teammate, I can trust that outdated/retracted memories are never presented as current fact."
  - "As a teammate, the citation I'm shown is the actual passage the answer used, not just the first chunk."
  - "As a user, the chat answers come from authorized memories I can actually see, not from text I typed into the chat box."
- **Deliverables:** shared recall-eligibility filter (exclude deprecated/superseded/retracted); passage-vector citations; server-grounded `/chat` (client memory rejected); author/scope labels on every card.
- **What the team sees:** answers cite the right evidence; withdrawn facts disappear from results; chat can't be gamed with planted memory text.

### Stage 4 — Complete erasure and content-free audit
**Status:** `[ ]` not started

- **User stories:**
  - "As a teammate, when I permanently delete a memory, it's actually gone from every store — I can prove it."
  - "As an admin, my audit records tell me who did what without storing the memory content itself."
- **Deliverables:** one shared erasure path; pending-cleanup receipts with retry; migration that nulls legacy audit content; explicit dashboard/MCP confirmation for permanent delete.
- **What the team sees:** "Permanently delete" really deletes; compliance erasure is verifiable; audit logs stop being a second copy of private data.

### Stage 5 — Identity, admin, and key lifecycle
**Status:** `[ ]` not started

- **User stories:**
  - "As the first user of a fresh workspace, I automatically become the admin."
  - "As a teammate, I can rotate my own key if it leaks, and the old key dies immediately."
  - "As an admin, I can create users, promote/demote, rotate keys, and deactivate without sharing the workspace secret."
- **Deliverables:** atomic first-user bootstrap; `GET /api/bootstrap-status` + admin-only People panel; self/admin key rotation; deactivation with custodian + private-export acknowledgement.
- **What the team sees:** no more shared secret; everyone signs in with a personal key; account recovery is a real flow.

### Stage 6 — Tested MCP onboarding
**Status:** `[ ]` not started

- **User stories:**
  - "As a teammate, I can connect Codex or Claude Code to shared memory in minutes by following the guide, and it works first try."
  - "As an operator, I know OAuth is off for the pilot so there is exactly one supported connection path."
- **Deliverables:** renamed + corrected skill; OAuth disabled by default; exact Codex/Claude/generic MCP examples; portable Workerd smoke; remote-staging protocol smoke.
- **What the team sees:** the documented 15-minute connect-and-capture journey succeeds without operator debugging.

### Stage 7 — Correction and attribution UX
**Status:** `[ ]` not started

- **User stories:**
  - "As a teammate, I can tell who wrote a memory and whether it's mine, and I can correct/outdate/restore without deleting history."
  - "As a teammate, I see the consequences before I publish or privatize."
- **Deliverables:** author + scope on every card; Edit / Add clarification / Mark outdated / View history / Restore; tag add/remove; visibility-change warnings.
- **What the team sees:** correcting shared knowledge is the normal, visible path — hard delete becomes a rare, warned action.

### Stage 8 — Recall receipts, feedback, evaluation
**Status:** `[ ]` not started

- **User stories:**
  - "As a teammate, I can rate a recall as helpful/not helpful and pick a reason — without my query or result text being stored."
  - "As an admin, I can see whether retrieval actually works (helpful rate, zero-results, latency) and whether people come back."
- **Deliverables:** privacy-safe recall events + feedback (hashed queries only); `rate_recall` MCP tool; admin pilot metrics; synthetic eval + golden questions.
- **What the team sees:** thumbs-up/thumbs-down on results; admins get a real scorecard instead of anecdotes.

### Stage 9 — Stage, observe, secure, recover  ⚠️ requires your authorization before any Cloudflare/GitHub changes
**Status:** `[ ]` not started

- **User stories:**
  - "As an operator, I can deploy to isolated staging, get alerted when the service degrades, and restore within hours from a backup."
  - "As an operator, I know exactly what is safe to run in production because CI blocks high-severity dependencies and broken canaries."
- **Deliverables:** staging D1/Vectorize/KV; readiness endpoint; canary + incident issue workflow; rate limiting; dependency security; recovery runbooks and drills.
- **What the team sees:** nothing visible day-to-day — this is the invisible safety net that makes the pilot trustworthy.

### Stage 10 — Rehearse and document the launch
**Status:** `[ ]` not started

- **User stories:**
  - "As a participant, I have a 15-minute guide that takes me from personal key to my first private recall."
  - "As an operator, I have a rehearsed acceptance journey covering every privacy and recovery scenario."
- **Deliverables:** participant guide, scorecard, observation log; full two-user acceptance journey; docs corrected to match real behavior.
- **What the team sees:** clear instructions, honest docs, and evidence that the whole journey works before anyone is invited.
- ▶ **Gate:** every prelaunch checklist passes on staging and a production canary → only then invite the pilot cohort.

---

## After the pilot (not before)

- Evidence-backed observations (Hindsight-style derived facts) — only if users want synthesized understanding.
- Directional living mental maps.
- Gap-aware answers and bounded expansion.
- Hermes LCM as a bounded session-context layer (never the canonical store).
