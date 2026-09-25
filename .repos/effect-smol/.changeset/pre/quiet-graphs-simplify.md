---
"effect": patch
---

Remove the redundant `Graph.Proto` interface. Use `Graph.Graph<N, E, Graph.Kind>` when accepting any immutable graph.
