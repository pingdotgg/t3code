---
"effect": patch
---

Fix `RequestResolver.fromEffectTagged` to consume handler results as an iterable, allowing arrays, iterators, and generators to resolve requests in order.
