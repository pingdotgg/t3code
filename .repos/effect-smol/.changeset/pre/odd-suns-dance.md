---
"effect": patch
---

Rename HttpApiClient request option `withResponse` to `responseMode` and add support for `responseMode: "response-only"` to return the raw `HttpClientResponse` without decoding.
