---
"effect": patch
---

Add `Function.memoizeIdempotent` and use it to avoid reprocessing canonical Schema ASTs, including optional and mutable property modifiers. Cache Config schema cursor AST compilation.
