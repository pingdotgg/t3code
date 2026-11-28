# Running Hyakki in the background

Run Hyakki as a background user service on Linux, macOS, or Windows so your host stays reachable without keeping a terminal open.

## Manage the service

Install the `hyakki` CLI first ([Command line](./install.md#command-line)), then run these commands on the host machine:

| Task                                    | Command                                                           |
| --------------------------------------- | ----------------------------------------------------------------- |
| Set up access from other devices        | `hyakki up`                                                       |
| Check how other devices reach it        | `hyakki status`                                                   |
| Install and start (or repair)           | `hyakki service install`                                          |
| Check status and log path               | `hyakki service status`                                           |
| Update to a newer release               | `hyakki update`                                                   |
| Restart                                 | `hyakki service restart`                                          |
| Stop and remove from startup            | `hyakki service uninstall`                                        |
| Remove service, launcher, and downloads | `hyakki uninstall` (keeps `~/.hyakki/userdata` and `service.env`) |

- Pairing codes are never written to logs; run `hyakki pair` or `hyakki up` on the host to connect a device.
- `hyakki update` asks before restarting (pass `--yes` in scripts). Pin a version with `hyakki update 0.0.42`, switch tracks with `--channel nightly`, or downgrade with `--allow-downgrade`.

## Local network access

New services bind to localhost only. Run `hyakki up --lan` (sets `HYAKKI_LAN=true` in `service.env`) to listen on LAN and Tailscale addresses for direct desktop/mobile connections, or `hyakki up --no-lan` to disable it. Anyone on that network can reach the port (gated by pairing). `HYAKKI_HOST` overrides `HYAKKI_LAN`. Hosted `hyakki.ryoku.dev` always uses Hyakki Connect.

## Configure the service environment

Add `KEY=VALUE` entries to `service.env` in your Hyakki home directory (`~/.hyakki/service.env` by default). Values are literal (quote spaces or `#`; no shell expansion) and survive installs and updates.

```dotenv
HYAKKI_PORT=3773
HYAKKI_HOST=127.0.0.1
```

- `PATH`, `HYAKKI_HOME`, `T3_BOOT_SERVICE_UNIT`, and `T3_SERVICE_LAUNCHER_CONTEXT` cannot be overridden here.
- Run `hyakki service restart` after editing (and `chmod 600 ~/.hyakki/service.env` if it holds secrets).

## Platform support

- **Linux**: Requires systemd user services with lingering enabled so Hyakki starts at boot and survives logout.
- **macOS**: Starts at login, stops at logout. Keep the Mac logged in and awake for unattended access. If agents can't read Desktop/Documents/Downloads, grant Full Disk Access to the `hyakki` path in `~/Library/LaunchAgents/dev.ryoku.hyakki.service.plist`.
- **Windows**: Runs windowless via Task Scheduler (`t3code-<domain>-<user>`) while signed in and auto-restarts on exit. Lock the screen instead of signing out for unattended access.

## Keep the server responsive under memory pressure (Linux)

On Linux, agents run at lower priority than the server, but heavy memory use can still trigger the OOM killer. Run as your normal user:

```sh
hyakki service protect
```

It previews system changes, asks for confirmation and `sudo`, and optionally protects Tailscale and SSH too. Run `hyakki service restart` for OOM-killer protection to take effect, or `hyakki service protect --undo` to remove it.

## Troubleshooting

Run `hyakki service status` on the host to see the log path and health checks:

| Status                                 | Fix                                                                                                                                            |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `linger-disabled`                      | Run `sudo loginctl enable-linger "$(id -un)"` (or `ssh -t your-server '...'`), then retry setup as your normal user. Never run Hyakki as root. |
| `linger-unavailable`                   | Check `loginctl show-user "$(id -un)" --property=Linger` and verify `systemd-logind`.                                                          |
| `user-manager-unavailable`             | Run `systemctl --user status` in a login session to verify systemd user support.                                                               |
| `service-disabled` / `service-stopped` | Check the log and `systemctl --user status t3code.service`, then run `hyakki service install`.                                                 |
| `restart-pending`                      | Run `hyakki service restart` to switch to the newly installed version.                                                                         |

## Reclaim database space

Hyakki automatically prunes old internal history while keeping conversations. Older databases that still hold freed space show a **Reclaim** button in **Settings → Maintenance** when at least 1 GiB is reclaimable (pauses the server/agents during repair).

For manually started servers (or CLI use), stop any hand-started server or desktop app and run:

```sh
t3 doctor          # Interactive repair (auto-stops/restarts a background service)
t3 doctor --dry-run
t3 doctor --fix    # Non-interactive recommended repairs
```

- Needs free disk space of ~2× active data size (in `TMPDIR`/`/var/tmp` and beside the database). Large databases can take over an hour.
- `hyakki doctor` optionally offers to remove the legacy pre-0.1.0 `state.sqlite` backup only when all active projects and threads exist in the current database (`--fix` never deletes it automatically).
