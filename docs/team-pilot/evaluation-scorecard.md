# Evaluation Scorecard — Team Pilot

> **Reconciled 2026-09-13** against `docs/superpowers/plans/2026-09-13-agent-memory-reliability.md`
> and the release evidence in `docs/team-pilot/releases/agent-reliability-1-1.md`.
>
> This file previously mixed **finite release regression gates** with **ongoing
> adoption metrics**, and its latency targets (p50 <3s / p95 <10s on *recall*)
> did not match the release gates the specification sets (raw recall p95 and
> generated-answer p95, measured on staging). The two are now separated: §1 is a
> per-release correctness gate that must pass before a rollout, §2 is an ongoing
> product observation that informs decisions but does not gate a release.
>
> **Nothing in §1 has been measured yet**, because the load and staging runs need
> a deployed environment. They are recorded as unmeasured, not as passing.

## 1. Release regression gates (must pass before a rollout)

These are finite, per-release checks. A failure blocks the single release.

| Gate | Measuring | Threshold | Status |
|---|---|---|---|
| Correctness | Zero lost acknowledged writes, zero duplicate retry effects, zero cross-owner private leaks, no partial provenance, predictable revision conflicts — at 1, 4 and 8 concurrent writers, 100 logical writes each, three runs each | 0 violations | **UNMEASURED** — needs staging |
| Raw recall latency | `p95` over full roundtrip, `include_insight:false`, `topK:5`, 100 measured requests after 10 excluded warm-ups | ≤ 3000 ms | **UNMEASURED** — needs staging |
| Generated answer latency | `p95` for `POST /chat` through complete SSE completion, 100 measured requests after 10 excluded warm-ups | ≤ 10000 ms | **UNMEASURED** — needs staging |
| Semantic availability | A finite staging semantic run | 0 `semantic_unavailable` responses | **UNMEASURED** — needs staging |
| Privacy | Cross-user private content leaks across every read, graph, export, proposal and history path | 0 incidents | **PASS locally** — two-installation isolation proof plus the visibility suites |
| Erasure | Irreversible deletion of every entry-owned artifact through the shared path, with no recreatable content | 0 survivors | **PASS locally** — real-SQLite erasure and tombstone tests |
| Honest failure | A failed tool sets `isError` with a safe code and no raw SQL; a committed write is never reported as failed | 0 violations | **PASS locally** |
| Maintenance | Read-only mode refuses every mutation before any side effect while serving reads | 0 violations | **PASS locally** |
| Workerd runtime | Real Workerd bootstrap, auth boundaries and protocol smoke | exit 0 | **BLOCKED locally** (`setsid` unavailable on macOS) — required in Linux CI |

Supported operating target: **four concurrent writers**. Eight-writer results must
be reported accurately; platform backpressure may reject or retry safely but must
not corrupt data.

## 2. Ongoing adoption and quality metrics (inform decisions, do not gate)

Retained from the original pilot scorecard. These are observations across a
cohort over time, not per-release gates.

| Metric | Formula | Target |
|---|---|---|
| Weekly active users | Users with ≥1 recall in 7 days | ≥80% of cohort |
| Zero-result rate | recalls with 0 results / total | <20% |
| Helpful rate | helpful ratings / total ratings | >60% |
| Semantic-unavailable rate | recalls with a semantic failure | <5% |
| First-capture within 24h | new users capturing within 24h | >50% |
| p50 recall latency | median recall duration | <3s (advisory, distinct from the §1 p95 gate) |
| MCP onboarding | First successful MCP `recall` from each participant | 100% within 24h |
| Recovery rehearsal | Staged restoration rehearsal | <4 hours, and only after in-flight work and stage-intent reconciliation have drained |

## 3. Decision framework

- **Go** — every §1 release gate passes on staging, and the §2 metrics are within target. Expand to a 5-person pilot.
- **Revise** — every §1 gate passes but one §2 metric is below target. Fix the metric, re-run.
- **Stop** — any §1 gate fails. Reassess before continuing.

A §2 metric below target never justifies skipping a §1 gate, and a passing §2
metric is not evidence that a §1 gate was measured.
