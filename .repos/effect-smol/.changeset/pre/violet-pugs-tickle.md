---
"effect": patch
---

Cluster shard-lock recovery no longer stalls behind a wedged reserved SQL connection.

While lock storage is unhealthy, the empty liveness probe (`refresh(address, [])`) now runs on the shared pool instead of the reserved lock connection, so a hung reserved connection cannot block recovery. Failed probes are also logged as warnings instead of being silently swallowed.
