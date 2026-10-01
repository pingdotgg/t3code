---
"@effect/platform-browser": patch
---

Fix IndexedDB bulk writes so `insertAll` and `upsertAll` resume when used inside `withTransaction`.
