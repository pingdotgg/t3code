# Remote access

Connect a phone, browser, or another desktop app to T3 Code running on a different
machine. That machine must stay running and reachable while you work.

## T3 Connect

T3 Connect makes an environment available to your other devices without setting
up router forwarding. In the desktop app on the host, open **Settings →
Connections**, sign in, and enable **T3 Connect** for that environment.

For a command-line host, run:

```bash
npx t3@latest connect
```

Follow the sign-in instructions. Setup offers a
[background service](./background-service.md); if you decline it, start the
server with `npx t3 serve`. Saving your sign-in alone does not make the machine
reachable.

On your other device, sign in to the same T3 Connect account and choose the
environment. Over SSH, the CLI prints a browser link and accepts the returned
authorization code, so you do not need to forward an OAuth callback port.

T3 Connect renews access credentials when needed without disconnecting a healthy
connection. Pull request diffs and provider settings keep working after the
previous credential expires. A failed renewal affects that request; it does not
disconnect an otherwise healthy conversation.

## Pair over a LAN or private network

Use direct pairing when the other device can reach the host's network address.

On a desktop host, open **Settings → Connections**, enable **Network access**,
then create a pairing link using an address the other device can reach. Changing
network access restarts the desktop app. You can turn it off in the same place.

For a command-line host, replace `<private-ip>` with the host's LAN or tailnet
address:

```bash
npx t3 serve --host <private-ip>
```

If a server is already running, generate a fresh link without restarting it:

```bash
npx t3 pair
```

Scan the QR code on your phone or paste the pairing URL into **Add environment**
in the receiving app. Connection settings are under **Settings → Connections**
on web and desktop and **Settings → Environments** on mobile. A loopback address
such as `127.0.0.1` reaches only the device opening the link.

Pairing authorizes that device for future connections. Use a fresh one-time link
for each new device; you do not need the original token to reconnect. Links
created in Settings can only be copied from the client that created them while
its Connections page stays open. If you leave or reload that page, create
another link to share.

### Balance new threads across machines

Auto balance is off by default. On web and desktop, enable it in
**Settings → Connections → Load balancing** to automatically choose a machine for
new threads in projects grouped across connected environments.
Each machine starts at **Normal**. Choose **Prefer** to favor it when it has CPU and
memory available, **Less often** to reduce its share, or **Manual only** to exclude
it from automatic selection. These are preferences, not fixed traffic percentages.
Preferences are saved separately in each client.

The composer checks eligible machines when choosing a draft's environment, then keeps
that choice stable. Choose **Auto balance** again to check current resources, or choose
a specific machine to override it. Choosing a branch or worktree also keeps the draft
on that machine. Existing threads stay where they started. If resource checks are
unavailable or all eligible machines are full, choose a machine manually to continue.
Mobile keeps its manual environment selection.

### Tailscale HTTPS

Join both devices to the same tailnet. In the desktop app, enable **Tailscale
HTTPS** in **Settings → Connections**. Turn it off there to remove that route.

To start a command-line server with Tailscale HTTPS:

```bash
npx t3 serve --tailscale-serve
```

For an already-running server:

```bash
npx t3 pair --tailscale
```

The pairing link uses an address such as `https://machine.tailnet.ts.net/`.
The mapping created by `pair --tailscale` persists across restarts. Remove its
default-port mapping with:

```bash
tailscale serve --https=443 off
```

If that port is already in use, choose another with
`--tailscale-serve-port`. See `npx t3 pair --help` for other pairing options.

### Hosted web app

