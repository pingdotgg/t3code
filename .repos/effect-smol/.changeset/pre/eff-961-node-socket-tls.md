---
"@effect/platform-node-shared": patch
"@effect/platform-node": patch
"@effect/platform-bun": patch
---

Add `NodeSocket.makeTls`, `NodeSocket.makeTlsChannel`, and `NodeSocket.layerTls` for TLS client connections.

These mirror the existing `makeNet` family but dial `tls.connect`, so they take the full `tls.ConnectionOptions` set:
trust anchors (`ca`), client certificates (`cert` / `key`), ALPN protocols, and `servername`. The socket opens once the
handshake completes; a failed handshake fails with a `SocketOpenError`.
