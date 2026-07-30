# Running T3 Code in the Background

On macOS or Linux, T3 Code can run as a background service for your user. The simplest setup is:

```sh
npx t3 connect
```

After T3 Connect links the machine, accept the default background setup. T3 Code starts immediately
and returns automatically after a reboot. On macOS, the per-user LaunchAgent starts after you sign
in. On Linux, the systemd user service starts at boot and keeps running after you log out.

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

## Using It with T3 Connect

T3 Connect offers to install the service during setup so the host starts automatically and stays
reachable in the background. The service and T3 Connect are still managed separately.

Signing out of T3 Connect does not remove the service. Use `t3 service uninstall` when you no longer
want T3 Code to start in the background.

The background service requires macOS with launchd or Linux with systemd.
