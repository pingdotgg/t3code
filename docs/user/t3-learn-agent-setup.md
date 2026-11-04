# Set up T3 Learn with an agent

Give this page to a coding agent (Claude Code, Codex, or a thread in T3 Code) and it can install T3 Learn, bring your T3 Code chats across, and connect the app. Paste this to the agent:

> Read https://github.com/aabdel0181/t3-learn/blob/main/docs/user/t3-learn-agent-setup.md and set up T3 Learn for me. Follow its rules. Stop and tell me when a step says **Ask**.

Everything below is written for the agent.

## Rules

- T3 Learn runs next to T3 Code. Never stop, restart, update or reconfigure T3 Code, its service, or its app.
- Never write to T3 Code's data folder (`~/.t3`, or the desktop app's home). Copying from it read-only is fine.
- Kill only a process whose PID you started. Never kill by name or path pattern.
- A pairing link is a one-time secret. Don't open it in a browser or T3 Code, and keep it out of commits, issues and logs. Hand it to the user to paste.
- A shell started by a T3 Code agent inherits `T3CODE_HOME` and `T3_BOOT_SERVICE_UNIT` from the T3 Code server. Run every `t3` command for T3 Learn with both reset, as in the commands below. Without that, a command targets T3 Code's data.

## 1. Install the app

On the machine the user will work on:

```bash
curl -fsSL https://github.com/aabdel0181/t3-learn/releases/latest/download/install.sh | sh
```

On Windows, in PowerShell: `irm https://github.com/aabdel0181/t3-learn/releases/latest/download/install.ps1 | iex`.

Use this command, not a download from the Releases page. The builds aren't signed, and only the command gets past macOS Gatekeeper. The app opens when the command finishes, installs next to T3 Code, and keeps its data in `~/.t3-learn`. Set `T3LEARN_NO_LAUNCH=1` to install without opening it.

If the user's chats are not on a server, you are done: T3 Learn starts empty and the user signs in to a provider (Claude Code, Codex) in its settings. Copying chats from a T3 Code desktop app on the same machine isn't scripted yet.

## 2. Bring chats from a T3 Code server

Do this on a Linux machine that runs T3 Code as a background service, so the user's chats stay where their projects and agents are. T3 Learn gets its own server beside it, with its own data folder, port and service.

**Ask** before starting: this copies the user's chats and starts a second server. Then:

1. Install T3 Learn's server as its own service. Take the Linux archive for the latest release (`t3-<version>-linux-x64.tar.gz`, or `linux-arm64`) from the [release page](https://github.com/aabdel0181/t3-learn/releases/latest), unpack it, and run:

   ```bash
   env -i HOME="$HOME" USER="$USER" LOGNAME="$USER" LANG=C.UTF-8 PATH="$PATH" \
     XDG_RUNTIME_DIR="/run/user/$(id -u)" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$(id -u)/bus" \
     T3CODE_HOME="$HOME/.t3-learn" ./t3 service install --base-dir "$HOME/.t3-learn"
   ```

   This creates `t3learn.service`. It never touches `t3code.service`.

2. Put the server on its own port, on the loopback address only, and restart just that service:

   ```bash
   printf 'T3CODE_PORT=3780\nT3CODE_HOST=127.0.0.1\n' > ~/.t3-learn/service.env
   systemctl --user restart t3learn.service
   ```

3. Check out this repository at the tag of the installed server (`git checkout v<version>`), run `vp i`, and run `scripts/t3-learn-copy-chats.sh`. If that tag predates the script, run it from a newer checkout with `T3_LEARN_CHECKOUT=<path to the tag checkout>`. It needs `sqlite3`, `python3` and `node`. It reads T3 Code's database read-only, builds a copy in a staging folder, boots that copy with no provider reachable so runs that were in flight are stopped instead of continuing, and swaps the copy into `t3learn.service` only when nothing is in flight. The old copy is kept as `~/.t3-learn/userdata/statev2.sqlite.previous`.

The copy is a snapshot. New T3 Code messages don't appear in T3 Learn. Run the script again to refresh, before the first device pairs: it refuses afterwards because a refresh would wipe the user's side chats. Pass `--force` only if the user says that's fine.

Make `t3 pair` and `t3 thread` easy to run with the right home by wrapping them, for example in `~/.local/bin/t3-learn`:

```sh
#!/bin/sh
t3=$(sed -n 's/^ExecStart=\(.*\) __service-launcher$/\1/p' "$HOME/.config/systemd/user/t3learn.service")
unset T3_BOOT_SERVICE_UNIT T3_SERVICE_LAUNCHER_CONTEXT T3LEARN_HOME
T3CODE_HOME="$HOME/.t3-learn" exec "$t3" "$@"
```

## 3. Connect the desktop app

The user's desktop app and the server need to reach each other. Tailscale with MagicDNS and HTTPS certificates turned on is the simplest route. T3 Connect isn't available in T3 Learn.

On the server, publish it and mint a link that lasts a day:

```bash
t3-learn pair --base-dir ~/.t3-learn --tailscale --tailscale-serve-port 8443 --ttl 24h
```

Give the user the `Pairing URL` it prints, as a code block. Don't use the `t3code://` app link: it opens T3 Code, not T3 Learn.

Tell the user to open T3 Learn, go to **Settings → Environments → Add environment**, paste the whole URL, and add it. Run the command again for a fresh link if it expires or gets used.

## 4. Tell the user how to learn from copied chats

- Learn through side chats only. Highlight text in an old chat and choose **Ask in side chat**.
- The side-chat header's map toggle (⌥⌘G on a Mac, Ctrl+Alt+G elsewhere) opens the lesson's map without leaving the chat.
- To choose the model new side chats start with, change how they explain things, or attach skills (when the side chat's provider has them), go to **Settings → Threads → Side chats**.
- Don't type in a copied chat's main box, revert it, or delete it along with its worktree. The copy shares T3 Code's agent session and git checkpoints, so any of those would land in the user's live T3 Code chat.
- Side chats can run commands in the project's real folder. Don't ask one to edit files that a live agent is working on.
- Older chats are under **Settled**, as in T3 Code.

## Updating

New versions are released automatically from `main` after CI and the install tests pass. T3 Learn shows an update button that updates the app and connected server together. On the Linux box, run `t3-learn update --yes`; when using the plain CLI, set `T3CODE_HOME=~/.t3-learn` first.
