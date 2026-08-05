# Running T3 Code in the Background

On a Linux host, T3 Code can run as a background service for your user. It starts when the machine
boots and keeps running after you log out.

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

The command installs the same T3 Code version as the CLI you ran. This makes nightly and pinned
installations predictable:

```sh
npx t3@nightly service update
npx t3@1.2.3 service update
```

An older CLI will not replace a newer installed service by accident. If you intentionally need to
downgrade, run the exact older version and pass `--allow-downgrade`:

```sh
npx t3@1.2.3 service update --allow-downgrade
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

The background service currently requires Linux with systemd.
