---
"@effect/platform-browser": patch
"@effect/platform-node": patch
"effect": patch
---

Add `HttpClientResponse.url`, including query parameters and excluding the hash. When redirects are followed, it reports
the final URL.
