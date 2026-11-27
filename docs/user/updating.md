# Updating T3 Code

T3 Code clients and servers can run on different machines and must share a compatible orchestration protocol. When a server or provider is behind, the sidebar update button and **Settings → Environments** handle updates.

This fork's desktop and standalone CLI updates come from
[ScriptedAlchemy/t3code releases](https://github.com/ScriptedAlchemy/t3code/releases).
The fork currently publishes **Nightly** releases. Install the fork's desktop
app or bundled web app to get its client changes; the upstream hosted web app,
mobile store apps, and npm package follow separate releases.

## Update everything at once

Click the **Update** button at the bottom of the sidebar (web or desktop) to update outdated providers, behind servers, and the desktop app in one step.

- Hover to preview what will update; click while running to view per-machine progress or retry failures.
- Confirmation dialogs show which machines are skipped (offline or manual-only) and how many active threads will pause/resume.
- Choose **Later** on the desktop restart countdown to restart when ready.

## Switch between Stable and Nightly

Keep this fork on **Nightly** unless a release exists on the track you want.
Switching tracks searches this fork's release repository; it does not switch
the installation to upstream T3 Code. If a track has no release, the dialog
reports that it is unavailable.

In the desktop app, change **Settings → About → Update track**. T3 Code shows each
connected machine it will move and each one it skips, then moves them in one
step. Remote servers install the latest release on the new track. Remote desktop
apps reinstall on the new track. This app reinstalls last. Your threads,
settings, and data stay.

- Moving a background service to an older Stable release requires running `t3 update --channel stable --allow-downgrade` on that host.
- A switch is blocked if the machine's database has schema changes the target track doesn't support yet. macOS desktop apps must switch on that Mac.

## Continue threads after restarts

**Settings → Maintenance → Continue threads after restarts** is enabled by default. After an update, crash, or reboot (once T3 Code starts again), supported active threads automatically resume—and threads waiting on subagents or monitors are woken and notified that background work stopped.

- Threads waiting for your approval/answer/secret—or archived, snoozed, or settled—are not auto-resumed.
- After 3 consecutive crash recoveries of an unfinished turn, the thread waits for your next message.
- Updating from V1? Read [Threads from older T3 Code versions](./thread-migration.md).

## Update a connected server manually

| Situation                           | Action                                                                                                |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Background service / desktop server | Click **Update server** in **Settings → Environments** (desktop hosts relaunch automatically).        |
| Installed `t3` CLI                  | Run `t3 update <version>` on the host (then `t3 service restart` if you declined the restart prompt). |
| `npx` server                        | Stop the server and relaunch with `npx t3@<version>` and your usual flags.                            |
| Package manager (Nix, AUR)          | Update via your package manager.                                                                      |

Updates from the previous orchestration system preserve conversation transcripts but cannot carry
every kind of runtime history forward. Read [Threads from older T3 Code versions](./thread-migration.md)
before continuing an important older thread.

## When versions don't match

A client and server must speak the same orchestration protocol. If they do not, the connection is
refused rather than running half-upgraded:

- An app newer than the server is blocked before connecting, with a notice telling you to update
  T3 Code on the machine named in the notice.
- A server newer than your app refuses the connection with an update message.

Update the side the notice names, then reconnect.

## Update a connected server

The offered action depends on how the server runs:

| Action                     | What to do                                                                                                                                                                                      |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Update server**          | Keep the client open while it installs and reconnects. Supported background services update remotely. For a desktop-hosted server, this also closes and relaunches the desktop app on the host. |
| **Update the desktop app** | Update the desktop app on the machine running the server, then reopen it if needed.                                                                                                             |
| **Copy update command**    | Run the command on the named host to update the detected global npm install or installed `t3` command, then restart the server with your usual options.                                         |
| **Copy relaunch command**  | Stop the command-line server on its host and relaunch with the copied command, keeping your usual subcommand and options. This does not update an installed `t3` command.                       |

On the host, run:

```sh
t3 update <client-version>
```

Replace `<client-version>` with a fork release version shown in the notice. The command
asks before restarting the background service; if you decline, run
`t3 service restart` when you are ready. For a server you started by hand,
stop it and start it again afterwards with your usual options such as `--host`
or `--tailscale-serve`.

If you decline the restart for a background service installed by an older
release, the service can stay down after a crash or reboot until you run
`t3 service restart`.

The npm update and relaunch actions apply to upstream npm installations.
This fork does not publish `t3` to npm: use its
[standalone installer](./install.md#command-line), or pull and rebuild a source
checkout. Running `npx t3@<version>` selects upstream, not a fork release.

## If an update fails

Keep the client open until it reconnects or reports a failure. A failed service
update can roll back to the previous version. If the update still fails:

1. Retry the offered action once.
2. Check that you updated the server's machine, not only the device you are using.
3. For a command-line server, stop it and relaunch the exact version shown in the notice.

Only one server can use a T3 home directory at a time. If startup reports that
another server owns it, stop that server before retrying, or use a separate home
directory and pair with the running server.

### macOS app does not reopen after an Alpha update

Updating an older **T3 Code (Alpha)** installation can replace it with
**T3 Code (Beta)** without reopening the app. Open **T3 Code (Beta)** from
Applications, or run:

```sh
open "/Applications/T3 Code (Beta).app"
```

If an old Dock shortcut no longer opens the app, remove it and add the Beta app
from Applications again.

## If the desktop app does not start

If the desktop app's server keeps failing at startup, T3 Code shows a "T3 Code
could not start" window instead of the app. If a newer version is available,
choose **Update** to install it. If not, the window links to the last version
that started on your computer in this fork's releases. Download and install it to go back. Use **Copy
details** to include the error in a bug report.

## Release sources and package registries

Each fork server checks T3 Code releases and their database compatibility
metadata from this fork's GitHub releases. The server needs access to GitHub
and the release assets; changing npm's registry does not change which T3 Code
builds are offered. Older releases without compatibility metadata cannot be
used for a cross-track switch until the target release's compatibility is known.

Providers installed with npm still check through the server's npm, using its
configured registry, authentication, and proxy settings. Providers installed
with Homebrew or pnpm check through those tools. Configure these package
managers on the server's machine. If its npm registry cannot be reached, the
provider's update check fails rather than trying the public registry instead.
Machines without npm check the public npm registry directly for those providers.

## Update providers

Open **Settings → Providers** and click **Update now** on individual providers or **Update all** across connected environments. Running chats keep using their current CLI until they end; new sessions and model catalogs refresh automatically. (Provider update checks in **Settings → Maintenance** must be enabled to fetch model catalog updates.)

## Mobile updates

- Update connected environments and providers from **Settings → Environments** on mobile.
- Update the mobile app via the App Store or Google Play (background over-the-air updates apply on next app switch and preserve drafts/queued messages).

## Troubleshooting

The App Store and Google Play apps follow upstream releases. Those apps can also
download updates in the background and apply them when you next leave the app.
It saves drafts and queued messages before restarting. If you keep the app open
for a long time, it may ask to install immediately; choosing **Later** leaves the
update queued for the next suitable moment.

This fork does not publish those store or over-the-air updates. If you built the
fork's mobile app from source, rebuild it from the updated checkout to receive
its native client changes. Fork builds disable over-the-air updates by default.
To opt into your own Expo project's updates, configure its project and owner and
explicitly enable updates when building; see [Mobile app setup](./install.md#mobile-app).
