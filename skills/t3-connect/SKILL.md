---
name: t3-connect
description: Use when a person wants Claude Code or Codex to connect to T3 Code over MCP, add the T3 MCP server, finish MCP login, or drive T3 projects and threads from an outside agent session.
---

# t3-connect: connect this agent to T3 Code

T3 Code exposes an MCP server on each environment. Once this session is signed in,
you can list projects, start and message threads, and check providers without
leaving Claude Code or Codex.

**Goal:** this session is connected and ready to use T3 tools. Stop after you
confirm the connection unless the person already asked you to do something in T3.

Tell them what you will run before you change MCP config. Do not broaden
permissions or rewrite unrelated config to avoid prompts.

## 1. Get the MCP URL

You need the environment's MCP URL (`…/mcp`). Prefer one they already pasted.

If they do not have it yet, ask them to open T3 Code, run **Use T3 Code in
another app (MCP)** from the command palette (`Cmd/Ctrl+K`), pick Claude Code or
Codex, and copy the URL (or the ready-made prompt). **Settings → Environments →
Copy MCP URL** also works. Hosted agents need the T3 Connect address; a local
agent can use that or a reachable `https` / `localhost` URL.

Do not invent an address. If they only have a plain-`http` LAN URL, explain that
sign-in needs `https` or `localhost`, and point them at T3 Connect or Tailscale
HTTPS in T3's outside-agents docs.

## 2. Add and sign in

Detect which harness you are:

- Claude Code: `claude --version` works, or this session is Claude Code.
- Codex: `codex --version` works, or this session is Codex.

Then run the matching pair (say so first):

```sh
# Claude Code
claude mcp add --transport http t3 <mcp-url>
claude mcp login t3

# Codex
codex mcp add t3 --url <mcp-url>
codex mcp login t3
```

If login opens a browser, wait for them to approve. If there is no browser, use
`--no-browser`, give them the printed URL, and paste the final URL back when
asked. A one-time code from T3's wizard or `t3 auth pairing create` may be needed
on older environments; only use a code they just minted.

## 3. Confirm, then ask what to do

- Claude Code: `claude mcp list` shows `t3` as connected.
- Codex: `codex mcp list` shows `t3` with OAuth.

Say you are connected. If they have not already given a task, ask what they want
to do in T3 Code. Prefer T3's thread tools (`t3_thread_launch`, `t3_thread_wait`,
`t3_thread_read`) for work that should show up in T3; tools that need an agent
running inside T3 will say so when called.

## If something fails

- `npx: command not found` is unrelated; this path uses `claude` / `codex` on PATH.
- Sign-in over plain `http` (non-localhost) will not finish; switch URL as in step 1.
- Revoke or inspect access later under T3 **Settings → Sharing & access**.
- Full reference: https://github.com/pingdotgg/t3code/blob/main/docs/user/outside-agents.md
