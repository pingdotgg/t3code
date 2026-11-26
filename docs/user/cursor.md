# Cursor

Run Cursor's local agent in T3 Code using your paid Cursor account or `CURSOR_API_KEY`.

## Prerequisites and sign-in

- **Node.js 22.13+** on the environment's machine.
- A **paid Cursor plan** via browser sign-in or `CURSOR_API_KEY`.
- Open **Settings → Providers → Cursor** and choose **Sign in** (works on remote environments and configured mobile instances too).

Each Cursor instance keeps its own login separate from your Cursor editor or CLI. A configured `CURSOR_API_KEY` overrides browser sign-in. **Change account** or **Sign out** stops running threads for that instance while keeping history (to revoke a key early, delete it in your Cursor dashboard).

## Capabilities and limits

- Supports streaming text, reasoning, tool activity, plans, image attachments, mid-turn text steering (steers with attachments or mode changes restart the run), and **Edit from here** / checkpoint rewind (rewinding to the first message starts a fresh session).
- **Subagents**: Cursor `task` subagents appear as read-only child threads; message the parent thread to interact.
- **Forking**: Uses a [portable handoff](./portable-handoffs.md) into a fresh Cursor session.
- **Cloud agents**: Not yet supported—runs operate locally in your T3 Code workspace.
- **Permissions**: **Full access** disables Cursor's sandbox; restricted modes enable it. On Windows, the Cursor SDK has no filesystem sandbox, so **Auto** and **Supervised** run without filesystem isolation when Cursor Auto-review is enabled, while **Auto-accept edits** cannot start on Windows.

## MCP servers and plugins

Cursor loads MCP servers and plugins from `~/.cursor/mcp.json`, `~/.cursor/plugins`, and (in **Full access** only) the project's `.cursor/mcp.json`.

For OAuth MCP servers, authenticate via the CLI from the project root before starting a session:

```bash
agent mcp login <server>
```

After adding or changing skills, plugins, or MCP logins, run **Restart agent session** from the command palette.
