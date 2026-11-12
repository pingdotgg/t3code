# Headless Linux host for the fork

Run the fork's server on a Linux host without the Electron window, under a systemd user unit,
and update it from the fork's nightly feed. Clients (web over Tailscale, the desktop app on
another machine, mobile) connect to it like any other remote environment.

`t3 service install` and `t3 update` download the fork's single-file runtimes, which fork releases
publish from 0.1.9 nightlies on. This setup runs the server bundled in the fork's AppImage
instead, which also covers older releases: [`packaging/linux-headless/`](../../packaging/linux-headless/).

## Why a plain unit instead of the desktop app

- The Electron main process moves itself into an `app-<appId>-<pid>.scope`, outside the
  service that launched it. Stopping the service closes the window but can leave the
  backend holding the userdata ownership lock, and the next start exits 78
  (`ServerAlreadyRunningError`) until systemd kills the old one. Headless, the server is the
  unit's main process and `KillMode=control-group` stops everything in its cgroup.
- Agents run in their own scopes under `app-t3code-agents-<hash>.slice`, outside the unit's
  cgroup ([agentScope.ts](../../apps/server/src/process/agentScope.ts)). They exit when the
  server's pipe closes, but a tool process an agent detached can outlive them. The unit's
  `ExecStopPost` stops that slice, as the next server would on start. Detached terminals live
  in the shared `app-t3code-agents.slice` and survive.
- A restart interrupts running turns. Conversations and provider sessions resume on start.
- The unit never stops retrying: a remote host has nobody to clear a systemd start limit, so
  it backs off up to 60 s between failed starts instead.
- A plain `t3 serve` binds 127.0.0.1. The unit sets `T3CODE_HOST=0.0.0.0`, so a Tailscale or
  LAN address that appears after boot is reachable without a network wait. Unlike the upstream
  launcher's default, an explicit host does not drop connections from public addresses;
  pairing and sign-in still apply.

## Install

```sh
install -Dm755 packaging/linux-headless/t3-headless-update ~/.local/bin/t3-headless-update
install -Dm644 packaging/linux-headless/t3code-headless.service ~/.config/systemd/user/t3code-headless.service
systemctl --user daemon-reload
t3-headless-update            # downloads, verifies sha512, extracts, writes the t3 shim
systemctl --user enable --now t3code-headless.service
sudo loginctl enable-linger "$(id -un)"   # keep it running without a login session
```

Edit `T3CODE_HOME`, `T3CODE_PORT`, and `PATH` in the unit (or a drop-in) to match the host.
Provider CLIs must be on that `PATH`; the server then adds the login shell's `PATH` for agents.
The unit passes home, port, and host to the server as flags and unsets them, so agents get the
same environment as under the desktop app: a `t3` command or dev server an agent runs in a
worktree must not find this server's home.

The server prints a pairing URL at every start (`journalctl --user -u t3code-headless`). Mint
another one with `~/.local/opt/t3code-headless/bin/t3 pair`.

## Update and roll back

`t3-headless-update` resolves the newest fork release, checks the AppImage against the
feed's sha512 and size, extracts it into `releases/<version>`, swaps `current`, restarts the
unit, and waits until `/.well-known/t3/environment` reports the new version. If the server
does not come back it switches to the previous version and exits non-zero. `install <version>`
pins a version; `rollback` swaps back; `status` shows what is installed.

Set `T3_HEADLESS_COMPANIONS=t3-mcp-gateway.service` when the MCP gateway service runs from
`~/.local/opt/t3code-headless/current`, so it restarts onto the same version.

In the UI, **Update all** still updates provider CLIs: that runs on the server. It cannot
update T3 itself here. The server is neither desktop-managed nor run by the upstream launcher,
so it is listed as needing a manual update. Run `t3-headless-update` (or a timer that runs
it).

## Switch from the desktop unit

[`cutover.sh`](../../packaging/linux-headless/cutover.sh) moves a host from the desktop unit to
the headless unit and back. Stopping the desktop unit ends every agent, including one that
started the switch, so run it in its own transient unit:

```sh
systemd-run --user --unit=t3-headless-cutover --collect packaging/linux-headless/cutover.sh run
```

`run` installs the unit, the update script, and a release (`CUTOVER_VERSION`, else the newest);
waits up to 30 minutes for running turns to end (`--force` skips this; otherwise it aborts
before changing anything); stops and disables the desktop unit; stops the
`app-<appId>-<pid>.scope` that still holds the port, if any; points the MCP gateway service at
the headless release with a drop-in; and starts the headless unit. It then checks for up to
120 seconds that the server listens on `0.0.0.0`, reports the installed version, answers on
the Tailscale Serve URL, has a connected runtime in the gateway, and writes its database. If a
check fails it rolls back: headless off, gateway drop-in removed, desktop unit on, and the same
checks again. `rollback` does that on request. Each run writes a report to
`~/.local/state/t3-captain/cutover-<timestamp>.txt`. Unit names, port, T3 home, and URL are
`CUTOVER_*` variables at the top of the script.

The headless server hosts the T3 Agents gateway runtime the desktop app used to provide: the
cutover adds `T3_MCP_HEADLESS_GATEWAY=1` to the unit, and the server reads the bridge token from
`~/.config/t3code/mcp-gateway.env`. Agents in chats keep their own `t3-code` MCP, which their
server serves either way.

## What the host loses

The local window and tray, desktop notifications on that machine, snap-shot screen capture,
deep links, and the Electron browser panel extras (the preview falls back to the server's
headless Chromium).
