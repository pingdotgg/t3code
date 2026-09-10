---
"effect": patch
---

Fix MCP initialize rejected over the protocol version header

`McpServer.layerHttp` validated the `MCP-Protocol-Version` header on every POST, including
the `initialize` request. That header reports the version negotiated by an earlier
`initialize`, so on a fresh connection a client can only send its own default. Whenever
that default was not among the server's registered protocols the `initialize` returned
`400` and never reached version negotiation, even when the body offered a version the
server supports.

The header check now applies only to requests after initialization, where the
specification requires it. An `initialize` negotiates from the version offered in its
body, through the protocol registry, and reports the selected version in the response.
