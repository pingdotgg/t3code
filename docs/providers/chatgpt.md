# ChatGPT (browser bridge)

The ChatGPT provider runs work through a signed-in `chatgpt.com` session in a
real browser instead of a local CLI. It exists for one reason: ChatGPT's web
plan and the Codex CLI meter against different limits, so a conversation that
would exhaust a Codex quota can be run against the web plan instead.

It is made of two independent halves, and it is worth understanding both
because they fail separately:

| Half                    | What it does                                                                                                                                          | How it talks                                     |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| **Browser bridge**      | Types your prompt into a ChatGPT conversation and streams the reply back into the SergeCode timeline.                                                 | Playwright drives a Chrome/Chromium page.        |
| **Workspace connector** | Lets that conversation work with the thread's repository — read, search, edit, patch, and (optionally) run commands, with approvals in your timeline. | ChatGPT calls SergeCode's MCP server over HTTPS. |

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

### 2. Choose what the connector may do

**Workspace access** in the same settings pane:

- **read** — inspect only: list, read, search, review uncommitted changes.
- **write** (default) — also edit files and apply patches.
- **full** — also run shell commands.

Access is baked into the connector credential, so changing it takes effect on
the next thread. Whether a granted mutation _executes_ is decided per
operation by the thread's runtime mode — see "Approvals" below.

### 3. Expose the server (only needed for the connector)

**OpenAI's servers call the connector, not your browser.** A loopback address
will never be reached, so the endpoint needs a public HTTPS route. The easy
path is the managed tunnel:

```bash
brew install cloudflared
```

then set **Managed tunnel** to `cloudflared`. On the first ChatGPT session
SergeCode starts a Cloudflare quick tunnel that exposes **only the `/mcp`
endpoint** (an internal proxy 404s every other path before it reaches the
server). No Cloudflare account needed. The tradeoff: the public hostname
changes every time the tunnel restarts, so after a server restart you must
paste the new connector URL into ChatGPT's connector settings.

For a stable hostname, run your own tunnel instead and paste its origin into
**Public HTTPS address (manual)** — a named cloudflared tunnel, an ngrok
domain, or Tailscale Funnel. The manual address wins over the managed tunnel
when both are set. If you go manual, prefer fronting the MCP endpoint only,
not the whole server port.

Leave both off to keep the connector off and use the provider as a plain chat
bridge.

### 4. Register the connector in ChatGPT, once

Start a ChatGPT thread in SergeCode. The timeline shows a **Workspace
connector** message with a URL. In ChatGPT: Settings → Connectors → add a
connector with:

- **Server URL** — the URL from the timeline
- **Authentication** — **No authentication**

"No authentication" is correct: ChatGPT's connector settings cannot send a
custom header, so the credential travels in the URL itself. See the security
notes below for what that does and does not expose.

Connectors are registered per ChatGPT account, not per conversation, so this
is a one-time step (per hostname — a managed quick tunnel changes hostname on
restart, a stable manual hostname never needs re-registering).

## What the connector can do

All tools are scoped to the calling thread's worktree. Reads (always granted):

| Tool                 | Purpose                                                                                 |
| -------------------- | --------------------------------------------------------------------------------------- |
| `workspace_overview` | Repository name, branch, dirty state, top-level entries, which instruction files exist. |
| `workspace_tree`     | Bounded directory listing.                                                              |
| `workspace_read`     | One file, with line numbers, optionally a line range.                                   |
| `workspace_search`   | Literal text search with smart case, returning path and line.                           |
| `workspace_changes`  | Changed-file list and unified diff for uncommitted work.                                |

Mutations (granted by the access level, executed per the runtime mode):

| Tool              | Access | Purpose                                                                |
| ----------------- | ------ | ---------------------------------------------------------------------- |
| `workspace_write` | write  | Create or fully overwrite one file.                                    |
| `workspace_edit`  | write  | Exact-match text replacement in one file.                              |
| `workspace_patch` | write  | Apply a unified diff (`git apply --check` first; all-or-nothing).      |
| `workspace_bash`  | full   | One shell command in the worktree, scrubbed environment, hard timeout. |
| `workspace_wait`  | read   | Poll a pending operation until the user decides.                       |

## Approvals

