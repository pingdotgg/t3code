---
"effect": patch
---

Fix `Graph.bellmanFord` reporting a negative cycle as affecting a target across an impassable, positive-infinite-weight edge. Targets separated from the cycle by such edges now retain their finite shortest path or remain unreachable, while targets reachable from the cycle through finite-weight edges still report an error.
