# Plugin tools

A trusted local plugin can offer tools that agents call through T3 Code's own
MCP server. Plugins are code that runs as your OS user, so only add plugins you
trust.

## Offering a tool

In the plugin's `t3-plugin.json`, add `"tools"` to `capabilities`, set
`"proposedApi": true`, and declare each tool in `tools` with a `name`,
`description`, `inputSchema` and `sideEffect` (`read`, `write` or
`destructive`). The plugin answers a call by registering
`context.proposed.handle("t3.tool.<name>", handler)`; the handler receives
`{ input, context: { environmentId, threadId } }`.

`inputSchema` must stay within the JSON Schema subset T3 Code enforces. A
manifest outside it is refused when the plugin is added, with the path of the
keyword it cannot enforce. Input that does not match the schema never reaches
the plugin.

## Making tools available

Plugins are managed from an administrative connection with the `plugins.add`,
`plugins.consent` and `plugins.enable` requests. Consent covers the plugin's
exact files, tool declarations included. Listing tools never starts the plugin;
the first call does.

Agents see two tools in every session that uses T3 Code's MCP server:
`plugin_tools_list` and `plugin_tool_call`.

## Which sessions can use a plugin

A session can use the tool plugins that were enabled when it started. A plugin
you enable later, or enable again after disabling it, shows up as not
available in this session. To use it, start a new thread.

Disabling or removing a plugin refuses its tools at once in every session and
cancels calls in progress. T3 Code checks a plugin's files when you refresh,
consent to or enable it, when the server starts, and before a call starts the
plugin. If the files changed, the plugin is disabled until you consent to the
new version. A plugin that is already running is not checked again until one of
those points, so refresh it after editing its files.
