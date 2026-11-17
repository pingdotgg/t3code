# Outside agents

Agents that T3 Code did not start can work with an environment through its MCP
server. They can read projects and threads, start and message threads, and
check which providers and models are available. This covers Claude Code or
Codex in your own terminal, ChatGPT, and bots that support MCP. Each agent signs
in once, and you choose what it may do.

## Add T3 Code to an assistant app

Open the command palette (`Cmd/Ctrl+K`) and choose **Use T3 Code in another
app (MCP)**, or use the button in **Settings → Sharing & access**. Pick the
app and follow the step for that app. Assistants like
Poke and Claude run in the cloud, so the wizard first asks you to sign in to T3
Connect and turn it on for the environment. To reach your other machines through
the same connection, turn on **Linked environments** in Labs and
[link them](./remote-access.md#link-another-environment).

When the app opens the sign-in page, choose what it may do and approve with your
T3 Connect account. On an older environment, the wizard asks for the level and
gives you a code to paste instead. A code works once, for 5 minutes, and
approves only that level.

For an app that is not listed, choose **Something else…**, add a remote MCP
server with OAuth in that app, and paste the URL. Apps that require their own
client ID cannot connect.

## Get the MCP URL

In **Settings → Environments**, open a saved environment's menu and choose
**Copy MCP URL**. The URL is the environment's address followed by `/mcp`, for
example:

```text
https://<environment-address>/mcp
```

When T3 Connect serves the environment, the copied URL is its T3 Connect
address, which agents can reach from anywhere. Otherwise it uses the route this
device is connected over, so an agent on the same device can reach it.

- **An agent on your own computers** can use `localhost` on the host, T3
  Connect, or any `https` address, such as
  [Tailscale HTTPS](./remote-access.md#tailscale-https). Signing in sends the
  agent's credentials to the environment, and agents only do that over `https`
  or to `localhost`. A plain-`http` LAN or Tailscale address, like
  `http://100.x.y.z:3773`, lets an agent find the environment but not finish
  signing in.
- **A hosted agent**, such as ChatGPT or a bot running in the cloud, must reach
  the environment from the internet. Use the T3 Connect address. A Tailscale
  address only works from your own tailnet.

## Approve a sign-in

The first time an agent connects, it opens a sign-in page. When the agent
reaches the environment through T3 Connect, the page opens on the T3 Code web
app: sign in with the T3 Connect account the environment is linked to and
approve there, without a code. Otherwise the page opens on the environment.
Either page names the agent and where its access goes:

- For an agent on your computer, approval returns to a `localhost` address on
  the computer that opened the page.
- For a hosted agent, approval goes to that service, such as `chatgpt.com`.
  Anyone who runs that service gets the access.

Only approve a sign-in you just started. On the environment's own page, enter a
code from **Use T3 Code in another app (MCP)**, **Settings → Sharing & access**,
or `t3 auth pairing create` on the host. A browser already signed in to the
environment with permission to manage access can approve without a code. On the
web app, **Use a sign-in code instead** opens the environment's own page.

A code from **Use T3 Code in another app (MCP)** already carries the level you
picked there. With another code, choose what the agent may do here: **Auto** is
selected by default, or the closest lower mode allowed by your organization’s
policy. Approving without a code starts at **Read only**:

- **Read only** lets the agent read projects and threads and see
  the available providers and models. It cannot change anything.
- **Supervised** through **Full access** also let it start, message and stop
  threads in every project. A thread it starts or steers cannot run with more
  permissions than the mode you chose.

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

### Receive thread notifications

The host administrator can configure outbound webhooks for a bot, including an
official Grok Bot webhook. Connect the bot to T3's MCP server first. The webhook
notifies the bot when a thread needs an answer or approval, or when a run ends.
The bot reads context and sends its response through MCP.

Create `thread-webhooks.json` in the environment's userdata directory, next to
`statev2.sqlite`. Protect it with `chmod 600 thread-webhooks.json` on macOS or
Linux, because it contains the receiver's bearer token. Use this format:

```json
[
  {
    "id": "grok-bot",
    "url": "https://your-bot.example/webhook",
    "token": "YOUR_WEBHOOK_TOKEN",
    "projectIds": ["YOUR_PROJECT_ID"]
  }
]
```

The project filter includes new threads in that project automatically. Add
`"threadIds": ["YOUR_THREAD_ID"]` to limit notifications to named threads. Both
filters must match when present. Omit a filter to include all projects or
threads. An empty filter includes none. HTTPS is required, except for HTTP on
localhost for local tests. Restart the host after each configuration change.
An absent file or `[]` disables notifications. Invalid configuration stops startup
with a bounded error that does not print the token. Keep this file out of Git.

T3 sends JSON with `Authorization: Bearer YOUR_WEBHOOK_TOKEN` and an
`Idempotency-Key` header equal to `deliveryId`. The version 1 payload includes
`eventId`, `sequence`, `occurredAt`, `projectId`, `threadId`, and `runId`.
`runId` can be null if the request has no associated run. Event types are:

- `thread.user-input.requested`, with `requestId` and `status: "pending"`.
- `thread.approval.requested`, with `requestId` and `status: "pending"`.
- `thread.provider-error`, with `turnItemId`, `failureClass`, and status `running`
  or `failed`. A running error means the provider is handling a retry. It does
  not mean the run has stopped. Retry counter updates do not repeat this event.
- `thread.goal.blocked`, with `providerThreadId` and status `usage_limited` or
  `budget_limited`. Its `runId` is null because a provider goal can span runs.
- `thread.run.terminal`, with status `completed`, `failed`, `interrupted`,
  `cancelled`, or `rolled_back`.

A terminal run status does not mean that delegated work, checkpoints, or the
whole thread have settled. A question and a permission approval are different
requests. Store these bot instructions with the bot so each callback can resume
the same process:

1. Deduplicate by `deliveryId`, then read the thread with `t3_thread_read`.
2. For a user-input request, use `t3_pending_request` to read it and submit an
   answer through its response action. For an approval request, ask a human to
   approve or reject it in T3 Code. MCP cannot approve permissions.
3. For a provider error or blocked goal, read the current retry state. Do not start duplicate
   work while T3 or the provider is already retrying.
4. For a terminal run, read its final result and check remaining work before
   deciding what to do next. Use `t3_thread_send` for follow-up work.

Only HTTP 200 acknowledges receipt, matching the official Grok Bot contract. T3 rejects redirects and limits each
request to 10 seconds. Failed requests retry with exponential backoff, from one
second up to five minutes, and survive host restarts. Delivery is at least once,
so a callback can arrive again after the receiver has already processed it.
The receiver must deduplicate and read current state, since retries can arrive
after newer events. Delivery failures appear in host logs with IDs and status,
without the token or destination URL.

Remove an endpoint and restart to stop delivery to it. Its queued notifications
remain dormant; restoring the same `id` and `url` resumes them. Changing the URL
does not forward older notifications to the new destination. Filters apply when an event commits; changing a filter does not cancel queued
notifications. Token rotation uses the new token after restart. Revoking the bot's MCP access is separate from
disabling its webhook.

## Scripts on the host

On the machine that runs the environment, `t3 thread` uses the same tools
without a sign-in:

```sh
id=$(t3 thread start . "Find why the tests are slow")
t3 thread send "$id" "Now fix it" --wait
t3 thread show "$id"
t3 thread list
```

`.` means the project that contains the current folder; a project id also
works. A new thread uses the project's default model and permission mode, and
runs in the project folder unless you pass `--worktree <base-branch>`. `send`
never interrupts: a busy thread gets the message as its next turn. Pass `-` as
the message to read it from stdin.

`--wait` prints the agent's reply. It exits 1 when the run fails or stops, and
2 when the agent waits for an answer you give in the app. Add `--json` for a
result that always includes the thread id.

## Remove an agent

Approved agents appear under **Settings → Sharing & access** like other clients.
Revoke one there to cut off its access immediately. A sign-in lasts 30 days;
after that the agent asks you to approve it again.
