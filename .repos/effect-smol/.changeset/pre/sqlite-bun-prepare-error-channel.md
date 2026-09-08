---
"@effect/sql-sqlite-bun": patch
---

Fail with a typed `SqlError` when Bun SQLite statement preparation throws (for example a missing table or a syntax error), instead of letting the driver error escape as a defect, closes #2385.
