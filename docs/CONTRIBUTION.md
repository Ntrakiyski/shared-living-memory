# Contribution Guide

This document describes the process used to build the **Shared Memory** (v2) feature. Use this as a template for future features — each gets its own folder under `docs/`.

## Folder Convention

```
docs/
├── shared-memory/          # <-- v2 multi-user feature (this one)
│   ├── GOAL.md             #    What we set out to build
│   ├── PRD.md              #    Full product spec (user stories, decisions, scope)
│   ├── tasks/              #    14 tracer-bullet tickets, one per file
│   │   ├── 01-auth-infrastructure.md
│   │   ├── ...
│   │   └── README.md       #    Ticket dependency graph + status
│   ├── CONTEXT.md           #    Glossary of domain terms (from domain-modeling)
│   ├── adr/                 #    Architectural Decision Records (if any)
│   │   └── 0001-slug.md
│   ├── CURRENT_STATE.md    #    Post-mortem snapshot of what was built
│   └── skills-lock.json    #    Skills installed at time of build
├── CONTRIBUTION.md         # <-- this file
└── <next-feature>/          #    Future feature folder (same structure)
```

When starting a new feature or version, create a folder under `docs/` named after it, and follow the process below.

## Process

### 1. Goal — write GOAL.md

Start with a single markdown file describing what you want to build. Keep it short — one or two sentences of the outcome, plus a few bullet points of constraints or must-haves.

**Example (shared-memory/GOAL.md):**
```
# Goal: Multi-User Shared Memory Platform
Extend Shared Living Memory from single-user to multi-user...
```

**Recommended skill:** `grill-with-docs` — a relentless interview that stress-tests your plan and simultaneously builds documentation. It combines two sub-skills:

- **`grilling`** — Walks down every branch of the design tree, one question at a time. Each question waits for your answer before continuing. Resolves ambiguities, surface edge cases, and forces precision about the boundaries between concepts. The AI provides a recommended answer with each question.

- **`domain-modeling`** — Produces two artifacts while the grilling runs:
  - `CONTEXT.md` — a glossary of domain terms. Each term has a tight 1–2 sentence definition and an `_Avoid_` list of rejected synonyms. Keeps the project's ubiquitous language sharp.
  - `docs/adr/` — Architectural Decision Records. Each ADR captures a decision that is (1) hard to reverse, (2) surprising without context, and (3) the result of a real trade-off. ADRs are numbered sequentially and can be a single paragraph.

Run the `grill-with-docs` skill with your initial GOAL.md as context. The AI will grill you to tighten the goal, then write the refined GOAL.md based on what you settled on.

### 2. PRD — convert GOAL.md to PRD.md

Use the **`to-spec`** skill to convert the GOAL.md (now sharpened by grilling and grounded in a domain glossary) into a full Product Requirements Document. The PRD should include:

- **User stories** — who needs what and why
- **Implementation decisions** — architecture choices, auth flow, data model changes
- **Testing decisions** — what gets tested at unit vs integration level
- **Out-of-scope items** — explicit boundaries to prevent scope creep
- **Migration plan** — how existing data moves to the new schema

Run: provide the GOAL.md, CONTEXT.md, and any ADRs as input. The AI will synthesize the discussion into `PRD.md`.

### 3. Decompose — break PRD into tickets

Use the **`decompose-into-slices`** skill to break the PRD into independent, vertically-sliced tickets. Each ticket should:

- Be independently testable (has its own acceptance criteria)
- Have a clear "done" state
- List its blockers (which tickets must complete first)
- Specify exact file changes needed

The result is a `tasks/` directory with numbered markdown files and a `README.md` with the dependency graph.

**For shared-memory:** 14 tickets produced, dependency chain:
```
01 (Auth) → 03 (Migration) → 04 (Ownership on Write) → 05 (Visibility) → ...
```

### 4. Implement — TDD, one ticket at a time

Work sequentially following the dependency graph. For each ticket, load the **`tdd`** and **`implement`** skills:

