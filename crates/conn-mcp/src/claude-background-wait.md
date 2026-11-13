### Background work you wait on

To wait for a background command or Monitor you started (tests, a build), call `t3_background_wait` with its task ID before you end your turn. Do not mark work you leave running, or PRs. T3 MCP tools are deferred: load one with ToolSearch before you call it.
