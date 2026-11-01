# Remote access

Connect a phone, browser, or another desktop app to T3 Code running on a different
machine. That machine must stay running and reachable while you work.

In **Settings → Connections**, open a machine’s **More actions** menu to rename it or
choose its icon (including desktop, laptop, and server). Names and icons are saved on
that machine and shown on connected devices. **Reset name** restores the original name.

## T3 Connect

T3 Connect makes an environment available to your other devices without setting
up router forwarding. In the desktop app on the host, open **Settings →
Environments**, sign in, and enable **T3 Connect** for that environment.

For a command-line host, run:

```bash
t3 up
```

It asks how your other devices reach the machine: T3 Connect, the local network,
or both. Choose T3 Connect and follow the sign-in instructions. On Linux and
macOS, it then runs T3 Code as a [background service](./background-service.md).
`t3 connect` is the same as `t3 up --connect`. Run `t3 up` again to change your
choice, and `t3 status` to see it.

The background service is not available on Windows, so there `t3 up` prints the
`t3 serve` command to keep running in a terminal. You can also keep the desktop
app running with its local environment enabled. Closing the desktop app's last
window stops its local server. Saving your sign-in alone does not start a server
or make the machine reachable.

On your other device, sign in to the same T3 Connect account and choose the
environment. On the app.t3.codes home page with no computer added yet, signing
in adds compatible computers linked to your account. Over SSH, the CLI prints a
browser link and a short code. Open the link on any device, confirm the code
matches, and approve. The CLI continues on its own, so you do not need to forward
an OAuth callback port.

T3 Connect renews access credentials when needed without disconnecting a healthy
connection. Pull request diffs and provider settings keep working after the
previous credential expires. A failed renewal affects that request; it does not
disconnect an otherwise healthy conversation.

### Scripts and agents

`t3 up` asks nothing when you name a choice: `--connect`, `--lan`, or their
`--no-` forms. Choices you do not name keep their settings, and `--yes` takes
the defaults. Without a terminal:

- T3 Connect sign-in prints a URL and a code. Approve it on any device.
- A needed restart runs without asking, and stops running agent turns.
- With nothing set up and no choice named, `t3 up` stops and names the flags.

`t3 status --json` prints the settings. `t3 up --help` lists every flag with
examples.

### More machines with T3 Chat

Each T3 Connect account can link up to 3 machines. Phones and browsers do not
count. A paid T3 Chat plan raises the limit to 10 machines with Pro, or 100 with
Premier.

To link T3 Chat, open your account menu on the web or desktop app, go to
**T3 Chat**, and select **Link T3 Chat**. Sign in to T3 Chat in the window that
opens and approve. The new limit applies the next time you add a machine. If you
cancel or downgrade T3 Chat, machines you already linked stay linked, but you
cannot add more until you are under the limit again.

## Pair over a LAN or private network

Use direct pairing when the other device can reach the host's network address.

On a desktop host, open **Settings → Environments**, enable **Network access**,
then create a pairing link using an address the other device can reach. Changing
network access restarts the desktop app. You can turn it off in the same place.

For a command-line host, choose the local network in `t3 up`, or run:

```bash
t3 up --lan
```

For a server in a terminal, run `t3 serve --lan`. Either way, T3 Code then
accepts connections from your local network and tailnet, so a pairing code is
all that keeps other devices on them out.

If a server is already running, generate a fresh link without restarting it:

```bash
t3 pair
```

Scan the QR code on your phone or paste the pairing URL into **Add environment**
in the receiving app. Connection settings are under **Settings → Environments**
on web and desktop and **Settings → Environments** on mobile. A loopback address
such as `127.0.0.1` reaches only the device opening the link.

On a computer with the desktop app, you can open the printed `t3code://pair`
app link instead. The desktop app asks you to confirm the server address, then
adds it.

If your HTTPS endpoint uses a certificate from your own certificate authority,
install that CA on Android as a **CA certificate** in its security settings; the
Android app then trusts it.

Pairing authorizes that device for future connections. Use a fresh one-time link
for each new device; you do not need the original token to reconnect. Links
created in Settings can only be copied from the client that created them while
its Environments page stays open. If you leave or reload that page, create
another link to share.

