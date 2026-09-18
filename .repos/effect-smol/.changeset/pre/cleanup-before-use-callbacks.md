---
"effect": patch
---

Ensure `Effect.acquireUseRelease` releases an acquired resource and `Effect.useSpan` ends its span when the use callback throws before returning an effect. The thrown exception remains a defect, but no longer skips cleanup.
