---
"effect": patch
---

Fix sql migrator lock handling to only treat duplicate migration-row inserts as a concurrent migration lock.
