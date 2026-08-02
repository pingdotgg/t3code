# MCP servers

**Settings → MCP** lists the MCP servers Claude Code loads, on every computer connected to T3 Code,
so you can see them without opening a terminal or a config file.

MCP (Model Context Protocol) servers give an agent extra tools: a database it can query, a browser
it can drive, an issue tracker it can read. You configure them in Claude Code itself, and T3 Code
reports what it finds.

## What the page shows

One collapsible group per connected computer, and inside it one group per Claude provider. Each row
is a server:

- **Name** — the name Claude Code knows it by.
- **Transport** — `stdio` for a local command, `http` or `sse` for a remote server.
- **Scope** — `project` for a server from the repo's `.mcp.json`, `local` for one private to that
  workspace. Servers available everywhere show no scope badge.
- **Detail** — the command line or the server address, with secrets removed. Environment values are
  never shown, a remote server is shown as its address only, and anything in a command line that
  looks like a credential is replaced with `…`. The one thing that slips through is a bare argument
  that looks like an ordinary word — `hunter2` is indistinguishable from a subcommand — so a secret
  passed with no flag in front of it can still be shown. Everything else stays in your config; T3
  Code does not carry it across the network.
- **Config file** — where the entry is declared. Click it to copy the full path.

"Refresh all" re-reads every computer, so a config you edited outside T3 Code shows up.

## Which harnesses are covered

Claude Code only, for now.

Cursor, Grok, and OpenCode run over ACP, which lets T3 Code _add_ a server to a session but never
reports the ones the agent loads from its own config — there is nothing to read. Codex keeps its
servers in `config.toml` and needs a separate lookup, which is not wired up yet.

Servers you connected through claude.ai rather than a config file are also not listed. Claude Code
resolves those outside the filesystem, where T3 Code cannot see them.

## When a config cannot be read

When a config exists but T3 Code cannot parse it — malformed JSON, a permissions problem, or a
`.claude.json` grown too large to read on demand — the page says so and names the file that failed.
The servers that file would have contributed are missing from the list; the rows you do see are
still accurate, because each one came from a file that parsed.

This never affects your sessions. T3 Code only reads these files; it does not write to
`.claude.json` or `.mcp.json`, and Claude Code resolves its own servers at launch exactly as it
would without T3 Code.

## Turning a server off

Not from here — this page is read-only. It tells you what is loaded, not what to load.

To remove a server, use Claude Code: `claude mcp remove <name>`, or edit the `mcpServers` block in
`.claude.json`. The change shows up here after "Refresh all".

## The built-in T3 Code server

T3 Code adds one MCP server of its own, named `t3-code`, to every session. It is what lets an agent
drive the built-in browser preview. It is not part of your configuration and does not appear on this
page.

---

Mobile: this page is web and desktop only.
