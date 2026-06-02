---
"effect": patch
---

Fix `SchemaAST.isJson` rejecting DAGs as cycles, closes #2021.

The previous implementation marked every visited object in a single `seen` set and never removed it, so any value that referenced the same object through two different paths (a DAG, e.g. `{ x: shared, y: shared }`) was treated as a cycle and returned `false`. Cycle detection now tracks only the current recursion path (popping on exit) and memoizes fully validated subtrees, so DAGs are accepted while true cycles are still rejected.
