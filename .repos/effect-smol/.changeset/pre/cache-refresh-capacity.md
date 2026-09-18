---
"effect": patch
---

Fix `Cache.refresh` and `ScopedCache.refresh` exceeding capacity when an existing key is evicted while its refresh is in progress. Publishing the refreshed entry now evicts older entries as needed, releasing their resources in `ScopedCache`.
