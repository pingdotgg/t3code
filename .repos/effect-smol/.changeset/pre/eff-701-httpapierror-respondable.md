---
"effect": patch
---

Make all built-in `HttpApiError` classes implement `HttpServerRespondable`, so they can be returned directly from plain HTTP server handlers outside of `HttpApi`.
