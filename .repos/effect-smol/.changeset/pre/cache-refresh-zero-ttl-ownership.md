---
"effect": patch
---

Fix `Cache.refresh` for an initially missing key deleting a newer cached value when the refresh completes with zero time to live.
