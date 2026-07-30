---
"effect": patch
---

Fix `MutableList.appendAll` / `appendAllUnsafe` so empty arrays are treated as a no-op instead of leaving behind an empty internal bucket.
