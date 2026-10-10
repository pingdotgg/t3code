# Shared MCP servers

Add an MCP server once and every new agent session on that environment can use
its tools, whichever provider runs the session: Claude, Codex, Cursor,
OpenCode, Pi, or ACP agents. If the server needs a login, you sign in once in
T3 Code. You don't sign in separately in each agent, and you don't edit each
agent's own MCP config.

Open **Settings → Integrations → Shared MCP servers**. On mobile, it's
**Settings → Shared MCP servers**. Shared servers belong to one environment, so
pick a single environment at the top of Settings first.

## How logins stay in T3 Code

Agents never connect to a shared server themselves. Each agent reaches it
through T3 Code with the same per-thread credential it already uses for T3's
own tools. T3 Code then connects to the real server with the server's headers
or OAuth login. Those stay in T3 Code's secret store, so no agent's config,
environment, or transcript ever holds them.

A login belongs to the environment, not to a person. Every session on that
environment, whoever starts it, reaches the server as the account that signed
in. If several people share one environment, the server sees all of their
changes as made by that one account.

Only tools are shared. Resources and prompts are not.

## Servers that sign in with OAuth

Most hosted MCP servers use an OAuth login. Add the server with just its name
and URL, and leave **Headers** empty:

| Name     | URL                          |
| -------- | ---------------------------- |
| `linear` | `https://mcp.linear.app/mcp` |
| `notion` | `https://mcp.notion.com/mcp` |
| `sentry` | `https://mcp.sentry.dev/mcp` |

1. Choose **Test connection** from the server's menu. A server you haven't
   signed in to yet shows **Needs sign-in**.
2. Choose **Sign in**. Your browser opens the provider's login page.
3. Approve access. The provider sends you back to a T3 Code page that says
   **Signed in to linear** (or the server's name). You can close it.
4. Choose **Test connection** again. It shows the server's name and how many
   tools it has.

T3 Code keeps the login and refreshes it. If the provider ends it, **Test
connection** shows **Needs sign-in** again, and agents get a tool error asking
you to sign in from Settings.

The provider sends your browser back to the environment's own address. That
address must open from the browser you sign in with. Any address that opens
T3 Code from that browser works.

## Servers that take a token in a header

Some servers take an API key or a personal access token instead of an OAuth
login. Put it under **Headers**, one per line, as `Name: value`:

| Name      | URL                                  | Headers                                  |
| --------- | ------------------------------------ | ---------------------------------------- |
| `github`  | `https://api.githubcopilot.com/mcp/` | `Authorization: Bearer <personal-token>` |
| `context` | `https://mcp.context7.com/mcp`       | `CONTEXT7_API_KEY: <key>`                |

Header values are stored as secrets. When you edit the server, they show as
`••••••`. Leave that as it is to keep the saved value, or type a new one.

## Servers with no login

A public server needs only a name and URL. For example, `deepwiki` at
`https://mcp.deepwiki.com/mcp`.

## Turning a server off

Use the server's switch to keep it out of new sessions without removing it.
New sessions pick up any change. For a session that's already running, use
**Restart agent session** in the command palette.

## Limits

- Servers are reached over `http(s)`. A command-line (stdio) server can be
  shared through a local MCP gateway, then added here by its URL.
- An OpenCode server you run yourself doesn't get shared servers, the same as
  T3 Code's own tools.
