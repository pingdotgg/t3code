---
title: "Run iOS Simulator and Android Emulator in T3 Code"
description: "Watch and control iOS simulators and Android emulators in T3 Code, grant agents device access, and connect device hosts over SSH."
updated: 2026-11-04
sources:
  - label: "Device setup and remote hosts"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/devices.md"
  - label: "Device architecture"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/internals/devices.md"
faq:
  - question: "Can T3 Code show an iOS simulator?"
    answer: "T3 Code's Device panel streams an iOS simulator running on a host with macOS and Xcode. You can interact with it and permit agents to control it."
  - question: "What does T3 Code need for Android emulators?"
    answer: "T3 Code needs Android SDK Platform-Tools, Android Emulator, Command-line Tools, and a configured virtual device on the device host. Android emulator video also requires ffmpeg with libx264."
  - question: "Can T3 Code use devices on another machine?"
    answer: "T3 Code supports device hosts added through Settings → Devices → Add source → Machine over SSH. SSH configuration and keys resolve on the environment server."
  - question: "Does closing the T3 Code Device tab stop the emulator?"
    answer: "Closing a T3 Code Device tab stops watching while the device keeps running. Use the power-off control when you want to shut down the device."
---

T3 Code's Device panel shows iOS simulators and Android emulators beside your thread so you can watch and control mobile testing. An authorized agent can use the same device. Devices run on the environment server or a configured device host, including a machine reached over SSH.

## Prepare the machine that runs your devices

Check dependencies on the device host before opening a simulator. Installing an SDK on your viewing laptop does not supply it to another machine.

| Device                 | Host requirements                                                                                        |
| ---------------------- | -------------------------------------------------------------------------------------------------------- |
| iOS simulator          | macOS and Xcode                                                                                          |
| Android emulator       | SDK Platform-Tools, Android Emulator, Command-line Tools, and a virtual device created in Android Studio |
| Android emulator video | `ffmpeg` with the libx264 encoder on the host's `PATH`, or selected by `SERVE_EMU_FFMPEG`                |
| SSH device host        | Node 22 or newer and npm available to non-interactive SSH commands, plus the platform tools              |

T3 Code detects standard Android SDK locations. Set `ANDROID_HOME` when using a custom location. After installing SDK tools, restart the environment server and refresh the device list.

If you change `PATH` or `SERVE_EMU_FFMPEG`, restart the environment server for local devices. For SSH devices, turn device support off and back on. Physical Android devices and iOS do not require ffmpeg.

## Open a simulator or emulator beside a thread

1. Open a project thread and select `Device` in the right panel.
2. Follow setup to start the device hub, check platform support, and choose agent access.
3. Select a running device, or choose `Start` beside a stopped device.
4. Use `+ → Device` when you need another device tab.

Opening the panel alone downloads and starts nothing. Setup reuses an installed hub. Each device has its own tab, and only the visible tab streams video. Switching tabs leaves the devices running.

You can click, drag, and type into the focused screen. Platform controls include Android Home, Back, and Recents, plus iOS rotation. `Float device over chat` keeps a smaller interactive view visible while the right panel shows other work.

Closing a tab stops watching. To shut down the device, use power off. Turning off `Settings → Devices → Use devices` stops T3 helpers while simulators and emulators remain running until powered off.

## Let an agent verify mobile work

Enable `Agents can use devices` in `Settings → Devices` before starting the agent session. T3 Code then installs and starts its device control CLI. Restart an existing agent session after granting access so it receives the required environment.

Agents use the `device_*` tools to discover and open a device, then the supplied `agent-device` command to interact with it. The first iOS tap builds a small test runner, which takes a couple of minutes once per server.

Turning off agent access hides the device tools from agents started afterward. Your own Device panel remains available. This lets you keep manual testing without offering device control to new agent sessions.

Use the device toolbar's `Tools` drawer for supported checks such as appearance, text size, accessibility settings, location, and app permissions. Available controls vary by platform and reflect values read back from the device.

## Watch a remote device from your phone

Device streams follow the environment connection, including LAN, Tailscale, and T3 Connect. Set up [remote access](/learn/remote/remote-access) before diagnosing the device viewer itself.

Live video needs a secure page, meaning HTTPS or localhost. On a plain HTTP remote origin, iOS uses a slower still-image stream. Android video cannot display there, except on EAS Simulator. Choose a secure route when moving between local and remote viewing.

In the [T3 Code mobile app](/learn/remote/mobile-apps), open the agent's thread and tap the device button above the composer. You can watch and control the screen. If several devices belong to the thread, select one in the viewer. Closing the viewer ends streaming while leaving the device available to the agent.

## Add a machine over SSH

In `Settings → Devices`, select the environments that should use the host. Choose `Add source → Machine over SSH`, then provide an alias or `user@host`. An identity file and port are optional.

These settings resolve on the environment server. Its SSH keys and configuration must reach the device host. Password prompts are unsupported for this connection.

Use `Test connection` to check SSH, Node, npm, and platform tools without installing anything. The first device listing installs pinned tools. Arrange app builds, installation, and Metro connectivity separately. A remote simulator cannot reach your environment's development server through its own `localhost`.

## Update the device host tools

The connected T3 server manages required tool versions on its machine and SSH hosts. `Check versions` in `Settings → Devices` reads installed versions without starting devices or installing tools.

Update the remote T3 server to receive newer tools. Updating your phone or browser alone does not change that server. Tool installation needs network access; T3 Code does not substitute an older version when installation fails.

## Use a Simlock device pool

If you already operate a compatible Simlock gateway and workers, T3 Code can lease their devices. This integration is an alpha. T3 Code does not install or manage the pool.

Enable `Settings → Labs → Simlock device hosts (alpha)` and `Use devices`, then select `Add source → Simlock pool` in device settings. Supply a separate agent token for each T3 server. Use an HTTPS gateway, or HTTP only over an encrypted network such as Tailscale. Treat the token like shell access to your workers.

Opening a pool device takes a lease. `Return device to the pool` releases and wipes it. The pool viewer supports touch and typing but omits several controls available on ordinary device hosts, including the Tools drawer and screenshots.

## Next steps

- Return to [remote and mobile](/learn/remote) to choose a connection workflow.
- Keep the environment available with a [background service](/learn/safety/background-service).
- Use [mobile notifications](/learn/remote/mobile-notifications) to know when testing needs your attention.
- Diagnose failed environment connections with [T3 Connect troubleshooting](/learn/remote/t3-connect-troubleshooting).
