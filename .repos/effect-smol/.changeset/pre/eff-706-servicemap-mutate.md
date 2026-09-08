---
"effect": patch
"@effect/opentelemetry": patch
---

Refactor call sites with multiple `Context` mutations to use `Context.mutate` for batched updates.
