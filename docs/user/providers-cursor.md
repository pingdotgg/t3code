# Cursor

Cursor threads load project, user, team, MDM and plugin settings from the
agent environment. To supply additional HTTP MCP servers dynamically, set
`T3CODE_CURSOR_MCP_CONFIG_COMMAND` in the T3 server environment to a JSON
array containing an executable and its arguments:

```sh
T3CODE_CURSOR_MCP_CONFIG_COMMAND='["/absolute/path/to/mcp-config"]'
```

The command runs without a shell, in the thread's working directory, with
`T3CODE_THREAD_ID` set. It must print only
`{"mcpServers":{"example":{"type":"http","url":"https://example.com/mcp","headers":{}}}}`
to stdout. Headers are optional. Only configure a command you trust; its
output can contain credentials and must not be logged or checked into git.
The executable must be available to the server process, including when T3
runs as a service on a remote environment.

Restart T3 after changing its environment and start a new Cursor thread.
T3 resolves the command at create/resume and before each send, so refreshed
credentials reach the SDK. A failure stops the operation instead of silently
launching without the requested tools. Commands have a 30-second timeout and
a 1 MiB output limit. T3's own `t3-code` server always takes precedence.
Cursor's ambient servers remain available alongside this inline set.
