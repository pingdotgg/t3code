---
"effect": patch
---

Fix `Stream.aggregateWithin` and `Stream.groupedWithin` retaining fiber continuations on every schedule tick while upstream is idle.
