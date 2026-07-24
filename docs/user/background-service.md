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

Stop it and remove it from startup:

```sh
npx t3@latest service uninstall
```

Updating restarts T3 Code briefly. Let active agent work and terminal commands finish first.

For a classic s6 scan directory, pass the same supervisor options to each lifecycle command:

```sh
t3 service install --supervisor s6 --service-dir /run/service/t3code
t3 service status --supervisor s6 --service-dir /run/service/t3code
```

The service directory must already be inside a scan directory managed by `s6-svscan`. T3 Code owns
the `run` file inside that directory and controls it with `s6-svc`.

## Automatic Service Updates

Set **Settings** → **General** → **Service update repository** to an exact GitHub repository URL,
such as `https://github.com/owner/repository`. Leave it empty to disable automatic service updates.

Every 15 minutes the managed service checks that repository's GitHub releases. A newer
platform-specific CLI and its adjacent `.sha256` file are downloaded into the T3 Code runtime
directory. T3 Code verifies the checksum and the binary's reported version before marking the
update pending.

While an update is pending, existing agent turns may finish and new turns are saved in a durable
queue. Once no agent turn is active, T3 Code atomically replaces the systemd unit or s6 run script
and asks the configured supervisor to restart it. The replacement process invokes queued turns
after it starts. A failed supervisor activation restores the previous service definition and
resumes queued work.

## Using It with T3 Connect

T3 Connect may offer to install the service during setup so the host stays reachable after you log
out. This is only an onboarding shortcut: the service and T3 Connect are managed separately.

Signing out of T3 Connect does not remove the service. Use `t3 service uninstall` when you no longer
want T3 Code to start in the background.

The background service requires Linux with either a systemd user manager or a classic s6 scan
directory.
