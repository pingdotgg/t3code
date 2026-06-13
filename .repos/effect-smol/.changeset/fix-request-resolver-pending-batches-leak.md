---
"effect": patch
---

Use `WeakMap` for `pendingBatches` instead of `Map`, to allow GC to collect resolvers
