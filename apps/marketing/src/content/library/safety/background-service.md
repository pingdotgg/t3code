---
title: "Run T3 Code in the background"
description: "Run a T3 Code background service on macOS or Linux, control network access, set service variables, and diagnose startup, restart, and remote issues."
updated: 2026-11-04
sources:
  - label: "Background service"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/background-service.md"
  - label: "Managed policy"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/managed-policy.md"
  - label: "Product usage data"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/telemetry.md"
  - label: "Service installation defaults"
    url: "https://github.com/pingdotgg/t3code/blob/main/apps/server/src/cli/service.ts"
  - label: "Service network configuration"
    url: "https://github.com/pingdotgg/t3code/blob/main/apps/server/src/cli/config.ts"
  - label: "Install requirements and Intel Mac limits"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/install.md"
faq:
  - question: "Can T3 Code run without an open terminal?"
    answer: "T3 Code can run as a user service on Linux and macOS. Linux requires systemd user services; macOS runs it during the logged-in user session."
  - question: "Does T3 Code support a Windows background service?"
    answer: "T3 Code does not support Windows background services. Keep the desktop app running with its local environment enabled, or keep t3 serve open in a terminal."
  - question: "Does uninstalling the T3 Code service delete my threads?"
    answer: "T3 Code service uninstall leaves projects, threads, and settings intact. The broader t3 uninstall command also keeps userdata and service.env."
  - question: "Why does my T3 Code service stop after logout?"
    answer: "T3 Code on Linux needs lingering to survive logout. On macOS the service stops at logout, so unattended remote access needs a logged-in, awake Mac."
---

T3 Code can run as a background user service on Linux and macOS, so an environment does not need an open terminal. Install the `t3` CLI, run `t3 service install` on the host, and inspect `t3 service status`. Keeping a server running and making it reachable from other devices are separate setup decisions.

## Choose the right host setup

| Host                             | Background behavior                                                    | What to keep available                                                       |
| -------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Linux with systemd user services | Setup enables lingering for startup at boot and operation after logout | The machine and user service                                                 |
| macOS                            | Starts at login and stops at logout                                    | A logged-in, awake Mac                                                       |
| Windows                          | No supported background service                                        | Desktop app with local environment enabled, or a terminal running `t3 serve` |

Intel Macs have no standalone `t3` executable. A server built from source there does not support this background service or `t3 update`.

On Windows, minimize the desktop app rather than closing its last window, which stops its local server. Linking T3 Connect does not configure Windows sign-in startup.

If you need the CLI or a current desktop build, start at [the download page](/download). For connection choices, read [remote access](/learn/remote/remote-access) before opening the host to other devices.

## Install and inspect the service

Run commands on the machine that will host the environment:

```sh
t3 service install
t3 service status
```

Status reports the log location. On Linux it also checks whether the service runs, starts automatically, and survives logout. Running installation again repairs a service reported as broken.

Use the command that matches your task:

| Task                                       | Command                |
| ------------------------------------------ | ---------------------- |
| Configure access from another device       | `t3 up`                |
| Inspect how devices reach the host         | `t3 status`            |
| Restart the installed service              | `t3 service restart`   |
| Remove the service from startup            | `t3 service uninstall` |
| Install the newest release on your channel | `t3 update`            |

Service uninstall preserves projects, threads, and settings. `t3 uninstall` additionally removes the launcher and downloaded versions after showing its list and asking for confirmation. It keeps `~/.t3/userdata` and the service environment file.

## Choose local-only or private-network access

A new service answers only on its own machine. You can reach it through T3 Connect, or enable direct private-network access with `t3 up --lan`. That writes `T3CODE_LAN=true` into `service.env`.

LAN mode listens on local-network and Tailscale addresses, not public addresses. Other devices on that network can reach the port, so pairing remains important. Desktop and mobile clients on the same network can connect directly. The hosted web app stays on T3 Connect because browsers block plain HTTP requests from an HTTPS page.

Older services can retain LAN listening from before the LAN setting existed. Check `t3 status` rather than inferring exposure from a fresh-install default. Use `t3 up --no-lan` to turn LAN access off. An explicit `T3CODE_HOST` replaces the LAN setting.

Review [devices and access](/learn/remote/devices) when deciding who can connect. An [outside MCP agent](/learn/safety/outside-agents) also needs a reachable address and an approved sign-in.

## Set variables for the service

Put persistent values in `service.env` under T3 home, normally `~/.t3/service.env`:

```dotenv
T3CODE_HOST=127.0.0.1
T3CODE_PORT=3773
T3CODE_TELEMETRY_ENABLED=false
```

This example binds to loopback, sets a port, and disables server product events and relay tracing. Choose those values for the access you intend. Read [security and privacy](/learn/safety/security-and-privacy) for other data flows.

Use literal `KEY=VALUE` entries. Quote values containing spaces or `#`. The file does not execute shell commands or expand variables. It survives service installation and updates, so review it when diagnosing behavior that persists across versions.

Run `t3 service restart` after editing. Changing the installed server version alone does not reload service variables. For a service from before env-file support, run installation once with an up-to-date CLI. If this file holds credentials, restrict access with `chmod 600 ~/.t3/service.env`.

## Update without interrupting work unexpectedly

`t3 update` installs the newest release for your channel and switches the launcher and service to it. Restarting interrupts active agent turns, terminals, and remote clients, so the updater asks first.

Decline the restart to keep the old service running until `t3 service restart`. Status then reports `restart-pending`. A server started manually remains running until you stop and start it. Wait for an already-running remote update before beginning another update.

T3 Connect sign-in has a separate lifetime. `t3 up` installs the service during Connect setup, but signing out of Connect does not stop or uninstall it.

## Diagnose logout and startup failures

Start with `t3 service status` and read the named log. On Linux, `linger-disabled` means the service cannot survive logout. An administrator can enable it with:

```sh
sudo loginctl enable-linger "$(id -un)"
```

Run T3 Code itself as your normal user. Starting it as root creates another installation and Connect identity. Without administrator access, keep `t3 serve` running in an open terminal session.

On macOS, check **System Settings → General → Login Items** if startup fails. Installing over SSH while nobody is logged in at the screen can install successfully but fail at the final start step. The service starts at the next login.

If a [managed policy](/learn/safety/managed-policy) changes, restart the host server to apply it. Reconnecting clients does not reload policy.

## Next steps

Return to [permissions and privacy](/learn/safety) to review the host's access controls. Confirm [remote access](/learn/remote/remote-access) from the device you intend to use before leaving the machine unattended.
