---
"effect": patch
"@effect/sql-pg": patch
"@effect/platform-node": patch
"@effect/platform-node-shared": patch
"@effect/platform-deno": patch
"@effect/platform-bun": patch
---

Add `NetAddress` under `effect/unstable/net` for MAC, IP, internet socket, and Unix socket addresses, with checked parsing, schemas, equality, canonical string serialization, and URL formatting. Companion modules `IpInterface` and `IpNetwork` represent IP interfaces and CIDR networks.

HTTP and socket servers now expose `NetAddress.SocketAddress`. Replace TCP `hostname` access with `NetAddress.formatIp(address.address)` and use `UnixPathAddress.path` for Unix sockets. URL helpers bracket IPv6 addresses and reject scoped IPv6. Bun and Deno HTTP server layers can now fail with `ServeError` when listener address conversion fails.

PostgreSQL `inet` values now use `IpInterface`; `cidr` values use `IpNetwork` and reject addresses with host bits set.
