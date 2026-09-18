---
"effect": patch
"@effect/platform-bun": patch
"@effect/platform-deno": patch
---

Omit response bodies for statuses 204, 205, and 304 in `HttpServerResponse.toWeb` and the Bun/Deno HTTP adapters, preventing invalid Web responses and hung requests. Cancel omitted raw `ReadableStream` bodies, and finalize request resources without starting omitted Effect streams.
