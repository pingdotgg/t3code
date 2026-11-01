---
name: t3code-ios
description: >-
  Inspect and drive an iOS Simulator through T3 Code's Device panel and its
  device-pinned agent-device CLI. Use for requested iOS interaction or simulator
  verification; requires an enabled device hub and a compatible device host.
---

# iOS Simulator in T3 Code

Use T3's `device_*` tools and the exact `agent-device` command returned by
`device_open`. T3 manages discovery, streaming and control; the repository's
build/install workflow remains yours to run. This guide uses T3's device API,
not Orca's emulator CLI or coordinate conventions.

## Select and open

1. Discover `device_list` and read host capabilities. For a local simulator the
   device host needs macOS with Xcode and an installed simulator runtime.
   A browser on a Mac does not make a remote Linux host support iOS.
2. Choose the requested iOS device using its returned `hostId` and `deviceId`.
   Call `device_open` for that target; it boots the device if needed and shows
   it in this thread's Device panel.
3. Retain the returned executable path and every target flag, including
   `--platform`, `--udid`, and any `--config` / `--session` flags. Do not substitute
   an unpinned CLI from PATH or assume another device opening switches yours.

If access is disabled or no device host is available, report the prerequisite
in **Settings → Devices**. Installing this skill does not install Xcode, enable
agent device access or provision a cloud device. Create a paid cloud session
only when the user's request authorizes that cost; use the returned setup and
cleanup instructions.

## Build, drive, verify

Use the repository's documented simulator build command and actual `.app`
output. Follow the returned CLI help for `install` and `open` with the real app
identifier; do not guess an artifact path or build for a physical device by
mistake. `xcodebuild` and `xcrun simctl` remain available on the device host for
operations the controller does not cover.

With the exact device-pinned command returned by T3:

- Run `snapshot -i` for fresh accessibility refs, then `click` or `fill` the
  returned `@eN` target. Keep the device flags on every invocation.
- Refresh state after navigation or a UI change. Prefer semantic refs over
  coordinates. Use CLI `help` / `<command> --help` for supported gestures,
  orientation and hardware-button operations; do not invent flags.
- Use `device_screenshot` for an open device's PNG or the CLI's screenshot
  command. Inspect the result after the action before calling a flow verified.
- First use can build an XCTest runner and take minutes. Wait on the actual
  process result rather than launching competing controllers.

For remote hosts, place the app build on the correct machine and arrange any
development-server connectivity explicitly. Do not assume local artifact paths
are remote paths. Report the host/device, build, flow exercised and observed
result; a successful build alone does not verify the simulator UI.

`device_close` removes the panel; it leaves the device running unless
`shutdown=true`. Preserve a user's existing session by default. For a cloud
session you created, close with `shutdown=true` when done to stop billing, and
report a cleanup failure explicitly. Do not erase simulator data to recover
from an error without authorization.
