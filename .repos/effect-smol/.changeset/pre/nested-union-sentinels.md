---
"effect": patch
---

Improve Union candidate selection: a nested union member is dispatched by the sentinels common to all its members, and candidates whose sentinel the input contradicts are excluded.
