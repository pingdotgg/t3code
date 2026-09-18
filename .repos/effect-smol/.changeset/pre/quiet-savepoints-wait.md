---
"effect": patch
---

Serialize concurrent nested SQL transactions to prevent savepoint collisions. Cross-dependent sibling nested
transactions now deadlock instead of interleaving and risking silent data corruption.
