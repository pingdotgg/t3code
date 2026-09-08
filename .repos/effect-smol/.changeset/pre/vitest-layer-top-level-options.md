---
"@effect/vitest": patch
---

Allow top-level `it.layer` to accept `memoMap`, `timeout`, and `excludeTestServices` options, matching the standalone `layer` export. Nested `it.layer` calls remain restricted to `timeout` only.
