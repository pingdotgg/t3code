---
"effect": patch
---

Fix `Effect.timeoutOrElse` to finish interrupting the source before evaluating the fallback, preventing the source from winning after the timeout.

Fallbacks now run in the caller fiber and inherit its interruptibility and supervision.
