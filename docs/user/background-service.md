# Running T3 Code in the background

On Linux and macOS, T3 Code can run as a service for your user so you do not need
to keep a terminal open.

## Manage the service

Run these commands on the machine that will host T3 Code:

| Task                            | Command                           |
| ------------------------------- | --------------------------------- |
| Install and start               | `npx t3@latest service install`   |
| Inspect status and log location | `npx t3@latest service status`    |
| Update or repair                | `npx t3@latest service update`    |
| Stop and remove from startup    | `npx t3@latest service uninstall` |

Uninstalling the service leaves your projects, threads, and settings intact.

Install and update use the version of the CLI you invoke. For nightly, use
`npx t3@nightly service update`; replace `nightly` with an exact version to pin
one. An older CLI refuses to replace a newer service unless you explicitly add
`--allow-downgrade`.

Updating restarts the server. Finish active work first, and wait for any remote
update already in progress. To match a remote client's version, follow
[Updating T3 Code](./updating.md).

## Platform support

Linux needs systemd user services. Setup enables lingering so T3 Code starts at
boot and keeps running after logout. If this needs administrator permission,
setup prints a recovery command before changing the service.

macOS starts the service when you log in and stops it when you log out. Keep the
Mac logged in and awake for unattended remote access. Installing over SSH while
nobody is logged in at the Mac's screen can fail at the final start step; the
service is still installed and will start at the next login.

Windows background services are not supported.

T3 Connect can offer service installation during setup, but the two are managed
separately. Signing out of T3 Connect does not stop or uninstall the service.

## Troubleshooting

Start with `t3 service status` on the host. It prints the log path and, on Linux,
checks whether the installed service is running, enabled, and allowed to survive
logout.

If it stops when your SSH session closes, check for `linger-disabled`. An
administrator can enable lingering with:

```sh
sudo loginctl enable-linger "$(id -un)"
```

Over SSH, allow sudo to prompt:

```sh
ssh -t your-server 'sudo loginctl enable-linger "$(id -un)"'
```

Then retry service setup as your normal user. Run only the `loginctl` command
with sudo; running T3 Code as root creates a separate installation and Connect
identity. Without administrator access, run `t3 serve` in a terminal and keep
that session open.

| Status problem                          | Next step                                                                                                                      |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `linger-unavailable`                    | Run `loginctl show-user "$(id -un)" --property=Linger` and check that systemd-logind is available.                             |
| `user-manager-unavailable`              | Run `systemctl --user status` in a login session for the service user; check your distribution's systemd user-session support. |
| `service-disabled` or `service-stopped` | Read the log and `systemctl --user status t3code.service`, then use the repair command printed by T3 Code.                     |

On macOS, check **System Settings → General → Login Items** if the service no
longer starts at login. If agent work cannot access Desktop, Documents, or
Downloads, it may need Full Disk Access for the Node executable listed in
`ProgramArguments` in
`~/Library/LaunchAgents/com.t3tools.t3code.service.plist`.

For failures after signing in to T3 Connect, see
[connection troubleshooting](./remote-access.md#t3-connect-troubleshooting).
