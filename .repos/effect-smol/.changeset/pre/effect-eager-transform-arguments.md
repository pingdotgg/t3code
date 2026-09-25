---
"effect": patch
---

Fix `Effect.fnUntracedEager` to pass the original function arguments to each transform after the current effect, matching `Effect.fn` and `Effect.fnUntraced`.
