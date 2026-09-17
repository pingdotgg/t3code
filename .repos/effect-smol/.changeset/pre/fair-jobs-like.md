---
"effect": patch
---

add a `radius` option to `Graph` search configuration, allowing `dfs`, `bfs`, and `dfsPostOrder` traversals to limit returned nodes by edge distance from the configured start nodes. Traversals can also use `direction: "undirected"` to follow edges in either direction.
