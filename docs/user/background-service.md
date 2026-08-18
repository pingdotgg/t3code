# Running T3 Code in the Background

On a Linux host, T3 Code can run as a background service for your user. It starts when the machine
boots and keeps running after you log out.

On Windows it starts when you sign in and stops when you sign out. See
[On Windows](#on-windows) for the full list of differences.

## Manage the Service

Install it with the latest T3 Code release:

```sh
npx t3@latest service install
```

Check whether it is installed:

```sh
npx t3@latest service status
```

Update or repair it:

```sh
npx t3@latest service update
```

Stop it and remove it from startup:

```sh
npx t3@latest service uninstall
```

Updating restarts T3 Code briefly. Let active agent work and terminal commands finish first.
If a remote update is already in progress, wait for it to finish before retrying a local update.

The systemd unit runs a small stable launcher. Exact T3 Code versions are installed separately, so
a failed remote candidate can return to the previous version without rewriting the unit. The
launcher snapshots the database before a remote candidate starts, so database updates roll back
with the server version. An older launcher may require one local `service update` before this is
available.

## Using It with T3 Connect

T3 Connect may offer to install the service during setup so the host stays reachable after you log
out. This is only an onboarding shortcut: the service and T3 Connect are managed separately.

Signing out of T3 Connect does not remove the service. Use `t3 service uninstall` when you no longer
want T3 Code to start in the background.

The background service requires Linux with systemd, or Windows. macOS is not supported yet.

## On Windows

Windows has no systemd, so `t3 service install` puts a shortcut named `T3 Code Server` in your
personal Startup folder. Windows Explorer runs that shortcut every time you sign in. The shortcut
starts PowerShell, PowerShell starts the T3 Code server with no window, then PowerShell exits.

It is called `T3 Code Server` rather than `T3 Code` because it only starts the server. The desktop
app is separate, and you start that yourself.

The same four commands work: `install`, `status`, `update` and `uninstall`.

Windows differs from Linux in ways worth knowing before you rely on it:

- **It starts at sign-in, not at boot.** Nothing runs while the machine sits at the sign-in screen.
- **It stops when you sign out.** Windows ends your session's processes, and the server is one.
- **Stopping is not graceful.** `update` and `uninstall` terminate the server rather than asking it
  to shut down. In-flight agent work is cut, and the server does not get to release its T3 Connect
  link, so the host can look online for a short while after it has gone.
- **A small window blinks once at sign-in.** It is named `T3 Code Server`. That flash is PowerShell
  starting, and it is expected. Nothing stays on your taskbar afterwards.
- **Windows Settings can switch it off.** It appears under Startup apps. If you disable it there,
  `t3 service status` still reports it as installed, because the shortcut is still on disk, and
  `t3 service install` still reports nothing to do. Check Startup apps first if the service stops
  coming back after you sign in. An install that does have work to do refuses to write over a
  disabled entry and tells you to turn it back on.
- **Windows Explorer must be your shell.** That is the default. If you replaced it, Startup folder
  entries may never run, and `t3 service install` warns you about that.

Let agent work finish before running `update` on Windows, because the stop is not graceful.
