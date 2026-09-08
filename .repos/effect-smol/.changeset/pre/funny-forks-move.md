---
"effect": patch
---

Constrain `HttpServerRequest.source` to `object` and key server-side request weak caches by `request.source` so middleware request wrappers share the same cache entries.
