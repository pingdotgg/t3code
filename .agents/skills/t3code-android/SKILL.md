---
name: t3code-android
description: >-
  Inspect and drive an Android emulator or connected device through T3 Code's
  Device panel and its device-pinned agent-device CLI. Use for requested Android
  interaction or device verification, including build/install and host targeting.
---

# Android devices in T3 Code

Use `device_*` and the exact `agent-device` command returned by `device_open`.
T3 supplies device discovery, streaming and control, not your app's build system.
Do not substitute Orca emulator commands or assume its coordinate conventions.

## Prerequisites and selection

Discover `device_list`; use its real host/device IDs and capabilities. Android
hosts need SDK Platform-Tools, Emulator and Command-line Tools, plus an existing
AVD or an authorized connected device. T3 detects standard SDK locations;
`ANDROID_HOME` selects a custom location. An emulator's video stream also needs
`ffmpeg` with libx264 on that host, or `SERVE_EMU_FFMPEG` pointing to it. Physical
Android devices do not need that video encoder.

If the hub or agent access is disabled, report **Settings → Devices** and the
specific missing dependency. Installing this skill does not install the SDK or
enable access. After a PATH/SDK change, local support needs an environment-server
restart; SSH support needs device support restarted so helpers inherit it.

Call `device_open` with the chosen `hostId` and `deviceId`. It can boot a stopped
emulator and opens it in this thread's Device panel. Keep the returned executable
path and all target flags (`--platform android`, `--serial`, and any `--config` /
`--session`) on every command. This matters with multiple devices or SSH hosts;
never use an unqualified `adb` command against whichever device happens to win.

## Build and exercise

1. Use the repository's documented Gradle/Expo/build command and actual APK
   output. Build success does not mean the app was installed or launched.
2. Use the returned CLI's `install` and `open` operations with the real package
   ID and artifact path. Consult `help` / `<command> --help` for exact flags.
3. Run the pinned CLI's `snapshot -i`, then target its fresh `@eN` refs with
   `click` / `fill`. Refresh after changes; prefer refs over coordinates.
4. Inspect with `device_screenshot` or the CLI screenshot operation to verify
   the requested UI behavior. Use documented CLI gestures/buttons where needed.

The snapshot helper installs itself on first use. For unsupported operations,
use the SDK tools on the selected device host with an explicit serial, such as
`adb -s <returned-serial> logcat -d -t 200`. Bound diagnostic output and avoid
collecting unrelated app data. Change runtime permissions or clear app data only
within the user's requested test scope.

On a remote host, arrange app uploads and development-server connectivity
(including Metro reverse forwarding when needed). T3 does not automatically
build, copy artifacts or forward Metro. Distinguish files on the agent host
from files on the device host.

Report host/device, installed build, flow and observed result. After an input
timeout, inspect state before retrying a potentially consequential action.
`device_close` detaches the panel; only `shutdown=true` powers off the device.
Leave pre-existing user devices running unless asked to stop them. Stop a paid
cloud session you created when finished using its returned cleanup instructions,
and report any cleanup failure. Do not wipe a device as an implicit retry.
