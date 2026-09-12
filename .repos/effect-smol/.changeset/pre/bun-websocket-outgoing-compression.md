---
"@effect/platform-bun": patch
---

Compress outgoing Bun WebSocket messages when per-message deflate is configured and negotiated. Messages
smaller than 1 KiB are left uncompressed, matching the default threshold used by Node's `ws` server.
The threshold is configurable via the new `websocket.compressionThreshold` server option.