### Reach one machine several ways

A machine can have more than one route: LAN, Tailscale, another VPN, a public
URL, SSH, or T3 Connect. Tailscale shares its `100.64.0.0/10` address range with
other VPNs such as Cloudflare WARP, so an address in that range shows as VPN
unless the machine confirms it is on Tailscale. To add a route, choose **Add
route** in the machine's route list, or next to it in the T3 Connect list.
A pairing link for a saved machine is refused when it comes from an address
that machine does not have yet; add that address with **Add route** instead.
Pairing again over an address the machine already has still works. A new route
is placed by speed, in that order, and you can reorder routes at any time.

While connected through T3 Connect or a paired address, T3 Code also learns the
machine's current LAN and Tailscale addresses and adds them as routes, so
pairing once through T3 Connect is enough to use the LAN at home. When the
machine's LAN address changes, for example after it joins another Wi-Fi network,
the learned route follows it. The machine must allow network access for its LAN
address to be learned: **Network access** in the desktop app, or the
[local network](./background-service.md#local-network-access) choice in `t3 up`.
You can reorder a learned route, but not remove it; it
goes away with the route it was learned through, or when the machine stops
reporting that address.

T3 Code connects over the first route that answers. Away from home, a LAN
address that does not answer is checked briefly and skipped. It is only tried
again, after the other routes, if none of them connect. While connected over a
later route, T3 Code checks the earlier ones when your network changes, when you
return to the app, and every minute, and moves back as soon as one works.

On web and desktop, select the route count under the machine's name in
**Settings → Environments** to see its routes. Drag a route to change the order,
or remove it. On mobile, open the machine under **Settings → Environments** and
choose **Edit**. Signing out of T3 Connect removes only that route; a machine
you can still reach another way stays saved.

Open **Permissions** next to **Routes** in web or desktop, or **Your permissions**
in the mobile route details, to see what your current connection can do on that
environment. For a remote environment, this is in its route details. Permissions
shown there apply only to the route marked **In use**; other routes are not
checked. Direct pairing and T3 Connect have separate sessions and may grant
different permissions.

### Balance new threads across machines

Auto balance is off by default. On web and desktop, enable it in
**Settings → Environments → Load balancing** to automatically choose a machine for
new threads in projects grouped across connected environments. The section
appears once two or more machines are switched on.
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
HTTPS** in **Settings → Environments**. Turn it off there to remove that route.

To start a command-line server with Tailscale HTTPS:

```bash
t3 serve --tailscale-serve
```

For an already-running server:

```bash
t3 pair --tailscale
```

The pairing link uses an address such as `https://machine.tailnet.ts.net/`.
The mapping created by `pair --tailscale` persists across restarts. Remove its
default-port mapping with:

```bash
tailscale serve --https=443 off
```

If that port is already in use, choose another with
`--tailscale-serve-port`. See `t3 pair --help` for other pairing options.

### Hosted web app

[app.t3.codes](https://app.t3.codes) needs an HTTPS endpoint. It connects directly
to your server; a hosted pairing link does not make an unreachable backend
reachable or convert HTTP to HTTPS.

For a plain HTTP LAN endpoint, use the direct pairing URL in a browser that can
open it, or pair from the desktop app. On mobile, an IP address entered without a
scheme uses HTTP, so include `https://` when your server uses HTTPS.

## Desktop-managed SSH

In the desktop app, open **Settings → Environments → Add environment**, choose
**SSH**, and enter a host or SSH alias such as `user@example.com`. T3 Code starts
or reuses a server there and opens the port forward for you. Projects, provider
credentials, and agent work stay on the remote machine.

The remote host must be Linux or an Apple Silicon Mac with `curl` or `wget`,
`tar`, `sha256sum` or `shasum`, and [provider setup](./install.md#providers).
The first launch downloads T3 Code's server to `~/.t3/runtime` on the host, so
it takes longer than later ones.
Provider CLIs must be on the `PATH` of a non-interactive login shell there;
check with:

```bash
ssh user@example.com 'sh -lc "command -v claude codex"'
```

If SSH reconnecting fails after an app update, retry the launch once. Removing
the connection stops a server that T3 Code launched; a server that was already
running is left alone.

Each desktop app keeps one session on the host for its SSH connection and reuses
it when it reconnects. Revoke sessions you no longer use in **Settings →
Environments** on the host, or on a headless host with `t3 auth session list` and
`t3 auth session revoke <id>`. A desktop that can still sign in over SSH pairs
again on its next connect.

For Antigravity's Google callback on a remote host, see
[remote sign-in](./providers-antigravity.md#sign-in-from-a-remote-device).

## Browser on a remote environment

Browser tabs belong to the environment, so you and your agents see the same
tabs from any device. The desktop app shows its own environment's tabs
directly. Every other device, and the desktop app for other environments,
streams them from the host. Agents keep using them while no device is
connected, and `localhost` addresses reach servers on the host.

The first tab downloads a headless Chrome, about 120 MB, into the T3 home. It
is the same browser [HTML renders](html-renders.md) use, so a host downloads it
only once. Some Linux hosts need [setup](#browser-host-setup) before it can
start.

Agent tabs have separate storage and share a Chromium process. Take control before
typing into an agent's tab, then release control when you want the agent to
continue. Read-only connections can watch without changing the page.

While you have control, the tab works with your device: text the page copies or
cuts goes to your clipboard, a file picker on the page opens your device's
picker, and a finished download is offered for you to save. Popups such as
sign-in windows open as their own tabs. Downloads stay on the host until the
tab closes. Audio does not play on your device.

On a phone, tap the floating preview's corner dot to show its controls, then
**Pop into separate window** to keep watching in picture-in-picture over other
apps.

### Local servers

The browser lists ports held by processes your terminals and agents started.
T3 Code reads which process holds each port and never connects to it, so a
listed port opens as `http://localhost:<port>` and might not be a web page. For
an HTTPS server or a specific path, set the **Preview URL** on the project
script that starts it; T3 Code checks that address and opens it as written.

To stop listing ports, set `T3CODE_PORT_DISCOVERY=0` in the environment that
starts the T3 Code server, such as
[`service.env`](./background-service.md#configure-the-service-environment) for
the background service, and restart it. Script preview URLs still appear.

### Browser host setup

macOS, Windows, and Linux desktops run the browser as is. Some Linux hosts need
one-time setup: Ubuntu 23.10 and later block the sandbox the browser runs in,
and minimal images and containers lack libraries it loads. When that happens,
the server says so at startup, and browser tabs and HTML previews show the
command to run on the host:

```sh
sudo t3 browser setup
```

The server shows the exact line for how you started it, such as
`sudo npx t3 browser setup`, and keeps your `PATH` when Node is installed only
for your user. Where `t3` is not on your `PATH`, such as with only the
desktop app installed, it names the full path of the app's own `t3` instead. It allows Chrome's sandbox with an AppArmor profile and installs
any missing libraries and system fonts with apt; pages that load without text
can mean the host has no fonts. It is safe to run again. Without `sudo`, it only
reports what it would change.

The browser runs in Chrome's sandbox by default. Chrome cannot start that sandbox
as root. If your T3 server runs as root, run it as a nonroot user to keep
sandboxing enabled. `t3 browser setup` does not fix this root restriction.

If you need to run as root, or cannot enable the sandbox on your host, set
`T3CODE_SERVER_BROWSER_SANDBOX=0` in the **T3 server's environment** and restart
the server. This disables Chrome's sandbox. For a manual launch:

```sh
T3CODE_SERVER_BROWSER_SANDBOX=0 t3 serve
```

For a systemd service, add `Environment=T3CODE_SERVER_BROWSER_SANDBOX=0` under
`[Service]` in its configuration, run `sudo systemctl daemon-reload`, then restart
your T3 service. Setting the variable in an agent's terminal does not change the
environment of an already running T3 server.

## Connect an outside agent

Claude Code, Codex, ChatGPT and other agents T3 Code did not start can drive
threads on an environment through its MCP server. See
[outside agents](./outside-agents.md) for setup.

## Link another environment

Link two machines, such as your laptop and a VPS, and agents on one can work on
the other: launch, message, wait on and stop its threads, answer their
questions, and manage its queues, projects and scheduled tasks.

Linked environments is on by default; turn it off for a machine in **Settings →
Labs**, or on mobile in **Settings → Labs**. While it is off on either machine,
agents start nothing over a link between them. A task already running on the
other machine still finishes, and if that machine has it off, its result
arrives once it is back on.

### Your tailnet devices

Machines running T3 Code that are signed in to the same Tailscale account link
to each other on their own, both ways, with no pairing code. Install T3 Code on
a new machine, sign in to Tailscale, and within ten minutes it appears in
**Settings → Environments → Linked environments** on your other machines.
Tagged nodes and machines shared from someone else's tailnet never link this
way.

- Each device's access there is the most it may do on your machines. Change it
  from any of them and the change reaches all of them. **Revoke** cuts the
  device off everywhere; **Restore** gives it back the default access.
- New devices get the default access set in the same section, and you can turn
  automatic linking off there.
- **Open** adds a device to this app without a code. Below full access, it
  opens read-only.
- Other people's machines, and anything off your tailnet, still link with a
  pairing code as described below.

To count only machines you choose, turn on **Only devices with the T3
capability** and grant `t3.codes/device` in your Tailscale policy file, from
the machines that should count to your T3 machines:

```json
"grants": [
  { "src": ["group:me"], "dst": ["group:me"], "app": { "t3.codes/device": [{}] } }
]
```

### Link with a pairing code

On the machine you will work from, open **Settings → Environments → Linked environments**,
choose **Link**, and pick the other machine or enter its address. The list
holds the machines this app knows and those on your T3 Connect account. If this
app is connected to that machine with a session that manages access there, it
makes the pairing code itself; otherwise paste one from that machine's
**Settings → Environments**. From a terminal, use
`t3 environment link <address> --pairing-code <code> --access <mode>`.

You can also ask an agent to link a machine by name, such as "delegate this to
my vps". It shows a card in the thread where you pick the machine the same way
and the access, then approve.

- The access you pick is the most agents from this machine may do there. An
  agent also never gets more there than its own mode here.
- Threads a link starts are marked **From** and this machine's name there.
- A full-access link works there like that machine's own agents. Below full
  access, the link's agents can change only threads it started, not that
  machine's own threads, projects or settings, and they skip its project setup
  scripts.
- The link shows up in that machine's **Settings → Environments** like any
  outside agent. Revoke it there to end it. **Forget** on this machine only
  removes it here.
- Links last 30 days. Link again with a new pairing code to renew one.

An agent can also hand a task to a linked machine with `delegate_task`: it runs
there as an ordinary thread, in the project with the same repository (or the
one `target.projectId` names), and this thread wakes with its result when it
ends, as for any delegated task. It keeps following the task across restarts.
If the other machine revokes the link, or the link is removed here, the task
fails with that reason.

## Manage or revoke access

On the host, **Settings → Environments** lets authorized administrators create
pairing links and revoke client sessions. Revoking an unused link prevents new
pairings; revoke a device's session to remove its existing access. Command-line
management is available through `t3 auth --help`.

A session with an open connection stays listed after its access credential
expires.

To choose a token's permissions, pass `--scope` once for each scope you want:

```sh
npx t3 pair --scope orchestration:read --scope relay:read
```

The selected scopes replace the default permissions. The same option works with
`npx t3 auth pairing create` and `npx t3 auth session issue`; each command's
`--help` lists the available scopes. Without `--scope`, pairing tokens and issued
bearer sessions get every permission, including managing access and T3 Connect.
A terminal or a full-access agent on the host can reach those as well, so a
client that should not manage access also needs to go without `terminal:operate`
and `orchestration:operate`.

To change an existing client's permissions, create a fresh pairing link with the
scopes it needs. In a browser opened directly on the environment, open that link
to replace the browser's current grant. For mobile or a saved remote environment
in web or desktop, use **Add Environment** with the fresh link or code; pairing
the same environment replaces its saved grant. Reconnecting alone does not change
permissions.

Grouping checkouts does not combine their permissions. Shared project settings
require `orchestration:operate` on every member environment; actions on one
checkout use that checkout's permissions.

`source-control:write` covers direct Git and pull request changes made from the
client: pushing, switching or creating branches, cloning, and removing
worktrees. It does not restrict what a task does. Starting a task in a new
worktree still creates that branch and worktree with `orchestration:operate`,
and the agent it runs can use Git however the environment allows.

Settings changes, provider management, environment maintenance, access
management, and T3 Connect management can each be granted separately. New
pairings without `--scope` include all of them. Existing clients keep the
permissions they paired with and can stay connected after an update, but newly
separated features may require pairing again with the permissions they need.
Older clients may show controls that the server denies. Create a fresh pairing
link to change a client's permissions.

`filesystem:read` allows browsing host files, opening workspace files, and viewing
local changes. Add `filesystem:write` to allow editing files or saving plans to
the workspace. These scopes control direct file access from the client.

To remove an environment from T3 Connect, open your account menu's **T3 Connect**
page, or **Settings → T3 Connect** on mobile, and choose **Deregister**. This
revokes its cloud access and frees its host space even when the environment is
offline or has been wiped. When T3 Connect rejects a host's link, the host
shows that it was removed from T3 Connect. To link it again, turn on
**T3 Connect** in **Settings → Environments** on a desktop host, or run
`t3 connect link` on a command-line host and then restart T3 Code there. A
command-line host that released its tunnel when it last stopped may link itself
again on its next start; run `t3 connect unlink` on that host to keep it off.
Removing an environment from a device's connection settings only forgets it on
that device and doesn't change your T3 Connect account. A device keeps a saved
environment after it's deregistered until you remove it from that device.

When idle tunnel cleanup is enabled, T3 Connect removes a linked environment's
tunnel after it stays offline for several minutes. The environment stays linked
and keeps the same address. When the host starts again or wakes, T3 Connect
creates a replacement tunnel on its own. You do not need to pair again. Cleanup
usually runs five to ten minutes after the tunnel goes down.

T3 Connect also removes the tunnel of an environment running an older version of
T3 Code once it has been offline for seven days. That environment shows a message
asking you to update. Start T3 Code on that computer and update it to the latest
version; it reconnects at the same address without pairing again.

On a command-line host, `t3 connect unlink` disables exposure while retaining
your login; `t3 connect logout` also clears that login. Background-service
[removal](./background-service.md#manage-the-service) is separate.

Treat pairing URLs and authorization codes as passwords. Do not include them in
screenshots, logs, or bug reports.

## T3 Connect troubleshooting

When a T3 Connect connection fails, see
[T3 Connect troubleshooting](./t3-connect-troubleshooting.md). It explains each
error, where the problem is, and how to fix it.

## Use MCP with connected environments

Agents in T3 Code chats always have the T3 Agents tools for the machine they run on. To let
them act on your other machines too, enable **Settings → Environments → MCP Gateway** in the desktop app and
grant access to each environment involved, including the one the chat runs on. Keep this
desktop connected while agents use it; calls for other machines go through it, under the
grants you set. Disabling the gateway stops those calls immediately.

For assistants outside T3 Code, copy the external MCP host configuration from the same page.
For standalone OpenCode, merge **Copy OpenCode config** into `~/.config/opencode/opencode.jsonc`
on the desktop's machine, preserving existing servers, then reconnect OpenCode. Other hosts
using `mcpServers` can use **Copy MCP config**. The copied configuration includes the bridge
token and the desktop's state-file path.

Enable access per environment and select **Save** to apply permission changes. Default access allows
reading chats, creating threads, and sending messages. **Enable all environments** enables machines
without removing their existing permissions; it does not grant every capability. Choose **All
capabilities** in a machine's access menu to allow the full set, or grant individual capabilities
for controlling work, handling approvals, retrieving artifacts, managing reviews, or event delivery.

The assistant can use agents from the shared library for new chats, inspect work and approvals, control thread
lifecycle, and subscribe to events or webhook delivery when permitted. Agents are managed on the
Agents board; changing an agent does not change existing chats. Mobile Home opens to **Agents**: choose an agent to start a chat in an existing environment, or switch to **Threads** for all threads. Configure agents on web or desktop. Use `t3_list_environments`
to check the environment IDs and effective grants seen by the assistant. Permission errors also
report the granted and missing scopes.

`t3_list_threads`, `t3_list_projects`, `t3_list_agents`, and `t3_get_agents_view` cover every
connected machine with read access when `environmentId` is omitted. Each result names its
machine with `environmentId` and `environmentLabel`, and `environments` lists any machine that
was skipped (disconnected or without read access) or failed, so a missing chat is not mistaken
for one that does not exist. Pass `environmentId` to list one machine.

`t3_list_threads` returns the 20 most recently updated chats unless you pass `limit` (up to
100). When `hasMore` is true, pass `nextCursor` back as `cursor` with the same filters for the
next page. `updatedAfter`, `updatedBefore`, and `createdAfter` take ISO times to pick a window.
Each row is a summary; `t3_get_thread` returns the whole chat.

A chat's `profileId` and `profileName` name the agent it was created with, not the agent's
instructions. Pass `includeSystemPrompt: true` to `t3_list_agents` when you need each agent's
current prompt, for example before `t3_update_agent`.

### Answer an agent's questions through MCP

When an agent asks a question with answer options, its chat shows `waiting-input`, and
`t3_list_threads` marks it with `hasPendingUserInput` (pass `includeQuestions: true` to include
the questions). `t3_get_pending_questions` returns each question's full text, its options, whether
several options can be chosen, and whether a typed answer is accepted. `t3_answer_question`
answers with option labels or typed text, and the chat continues as if you had answered in the
app. Every question in the request needs an answer. Answering needs the same send access as
`t3_send_message`.

### Pause or stop work through MCP

Default access does not include pause or stop. In **Settings → Environments → MCP Gateway**, open the target
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

In the installed desktop app, connect the remote environment and configure **Settings → Environments → MCP Gateway**
with your MCP assistant. Grant the environment read access. Your assistant can use `t3_open_thread`
with the environment and thread IDs to open that chat and bring this desktop window forward.
The remote machine supplies the chat; the desktop connected to the gateway displays it. Opening a
chat does not start or stop its agent. The desktop app must already be running and connected.

### Show a chat on another device

Your assistant can also put a chat on a different screen, for example when you talk to an assistant
on your laptop but watch T3 Code on your desktop. `t3_list_devices` lists the desktop, web, and
mobile apps connected to an environment, and shows which one you are looking at. `t3_focus_device`
then opens a chat on one of them by device ID or name. It can also open a file from that chat's
workspace beside the chat, such as a screenshot, video, PDF, or source file, or open the Agents board.
Desktop apps come to the front. Browser tabs switch to the chat but stay behind other windows. Phones
must have T3 Code open. On mobile, that request opens Home’s Agents tab.

A device appears once it connects to the environment directly, over your network, Tailscale, or T3
Connect. Desktop apps use the computer's name; browsers show as the browser and OS, such as "Chrome
on Windows".

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
ambiguous selection must be re-selected before starting a thread. Agent configuration and skill changes apply when a new chat is created. Existing chats keep the configuration and skill contents they started with.

Add a short **Specialization** when creating or editing an agent to show what it does beneath its name and in MCP. This description does not replace its instructions.

MCP assistants can discover agents with read access using `t3_list_agents`, or manage them using `t3_create_agent`, `t3_update_agent`, and `t3_delete_agent` with create
or admin access. Agent writes share only to connected environments with one of those grants;
check the returned sync failures. Use `profileId` with `t3_create_thread` to select an agent and its initial settings,
then `t3_send_message` to start work, or `t3_create_and_start_thread` to create the chat and send its opening task in one idempotent call. The environment-local `/mcp/workspace` endpoint exposes `list_agents` and `get_agents_view` with the same profile and state filters, using runs from its hosting machine. Agent listings include specializations without exposing system prompts. Use `t3_get_agents_view` to list agents alongside their chats and run status. Filter by `profileId`, `state` (`active`, `settled`, or `all`; active is the default and includes completed chats that have not been settled), and `executionState` (`running`, `queued`, `waiting-approval`, `waiting-input`, `completed`, `failed`, `interrupted`, `stopped`, or `idle`). Chats belonging to deleted agents appear under `orphanedRuns`. To follow one chat without polling, use `t3_wait_for_thread_status`, which returns the new status and a resume cursor when it changes or the bounded timeout elapses. Use `t3_unsettle_thread`
with lifecycle access to return a settled chat to the active list. `t3_open_agents` opens the
board in the connected desktop window with read access.

### Child chats and subagents

An agent can hand work to two different kinds of helper:

- A **child chat** is a full agent chat with its own context, launched to do a separate part of a
  larger task. A lead agent can run several children at once, for example two Doug chats and a
  Cody chat on different pieces of one feature. Each child keeps its own status, can be settled
  on its own, and has subagents of its own.
- A **subagent** is a helper inside one agent's own run, used to save that agent's context:
  native subagents such as Claude's Agent tool, or a `delegate_task` without an agent. Subagents
  never appear on the board or in the sidebar.

When an agent's chat creates chats through the MCP gateway (`t3_create_thread` or
`t3_create_and_start_thread`), its own `t3_thread_launch` or `create_threads`, or a
`delegate_task` run as a named agent, each new chat is a child of the chat that created it. This
happens without the agent doing anything extra. This works across machines too. Pass `parentThreadId` (with
`parentEnvironmentId` when that chat is on another machine) to attach a new chat to another
chat, or `parentThreadId: null` for a standalone chat. `t3_list_threads` accepts `parentThreadId` to list a chat's children. To regroup existing
chats, `t3_set_thread_parent` moves a chat under another chat on any machine, or detaches it
with `parentThreadId: null`; it needs lifecycle access. On the board, drag a run onto a card
from any connected machine.

On the Agents board, children appear inside the card of the chat that created them, including
chats by other agents, on the full board and in the side list next to an open chat. Subagents are
not cards: they appear only in the **Lineage** panel of the chat that owns them. On web and
desktop, a card's children start collapsed to one line counting them by state (need input,
running, waiting, failed, done); click it to show or hide them. Each card remembers your choice on
this device, shared with the same parent's row in the sidebar. Open, each child shows its agent,
title, and status; click it to open that chat.
Children that need your input come first, then ones still working or waiting, then failed, idle,
and finished ones, newest first within each group. The list re-sorts at most once a minute so rows
stay put while you read them. A card shows eight children until you choose **Show more**, but a
child that needs input always shows. Right-click a child for the same actions as a card.
**Pin to top of parent** keeps it first in its parent's list, and settling moves it into its
parent's collapsed **Settled** group. A live child chat whose parent is settled keeps its
own card, which names its parent's agent and chat; click that name to open the parent.

A card reads **In progress** while any child chat or subagent below it is still working, even
after its own turn finishes. It reads **Waiting** when nothing is working but something will
wake it or a chat below it later, such as a watched pull request, a background monitor, or a
scheduled task bound to the chat. A child chat starts with a **Child of** link to its parent, and a
parent's details list its **Children** with their status.

Manually settling a parent card also settles its child chats through the existing cascade.
Working child chats remain active and follow that manual choice when they finish. Un-settling
the parent restores chats that settled with it; ones you settled earlier stay settled.

Completing a turn leaves a card unsettled. Automatic settlement applies to each card's own
inactivity period, three days by default. Running child chats, subagents, monitoring,
watched pull requests, and pending questions or approvals keep a parent active. New activity and un-settling reset
the idle clock. Disable auto-settle on a card to keep it active indefinitely.

To link chats yourself on web and desktop, drag a card onto the middle of another card to make it a
child, or drag a child out of its card to make it independent. Dragging a child onto
another card moves it there. The board shows the move at once and puts it back, with the reason,
if it fails: a chat cannot go under itself or its own child chats, or under an archived chat. To
remove a chat from its parent without dragging, right-click it (or focus it and press the context
menu key) and choose **Remove from parent**. Deleting a chat leaves its child chats as their own
cards, and a chat left pointing at a missing parent is detached when the server starts.

### Schedule prompts for an agent

Open **Scheduled** on the Agents board, or choose **Schedule task** from an agent's menu, to send
an agent a prompt at a set time (for example a deploy tonight) or on repeat (for example pulling
the latest changes every weekday at 7:00). Each task has one thread: the first run creates it and
every later run posts into it. Pause, resume, run now, edit, or delete a task from the same list.

A task is kept on, and runs on, the machine that hosts its project. When you ask an agent in a chat
to schedule something, that is the chat's machine, not the device you are typing on, so the task
still runs after that device shuts down. Tasks run only while that machine's T3 server is up and it is awake;
T3 does not wake a sleeping machine or keep it awake. A run missed while it was off or asleep
happens once when it is back. For unattended runs, set the machine not to sleep and keep T3 running
with the desktop app open or as a [background service](./background-service.md). Runs use the agent's permission mode, so an agent that
asks for approvals waits for you. Changing a task's agent or project starts a new thread on the next
run. MCP assistants can manage tasks with `t3_list_scheduled_tasks`, `t3_create_scheduled_task`,
`t3_update_scheduled_task`, and `t3_delete_scheduled_task` (create or admin access), and run one
immediately with `t3_run_scheduled_task` (send access). Pass `runAt` for a single run, or `cron`
with an optional IANA `timezone` for a repeating one.

MCP assistants can keep a project's [TODO list](./thread-sidebar.md#keep-a-todo-list) with
`t3_list_todos` (read access) and `t3_add_todo`, `t3_update_todo`, `t3_settle_todo`,
`t3_unsettle_todo`, and `t3_remove_todo` (create or admin access). Settling marks a todo done
and is reversible; removing deletes it.

To start from a ready-made agent, select **New agent** on the Agents board, then **Preconfigured**.
Choosing one opens the agent editor already filled in with its instructions, model, modes, and
skills; change anything before saving. Saving adds its skills to the shared library, reusing any
skill you already have with identical content. If a preset's provider or model is not set up on
your machines, choose an available one before saving. Some presets list software they need for
full compatibility, such as a signed-in CLI.

Ask an assistant connected to the **T3 Agents MCP** to create a shared skill and assign it to
an agent. For example: “Create a shared skill for reviewing pull requests and assign it to Randy.”
The MCP can list skills with read access and create, update, or delete them with create or admin
access. One shared library supplies every assigned agent, regardless of provider.

For manual editing, open **Skills** on the Agents board and expand **Create or edit manually**.
Assign skills in the agent editor. Skills can include references, scripts, and binary assets beside
`SKILL.md`. When importing through MCP, include a `resources` list with each file's relative `path`,
base64-encoded `contentBase64`, and optional `executable` flag. Nested paths stay relative to the
skill folder; references are read only when needed. Each skill supports up to 256 files, 1 MiB per
file and 2 MiB of resources; the shared library supports 8 MiB of resources. On update, omitting
`resources` preserves the files, while supplying a list replaces them (`[]` removes them).

Update the T3 gateway, clients, and connected environments before using resource bundles. Older
environments cannot synchronize them. New chats receive the updated bundle; existing chats retain
their starting copy, including files. Deleting a skill excludes it from new chats.

To migrate previously imported skills that still refer to local folders, use the supported
[resource import utility](../operations/skill-resource-import.md). It verifies uploaded resources
before removing the local-folder workaround and preserves skill IDs and agent assignments.

Before creating an agent chat, T3 synchronizes its library from environments available to the client.
Keep both machines connected to a client at least once after an edit so the destination can
receive it. Offline machines catch up when they reconnect; a disconnected source that this
client has never seen cannot supply updates.

Each chat has generated instructions and assigned skill files under `.agents/t3/` in its workspace.
T3 creates these from the configuration saved when the chat was created and clears them when
the chat is settled. Continuing or resuming restores that same configuration, even if the agent
or shared skills have since been edited or deleted. Deleting an agent keeps its existing chats
and their saved instructions and skills.

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

## Using the Desktop App as a Remote Only

If a computer should only drive work running elsewhere, turn off its local environment. In the
desktop app, open **Settings → Environments** and switch off **Local
environment**. T3 Code restarts without a local server: no local agents or terminals run, WSL
backends stay off, and other devices can no longer connect to this computer. Your projects,
history, and saved connections are kept, and you keep working through pairing, T3 Connect, or SSH.

Switch **Local environment** back on in the same place to restart with your previous local
settings.
