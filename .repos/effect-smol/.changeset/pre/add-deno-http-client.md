---
"@effect/platform-deno": patch
---

Add `DenoHttpClient`, re-exporting `effect/unstable/http/FetchHttpClient`

Deno's `fetch` is spec-compliant, so the core fetch-based `HttpClient` works on Deno unmodified. This module mirrors `BunHttpClient` so the platform packages expose a consistent surface.
