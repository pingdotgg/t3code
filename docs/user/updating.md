# Updating Ada

The app you use and the server running your agents can be on different machines.
When a server is behind your web or desktop app, the update button at the bottom
of the sidebar and **Settings → Environments** offer to update it.

## Check for updates

Checking for updates from the sidebar's update button, **Settings → About**, or
the desktop app menu checks the desktop app you are using, every connected
server, and every provider on those servers. On your phone, use **Settings →
About → Check for Updates**. Ada then lists each result: up to date, the version
available, or why it could not check. When updates are already waiting, the
sidebar button opens them and checks again while the list is open.

## Update everything at once

The update button at the bottom of the sidebar updates every connected machine
in one step. It updates outdated providers, then servers that are behind, then
the desktop app you are using. Servers move to the
version your desktop app is installing, or to your web app's version. A remote
desktop app installs the latest nightly. Hover the button to see what it will
update.

While it runs, the button widens to show progress. It names a machine that is
taking longer than usual, and offers **Retry** for a server that failed. Click
it to see every machine. The desktop app restarts once each server has started
its own restart, after a short countdown. Choose **Later** to keep working and
restart from the update button when you are ready. A server still restarting
finishes on its own, and the button keeps showing it after the desktop app
restarts.

Each server checks that it can install the release before it restarts. If the
release is not available to a server yet, its update fails, the server keeps
running, and you can retry. The confirmation lists each machine it skips and
why, such as a machine that is offline or needs a manual update. Use
**Settings → Environments** for those.

If a desktop app restarts on its old version, Ada tells you the update did
not apply. It does not install that version again on its own, even when another
device asks. Use the update button on that machine to retry.

The confirmation counts the running threads that the restarts will interrupt,
and how many can resume afterwards. See **Continue threads after restarts**
below.

## Release channel

Every Ada release is a nightly, published on
[GitHub Releases](https://github.com/jayleaton/ada/releases). There is no
stable track to switch to. Do not update with T3 Code's installers or
its npm package: they replace Ada's server with T3 Code's.

## Before you update

Server updates restart the connection and can interrupt active agents and
terminal commands. Saved threads, settings, and project files remain.

**Settings → Maintenance → Continue threads after restarts** is on by default.
It resumes supported active threads after an update, crash, or machine
restart. Changes are saved to connected environments that support this setting;
update older servers first. If a supported environment was offline or has a
different value, use **Apply to all** in Settings after it connects.
Ada must start again on that machine;
the setting does not enable automatic startup. Terminal commands may still be
interrupted, and threads without saved provider resume state need a new message.
A thread that finished its turn to wait on a subagent, a background task, a Claude
monitor, or a command or other monitor the agent said it was waiting on is woken and told that this work
stopped. Other background shells and monitors, such as a dev server and its
watchdog, do not wake it; the thread learns about them with your next message.
A thread is not resumed while it waits for your approval, answer, or secret, or
while it is archived, snoozed, or settled. After three consecutive crash recoveries
of an unfinished turn, the thread waits for your next message, even when crashes
are more than five minutes apart. A completed turn or a planned shutdown resets
that limit.

Updates from the previous orchestration system preserve conversation transcripts but cannot carry
every kind of runtime history forward. Read [Threads from older Ada versions](./thread-migration.md)
before continuing an important older thread.

## When versions don't match

A client and server must speak the same orchestration protocol. If they do not, the connection is
refused rather than running half-upgraded:

- An app newer than the server is blocked before connecting, with a notice telling you to update
  Ada on the machine named in the notice.
- A server newer than your app refuses the connection with an update message.

Update the side the notice names, then reconnect.

## Update a connected server

The offered action depends on how the server runs:

| Action                     | What to do                                                                                                                                                                                      |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Update server**          | Keep the client open while it installs and reconnects. Supported background services update remotely. For a desktop-hosted server, this also closes and relaunches the desktop app on the host. |
| **Update the desktop app** | Update the desktop app on the machine running the server, then reopen it if needed.                                                                                                             |
| **Copy update command**    | Run the copied command on the server's host. It is `t3 update <version>`, which works on any version, or `t3-headless-update install <version>` on the AppImage headless unit.                  |

On the host, run:

```sh
ada update <client-version>
```

Replace `<client-version>` with the version shown in the notice. The command
asks before restarting the background service; if you decline, run
`ada service restart` when you are ready. For a server you started by hand,
stop it and start it again afterwards with your usual options such as `--host`
or `--tailscale-serve`. `ada update` with no version moves to the newest release.
For a host running the AppImage-based systemd unit, run
`t3-headless-update install <version>` instead; see
[Headless Linux host](../operations/headless-linux.md).

If you decline the restart for a background service installed by an older
release, the service can stay down after a crash or reboot until you run
`ada service restart`.

## If an update fails

Keep the client open until it reconnects or reports a failure. A failed service
update can roll back to the previous version. If the update still fails:

1. Retry the offered action once.
2. Check that you updated the server's machine, not only the device you are using.
3. For a command-line server, run `ada update <version>` with the exact version shown in the notice, then start it again.

Only one server can use a Ada home directory at a time. If startup reports that
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

If the desktop app's server keeps failing at startup, Ada shows a "Ada
could not start" window instead of the app. If a newer version is available,
choose **Update** to install it. If not, the window links to the last version
that started on your computer. Download and install it to go back. Use **Copy
details** to include the error in a bug report.

## Registries and proxies

Each server checks providers installed with npm through its own npm, so the
checks use npm's configured registry, authentication, and proxy settings.
Providers installed with Homebrew or pnpm check through those tools.
Configure npm on the server's machine. If that registry cannot be reached, the
provider update shows as unavailable; Ada does not try the public registry
instead. Machines without npm check the public npm registry directly.

To download Ada releases through a mirror of
[GitHub Releases](https://github.com/jayleaton/ada/releases), set
`T3CODE_RELEASE_BASE_URL` for the installer and in the server's environment.

## Update providers

**Settings → Providers** shows provider updates for the selected environment.
**Update all** updates every outdated provider on every connected environment
at once. Hover it to see which providers it will update. A provider is left out
when any of its enabled, outdated instances offers only a manual update command,
or when its instances use different update commands, such as two instances that
run different CLI installs. Update those by hand, or point every instance of the
provider at the same CLI.

After a successful provider CLI update, Ada refreshes model discovery for
every enabled instance of that provider using its own configuration. Connected
clients receive the refreshed catalogs automatically. Provider update checks
must be enabled to download the latest Ada model catalog.

Provider updates do not restart running chats. An existing session can keep
using the previous CLI until it ends. If discovery fails, check the provider
status and refresh it again.

## Mobile updates

To update an environment from your phone, open **Settings → Environments** and
select it. **Check for updates** finds the latest nightly for that environment. Keep the app open while the environment updates and
reconnects. Hosts that cannot update remotely show instructions for updating on
the machine instead.

The same page lets you refresh provider status and update supported providers.
These controls require a connected environment and permission to operate it.
Provider update checks and restart continuation preferences are in
**Settings → Maintenance**. If provider update checks are disabled, enable them
there before refreshing to find newer versions. The same setting controls whether
Ada downloads model catalog updates, so with it off new models may not appear
until you enable it and refresh provider status.

Ada's mobile app is not in the App Store or Google Play yet, so install test
builds as described in [Mobile app](./install.md#mobile-app). The mobile app can also
download updates in the background and apply them when you next leave the app.
It saves drafts and queued messages before restarting. If you keep the app open
for a long time, it may ask to install immediately; choosing **Later** leaves the
update queued for the next suitable moment.
