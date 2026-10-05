---
"effect": patch
---

Add `Pool.use`, which borrows an item while an effect runs and returns it on any
exit. Unlike `Effect.scoped(Pool.get(pool))`, it does not require a `Scope`.
