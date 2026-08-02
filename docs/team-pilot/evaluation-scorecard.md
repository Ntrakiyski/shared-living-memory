# Evaluation Scorecard — Team Pilot

## Gates (must pass before expansion)

| Gate | Measuring | Threshold |
|---|---|---|
| MCP onboarding | First successful MCP `recall` from each participant | 100% within 24h |
| Privacy | Zero cross-user private content leaks | 0 incidents |
| Availability | `/ready` returns 200 | >99.5% uptime |
| Recovery | Staged restoration rehearsal | <4 hours |

## Metrics (inform decision, not gated)

| Metric | Formula | Target |
|---|---|---|
| Weekly active users | Users with ≥1 recall in 7 days | ≥80% of cohort |
| Zero-result rate | recalls with 0 results / total | <20% |
| Helpful rate | helpful ratings / total ratings | >60% |
| Semantic-unavailable rate | recalls with semantic failure | <5% |
| First-capture within 24h | new users capturing within 24h | >50% |
| p50 recall latency | median recall duration | <3s |
| p95 recall latency | 95th percentile recall duration | <10s |

## Decision framework

- **Go** — all gates pass, all metrics within target. Expand to 5-person pilot.
- **Revise** — all gates pass, one metric below target. Fix the metric, re-run.
- **Stop** — any gate fails. Reassess architecture before continuing.
