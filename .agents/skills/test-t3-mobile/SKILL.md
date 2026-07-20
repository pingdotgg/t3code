---
name: test-t3-mobile
description: Launch and test T3 Code Mobile on an iOS Simulator or Android Emulator against disposable local T3 environments, including Metro and dev-client reuse, native rebuild decisions, per-client pairing, seeded projects, semantic UI control, screenshots, and iOS serve-sim streaming. Use after mobile UI or native changes, when reproducing phone or tablet behavior, pairing an emulator to isolated state, or verifying mobile behavior on macOS, Linux, or Windows.
---

# Test T3 Mobile

Run one focused, end-to-end mobile verification pass against disposable T3 state. Use the sibling [`test-t3-app`](../test-t3-app/SKILL.md) skill as the detailed reference for pairing-token semantics and SQLite fixtures.

Command examples use POSIX shell syntax. On Windows, use PowerShell equivalents: set variables with `$env:NAME = "value"`, use an explicit temporary directory from `[System.IO.Path]::GetTempPath()`, and run multiline examples on one line or with PowerShell backticks. Use `$env:ANDROID_HOME\platform-tools\adb.exe` when `adb` is not already on `PATH`.

## Select a viable platform

Inspect the host and the affected code before launching processes:

- On macOS with Xcode, prefer one representative iOS Simulator when the change is cross-platform so the user can watch through serve-sim. Load and follow [`ios-debugger-agent`](../ios-debugger-agent/SKILL.md), and load [`ios-simulator-browser`](../ios-simulator-browser/SKILL.md) when live streaming is available.
- On macOS, Linux, or Windows with the Android SDK, use one Android Emulator when Android is the affected surface or iOS tooling is unavailable.
- When the change is platform-specific, test that platform. When neither platform is viable, report the missing SDK, emulator, or dev-client prerequisite rather than claiming verification.

Do not treat unavailable iOS tooling as a blocker when Android is a valid representative target.

## Choose the lightest valid launch path

- For JavaScript, TypeScript, or asset-only changes, reuse a compatible installed development client and start Metro. Do not rebuild native code merely to load a new bundle.
- For native source, native dependencies, entitlements, config plugins, or generated project changes, rebuild the affected platform.
- Use `vp run ios:dev` or `vp run android:dev` only when an Expo clean prebuild is actually required; both commands regenerate the native project.
- If the user requested no native rebuild and no compatible app is installed, reuse an existing compatible `.app` or `.apk` artifact when available. Otherwise report the missing dev client instead of silently rebuilding.

The development identity on both platforms is:

- App: `T3 Code Dev`
- Bundle/package identifier: `com.t3tools.t3code.dev`
- URL scheme: `t3code-dev`

Bundle or package presence proves the correct variant, not native compatibility. Reuse it only when the current changes did not alter its Expo SDK, native dependencies, config plugins, entitlements, generated project, or native source.

## Start one disposable T3 environment

Run backend commands from the repository root. Use the ignored, worktree-local `.t3` directory or create a fresh directory with the host OS's temporary-directory mechanism. An explicit base directory stores state in `<base-dir>/userdata`; never point testing at shared `~/.t3` state.

Seed a small number of meaningful Git projects before starting the backend:

```bash
node apps/server/src/bin.ts project add <git-workspace> \
  --base-dir <base-dir> \
  --title <project-title>
```

Running `project add` before the backend starts gives it exclusive offline database access. If a backend is already running, wait until it is ready so the CLI dispatches through the live server; never run offline mutations concurrently with the server.

Use direct SQLite mutation only for disposable projection fixtures. Follow `test-t3-app` and stop the backend before writing.

Start a headless backend after seeding:

```bash
node apps/server/src/bin.ts serve \
  --host 127.0.0.1 \
  --port <server-port> \
  --base-dir <base-dir> \
  --no-browser
```

Use these client origins:

- iOS Simulator: `http://127.0.0.1:<server-port>`
- Android Emulator: `http://10.0.2.2:<server-port>`
- Physical device: bind the backend to `0.0.0.0` and use the host's reachable LAN origin

Always enter the complete `http://` origin; the mobile host field otherwise assumes HTTPS. When testing web and mobile together, run `vp run dev --home-dir <base-dir> --host 127.0.0.1` instead and do not launch a second backend over the same base directory.

## Start or reuse Metro safely

Run Metro from `apps/mobile`.

1. Inspect any process on the intended Metro port and its `/status` response. Reuse it only when it is healthy, belongs to this worktree, and matches `APP_VARIANT=development`, `--dev-client`, and scheme `t3code-dev`.
2. Never kill another worktree's Metro. Use a free explicit port when necessary.
3. Run `vp run dev:client` on the standard port. For another port, retain the complete development identity:

   ```bash
   APP_VARIANT=development vp exec expo start \
     --dev-client \
     --scheme t3code-dev \
     --clear \
     --lan \
     --port <metro-port>
   ```

   In PowerShell, set `$env:APP_VARIANT = "development"` first and then run the `vp exec expo start ...` command without the leading assignment.

