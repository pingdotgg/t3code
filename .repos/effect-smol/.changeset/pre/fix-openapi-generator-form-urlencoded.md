---
"@effect/openapi-generator": patch
---

Support `application/x-www-form-urlencoded` request bodies in `httpclient` output format. Previously, form-urlencoded request bodies were silently dropped, producing operations with no payload parameter. The generator now emits `HttpClientRequest.bodyUrlParams` for these endpoints, matching the existing pattern for `multipart/form-data` (`bodyFormData`) and `application/json` (`bodyJsonUnsafe`). The `httpapi` format was already handling this content type correctly.
