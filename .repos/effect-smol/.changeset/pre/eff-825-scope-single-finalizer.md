---
"effect": patch
---

Reduce scoped resource acquisition allocations by storing the first Scope
finalizer inline and allocating a Map only when a second is added. This changes
the public `Scope.State.Open` interface.
