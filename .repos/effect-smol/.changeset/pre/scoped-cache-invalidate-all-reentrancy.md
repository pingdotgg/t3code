---
"effect": patch
---

Fix `ScopedCache.invalidateAll` discarding entries created by reentrant resource finalizers without releasing them. Entries are now removed before their finalizers run, so replacement resources remain cached and are released when the cache closes.