[app.t3.codes](https://app.t3.codes) needs an HTTPS endpoint. It connects directly
to your server; a hosted pairing link does not make an unreachable backend
reachable or convert HTTP to HTTPS.

For a plain HTTP LAN endpoint, use the direct pairing URL in a browser that can
open it, or pair from the desktop app. On mobile, an IP address entered without a
scheme uses HTTP, so include `https://` when your server uses HTTPS.

## Desktop-managed SSH

In the desktop app, open **Settings → Connections → Add environment**, choose
**SSH**, and enter a host or SSH alias such as `user@example.com`. T3 Code starts
or reuses a server there and opens the port forward for you. Projects, provider
credentials, and agent work stay on the remote machine.

The remote host needs a compatible [Node.js installation](./install.md#requirements)
and [provider setup](./install.md#providers). If launch cannot find Node or reports
an incompatible version, check it through a non-interactive SSH session:

```bash
ssh user@example.com 'sh -lc "command -v node && node --version"'
```

Configure your version manager for non-interactive shells if this differs from
your normal terminal. With nvm, setting a compatible default, such as
`nvm alias default 24`, can resolve the problem.

If SSH reconnecting fails after an app update, retry the launch once. Removing
the connection stops a server that T3 Code launched; a server that was already
running is left alone.

For Antigravity's Google callback on a remote host, see
[remote sign-in](./providers-antigravity.md#sign-in-from-a-remote-device).

## Manage or revoke access

On the host, **Settings → Connections** lets authorized administrators create
pairing links and revoke client sessions. Revoking an unused link prevents new
pairings; revoke a device's session to remove its existing access. Command-line
management is available through `npx t3 auth --help`.

A session with an open connection stays listed after its access credential
expires.

To remove an environment from T3 Connect, open your account menu's **T3 Connect**
page, or **Settings → T3 Connect** on mobile, and choose **Deregister**. This
revokes its cloud access and frees its host space even when the environment is
offline or has been wiped.

On a command-line host, `t3 connect unlink` disables exposure while retaining
your login; `t3 connect logout` also clears that login. Background-service
[removal](./background-service.md#manage-the-service) is separate.

Treat pairing URLs and authorization codes as passwords. Do not include them in
screenshots, logs, or bug reports.

## T3 Connect troubleshooting

Run `t3 connect status` on the host to inspect saved authorization and link
configuration. It is not a live reachability check. If the environment appears
offline, run `t3 service status` and read the displayed log. If it disappears
when SSH closes, see [background-service troubleshooting](./background-service.md#troubleshooting).

| Error                                                     | Recovery                                                                                                                                    |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `environment_link_limit_exceeded` or managed tunnel limit | Deregister an unused environment, then restart T3 Code on the host.                                                                         |
| `auth_invalid` or `invalid_bearer`                        | Run `t3 connect login`. If credentials were revoked, run `t3 connect logout`, then `t3 connect` again. Restart the server after signing in. |
| Expired or invalid link proof                             | Check the host's date and time, update T3 Code, then restart it.                                                                            |
| HTTP 403 without a recognized error                       | Check relay access, proxies, and firewall rules. Keep any Cloudflare Ray ID for a bug report.                                               |
| HTTP 408, 429, or 5xx                                     | Check network and relay availability. Startup retries temporary failures for up to ten minutes.                                             |

After fixing a permanent rejection, restart the host's server. On Linux, use
`systemctl --user restart t3code.service` for the background service. For a
foreground server, stop it and run `t3 serve` again with your usual options.
Include the diagnostic message and trace ID when reporting a persistent failure.

For a connection that still fails after linking, check the date and time on both
devices. For server version warnings, follow [Updating T3 Code](./updating.md).

## Use MCP with connected environments

Configure your assistant using the launch configuration in **Settings → MCP Gateway**, then enable
the gateway in the desktop app. Keep that desktop connected to the environments your assistant
needs to access. If you configure a custom companion port, set the same **Bridge port** in MCP Gateway settings; the standard port works without changing it.

Enable access per environment and select **Save** to apply permission changes. Default access allows
reading chats, creating threads, and sending messages. **Enable all environments** enables machines
without removing their existing permissions; it does not grant every capability. Choose **All
capabilities** in a machine's access menu to allow the full set, or grant individual capabilities
for controlling work, handling approvals, retrieving artifacts, managing reviews, or event delivery.

The assistant can use agents from the shared library for new chats, inspect work and approvals, control thread
lifecycle, and subscribe to events or webhook delivery when permitted. Agents are managed on the
Agents board; changing an agent does not change existing chats. Use `t3_list_environments`
to check the environment IDs and effective grants seen by the assistant. Permission errors also
report the granted and missing scopes.

### Pause or stop work through MCP

Default access does not include pause or stop. In **Settings → MCP Gateway**, open the target
machine's access menu, enable **Control active work**, and select **Save**. This grants `control`
only for that environment. The broader `lifecycle` grant also permits thread controls, but neither
**All capabilities** nor access to other machines is needed. Use `t3_list_environments` to confirm
that the assistant sees the updated grant. A `scope_required` error means no control was dispatched;
`control` and `lifecycle` are alternatives, not two required grants.

`t3_pause_thread` requests an interruption of the active turn; it does not suspend a provider process.
`t3_stop_thread` requests stopping its provider session. Their `accepted` result acknowledges the
request, not its completion. Read `t3_get_thread` or watch the subsequent session/turn events to
confirm the outcome. An interrupted turn is reported as `interrupted`, and a stopped session as
`stopped`. A provider can finish normally before the interruption takes effect; `completed` is a
finished turn, not evidence that it was paused. Do not automatically resume or restart it.

These controls do not delete queued messages or pause a queue. A new message awaiting turn adoption
can still be reported as `queued` after a stop; inspect it separately before claiming all work has
stopped. A queued-only thread with no active turn cannot be paused. Sending a chat message asking
an agent to stop is cooperative: message acceptance alone does not prove the agent has stopped.

### Open a remote chat

In the installed desktop app, connect the remote environment and configure **Settings → MCP Gateway**
with your MCP assistant. Grant the environment read access. Your assistant can use `t3_open_thread`
with the environment and thread IDs to open that chat and bring this desktop window forward.
The remote machine supplies the chat; the desktop connected to the gateway displays it. Opening a
chat does not start or stop its agent. The desktop app must already be running and connected.

### Organize work by agent

Open **Open agents** in the command palette, or visit `/agents`. Create a named agent, choose its
provider, model, thinking, allowed machines, and a system prompt describing its role and workflow,
then start a task or an empty chat. Clicking a
card opens the conversation; **Back to agents** returns to the board. Settled work moves into a collapsed **Settled** section
in its agent column. Right-click a chat to settle or un-settle it. Deleting an agent keeps its conversations under **Removed agents**.

Hover a chat to read its recent messages and send a follow-up without leaving the board. The
preview updates live and shares your draft with the full chat. Attachments, approvals, and plan
responses use the full chat. While a chat is open, the compact list shows active work and
completed chats you have not viewed on this device. Your current chat stays visible until you
switch away; settled chats remain on the board under **Settled**.

Agents are shared across clients connected to the same server. Updated clients also synchronize
the agent library between connected environments that support agent sync, including after reconnecting. Each target resolves the provider and model locally; an unavailable or
ambiguous selection must be re-selected before starting a thread. Agent changes apply only to
new chats.

MCP assistants can discover agents with read access using `t3_list_agents`, or manage them using `t3_create_agent`, `t3_update_agent`, and `t3_delete_agent` with create
or admin access. Agent writes share only to connected environments with one of those grants;
check the returned sync failures. Use `profileId` with `t3_create_thread` to snapshot an agent’s instructions and settings,
then `t3_send_message` to start work. Filter `t3_list_threads` by the same ID and `state`
(`active`, `settled`, or `all`) to find ongoing or completed work. Use `t3_unsettle_thread`
with lifecycle access to return a settled chat to the active list. `t3_open_agents` opens the
board in the connected desktop window with read access.

Each chat keeps the agent instructions it started with, including after the agent is edited or
deleted. When work starts, T3 places that chat’s generated `AGENT.md` in its own directory under
`.agents/t3/` in the workspace. This runtime directory is ignored by Git. Settling removes that
generated file; continuing the conversation
restores its original instructions. Other chats and project-owned instruction files are left
alone. Edit the agent in the app to change instructions for future chats.

Use the speed control on a chat card to choose a model-supported speed tier. The setting applies
to the next provider request, including when changed during a running turn; it does not restart
or accelerate a response already in progress.

MCP assistants can use `t3_handoff_thread` to move work from planning to implementation or from
code to review. Supply a summary, destination agent and project, a task, and optionally
workspace-relative text files such as `plan.md`. The destination receives a Markdown brief with
copied file contents, including across machines. Plans and handoff briefs remain available when
the source settles. Reuse the handoff UUID when
retrying, and inspect the returned status: `created` means the new chat exists but delivery needs
recovery. Settlement is a separate `t3_settle_thread` call after the user confirms. Handoff needs
read access on the source, artifact access when copying files, and create/send/artifact access on
the destination; settlement needs lifecycle access.
