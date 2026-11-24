# MCP tool deferral

T3 can list only a few MCP tools to a harness and reveal the rest through `tool_search`. Why that needs a harness that lists tools again is in [Providers](../internals/03_providers.md). This page is how to check a harness, and what the last checks found.

## Probe a harness

1. From `apps/server`, run `node scripts/mcp-relist-probe.ts` (`--port` changes the port). It serves the real MCP transport with one hidden tool and prints the endpoint, the two headers, and a prompt.
2. Attach that endpoint to the harness as an HTTP MCP server with both headers, and send the prompt on the harness's cheapest model.
3. The harness passes when the log shows `mcp.tool-search.relisted` and then `the model called the hidden tool` in the same turn.
4. Restart the probe before the next run: a search stays loaded for the life of the process.

A harness that passes can take `deferMcpTools`. One that does not stays on the full list.

The live server writes the same `mcp.tool-search.relisted` line at debug level. It warns with `mcp.tool-search.not-relisted` when a session searches again without ever having listed after a search, which is how a harness that stopped listing shows up in the field.

## Last observations

Checked 2026-11-23. Harnesses change, so re-run the probe rather than trust a row. "Probe" rows were run; the others were read from shipped code.

| Harness      | Lists again after `list_changed`                                                     | Today                     | Known from         |
| ------------ | ------------------------------------------------------------------------------------ | ------------------------- | ------------------ |
| Claude Code  | Yes, same turn                                                                       | Its own ToolSearch        | Probe              |
| Codex        | Only with `features.mcp_tool_list_changed`                                           | Its own tool search       | Probe              |
| Copilot CLI  | Yes, same turn                                                                       | T3's `tool_search`        | Probe (#34245)     |
| Pi           | No: T3's extension lists once                                                        | Pi's own `tool_search`    | Source             |
| OpenCode     | Yes, same turn; the next step can race it                                            | Full list                 | Source, not probed |
| Antigravity  | Yes; same turn unknown                                                               | Full list                 | Binary symbols     |
| Kiro         | Unknown; its open-source ancestor did                                                | Full list                 | Strings            |
| Grok         | Unknown                                                                              | Full list                 | Strings            |
| fx           | Not from a POST response; yes over stdio                                             | Full list                 | Source             |
| Cursor       | No: tools are read once per run                                                      | Full list                 | Bundle             |
| Muse Code    | Unknown                                                                              | Full list                 | Strings            |
| ACP Registry | Gemini CLI, Goose, Kilo, fast-agent, Kimchi do; Qwen Code, Kimi, Mistral Vibe do not | Full list, except Copilot | Source             |
