---
"@effect/sql-pglite": patch
---

Align PGlite `listen` with the PostgreSQL client. It now returns a scoped dequeue after the listener is installed, providing an explicit readiness boundary and preserving notifications received before the first take.
