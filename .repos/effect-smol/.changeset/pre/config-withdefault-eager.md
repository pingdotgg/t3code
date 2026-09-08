---
"effect": patch
---

Revert `Config.withDefault` to v3 behavior, closes #1530.

Make `Config.withDefault` accept an eager value instead of `LazyArg`, aligning with CLI module conventions.
