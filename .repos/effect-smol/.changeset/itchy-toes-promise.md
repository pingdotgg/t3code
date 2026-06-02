---
"effect": patch
---

Revert `Effect.partition` to Effect v3 behavior by accumulating failures from the effect error channel and never failing.
