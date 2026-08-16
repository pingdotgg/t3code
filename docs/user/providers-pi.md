# Pi

T3 Code can run Pi through Pi's RPC mode. Pi keeps control of its models, accounts, extensions,
skills, tools, configuration, and session files.

## Set Up Pi

Install and configure Pi first. Confirm that the command works in the same environment as the T3
server:

```bash
pi --version
```

Then open **Settings**, add a **Pi** provider, and refresh its status. T3 uses `pi` from `PATH` by
default. Set **Binary path** when Pi lives elsewhere.

T3 marks the provider unavailable when it cannot run the configured binary.

## Models And Reasoning

T3 asks Pi for its current model list. Sign in to providers and manage custom models through Pi as
you normally would. T3 does not keep a separate fallback model list.

The model picker shows the models Pi reports. The reasoning picker only shows levels supported by
the selected model.

## MCP, Subagents, Commands, And Skills

Pi keeps MCP and subagents outside its core. A useful T3 setup must enable extensions for both.
Install the MCP adapter in Pi's normal configuration:

```bash
pi install npm:pi-mcp-adapter
```

T3 reports a warning when it cannot detect that adapter. The adapter reads `.mcp.json`,
`~/.config/mcp/mcp.json`, and its Pi-specific override files. Its proxy and direct MCP calls appear
as MCP tool activity in T3. Remote OAuth can use the adapter's `auth-start` and `auth-complete`
tool actions.

Enable a Pi subagent extension for isolated agents. T3 supports Pi's current `subagent` extension
result format, including single, parallel, and chained work. It also supports the older
`subagent_spawn` and `workflow` formats. Claude Code-style `Agent` extensions, including
`@tintinweb/pi-subagents`, can keep background agents running while the main Pi orchestrator
accepts new messages. T3 tracks their completion notifications and `get_subagent_result` calls.
Agent status, model, and token use appear in the Agents panel.

T3 reads the user-level Pi command catalog when it checks the provider:

- User-level Pi extension and prompt commands appear in the `/` menu.
- User-level Pi skills appear in both the `/skill:` menu and the `$` skill menu.
- Project commands and skills load inside the project session but are not advertised as a global
  provider catalog.
- Extension `select`, `confirm`, `input`, and `editor` requests use T3's user-input panel.

Extensions must use Pi's RPC-compatible UI methods for remote input. TUI-only custom views cannot
run in RPC mode.

## Sessions And Configuration

T3 stores the Pi session file path with each thread and resumes that same file later. It does not
copy or replace Pi's configuration directory. Changes made through Pi remain available in T3, and
changes made by a T3-hosted Pi session remain available to Pi.

You can set environment variables on each Pi provider instance in Settings. T3 passes them to the
Pi process without replacing the rest of the server environment.

## Context Use

T3 reads Pi's session statistics after each settled turn. The thread meter shows the tokens in the
current model context, while processed-token totals remain cumulative for the session. Immediately
after Pi compacts a session, current usage can be temporarily unavailable until the next model
response.

## Current Limits

Pi sessions use **Full access** mode. T3 does not add an approval gate around Pi tools. MCP and
subagent behavior comes from the enabled Pi extensions, and T3 translates their RPC events. T3
does not support restoring a Pi turn from a T3 checkpoint.