Mutations follow the thread's runtime mode, exactly like a local provider:

| Runtime mode      | write/edit/patch | bash          |
| ----------------- | ---------------- | ------------- |
| Approvals         | approval card    | approval card |
| Auto-accept edits | auto             | approval card |
| Auto              | auto             | approval card |
| Full access       | auto             | auto          |

When approval is needed, the operation appears as an approval card in the
SergeCode timeline with the file content, patch, or command. Nothing touches
disk until you decide. "Approve for session" remembers the decision for that
kind of operation until the session ends. Meanwhile the ChatGPT side sees
`status: pending-approval` and polls `workspace_wait`; the operation executes
the moment you click approve.

If a mutation needs approval while the thread's ChatGPT session is not running
in SergeCode, it fails with `approval-unavailable` rather than queueing
invisibly — keep the thread open while ChatGPT works.

## Security model

The connector URL is a credential. What limits the damage if it leaks:

- **Capabilities are baked into the token.** A `read` credential physically
  cannot mutate; a `write` credential cannot run commands. No credential ever
  carries the `agents` capability that local provider sessions get — a leaked
  connector URL can never start agents on this machine (the issuance path
  strips `agents` unconditionally).
- **Mutations need a human unless you opted out.** In the default runtime mode
  every write, patch, and command is an approval card in your timeline before
  anything executes. An attacker with the URL in that mode can propose
  operations you then see and decline. Only the thread's own runtime mode
  (which you set) relaxes that.
- **Scoped to one thread.** The credential is minted per thread and resolves
  to that thread's worktree. It cannot reach another project.
- **Expiring and revocable.** Credentials idle out after 30 minutes and expire
  after 8 hours. Ending the session revokes them.
- **Contained.** Every path — read or write, including each file named in a
  patch — is resolved against the workspace root and re-checked after symlink
  resolution (writes also re-check the parent directory). Absolute paths,
  `..` traversal, version-control internals, dependency directories, and
  credential files (`.env`, `*.pem`, `*.key`, `id_rsa*`, `.ssh/**`, …) are
  refused for writing as well as reading.
- **Commands run in a scrubbed environment.** `workspace_bash` rebuilds the
  environment from scratch (`env -i` with PATH/HOME/TMPDIR only), so API keys
  and tokens exported in the server's environment are not observable from
  inside a command — which matters, because command output is relayed to
  OpenAI. Output is byte-capped and the command has a hard timeout.
- **The managed tunnel exposes only `/mcp`.** An internal proxy answers 404
  for every other path, so "publicly reachable" and "the token-gated MCP
  endpoint" are the same set. The WebSocket RPC surface, pairing, and
  discovery routes stay private.
- **Redacted in SergeCode's logs.** Log lines this server writes run the URL
  through a redactor first. This does not extend to Effect's built-in HTTP
  request logger — if you turn on `logWebSocketEvents`, the query string
  (and therefore the credential) is logged. Avoid that while a connector is
  registered, or re-register afterwards to rotate the token.

What it does _not_ protect against: the contents of files ChatGPT reads are
sent to OpenAI and subject to your account's data policy, exactly as if you
had pasted them into the chat. Do not point the connector at a repository you
would not paste. And `full` access plus **Full access** runtime mode means
remote code execution by design — that combination should be a deliberate
choice for a thread, not a default you forget about.

Treat leaving a tunnel running as leaving a door open. Stop the tunnel when
you stop working.

## Limits and known rough edges

- **Model responses are scraped from the DOM.** ChatGPT's markup changes
  without notice; a layout change can break response capture even while the
  conversation itself works fine.
- **The managed quick tunnel's hostname rotates on restart**, which means
  re-pasting the connector URL in ChatGPT settings. Use a stable manual
  address if that gets old.
- **No plans or checkpoints.** The browser bridge has no protocol for them;
  approvals exist only for workspace-connector mutations.
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

The one CodexPro feature without an equivalent here is the `.ai-bridge`
file-based handoff workflow; SergeCode's own delegation covers that ground
differently.

## Roadmap

- Connector-URL affordance in Settings → Providers (copy button, QR) rather
  than only in the thread timeline.
- A named-tunnel option so the managed tunnel can keep a stable hostname.
- Attachment upload through the browser bridge.
