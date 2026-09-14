---
"effect": patch
---

Update `McpServer.layerHttp` to return `405` for unsupported HTTP methods, reject unsupported `MCP-Protocol-Version` headers with `400`, and return an empty `202` for accepted notifications and responses.
