---
"effect": patch
---

Avoid allocating a scheduler dispatcher when `runSyncExit` completes without yielding.
