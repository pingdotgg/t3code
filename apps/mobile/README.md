# T3 Code Mobile

> [!WARNING]
> T3 Code Mobile is currently in development and is not distributed yet. If you want to try it out, you can build it from source.

## Quickstart

> [!NOTE]
> Uses native modules so using Expo Go is not supported. You need to use the Expo Dev Client.

This app has three variants:

- `development`: Expo dev client, installable side-by-side as `T3 Code Dev`
- `preview`: persistent internal preview build, installable side-by-side as `T3 Code Preview`
- `production`: store/release build as `T3 Code`

Run commands from `apps/mobile`.

T3 Connect is optional and disabled in a fresh clone. Public configuration belongs in the
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

### Android

Local Android builds need **JDK 17+** and the **Android SDK** (`platform-tools`, build-tools, and at
least one platform image). The `android:*` scripts resolve `JAVA_HOME` and `ANDROID_HOME` via
[`scripts/with-android-env.mjs`](scripts/with-android-env.mjs) when they are unset — typical
locations are `/usr/lib/jvm/java-21-openjdk` and `~/Android/Sdk`.

FCM push requires a dev-client binary signed with Firebase config. Before the first prebuild, place
`google-services.json` for your variant (or use the CI stub for builds that do not exercise push):

```bash
mkdir -p apps/mobile/secrets
cp ~/Downloads/google-services.json apps/mobile/secrets/google-services.development.json
```

See [`docs/FIREBASE-ANDROID.md`](docs/FIREBASE-ANDROID.md) for variant package names and EAS secrets.
For tier-0 defaults, native module status, and verification gates, see
[`docs/ANDROID-PARITY.md`](docs/ANDROID-PARITY.md).

Build and run the local Android dev client (prebuilds `android/`, then installs on a connected device
or booted emulator):

```bash
vp run android:dev
```

Other local variants:

```bash
vp run android:preview
vp run android:prod
```

Start Metro for an already-installed dev client:

```bash
APP_VARIANT=development vp run dev:client
```

Run Maestro smoke flows on a booted emulator (builds, installs, and drives the dev client):

```bash
./scripts/android-parity/run-maestro-android.sh
```

The harness uses a stub `google-services.json` when `apps/mobile/secrets/google-services.development.json`
is missing. Set `GOOGLE_SERVICES_JSON` to override. Optional `smoke-agent-push` runs when
`RELAY_STAGING_URL` and `RELAY_STAGING_TEST_SECRET` are set.

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
