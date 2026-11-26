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

Uninstalling the service leaves your projects, threads, and settings intact.
Running `t3 service install` again repairs a service that `t3 service status`
reports as broken.

`t3 update` downloads the newest release on your channel from
[this fork's GitHub releases](https://github.com/ScriptedAlchemy/t3code/releases) and switches `t3`
and the service to it. Restarting interrupts running agent turns, terminals,
and remote clients, so it asks first; answer no and the service keeps running
the old version until you run `t3 service restart`. Pass `--yes` from a
script. A server you started by hand is left running; stop and start it again
to pick up the new version. Wait for any remote update already in progress
before updating; to match a remote client's version, follow
[Updating T3 Code](./updating.md).

This fork currently publishes Nightly releases, and its installer defaults to
that channel. Pass an exact published version (`t3 update <version>`) to pin
one, `--channel nightly` to select Nightly, or `--allow-downgrade` to move
backwards. `preview` is a
maintainers' test train: its builds can be broken and are never offered as
updates, so the installer and `t3 update` ask for confirmation before
installing one.

`t3 uninstall` removes the background service, the `t3` launcher, and the
downloaded versions after showing you the list and asking once. Your projects,
threads, and settings under `~/.t3/userdata` are kept, along with `service.env`
under T3 home. Pass `--yes` from a script.

## Local network access

A new service answers only on this machine. Other devices reach it through
T3 Connect, or directly once you choose the local network in `t3 up` (or run
`t3 up --lan`, which sets `T3CODE_LAN=true` in `service.env`). It then listens on
your local network and Tailscale addresses, so the desktop and mobile apps on
the same network connect directly instead of through T3 Connect. It still does
not answer on public addresses. Anyone on the same network can reach the port,
so a pairing code is all that keeps them out. The upstream hosted web app at app.t3.codes
stays on T3 Connect, because browsers block plain HTTP from an HTTPS page.

A service installed before `T3CODE_LAN` existed keeps listening on the local
network. `t3 status` says so, and `t3 up --no-lan` turns it off. Any
`T3CODE_HOST` value replaces this setting.

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
