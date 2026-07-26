# Hermes Charter (Deprecated)

**Status:** deprecated on 2026-07-16
**Canonical replacement:** [Hermes: Living Knowledge Agent Charter](hermes-living-knowledge-agent-charter.md)
**Deployment guide:** [Operator Runtime and Hermes Deployment](../operator-runtime-deployment.md)

This document path is retained only so old links resolve. Do not use its previous content as an implementation or operating contract.

The superseded draft incorrectly coupled Hermes to implementation details that now belong to the governed Operator control plane, including human-style authentication, broad direct mutation tools, and Hermes-managed tables in Shared Living Memory's database. The current contract is:

- Shared Living Memory is the sole canonical memory and policy authority.
- Hermes is a replaceable service identity, not the memory layer or a privileged process.
- Hermes uses governed MCP/API tools only and never receives direct D1, Vectorize, R2, migration, or deployment access.
- The default Hermes credential can read, create constrained private draft candidates, and create proposals; consequential changes require human approval.
- Required audit records, proposal policy, credential rotation, and revocation are enforced by Shared Living Memory.
- Hermes is deployed only after Pillars 1–3 satisfy their acceptance gates.

Use the canonical charter and deployment guide above for all future design, implementation, and operations work.