4. Open the exact development-client URL for the selected device and confirm the loaded bundle belongs to this worktree and Metro port.

### iOS launch

Use `ios-debugger-agent` to select one UDID and set these XcodeBuildMCP session defaults:

- Workspace: `<repo>/apps/mobile/ios/T3CodeDev.xcworkspace`
- Scheme: `T3CodeDev`
- Configuration: `Debug`
- Simulator ID: the selected UDID
- Bundle ID: `com.t3tools.t3code.dev`

Check the installed client with:

```bash
xcrun simctl get_app_container <simulator-udid> com.t3tools.t3code.dev app
xcrun simctl openurl <simulator-udid> <printed-dev-client-url>
```

Accept the iOS confirmation prompt and dismiss the developer menu when it obscures the app.

### Android launch

Select one running emulator serial from `adb devices` and check the installed client:

```bash
adb -s <emulator-serial> shell pm path com.t3tools.t3code.dev
adb -s <emulator-serial> reverse tcp:<metro-port> tcp:<metro-port>
adb -s <emulator-serial> shell am start -W \
  -a android.intent.action.VIEW \
  -d '<printed-dev-client-url>' \
  com.t3tools.t3code.dev
```

Do not start, stop, erase, or reconfigure an emulator owned by another task. Track and later stop only processes owned by this test.

## Pair each client once

Issue a fresh credential against the running backend's exact base directory:

```bash
T3CODE_PORT=<server-port> node apps/server/src/bin.ts auth pairing create \
  --base-dir <base-dir> \
  --base-url <mobile-origin> \
  --ttl 15m \
  --label agent-mobile-<short-device-id>
```

In PowerShell, set `$env:T3CODE_PORT = "<server-port>"` first and run the `node ... auth pairing create` command without the leading assignment.

If the visible Add Environment action is not exposed as a semantic target, open the app's registered route instead of guessing coordinates:

```bash
xcrun simctl openurl <simulator-udid> 't3code-dev://connections/new'
adb -s <emulator-serial> shell am start -W \
  -a android.intent.action.VIEW \
  -d 't3code-dev://connections/new' \
  com.t3tools.t3code.dev
```

Run only the command for the selected platform.

In T3 Code Dev, open Add Environment and enter the complete `<mobile-origin>` and newly printed `Token`. Verify the expected seeded projects appear before exercising the affected flow.

Pairing credentials are secret, short-lived, and single-use. Create a different credential for every simulator, emulator, physical device, or browser. If an attempt fails, issue a new credential rather than retrying the old one. Do not expose tokens in screenshots, commits, or final responses.

## Drive and observe the affected flow

### iOS

Use `snapshot_ui` and current element references from XcodeBuildMCP for taps and typing. Stream the same UDID through `ios-simulator-browser` so the user can watch in T3 Code when the host supports it. Use the stream as a visual feed rather than a reason to switch to fragile browser coordinates.

### Android

Prefer semantic Android automation exposed by the current agent host. Otherwise inspect the current hierarchy with `adb shell uiautomator dump`, target stable resource IDs, content descriptions, text, or bounds, and use scoped `adb shell input` actions. Refresh the hierarchy after navigation. Capture the final state with `adb exec-out screencap -p`.

Android does not use serve-sim. Use a browser-compatible Android mirror when the host already provides one; otherwise return focused emulator screenshots as evidence rather than installing unrelated streaming infrastructure during verification.

## Verify and clean up

Exercise only the affected flow on one representative device unless the change specifically concerns platform, OS version, or screen size. Before finishing:

1. Confirm the app connected to the intended disposable environment instead of merely rendering an empty disconnected state.
2. Capture the relevant final state.
3. Remove the disposable environment from T3 Code Dev.
4. Remove any `adb reverse` rule created for this test with `adb -s <emulator-serial> reverse --remove tcp:<metro-port>`.
5. Stop only the serve-sim, Metro, backend, emulator, and log processes started by this test.
6. Remove only base directories and temporary Git repositories deliberately created for this test. Preserve them when they contain useful reproduction evidence.

Keep local verification focused. Do not turn this workflow into a full repository test run.

## Troubleshoot predictable failures

- **Old UI or an old error appears:** verify Metro's worktree, variant, URL, and port before diagnosing the app.
- **The environment remains empty:** verify the platform-specific HTTP origin, use a fresh token, and confirm project seeding used the identical base directory.
- **A second client cannot pair:** pairing tokens are single-use; issue another token.
- **iOS semantic actions fail:** set explicit XcodeBuildMCP defaults and refresh with `snapshot_ui`.
- **Android cannot reach Metro:** verify `adb reverse` for the exact Metro port and relaunch the development-client URL.
- **Android cannot reach the backend:** use `10.0.2.2`, not `127.0.0.1`, for the Android Emulator.
