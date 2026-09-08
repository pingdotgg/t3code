---
"effect": patch
---

Fix a `@effect/cluster` shutdown deadlock on single-runner topologies (e.g. single-node deployments and `TestRunner`), where `Sharding.sendOutgoing` retried `EntityNotAssignedToRunner` forever during teardown.
