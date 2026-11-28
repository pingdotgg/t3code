# Outside agents

Connect external agents (Claude Code or Codex in your terminal, ChatGPT, or any OAuth-capable MCP client) to your T3 Code environment over MCP to read projects/threads, launch and message threads, and monitor events.

## Quick setup

Open the command palette (`Cmd/Ctrl+K`) and run **Use T3 Code in another app (MCP)** (or open **Settings → Sharing & access**), pick your app, and follow the prompts.

- Cloud assistants (like ChatGPT or Claude) require **T3 Connect** enabled on the environment.
- To also reach other machines through the same connection, enable **Settings → Labs → Linked environments** and [link them](./remote-access.md#link-another-environment).
- To copy the raw MCP endpoint (`https://<environment-address>/mcp`) of the machine you are on, use **MCP URL** in **Settings → Sharing & access**: it is the T3 Connect address when the tunnel is on, otherwise a `localhost` or `https://` address. For a saved remote environment, open its menu in **Settings → Environments → Copy MCP URL**. OAuth requires `https://` or `localhost` (plain `http://` LAN/Tailscale addresses cannot complete OAuth).

### CLI clients and ChatGPT

- **Claude Code**:
  ```sh
  claude mcp add --transport http t3 https://<environment-address>/mcp
  claude mcp login t3   # add --no-browser on headless hosts
  ```
- **Codex**:
  ```sh
  codex mcp add t3 --url https://<environment-address>/mcp
  codex mcp login t3    # add --no-browser on headless hosts
  ```
- **ChatGPT / other OAuth MCP clients**: Add a custom remote MCP server pointing to `https://<environment-address>/mcp` with **OAuth** authentication (no client ID or secret needed).

## Approve access and permissions

The first time an outside agent connects, approve its sign-in page (via your T3 Connect account, an already-authorized browser, or a one-time pairing code from **Settings → Sharing & access** / `t3 auth pairing create`).

- **Read only**: Inspect projects, threads, providers, and models.
- **Supervised → Full access**: Also launch, message, and stop threads up to the granted permission mode. Managing [workflow runs](./workflows.md) or using approval-skipping agent modes requires **Full access** (or your policy's maximum mode).
- Sign-ins last **30 days**; revoke anytime in **Settings → Sharing & access**.

## Available tools and limits

Tools that act as a running T3 thread (`delegate_task`, `create_threads`, `request_secret`, `html_render`, `preview_*`, `device_*`, `t3_worktree_handoff`) only work for agents running **inside** T3 Code.

- Use `t3_thread_launch` + `t3_thread_wait` / `t3_thread_read` to run and follow work.
- Pass `projectId` or `threadId` explicitly (or `allProjects: true` on `t3_thread_list`).
- **MCP Events (`io.modelcontextprotocol/events`)**: Bots can poll, stream, or subscribe via HTTPS webhooks (up to 1-hour leases; latest 1,000 milestones buffered in memory) for turn, approval, guest, PR watch, and workflow events. For local webhook testing, set `T3CODE_MCP_WEBHOOK_ALLOWED_HOSTS=localhost,127.0.0.1` on the server.

## Host scripts (`t3 thread`)

Only approve a sign-in you just started. On the environment's own page, enter a
code from **Use T3 Code in another app (MCP)**, **Settings → Sharing & access**,
or `t3 auth pairing create` on the host. A browser already signed in to the
environment with permission to manage access can approve without a code. On the
web app, **Use a sign-in code instead** opens the environment's own page.

A code from **Use T3 Code in another app (MCP)** already carries the level you
picked there. With another code, choose what the agent may do here: **Auto** is
selected by default, or the closest lower mode allowed by your organization’s
policy. Approving without a code starts at **Read only**:

- **Read only** lets the agent read projects, threads, and project
  code, recall saved facts, and see the available providers and models. It cannot
  change source files or saved facts.
- **Supervised** through **Full access** also let it start, message and stop
  threads in every project. A thread it starts or steers cannot run with more
  permissions than the mode you chose.

## What outside agents can call

Some tools only work for an agent running inside a T3 thread, because they act
as that thread: subagents, secret requests, rendered HTML, the browser preview,
devices, and worktree handoff. They still appear in an outside agent's tool
list, but calling one returns an error saying it needs an agent running inside
T3 Code.

- To hand off work, start a thread with `t3_thread_launch`, then follow it with
  `t3_thread_wait` or `t3_thread_read`, instead of `create_threads` or
  `delegate_task`.
- Tools that default to the caller's own project or thread need an explicit
  `projectId` or `threadId`.
- To list threads across projects, call `t3_thread_list` with
  `allProjects: true`, or use `t3_thread_search`.

## Claude Code

```sh
claude mcp add --transport http t3 https://<environment-address>/mcp
claude mcp login t3
```

`claude mcp login` opens the sign-in page in your browser. On a machine
without a browser, add `--no-browser`, open the printed URL elsewhere, and
paste the final URL back when asked. `claude mcp list` shows `t3` as connected
once you approve.

## Codex

```sh
codex mcp add t3 --url https://<environment-address>/mcp
codex mcp login t3
```

`codex mcp login --no-browser` prints the sign-in URL instead of opening it.
`codex mcp list` shows `t3` with OAuth once you approve.

## ChatGPT

Add the environment as a custom MCP app in ChatGPT's apps settings:

1. Create a new app or plugin with a custom MCP server.
2. Set the server URL to `https://<environment-address>/mcp`, using the T3
   Connect address.
3. Choose **OAuth** for authentication. ChatGPT discovers the rest; you do not
   need a client ID or secret.
4. Create the app, then approve the sign-in page that opens.

## Other agents and bots

Any agent that supports remote MCP servers over HTTP with OAuth can connect. Give
it the MCP URL and choose OAuth, and the agent finds the sign-in settings itself.
Agents without OAuth support cannot connect.

## Project memory and code navigation

Connected agents can search a project's conversations and recall saved facts.
With permission to make changes, they can record observations for later work.
An observation is saved immediately and keeps the agent's identity. Use **Project
memory** in T3 Code to inspect, edit, or forget these facts.

A directly connected outside client explicitly selects the project whose memory
it needs. Agents running in a T3 thread are restricted to that thread's project
and environment, including through linked environments. To use another
project's memory, open a thread in that project or connect a client directly to
its environment.

Agents can also query symbols, callers, references, dependencies, and likely
change impact in a registered project's codebase. Selecting a thread uses that
thread's worktree. The environment reads the files on its own machine, so the
same tools work when you connect remotely.

Code navigation requires filesystem read access. An existing agent sign-in
without that permission must be authorized again to use it. Graph results report
language coverage and unresolved relationships. Static relationships are leads
to inspect in source, and do not prove every possible runtime call. The first
query builds a local index; later queries update it for source changes.

## Scripts on the host

On the machine that runs the environment, `t3 thread` uses the same tools
without a sign-in:

```sh
id=$(t3 thread start . "Find why the tests are slow")
t3 thread send "$id" "Now fix it" --wait
t3 thread show "$id"
t3 thread list
```

- Pass `--worktree <base-branch>`, `--title` / `--generate-title`, `--provider <id> --model <slug>`, `--option id=value` (e.g. `reasoningEffort=high` for Codex, `effort=high` for Claude), or `-` to read the prompt from stdin.
- `--wait` prints the reply and exits `1` on failure/stop or `2` when waiting for user input. Add `--json` for structured output including the thread ID.
