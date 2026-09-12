---
"effect": patch
---

Cluster no longer retains fiber ids for every local teardown.

Transient persisted interrupts are now classified from live teardown state
(entity, shard, singleton, entity type, and node shutdown) instead of a
process-lifetime set of fiber ids. The registry is bounded by in-flight
teardowns and returns to baseline after entity reap storms.
