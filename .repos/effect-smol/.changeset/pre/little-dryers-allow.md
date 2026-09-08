---
"effect": patch
---

Persist MCP client capability context across HTTP requests by resolving initialized payloads through the standard `Mcp-Session-Id` HTTP header in `McpServer`.

Adds a regression test that initializes an MCP HTTP client, verifies the MCP server echoes `Mcp-Session-Id`, and then checks a later tool call can still read `McpServer.clientCapabilities`.
