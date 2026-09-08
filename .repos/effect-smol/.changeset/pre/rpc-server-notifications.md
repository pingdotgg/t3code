---
"effect": patch
---

Add support for server-originated RPC requests and notifications. Buffered
JSON-RPC HTTP drops notifications until streaming responses are available.
