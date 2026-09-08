---
"effect": patch
---

Fix `HttpApiBuilder` security middleware caching so separate handler builds do not reuse the first provided middleware implementation.
