---
"@effect/openapi-generator": patch
---

Quote static paths and percent-encode path parameters in generated HTTP clients, including SSE and binary stream methods. Reject empty parameters and dot segments with an HTTP client error before sending a request.
