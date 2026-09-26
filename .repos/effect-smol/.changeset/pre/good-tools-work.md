---
"effect": patch
---

HttpServerResponse: fix `fromWeb` to preserve Content-Type header when response has a body

Previously, when converting a web `Response` to an `HttpServerResponse` via `fromWeb`, the `Content-Type` header was not passed to `Body.stream()`, causing it to default to `application/octet-stream`. This affected any code using `HttpApp.fromWebHandler` to wrap web handlers, as JSON responses would incorrectly have their Content-Type set to `application/octet-stream` instead of `application/json`.
