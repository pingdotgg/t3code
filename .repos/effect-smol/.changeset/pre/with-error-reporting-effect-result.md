---
"effect": patch
---

Fix `Effect.withErrorReporting` to return an `Effect` instead of preserving input
subtypes such as `Exit`, whose subtype-specific fields are not present on the wrapper.
