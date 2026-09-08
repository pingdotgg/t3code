---
"effect": patch
---

Remove `Effect.withConcurrency`, the `References.CurrentConcurrency` reference backing it, and the `"inherit"` option from `Types.Concurrency`. Use an explicit `number` or `"unbounded"` concurrency value instead.
