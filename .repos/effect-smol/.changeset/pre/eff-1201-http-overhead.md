---
"effect": patch
---

Reduce HTTP server overhead: complete freshly created header maps in place in
`HttpServerResponse.setHeader` and `setHeaders`, compare static route prefixes
with a prepared `startsWith`, map `HttpApi` schema errors eagerly for completed
decoder results, and implement `Effect.cached` as a dedicated one-time memo
without time-to-live machinery.
