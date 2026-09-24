---
"@effect/sql-d1": patch
---

Return the complete native `D1Result` from D1 statement `.raw`, preserving `success`, `meta`, and `results` instead of returning only the row array.

Callers that treated `.raw` as an array should read `.results` or use an ordinary or `.unprepared` statement when only rows are needed.
