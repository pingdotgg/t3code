---
"@effect/platform-bun": patch
---

Fix `BunHttpServer` startup when `hostname` is omitted by explicitly listening on `::`, preserving IPv4 and IPv6 connectivity and avoiding a `ServeError` when parsing Bun's default hostname.

Preserve the configured listen address in `BunClusterHttp`, including loopback addresses, when applying the HTTP server hostname default.
