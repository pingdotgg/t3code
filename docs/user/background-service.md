# Running T3 Code in the Background

On Linux and macOS, T3 Code can run as a background service for your user, so it is ready without
keeping a terminal open.

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

The service uses the same T3 Code version as the CLI you run. To install a nightly or an exact
version, use that version of the CLI:

```sh
npx t3@nightly service update
npx t3@1.2.3 service update
```

The install and update commands refuse to replace a newer service with an older version. Setup
through T3 Connect leaves a newer service unchanged. To downgrade, select the exact older version
and pass `--allow-downgrade`:

```sh
npx t3@1.2.3 service update --allow-downgrade
```

Stop it and remove it from startup:

```sh
npx t3@latest service uninstall
```

Updating restarts T3 Code briefly. Let active agent work and terminal commands finish first.
If a remote update is already in progress, wait for it to finish before retrying a local update.

The service runs a small stable launcher. Exact T3 Code versions are installed separately, so a
failed remote candidate can return to the previous version without rewriting the service
definition. The launcher snapshots the database before a remote candidate starts, so database
updates roll back with the server version. An older launcher may require one local
`service update` before this is available.

## Platform Support

**Linux** uses a systemd user unit at `~/.config/systemd/user/t3code.service`. The service starts
when the machine boots and keeps running after you log out (lingering is enabled during install).

**macOS** uses a launch agent at `~/Library/LaunchAgents/com.t3tools.t3code.service.plist`. It
starts when you log in, not when the Mac boots, and it stops when you log out; macOS has no
equivalent of Linux lingering for user agents. For a Mac that should stay reachable unattended,
turn on automatic login (System Settings → Users & Groups; unavailable while FileVault is on) and
keep the Mac from sleeping.

A few more macOS notes:

- Installing over SSH needs someone logged in at the Mac's screen to start the agent right away.
  Without that, the install command reports an error at the final start step, but the agent is
  fully installed and starts at the next login.
- macOS may show privacy prompts for protected folders such as Desktop, Documents, or Downloads,
  attributed to a bare `node` process, or deny access without a prompt. If agent work fails to
  read those folders, grant Full Disk Access to the node binary listed in the launch agent's
  `ProgramArguments`.
- The agent appears under System Settings → General → Login Items. If it was switched off there,
  or disabled with `launchctl disable`, macOS will not start it at login until you switch it back
  on.

**Windows** is not supported yet.

## Using It with T3 Connect

T3 Connect may offer to install the service during setup so the host stays reachable in the
background. This is only an onboarding shortcut: the service and T3 Connect are managed separately.

Signing out of T3 Connect does not remove the service. Use `t3 service uninstall` when you no longer
want T3 Code to start in the background.
