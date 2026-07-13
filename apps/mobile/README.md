# SurgeCode Mobile

> [!WARNING]
> SurgeCode Mobile is currently in development and is not distributed yet. If you want to try it out, you can build it from source.

## Quickstart

> [!NOTE]
> Uses native modules so using Expo Go is not supported. You need to use the Expo Dev Client.

This app has three variants:

- `development`: Expo dev client, installable side-by-side as `SurgeCode Dev`
- `preview`: persistent internal preview build, installable side-by-side as `SurgeCode Preview`
- `production`: store/release build as `SurgeCode`

Run commands from `apps/mobile`.

Cloud access is optional and disabled in a fresh clone. Public configuration belongs in the
repository-root `.env` or `.env.local`, not an `apps/mobile/.env` file. See
[`../../.env.example`](../../.env.example).

## Development

Start Metro for the dev client:

```bash
vp run dev:client
```

Build and run the local iOS dev client:

```bash
vp run ios:dev
```

Build and run the local iOS preview app:

```bash
vp run ios:preview
```

Force the review diff highlighter engine:

```bash
EXPO_PUBLIC_REVIEW_HIGHLIGHTER_ENGINE=javascript vp run ios:dev
```

`javascript` is the default and recommended setting for the review diff screen. Set `EXPO_PUBLIC_REVIEW_HIGHLIGHTER_ENGINE=native` only when you explicitly want to test the native Shiki engine.

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

## Installing on a device with a free Apple ID

Local device installs without T3 Tools team membership: sign in to Xcode with
your Apple ID (Personal Team), find your team ID in Xcode → Settings →
Accounts, then build with personal signing (device UDID from
`xcrun devicectl list devices`):

```bash
export SERGECODE_PERSONAL_SIGNING=1 SERGECODE_PERSONAL_TEAM_ID=<your-team-id>
export UDID=<device-udid>
APP_VARIANT=development EXPO_NO_GIT_STATUS=1 \
  npx expo prebuild --clean --platform ios --no-install
cd ios && pod install && xcodebuild -workspace SurgeCodeDev.xcworkspace \
  -scheme SurgeCodeDev -configuration Debug -destination "id=$UDID" \
  -allowProvisioningUpdates -allowProvisioningDeviceRegistration \
  -derivedDataPath build build
xcrun devicectl device install app --device "$UDID" \
  build/Build/Products/Debug-iphoneos/SurgeCodeDev.app
xcrun devicectl device process launch --device "$UDID" \
  "dev.$(echo "$SERGECODE_PERSONAL_TEAM_ID" | tr '[:upper:]' '[:lower:]').sergecode.development"
```

Then start Metro (`APP_VARIANT=development npx expo start --dev-client`) and
pick the server in the dev launcher on the phone (same WiFi).

This signs with your Personal Team, derives a per-team bundle id
(`dev.<teamid>.sergecode.development`, override with
`SERGECODE_PERSONAL_BUNDLE_ID`), and drops what free accounts cannot sign:
the widgets extension, app groups, push, Sign in with Apple, and associated
domains. Signatures expire after 7 days — rebuild to refresh. Trust the
developer profile on the phone (Settings → General → VPN & Device Management)
on first launch. The mode refuses to run for EAS builds or any
`APP_VARIANT` other than `development`.

## Alpine scenery (Unsplash)

The app's Dolomites scenery (thread thumbnails, chat wallpaper, daily hero) is
fetched from Unsplash at runtime using a public read-only access key delivered
at build time. Without a key everything degrades to the deterministic gradient
washes — nothing breaks.

- Local builds: set `EXPO_PUBLIC_UNSPLASH_ACCESS_KEY` in the repository-root
  `.env.local` (never commit it; see `../../.env.example`).
- EAS builds: `eas env:create --scope project --name EXPO_PUBLIC_UNSPLASH_ACCESS_KEY`
  per environment.

The key is embedded in the JS bundle (standard for `EXPO_PUBLIC_*` values), so
only use a public Unsplash _access_ key — never the secret key. Attribution
pills and the download-location ping required by the Unsplash guidelines are
handled by `src/features/scenery/`.

## Connecting from your phone (Tailscale / LAN)

The gateway already supports remote clients. On the machine running SergeCode:

```bash
t3 serve --host "$(tailscale ip -4)"   # or: t3 serve --tailscale-serve
```

The server prints a pairing URL and QR code. In the app: **Connections → New →
scan the QR** (or paste the pairing URL). The phone exchanges the one-time
token for a scoped bearer credential and connects over `wss://…/ws`. See
[`docs/user/remote-access.md`](../../docs/user/remote-access.md). Adding
_projects_ remotely is not supported yet — create them on the host with
`t3 project`; thread creation and management work from the phone.

## EAS Builds

CI uses Expo fingerprinting with the `preview:dev` profile to reuse an existing compatible build when possible, or start a new internal EAS build when native runtime inputs change. Production and default local builds continue to use the `appVersion` runtime policy.

For preview or production EAS environments, set `T3CODE_CLERK_PUBLISHABLE_KEY`,
`T3CODE_CLERK_JWT_TEMPLATE`, and `T3CODE_RELAY_URL`
as EAS environment variables. Expo config maps the canonical values into the mobile build.

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
