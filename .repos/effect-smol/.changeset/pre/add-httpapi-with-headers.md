---
"effect": patch
---

httpapi: add typed response headers across handlers, generated clients (including `HttpApiTest`), streaming responses, and OpenAPI with `HttpApiSchema.WithHeaders`. Add `HttpApiSchema.encodeToWithHeaders` for folding response headers into domain types such as error classes. Explicit `content-type` and `content-length` values applied with `HttpServerResponse.setHeader` or `setHeaders` now override body-derived values.
