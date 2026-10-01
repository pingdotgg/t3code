---
"effect": patch
"@effect/platform-node": patch
"@effect/platform-bun": patch
"@effect/platform-deno": patch
---

Add HTTP response compression support. Node.js, Bun, and Deno use asynchronous
`node:zlib` one-shot compression for byte-array bodies, preserving an exact
`Content-Length`; stream and raw bodies remain streaming transforms.
