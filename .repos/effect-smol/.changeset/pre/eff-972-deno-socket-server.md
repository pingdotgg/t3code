---
"@effect/platform-deno": patch
"@effect/platform-node-shared": patch
---

Use the node-shared socket server on Deno so accepted TCP connections support reader-scoped server TLS upgrades.

### Breaking changes

`DenoSocketServer.make` and `layer` now accept Node listen options. Use `host` instead of `hostname` for TCP and
`{ path }` instead of `{ transport: "unix", path }` for Unix sockets. Deno 2.8.3 or newer is now required.
