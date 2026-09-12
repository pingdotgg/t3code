---
"effect": patch
---

Fix `Cache.invalidateWhen` and `ScopedCache.invalidateWhen` deleting a replacement entry while waiting for an earlier lookup.
