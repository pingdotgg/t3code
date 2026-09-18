---
"@effect/platform-node": patch
---

Prevent NodeHttpServer from writing the route's HTTP response onto a connection that was upgraded to a WebSocket connection because stricter clients will interpret those bytes as WebSocket frames, logging "Invalid frame header" and failing the connection with an untyped 1006 error instead of the actual close code that the server sent.
