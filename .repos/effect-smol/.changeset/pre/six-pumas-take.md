---
"effect": patch
---

add advanced graph set operations for deriving related graph structures

- `Graph.complement` - complement over the existing node set, adding missing edges between distinct nodes
- `Graph.neighborhood` - induced subgraph containing nodes within a radius of a node
- `Graph.sum` - disjoint union of two graphs without merging equal node data
