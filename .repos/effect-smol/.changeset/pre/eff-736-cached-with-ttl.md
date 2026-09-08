---
"effect": patch
---

Fix `Effect.cachedWithTTL` and `Effect.cachedInvalidateWithTTL` to start TTL expiration when the cached value is produced instead of when computation starts.
