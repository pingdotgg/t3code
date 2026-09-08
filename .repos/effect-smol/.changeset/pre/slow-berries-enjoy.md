---
"effect": patch
---

Simplify internal and documented request usage by passing request resolvers directly to `Effect.request` instead of wrapping them with `Effect.succeed`.
