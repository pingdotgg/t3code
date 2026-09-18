---
"effect": patch
"@effect/platform-node": patch
"@effect/platform-bun": patch
---

Improve HTTP server throughput by reducing routing, request handling, response
construction, and body encoding overhead. Add `Effect.withFiberSucceed` for
synchronously computing successful values from the current fiber. Copy pooled
byte views by their exact range when exposing `ArrayBuffer` values.
