# Skills and MCP servers

**Settings → Tools** controls what agents can use on an environment: the skills they load and the
MCP servers T3 Code gives them. Pick a project in the settings crumb to change them for that
project only. Changes apply when an agent session next starts; use **Restart agent session** in the
command palette to pick them up in an open thread.

## Skills

The **Skills** tab lists every skill the environment's agents find, grouped by where it lives: the
selected project, your personal folders (such as `~/.agents/skills` and `~/.claude/skills`), and
plugins. A skill is listed once even when several folders or agents have it.

Turning a skill off removes it from the composer's skill menu and hides it from Claude, Codex and
OpenCode 1.x sessions. Cursor, Grok, Antigravity, Pi and OpenCode 2 have no way to hide one skill,
so they may still use it on their own. A skill switched off in the agent's own settings shows as
off and can't be turned on here.

With a project selected, a switch overrides the environment for that project only: you can turn a
skill off for one project, or back on where the environment has it off.

## MCP servers

The **MCP servers** tab lists servers T3 Code adds to every agent session, next to its own
`t3-code` server and the servers each agent already loads from its own config, which keep working
unchanged. T3 Code never edits those config files.

**Add server** takes a command (such as `npx -y @playwright/mcp`) or a URL. Pasting the JSON
snippet from a server's documentation fills in the form. Environment variables and headers are
marked secret by default: secret values are stored on the environment and never shown again, so
leave the field empty to keep one or type a new value to replace it. Adding or editing a server
needs permission to manage providers, because a server runs on the environment for every agent.

With a project selected, servers you add belong to that project. Giving one the same name as an
environment server replaces it for the project, which is how to point a project at a different
account. Inherited servers can be switched off for the project without removing them elsewhere.

Claude, Codex, Cursor, OpenCode, Grok and other ACP agents get these servers. ACP agents that don't
support URL servers only get command servers. Pi isn't supported yet.
