---
"effect": patch
---

Preserve the source error type when a saved `Effect.tapDefect` operator is applied. The source error is now inferred from each application instead of when the operator is created. Runtime behavior is unchanged.
