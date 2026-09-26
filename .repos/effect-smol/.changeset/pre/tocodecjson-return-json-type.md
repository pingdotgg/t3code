---
"effect": patch
"@effect/platform-browser": patch
"@effect/platform-bun": patch
"@effect/platform-node": patch
---

Schema: `toCodecJson` now returns `Codec<T, Json, RD, RE>` instead of `Codec<T, unknown, RD, RE>`.

Http: the `json` property on `HttpIncomingMessage`, `HttpClientResponse`, `HttpServerRequest`, and `HttpServerResponse` now returns `Effect<Schema.Json, E>` instead of `Effect<unknown, E>`.
