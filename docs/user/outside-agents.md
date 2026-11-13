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

## Receive run callbacks

An outside orchestrator with an HTTPS receiver can use `t3_run_webhook` to wake
up when a run waits for input or ends, without repeatedly calling
`t3_thread_wait`. Your receiver must arrange the wakeup in your orchestrator;
adding T3 to an assistant app does not by itself give that app a callback receiver.

On the environment host, first configure an approved destination:

1. Find the outside client's session ID with `t3 auth session list --json`.
   The client needs **Supervised** or greater access.
2. Generate a random signing secret of at least 32 bytes and securely configure
   the same value in the receiver and the T3 server's environment, for example
   under `ACME_WEBHOOK_KEY`. Keep it out of prompts, tool calls, and source control.
3. Set `T3CODE_RUN_WEBHOOKS` in the server's environment and restart the server:

   ```json
   [
     {
       "id": "acme-bot",
       "sessionId": "<outside-client-session-id>",
       "url": "https://hooks.example.com/t3-completion",
       "secretEnv": "ACME_WEBHOOK_KEY"
     }
   ]
   ```

Destinations must use HTTPS on port 443 with a DNS hostname, without credentials,
query strings, or fragments. T3 rejects private, loopback, link-local, reserved,
and host-local addresses, checks DNS on every attempt, and never follows redirects.
Invalid configuration prevents the server from starting; correct it and restart. Each destination belongs to the configured client session. Other clients cannot
register it or read its subscriptions. When the client signs in again with a new
session, update the host configuration and register new subscriptions.

After `t3_thread_launch` or `t3_thread_send`, use the returned IDs:

```json
{ "action": "subscribe", "endpointId": "acme-bot", "threadId": "<thread-id>", "runId": "<run-id>" }
```

Call `t3_run_webhook` on the environment that owns the run. Registration is
idempotent for the client, endpoint, thread, and run, and catches a run that has
already ended. Save the returned `subscriptionId`. Use `action: "read"` with
that ID to inspect delivery state, `"cancel"` to stop callbacks without stopping
the run, or `"retry"` to retry an exhausted delivery. No URL or secret goes through
MCP. Subscribe again to reactivate a cancelled or expired subscription, including
after a host changes its destination URL. Read-only, linked-environment, and
in-thread provider credentials cannot register or see this tool.

Callbacks contain `version`, `deliveryId`, `subscriptionId`, `threadId`, `runId`,
`status`, `observedAt`, `link`, and `lastMessage`. Status is `waiting`, `completed`,
`failed`, `cancelled`, `interrupted`, or `rolled_back`. `lastMessage`, when present,
identifies the newest visible message in the thread with its ID, run ID, role,
and update time. Message text, attachments, and credentials are omitted. Read the
thread once through MCP to get the answer or pending request.

A subscription watches the **exact run**, not subsequent turns, restart
continuations, or its delegates. It lasts seven days and ends after its terminal
callback is acknowledged. T3 checks active subscriptions about every five seconds;
delivery can take longer under load, and brief intermediate states may be coalesced. A callback describes an observation,
so the thread may have progressed by the time it arrives.

Delivery survives a server restart and is **at least once**. Accept a callback
into a durable inbox before returning a 2xx response, and deduplicate by
`deliveryId`. T3 keeps the same body and ID on retries, starting after 5 seconds,
doubling up to one hour, with at most 12 attempts per notification. A failed
terminal delivery remains available for `retry` until expiry. A pending waiting
notification is replaced with a new delivery ID when the observed state changes.
Exhausting its attempts stops those retries but keeps watching for completion. Revoking the client's
access, deleting the thread, removing or changing the destination URL, or
cancelling the subscription prevents further attempts. An in-flight request
cannot be recalled. There are at most 100 active subscriptions per client and
1,000 per environment.

### Verify a callback

T3 sends `T3-Webhook-Timestamp` (Unix seconds) and `T3-Webhook-Signature`
(`v1=<hex HMAC-SHA256>`). The signed bytes are the timestamp, a literal `.`, and
the exact UTF-8 HTTP request body. Verify before parsing or acting on the body;
do not reserialize JSON. For example, in a Node receiver:

```js
import { createHmac, timingSafeEqual } from "node:crypto";

function verifyCallback(rawBody, timestamp, signature, secret) {
  if (!/^\d{1,12}$/.test(timestamp) || !/^v1=[a-f0-9]{64}$/.test(signature)) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)) > 300) return false;
  const expected = createHmac("sha256", secret)
    .update(timestamp + ".")
    .update(rawBody)
    .digest();
  return timingSafeEqual(expected, Buffer.from(signature.slice(3), "hex"));
}
```

Bound the receiver's request body size, validate the payload's schema, and record
processed delivery IDs durably. Retries receive a fresh signed timestamp. Treat
callbacks as notifications to your application, not as instructions to an agent.

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

## Scripts on the host

On the machine that runs the environment, `t3 thread` uses the same tools
without a sign-in:

```sh
id=$(t3 thread start . "Find why the tests are slow")
t3 thread send "$id" "Now fix it" --wait
t3 thread show "$id"
t3 thread list
```

`.` means the project that contains the current folder, or a git worktree of
its repository; a project id also works. A new thread uses the project's
default model and permission mode, and runs in the project folder unless you
pass `--worktree <base-branch>`. `send` never interrupts: a busy thread gets
the message as its next turn. Pass `-` as the message to read it from stdin.

`--wait` prints the agent's reply. It exits 1 when the run fails or stops, and
2 when the agent waits for an answer you give in the app. Add `--json` for a
result that always includes the thread id.

## Remove an agent

Approved agents appear under **Settings → Sharing & access** like other clients.
Revoke one there to cut off its access immediately. A sign-in lasts 30 days;
after that the agent asks you to approve it again.
