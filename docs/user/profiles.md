# Profiles

A profile bundles prompt parts, skills, MCP servers and, for each provider, a named set of
**provider settings** that shape how that provider's harness runs. Pick a profile beside the composer on web, desktop or
mobile. New threads use the default profile. A thread an agent starts keeps the profile of the agent's
thread, also when the agent picks another model; it gets the default only when that thread has none.
Delegated tasks start without a profile: they take neither the parent's profile nor the default.

Manage everything in **Settings → Profiles**. Mobile shows the same page with fewer controls; edit
provider settings and prompt text on web or desktop.

## The profiles folder

Each environment keeps its profiles in a folder, `<T3 home>/profiles` unless you set another path in
**Settings → Profiles**. **Open in editor** opens it on the selected environment's machine when
that environment has a supported editor.

```text
profiles/
  profiles.json            profiles and the default
  provider-settings.json   named provider settings per provider
  mcp-servers.json         MCP servers profiles can add
  prompts/<name>.md        prompt parts
  .agents/skills/<name>/   skills, one SKILL.md each
  skills-lock.json         where installed skills came from
```

A broken profile stays in the list with a warning; the others keep working.

## Sharing between environments

You do not run Git for this. When you save in **Settings → Profiles**, T3 copies the folder to every
environment the app is connected to. An environment that was offline gets the newer copy when the app
connects to it again, and **Sync now** does the same on demand. The most recently changed copy wins,
judged by each machine's clock; an edit made outside T3 counts from when its file changed. If an
environment's folder was also changed by hand since its last sync, T3 keeps that version in a backup
folder under `<T3 home>/profiles-backups` and shows a notice.

To keep one machine's profiles to itself, turn off **Sync with other machines** on that machine. It
then neither sends nor receives copies.

An environment no app connects to keeps its last copy until the app connects to it. `node_modules` is
never copied: a skill that needs dependencies shows **Install** on each machine.

## Skills

**Add skill** takes a repository such as `YJJosh/Portler` and installs it with the
[`skills`](https://github.com/vercel-labs/skills) command (`npx skills`), so the environment needs Node
and `npx`. **Update all** updates every installed skill from its source, then syncs. Skills you write
yourself go in `.agents/skills/<name>/SKILL.md`; they are not updated.

Skills are not added to profiles automatically. Tick them in each profile. A selected skill gives the
agent its name, description and the path of its `SKILL.md`, which the agent reads when needed. Skills
can contain scripts and run with the agent's permissions, and syncing copies them to every
environment, so only add skills you trust.

## MCP servers

Define MCP servers once in **Settings → Profiles → MCP servers**, then tick them in each profile. A
selected server is added to Claude and Codex sessions, next to your own MCP servers and T3's. Other
providers start without it. Give profile servers names your own MCP config does not use.

A server is either a **URL** (with optional headers) or a **command** (with arguments and environment
variables). `mcp-servers.json` uses the same shape as Claude's `.mcp.json`, so you can paste
definitions in. Only the fields T3 knows are kept, and URL servers must use `"type": "http"` — the
older `"sse"` type is not supported. Server names starting with `t3-code` belong to T3 itself. If a
server cannot be reached when a session starts, the session starts without it.

```json
{
  "mcpServers": {
    "docs": { "type": "http", "url": "https://docs.example.com/mcp" },
    "browser": { "command": "npx", "args": ["-y", "@example/browser-mcp"] }
  }
}
```

The folder syncs to your other machines, and a command server runs on whichever machine starts the
session. So command servers only run where **Allow MCP commands** is on in **Settings → Profiles**;
it is off by default on each machine. A session whose profile needs a command server does not start
until you turn it on there or remove the server from the profile.

Header and environment values are copied to every machine too. For tokens, pick a
[secret provider](./secrets.md) instead of **Value**. The secret is read when a session starts; if
that machine cannot read it, the session does not start and says which server needs it. Each machine
sends its own secret to the server's URL, and URL servers do not need **Allow MCP commands**, so only
sync profiles with machines and people you trust. Changing MCP servers needs permission to manage
providers.

## Provider settings

Provider settings are named per provider, such as `lean` or `full` for Claude. A profile picks one for
each provider, so two threads on the same provider can run different settings at the same time.
**Detect** reads what this machine's provider offers (tools, skills, plugins, features). An option
another machine lacks is marked and skipped there.

| Provider | What provider settings can change                                                                                    |
| -------- | -------------------------------------------------------------------------------------------------------------------- |
| Claude   | Blocked tools, bundled skills, skills and plugins, memory, attribution, Claude in Chrome, other Claude Code settings |
| Codex    | Features and config that Codex applies per thread                                                                    |
| Pi       | Pi's own skills and prompt templates on or off                                                                       |

Login, binary path and home directory stay with the provider in **Settings → Providers**. Settings T3
itself needs, such as its own tools and MCP servers, cannot be turned off. Provider settings are copied
to every environment, so do not put secrets in them. Add MCP servers in the MCP servers section, not
here.

Changes apply when a session starts or resumes, not to a turn that is running. Claude, Codex, Pi,
Muse and ACP providers support profile prompts and skills. Named provider settings apply only to
Claude, Codex and Pi. Cursor, OpenCode and other unsupported providers gray out the picker and start
sessions normally.
