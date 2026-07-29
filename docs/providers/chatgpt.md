# ChatGPT (browser bridge)

The ChatGPT provider runs work through a signed-in `chatgpt.com` session in a
real browser instead of a local CLI. It exists for one reason: ChatGPT's web
plan and the Codex CLI meter against different limits, so a conversation that
would exhaust a Codex quota can be run against the web plan instead.

It is made of two independent halves, and it is worth understanding both
because they fail separately:

| Half                    | What it does                                                                                              | How it talks                                     |
| ----------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| **Browser bridge**      | Types your prompt into a ChatGPT conversation and streams the reply back into the SergeCode timeline.     | Playwright drives a Chrome/Chromium page.        |
| **Workspace connector** | Lets that conversation read the thread's repository — list, read, search, and review uncommitted changes. | ChatGPT calls SergeCode's MCP server over HTTPS. |

The browser bridge alone gives you a chat box with no awareness of your code.
The connector is what makes it a coding session.

## How a turn actually flows

```
SergeCode composer
      │  Playwright types the prompt
      ▼
chatgpt.com conversation
      │  OpenAI's backend calls the connector
      ▼
SergeCode MCP server  ──►  workspace_read / _tree / _search / _changes
      │  answers, scoped to this thread's worktree
      ▼
chatgpt.com composes a reply
      │  Playwright scrapes the streamed text
      ▼
SergeCode timeline
```

Every connector call also lands in the thread timeline as a tool activity, so
you can see which files ChatGPT actually opened rather than inferring it from
the prose.

## Setup

### 1. Point SergeCode at a browser

In Settings → Providers → ChatGPT, choose one of:

- **Browser debugging endpoint** (default `http://127.0.0.1:9222`) — start
  Chrome with `--remote-debugging-port=9222` and keep a signed-in
  `chatgpt.com` tab open. SergeCode attaches to the browser you already use.
- **Browser executable path** — SergeCode launches its own persistent profile
  at `~/.sergecode/chatgpt-browser-profile`. Sign in to `chatgpt.com` once in
  that profile.

Leave **Headless browser** off. Login and bot checks need to be visible; a
headless window that is silently blocked looks identical to a slow model.

### 2. Expose the server (only needed for the connector)

**OpenAI's servers call the connector, not your browser.** A loopback address
will never be reached, so the endpoint needs a public HTTPS route. Any tunnel
works; SergeCode does not manage one for you:

```bash
cloudflared tunnel --url http://127.0.0.1:<sergecode-server-port>
# or
ngrok http <sergecode-server-port>
# or, with Tailscale Funnel already enabled
tailscale funnel <sergecode-server-port>
```

Paste the resulting `https://…` origin into **Public HTTPS address**. Leave it
blank to keep the connector off and use the provider as a plain chat bridge.

### 3. Register the connector in ChatGPT, once

Start a ChatGPT thread in SergeCode. The timeline shows a **Workspace
connector** message with a URL. In ChatGPT: Settings → Connectors → add a
connector with:

- **Server URL** — the URL from the timeline
- **Authentication** — **No authentication**

"No authentication" is correct: ChatGPT's connector settings cannot send a
custom header, so the credential travels in the URL itself. See the security
notes below for what that does and does not expose.

Connectors are registered per ChatGPT account, not per conversation, so this
is a one-time step. Later threads reuse the registered connector.

## What the connector can do

Five read-only tools, all scoped to the calling thread's worktree:

| Tool                 | Purpose                                                                                 |
| -------------------- | --------------------------------------------------------------------------------------- |
| `workspace_overview` | Repository name, branch, dirty state, top-level entries, which instruction files exist. |
| `workspace_tree`     | Bounded directory listing.                                                              |
| `workspace_read`     | One file, with line numbers, optionally a line range.                                   |
| `workspace_search`   | Literal text search with smart case, returning path and line.                           |
| `workspace_changes`  | Changed-file list and unified diff for uncommitted work.                                |

There is deliberately no write, patch, or command tool. Ask ChatGPT for a diff
or an instruction and apply it with a provider that has real write access.

## Security model

The connector URL is a credential. What limits the damage if it leaks:

- **Read-only.** The `workspace` capability grants exactly the five tools
  above. It cannot write files, run commands, or start agents — notably, it
  does _not_ carry the `agents` capability that local provider sessions get.
- **Scoped to one thread.** The credential is minted per thread and resolves
  to that thread's worktree. It cannot reach another project.
- **Expiring and revocable.** Credentials idle out after 30 minutes and expire
  after 8 hours. Ending the session revokes them.
- **Contained.** Every path is resolved against the workspace root and
  re-checked after symlink resolution. Absolute paths, `..` traversal,
  version-control internals, dependency directories, and credential files
  (`.env`, `*.pem`, `*.key`, `id_rsa*`, `.ssh/**`, …) are refused.
- **Redacted in SergeCode's logs.** Log lines this server writes run the URL
  through a redactor first. This does not extend to Effect's built-in HTTP
  request logger — if you turn on `logWebSocketEvents`, the query string
  (and therefore the credential) is logged. Avoid that while a connector is
  registered, or re-register afterwards to rotate the token.

What it does _not_ protect against: the contents of files ChatGPT reads are
sent to OpenAI and subject to your account's data policy, exactly as if you
had pasted them into the chat. Do not point the connector at a repository you
would not paste.

Treat leaving a tunnel running as leaving a door open. Stop the tunnel when
you stop working.

## Limits and known rough edges

- **Model responses are scraped from the DOM.** ChatGPT's markup changes
  without notice; a layout change can break response capture even while the
  conversation itself works fine.
- **No approvals, plans, or checkpoints.** The browser bridge has no protocol
  for them, so those provider operations fail explicitly rather than silently
  no-op.
- **No attachments.** Files attached to a turn are named in the prompt but not
  uploaded.
- **No background text generation.** Commit messages, PR text, branch names,
  and thread titles fall back to Codex, Claude, or Grok.
- **One turn at a time per thread.**
- **Automating a logged-in web session is your call.** Check OpenAI's terms
  for your account before relying on this in a workflow that matters.

## Relationship to CodexPro

[CodexPro](https://github.com/rebel0789/codexpro) pioneered this pattern: run
a local MCP server, tunnel it, and register it as a ChatGPT Developer Mode
connector. SergeCode implements the same idea natively rather than depending
on the package, because the server already hosts an MCP endpoint with
per-thread credential scoping, and a native implementation can bind each
conversation to a real SergeCode thread — which is what puts ChatGPT's file
access in the timeline instead of in a separate terminal.

If you want write access, patches, shell commands, or the `.ai-bridge` handoff
workflow today, use CodexPro directly. Those are intentionally out of scope
here for now; see the roadmap below.

## Roadmap

- Write and patch tools, gated behind SergeCode's existing approval flow so
  every edit needs a decision in the UI.
- A managed tunnel, so **Public HTTPS address** fills itself in.
- Connector-URL affordance in Settings → Providers (copy button, QR) rather
  than only in the thread timeline.
- Attachment upload through the browser bridge.
