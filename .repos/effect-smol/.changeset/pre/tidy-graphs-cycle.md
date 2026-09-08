---
"effect": patch
---

Throw `GraphError` when a negative cycle affects a Bellman-Ford target, reserving `Option.none()` for unreachable paths.
