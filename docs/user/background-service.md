# Running T3 Code in the background

Run T3 Code as a background user service on Linux, macOS, or Windows so your host stays reachable without keeping a terminal open.

## Manage the service

Install the `t3` CLI first ([Command line](./install.md#command-line)), then run these commands on the host machine:

| Task                                    | Command                                                   |
| --------------------------------------- | --------------------------------------------------------- |
| Set up access from other devices        | `t3 up`                                                   |
| Check how other devices reach it        | `t3 status`                                               |
| Install and start (or repair)           | `t3 service install`                                      |
| Check status and log path               | `t3 service status`                                       |
| Update to a newer release               | `t3 update`                                               |
| Restart                                 | `t3 service restart`                                      |
| Stop and remove from startup            | `t3 service uninstall`                                    |
| Remove service, launcher, and downloads | `t3 uninstall` (keeps `~/.t3/userdata` and `service.env`) |

- Pairing codes are never written to logs; run `t3 pair` or `t3 up` on the host to connect a device.
- `t3 update` asks before restarting (pass `--yes` in scripts). Pin a version with `t3 update 0.0.42`, switch tracks with `--channel nightly`, or downgrade with `--allow-downgrade`.

## Local network access

New services bind to localhost only. Run `t3 up --lan` (sets `T3CODE_LAN=true` in `service.env`) to listen on LAN and Tailscale addresses for direct desktop/mobile connections, or `t3 up --no-lan` to disable it. Anyone on that network can reach the port (gated by pairing). `T3CODE_HOST` overrides `T3CODE_LAN`. Hosted `app.t3.codes` always uses T3 Connect.

## Configure the service environment

Add `KEY=VALUE` entries to `service.env` in your T3 home directory (`~/.t3/service.env` by default). Values are literal (quote spaces or `#`; no shell expansion) and survive installs and updates.

```dotenv
T3CODE_PORT=3773
T3CODE_HOST=127.0.0.1
```

- `PATH`, `T3CODE_HOME`, `T3_BOOT_SERVICE_UNIT`, and `T3_SERVICE_LAUNCHER_CONTEXT` cannot be overridden here.
- Run `t3 service restart` after editing (and `chmod 600 ~/.t3/service.env` if it holds secrets).

## Platform support

- **Linux**: Requires systemd user services with lingering enabled so T3 Code starts at boot and survives logout.
- **macOS**: Starts at login, stops at logout. Keep the Mac logged in and awake for unattended access. If agents can't read Desktop/Documents/Downloads, grant Full Disk Access to the `t3` path in `~/Library/LaunchAgents/com.t3tools.t3code.service.plist`.
- **Windows**: Runs windowless via Task Scheduler (`t3code-<domain>-<user>`) while signed in and auto-restarts on exit. Lock the screen instead of signing out for unattended access.

> Note: Signing out of T3 Connect does not stop or uninstall the background service.

## Keep the server responsive under memory pressure (Linux)

On Linux, agents run at lower priority than the server, but heavy memory use can still trigger the OOM killer. Run as your normal user:

```sh
t3 service protect
```

It previews system changes, asks for confirmation and `sudo`, and optionally protects Tailscale and SSH too. Run `t3 service restart` for OOM-killer protection to take effect, or `t3 service protect --undo` to remove it.

When the host is in trouble, the sidebar (or the top of the thread list on
mobile) says so: **Memory is slowing agents down** (this can happen before
memory runs out), **Almost out of disk space** (where T3 Code keeps its data and
worktrees), or **Machine overloaded** (work waiting for a CPU or for the disk).
A machine that is merely busy shows nothing. With several machines in trouble,
one notice covers them all. On Linux the warning names the agents using the most
memory or CPU, and you can force stop one there to free the machine for the
rest. Their threads also show a warning icon in the thread list.

## Troubleshooting

Run `t3 service status` on the host to see the log path and health checks:

| Status                                 | Fix                                                                                                                                             |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `linger-disabled`                      | Run `sudo loginctl enable-linger "$(id -un)"` (or `ssh -t your-server '...'`), then retry setup as your normal user. Never run T3 Code as root. |
| `linger-unavailable`                   | Check `loginctl show-user "$(id -un)" --property=Linger` and verify `systemd-logind`.                                                           |
| `user-manager-unavailable`             | Run `systemctl --user status` in a login session to verify systemd user support.                                                                |
| `service-disabled` / `service-stopped` | Check the log and `systemctl --user status t3code.service`, then run `t3 service install`.                                                      |
| `restart-pending`                      | Run `t3 service restart` to switch to the newly installed version.                                                                              |

For T3 Connect issues, see [T3 Connect troubleshooting](./t3-connect-troubleshooting.md).

## Reclaim database space

T3 Code automatically prunes old internal history while keeping conversations. Older databases that still hold freed space show a **Reclaim** button in **Settings → Maintenance** when at least 1 GiB is reclaimable (pauses the server/agents during repair).

For manually started servers (or CLI use), stop any hand-started server or desktop app and run:

```sh
t3 doctor          # Interactive repair (auto-stops/restarts a background service)
t3 doctor --dry-run
t3 doctor --fix    # Non-interactive recommended repairs
```

- Needs free disk space of ~2× active data size (in `TMPDIR`/`/var/tmp` and beside the database). Large databases can take over an hour.
- `t3 doctor` optionally offers to remove the legacy pre-0.1.0 `state.sqlite` backup only when all active projects and threads exist in the current database (`--fix` never deletes it automatically).
