---
"effect": patch
---

Mark the internal `~sentinels` Schema annotation as `@internal` so release declaration stripping removes it together with `SchemaAST.Sentinel`. This keeps the published declarations self-consistent for consumers that type-check dependencies with `skipLibCheck: false`.
