# Native Android release readiness

This is the authoritative closeout record for the independent native Android client. The phase documents remain historical implementation evidence; this document describes the current product.

## Status

- App version: `0.7.0` (`versionCode` 2).
- Application id: `com.t3tools.t3code.native.experimental`.
- Minimum Android version: API 26; target API: 35.
- The existing application id is retained so local app data, deep links, shortcuts, and the Clerk redirect identity remain stable.

## Automated gate

Run from `apps/android-native`:

```bash
./gradlew :protocol:test :app:testDebugUnitTest :app:assembleDebug
```

This covers protocol fixtures and reducers, native app behavior, adaptive layout rules, and debug APK assembly. `git diff --check` and local Markdown-link validation complete the closeout gate.

Android Lint is not part of this gate because the pinned toolchain crashes while initializing its own `InferredThreadDetector`. Gradle also reports that the project must eventually migrate to AGP built-in Kotlin. Both are tracked tooling maintenance; neither is an application diagnostic. Do not suppress or misreport the lint crash as a clean result.

## Accepted device behavior

The current build has been exercised on a Samsung S25 Ultra, including a resizable Samsung DeX window:

- Compact phone navigation and composers work with gesture navigation and the software keyboard.
- At 720 dp by 600 dp or larger, Home becomes a persistent thread sidebar.
- The sidebar remains present through thread, files, Git, terminal, and review screens.
- Selecting another thread replaces the detail destination and highlights the selected row.
- Resizing between compact and split layouts preserves the selected thread and draft state.
- Settings and onboarding intentionally use the full window.

Physical-device instrumentation is not part of routine acceptance because persistence tests clear application data. The user performs interactive phone and DeX acceptance; installation may use `adb install -r` without driving the UI.

## External gates

- Production Clerk must allowlist `clerk://com.t3tools.t3code.native.experimental.callback` before Google/OAuth and T3 Connect can be accepted end to end.
- Production signing and Play Store automation are not configured for this independent APK.
- The client targets the matching T3 server revision; compatibility with arbitrary historical servers is not promised without versioned wire artifacts.

## Intentional boundaries

The client does not include camera capture, document or video attachments, direct share-to-existing-thread, workspace file editing, notification actions, widgets, or iOS Live Activities. These are product boundaries, not release blockers.

## Deferred maintenance

- Migrate the Gradle modules to AGP built-in Kotlin and remove the legacy DSL flags.
- Repair or upgrade the Android Lint toolchain after reproducing the detector crash in isolation.
- Add production signing/store delivery only when this APK becomes a distribution target.
- Revisit long-thread performance only with the documented release-build trace and a representative sustained-streaming fixture.
