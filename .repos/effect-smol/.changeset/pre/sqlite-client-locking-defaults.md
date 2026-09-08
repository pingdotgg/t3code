---
"@effect/sql-sqlite-bun": patch
"@effect/sql-sqlite-node": patch
---

Use a configurable five-second busy timeout and immediate transactions by default to avoid SQLite lock failures under concurrent access. Busy waits can block the event loop, while immediate transactions serialize behind other writers.
