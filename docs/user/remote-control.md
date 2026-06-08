# Remote Control

Use this when you want to drive a Claude session — started and managed by T3 Code — from the
**Claude iOS app** or the **Claude web app** (`claude.ai`).

> **This is different from Remote Access.**
> Remote Access connects *another device to your T3 server* over WebSocket (LAN, Tailscale, SSH).
> Remote Control launches the real `claude` CLI in a mode where Anthropic relays control from
> the Claude iPhone/web app to the running CLI process on your machine.
> See [How this differs from Remote Access](#how-this-differs-from-remote-access) below.

---

## Prerequisites

Remote Control requires:

- **A claude.ai subscription:** Pro, Max, Team, or Enterprise. The feature is not available on the
  free tier or with API-key-only authentication.
- **Claude Code CLI installed** and logged in with your claude.ai account:
  ```bash
  claude auth login
  ```
- **T3 Code** installed. `t3 remote-control` is a T3 CLI command that launches the underlying
  `claude` binary for you.

Remote Control is a capability of the official `claude` CLI. T3 Code does not implement the
relay itself — it only launches the CLI in the right mode and surfaces the pairing output so you
can complete setup from the Claude app.

---

## How It Works

1. T3 launches `claude remote-control` (server mode) or `claude --remote-control` (interactive
   mode) using the Claude HOME directory and account you configured in your Claude provider.
2. The `claude` process registers the local session with Anthropic's relay over outbound HTTPS.
3. Anthropic relays control commands from the Claude iOS/web app to your local `claude` process.
4. You see the pairing output (registration URL or QR code) in T3's terminal panel or in your
   terminal, and complete the pairing from the Claude app.

The relay is Anthropic's own infrastructure. T3 Code does not proxy or inspect relay traffic.

---

## Running from the CLI

```bash
t3 remote-control
```

or using the short alias:

```bash
t3 rc
```

### Flags

| Flag | Description |
| --- | --- |
| `--claude-home <path>` | Path to the Claude HOME directory. Defaults to the home directory of the active Claude provider. |
| `--account <path>` | Alias for `--claude-home`. |
| `--name <title>` | Display name for this session in the Claude app. |
| `--server` | Launch `claude remote-control` in server (non-interactive) mode. |
| `--interactive` | Launch `claude --remote-control` in interactive mode. |
| `[cwd]` | Optional working directory. Defaults to the current directory. |

If neither `--server` nor `--interactive` is specified, T3 defaults to server mode.

### Example: launch with a name

```bash
t3 remote-control --name "my-work-machine"
```

### Example: launch against a specific Claude account

```bash
t3 remote-control --claude-home ~/.claude_personal_home --name "personal"
```

### Example: launch interactive mode in a project directory

```bash
t3 rc --interactive ~/projects/my-app
```

---

## Completing the Pairing from the Claude App

After `t3 remote-control` starts, the terminal shows pairing output from the `claude` CLI — a
registration URL, a session code, or a QR code depending on your Claude version.

On your iPhone or in the Claude web app:

1. Open the Claude app.
2. Look for the **Remote** or **Remote sessions** entry in the menu or settings.
3. Tap or click it. If a session is waiting for pairing it will appear in the list.
4. Select the session and confirm.

Once paired, you can issue prompts and receive responses from the Claude app. The `claude` process
runs on your local machine; the app is the remote control interface.

---

## Launching from Inside T3

You can also start a Remote Control session without leaving T3:

1. Open the Claude provider card in **Settings → Providers**.
2. Expand the Claude provider instance you want to use.
3. Click **Start Remote Control**.
4. T3 launches `claude --remote-control` through the terminal subsystem. A terminal panel opens
   showing the pairing output.
5. Complete pairing from the Claude app as described above.

The in-app launch uses the `Claude HOME path` already configured for that provider instance.
No additional flags are needed.

---

## How This Differs from Remote Access

These two features share the word "remote" but they solve different problems.

| | Remote Access | Remote Control |
| --- | --- | --- |
| **What connects** | Another device (phone, tablet, second PC) connects to *your T3 server* | The Claude iOS/web app connects to *a running `claude` CLI process* on your machine |
| **Transport** | WebSocket directly to T3 server (LAN, Tailscale, SSH) | Anthropic's relay (outbound HTTPS from your machine to Anthropic's servers) |
| **What you control** | Full T3 UI on a second device | Claude coding session from the Claude app |
| **Account requirement** | Any T3 setup | claude.ai Pro, Max, Team, or Enterprise |
| **Launched by** | T3 server / desktop app | The `claude` CLI (T3 launches it for you) |
| **Relevant guide** | [Remote Access](./remote-access.md) | This guide |

Remote Access is for when you want the **T3 interface** on another device.
Remote Control is for when you want to use the **Claude app** as the interface for a session
running on your PC.

The two features can be combined: you can run T3 headlessly on a remote machine via Remote
Access, and also launch Remote Control from that T3 instance so the Claude app can reach the
session on the remote machine.

---

## Troubleshooting

**"claude: command not found"**
Make sure the `claude` CLI is installed and on your PATH. See the
[Claude Code installation guide](https://claude.com/product/claude-code) for setup steps.
You can also specify the binary path in the provider settings under **Settings → Providers →
Claude → Binary path**.

**The session does not appear in the Claude app**
Check that your `claude` CLI is logged in to the correct claude.ai account:
```bash
claude auth status
```
The account must have a Pro, Max, Team, or Enterprise subscription.

**Remote Control is not available in your Claude version**
`claude remote-control` is a feature of the `claude` CLI. If your installed version does not
support it, update the CLI:
```bash
npm install -g @anthropic-ai/claude-code@latest
```
or use the in-app update button in **Settings → Providers → Claude**.

**Port or firewall issues**
Remote Control uses outbound HTTPS from the `claude` process to Anthropic's relay. No inbound
port needs to be open. If outbound HTTPS is blocked on your network, Remote Control will not work.

---

## See Also

- [Remote Access](./remote-access.md) — connecting other devices to your T3 server
- [Claude provider guide](../providers/claude.md) — setting up Claude accounts and HOME paths
- [Multi-instance architecture](../architecture/multi-instance.md) — running multiple T3 instances