1. Read the ticket file for exact changes
2. Write failing tests first (red)
3. Implement the changes (green)
4. Run `npm run typecheck && npm test` (refactor)
5. Mark the ticket complete in `tasks/README.md`

**Conventions used:**
- **TDD** — red-green-refactor cycle on every ticket
- **Vitest** with `D1Mock` for database, mocked Vectorize and KV
- **`req()` helper** for HTTP test requests: `(method, path, { body?, token?, userCredentials? })`
- **Single-file Worker** — all logic in `src/index.ts` (~4,200 lines)

### 5. Code Review — audit for security and correctness

After all tickets are implemented and tests pass, run the **`review`** and **`security-review`** skills:

- **Security:** STRIDE analysis (timing attacks, injection, auth bypass, info leaks)
- **Correctness:** ownership checks on every mutation, visibility on every read
- **Edge cases:** empty states, race conditions, cascade deletes
- **Performance:** Vectorize batch sizes, D1 bound param limits

Fix critical and high-severity findings before shipping.

**For shared-memory:** 7 issues found and fixed:
- C1–C3: Correctness (owner_user_id preservation, visibility on /count/tags/stats, smart merge ownership)
- H1–H3: Security (constant-time HMAC, keyword search visibility, owner self-deactivation guard)
- H5: Security (LIKE wildcard escaping)

### 6. Ship — deploy and verify

1. Run full test suite: `npm test` (all 702 tests)
2. Run typecheck: `npx tsc --noEmit`
3. Commit and push to GitHub
4. Deploy to Cloudflare: `npm run deploy`
5. Smoke-test in browser: create accounts, verify visibility, test forget/recall/capture

### 7. Document — changelog, agents, and current state

After shipping:

- Update `CHANGELOG.md` with all new features, breaking changes, and migration notes
- Update `AGENTS.md` with new architecture patterns, key functions, gotchas
- Write `CURRENT_STATE.md` in the feature folder as a post-mortem snapshot
- Lock installed skills in `skills-lock.json`

## Full Pipeline Summary

```
GOAL.md ──→ grill-with-docs ──→ GOAL.md (sharpened)  +  CONTEXT.md  +  adr/
                                        │
                                        ▼
                                    to-spec
                                        │
                                        ▼
                                     PRD.md
                                        │
                                        ▼
                              decompose-into-slices
                                        │
                                        ▼
                                  tasks/ (N tickets)
                                        │
                                        ▼
                              tdd + implement (per ticket)
                                        │
                                        ▼
                          review + security-review
                                        │
                                        ▼
                                   ship (deploy)
                                        │
                                        ▼
                        CHANGELOG + AGENTS + CURRENT_STATE
```

## Skills Used

| Skill | Stage | What it produces |
|-------|-------|-----------------|
| `grill-with-docs` | 1. Goal | Sharpened GOAL.md + CONTEXT.md + ADRs |
| └ `grilling` | 1. Goal | Relentless one-question-at-a-time interview |
| └ `domain-modeling` | 1. Goal | Glossary (`CONTEXT.md`) + decisions (`docs/adr/`) |
| `to-spec` | 2. PRD | Full PRD from GOAL + CONTEXT + ADRs |
| `decompose-into-slices` | 3. Tickets | Numbered tracer-bullet tickets with dependency graph |
| `tdd` | 4. Implement | Red-green-refactor cycle |
| `implement` | 4. Implement | Execute each ticket's changes |
| `review` | 5. Review | Security and correctness audit |
| `security-review` | 5. Review | STRIDE threat modeling |
| `cloudflare` | All | Cloudflare Workers, D1, Vectorize platform reference |
| `workers-best-practices` | 4–5 | Worker-specific anti-patterns |
| `write-docs` | 7. Document | CHANGELOG, AGENTS, CONTRIBUTION authoring |

## Test Command Reference

```bash
npm test                        # run all 702 tests
npm test -- test/unit/edges     # run specific test file
npm run typecheck               # tsc --noEmit
npm run dev                     # local dev server
```
