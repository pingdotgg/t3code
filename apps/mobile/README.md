# T3 Code Mobile

> [!NOTE]
> To install the released app from the App Store or Google Play, see [Mobile app](../../docs/user/install.md#mobile-app). This guide covers building it from source.

## Quickstart

> [!NOTE]
> Uses native modules so using Expo Go is not supported. You need to use the Expo Dev Client.

This app has three variants:

- `development`: Expo dev client, installable side-by-side as `T3 Code Personal Dev`
- `preview`: persistent internal preview build, installable side-by-side as `T3 Code Personal Preview`
- `production`: store/release build as `T3 Code Personal`

Run commands from `apps/mobile`.

T3 Connect is optional and disabled in a fresh clone. Public configuration belongs in the
repository-root `.env` or `.env.local`, not an `apps/mobile/.env` file. See
[`../../.env.example`](../../.env.example).

## Development

For simulator, emulator, or Android phone development, boot or connect a device, then install the
native client that matches this checkout before starting Metro:

```bash
vp run mobile:install ios [simulator-udid]
# Or: vp run mobile:install android [emulator-or-phone-serial]
vp run dev:client
```

The device argument can be omitted when exactly one device is booted or connected. The helper
compares this checkout's Expo fingerprint and the installed binary with its last install record,
and reuses a matching client. Otherwise it installs the build for that fingerprint from
`~/.cache/t3code/native-clients/artifacts`, then the shared task cache, and builds only when
neither has it. One iOS simulator build serves every iPhone and iPad simulator, and one APK per
ABI (x86_64 or arm64-v8a) serves every emulator and phone of that ABI. Build output goes to the
log file it prints (`T3_NATIVE_CLIENT_VERBOSE=1` streams it instead). Builds are shared back when
your task-cache login (`bash infra/task-cache/install.sh`) can write. `T3_NATIVE_CLIENT_CACHE=read`
skips the upload and `off` skips the shared cache. Physical iPhones still use `vp run ios:dev`.

`--session <name>` installs into an agent-device session opened elsewhere, such as a device pool
or a cloud simulator, instead of a local device: `vp run mobile:install android --session pool-1
--metro http://<this-machine>:8081`. It uses only the cached build (x86_64 by default; `--abi`
for ARM) and fails with the next step when no machine has built this fingerprint yet.

For a read-only decision, run `node ../../scripts/mobile-native-client.ts check <ios|android>
[device]`: exit 0 means compatible, 2 means an install is needed, and 1 means an operational error.
An externally installed client is unverified until the helper installs it once.

Start Metro for an already verified dev client:

```bash
vp run dev:client
```

Metro keeps its transform cache between ordinary starts. If the cache itself is causing stale or
invalid output, clear it for one development-client start:

```bash
vp run dev:client:reset
```

Run that reset once after installing or changing the Uniwind dependency patch. Cached transforms
can otherwise reference its previous pnpm package path. Ordinary Metro starts still keep the cache.

Component edits use Fast Refresh. See [mobile development lifecycle](../../docs/internals/mobile-development.md)
before changing runtime ownership or refresh behavior.

Build and run the local iOS dev client:

```bash
vp run ios:dev
```

After changing a native dependency patch, rerun CocoaPods before rebuilding an existing iOS
project. pnpm gives each patch hash a new package path; Pods can otherwise keep compiling the
previous directory.

If your Xcode account only has a Personal Team, use a bundle identifier you control and opt into the
reduced-capability local build. Personal Team builds omit the widget and share extensions, push
entitlement, and native Sign in with Apple entitlement; builds without this opt-in are unchanged.

```bash
T3CODE_IOS_PERSONAL_TEAM=1 \
T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID=com.example.t3code.dev \
vp run ios:dev
```

Build and install a self-contained Release app that does not need Metro:

```bash
vp run ios:release
```

The Personal Team equivalent also needs a unique bundle identifier:

```bash
T3CODE_IOS_PERSONAL_TEAM=1 \
T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID=com.example.t3code \
vp run ios:release
```

Build and run the local iOS preview app:

```bash
vp run ios:preview
```

Inspect the resolved Expo config for a variant:

```bash
vp run config:dev
vp run config:preview
```

Run static checks for mobile native code:

```bash
node ../../scripts/mobile-native-static-check.ts
```

The native lint task runs SwiftLint for Swift plus ktlint and detekt for Kotlin. Missing native tools are reported as warnings and skipped locally. CI installs the default toolset from `apps/mobile/Brewfile` before running the native checks.

## EAS Builds

This fork uses [@jayleaton/t3-code-personal](https://expo.dev/accounts/jayleaton/projects/t3-code-personal)
for builds and OTA updates. Its bundle/package identifier is `com.jayleaton.t3code`, with `.dev`
and `.preview` suffixes for the corresponding variants. Release builds use Apple team `4RVGYA25L8` during
provisioning; the upstream Apple team and App Store Connect app binding are removed. TestFlight
submission requires your own App Store Connect app record.

Personal builds disable Clerk, Google sign-in, cloud accounts, and account-based T3 Connect.
They use the existing server's direct pairing and persist its credential in SecureStore. No
Clerk/relay environment variables are required, and inherited cloud config is ignored.

For a standalone TestFlight app with embedded JavaScript and no Metro dependency:

```bash
vp run eas:ios:testflight
vp run eas:submit:ios:testflight
```

The `personal-testflight` profile uses store distribution, the production bundle ID,
automatically incremented build numbers, and disabled OTA updates. Configure store provisioning
for your Apple team and your App Store Connect app/submit credentials first.

On the Mac running your existing T3 environment, generate a fresh reachable link with
`t3 pair --tailscale` (use `--base-dir` if that server uses a different T3 home). Connect the
phone to the same tailnet, open Environments → Add environment, scan the QR or paste the full
link into Host, then tap Add environment. Host and pairing code can also be entered separately.
A LAN IP works on the same network if the server's network access is enabled. Localhost does
not point to your Mac. Stop/restart the app to reconnect with the saved server credential;
Metro can remain off, but the T3 server must remain reachable.

Preview and production variants use Expo fingerprinting. Development clients below are for
contributor workflows, not the standalone personal install.

Create a PR preview dev-client build manually:

```bash
vp run eas:ios:preview:dev
```

Create a cloud dev-client build:

```bash
vp run eas:ios:dev
```

Create a persistent preview build:

```bash
vp run eas:ios:preview
```

Android equivalents:

```bash
vp run eas:android:dev
vp run eas:android:preview:dev
vp run eas:android:preview
```
