---
"effect": patch
"@effect/platform-node-shared": patch
"@effect/platform-node": patch
"@effect/platform-bun": patch
"@effect/platform-deno": patch
"@effect/platform-browser": patch
"@effect/ai-openai": patch
---

Redesign `Socket` around a scoped, pull-based reader with transport backpressure.

`Socket` now exposes `reader` and `writer`. Client reader acquisition dials and yields a pull of non-empty batches: one buffer for TCP and one entry per WebSocket frame. TCP applies backpressure while paused; pausable WebSockets pause at `highWaterMark` (64 KiB by default) and resume after draining. Browser WebSockets cannot pause, so they can fail with `SocketReadError` at a configured `highWaterMark`. Writes await native drain signals and batch with `cork` / `uncork` where available.

### Breaking changes

- `Socket.run`, `Socket.runString`, and `Socket.runRaw` are removed. Acquire `socket.reader` (or `Socket.readerBytes` / `Socket.readerString`) in a scope and pull in a loop. Code before the first pull replaces `onOpen`.
- `Socket.make` now takes `{ reader, writer }`. The writer acquisition is infallible and yields a `Writer` with `write` and `writeAll`; both operations can still fail with `SocketError`.
- Every close fails the pull with `SocketError` wrapping `SocketCloseError`. The close-code predicates are removed; use `Effect.retry` around the scoped read loop to reconnect.
- `Socket.toChannel` and `Socket.toChannelString` now read from the pull and fail on close. `Socket.toStream` is added for read-only consumption.
- `fromWebSocket` drops the `onInitialRun` option; `SendQueueCapacity` is removed.
- Accepted server sockets pause immediately. Their reader attaches to the existing connection and cannot reconnect after close.
