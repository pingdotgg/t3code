# Android parity

T3 Code Mobile ships a full Android dev client alongside iOS. Android currently targets
**tier-0 parity**: every core flow works via JS or cross-platform native fallbacks, while
iOS-only modules remain available on Apple platforms.

## Tier-0 defaults

Resolved at build time in `src/platform/capabilities.ts`:

| Surface     | Android default               | iOS default                  |
| ----------- | ----------------------------- | ---------------------------- |
| Review diff | JS list + highlighter         | Native `T3ReviewDiffSurface` |
| Markdown    | Nitro markdown                | Native selectable markdown   |
| Terminal    | WebView xterm                 | Native `T3TerminalView`      |
| Composer    | Strip chip mode (`TextInput`) | Native `T3ComposerEditor`    |

Override locally via repository-root `.env` / `.env.local` (see [`.env.example`](../../../.env.example)):

```bash
EXPO_PUBLIC_FORCE_JS_REVIEW=1          # force JS review (Android dogfood default in CI)
EXPO_PUBLIC_FORCE_NITRO_MARKDOWN=1     # force Nitro markdown
EXPO_PUBLIC_TERMINAL_WEBVIEW=1         # force WebView terminal (Android default when unset)
EXPO_PUBLIC_TERMINAL_WEBVIEW=0         # opt into native terminal on Android
EXPO_PUBLIC_COMPOSER_CHIP_MODE=strip   # force strip composer chips
```

## Native modules

| Module               | Android         | Notes                                               |
| -------------------- | --------------- | --------------------------------------------------- |
| `t3-native-controls` | Yes             | Hardware keyboard shortcuts                         |
| `t3-terminal`        | Yes             | Built; WebView is the default surface on Android    |
| `t3-composer-editor` | No              | iOS only — Android uses `expo-paste-input` fallback |
| `t3-review-diff`     | No              | iOS only — Android uses JS review screen            |
| `t3-markdown-text`   | No (selectable) | Nitro markdown covers Android rendering             |

Android-specific product features:

- Thread accessory bar (phone + tablet rail layouts)
- Ongoing agent notification + FCM push registration
- Predictive back + edge-to-edge insets (SDK 35+)
- Variant adaptive-icon background colors (dev / preview / production)

iOS-only features without Android equivalents:

- Live Activity + home-screen widget (`expo-widgets`)
- Liquid glass / native mail-search toolbar chrome

## Build and run

See [README.md](../README.md#android) for local prerequisites, `vp run android:dev`, and Maestro smoke.

Key build wiring:

- `scripts/with-android-env.mjs` — resolves `JAVA_HOME` / `ANDROID_HOME`, writes `local.properties`
- `plugins/withAndroidBuildFixes.cjs` — expo-dev-client Gradle ordering + SDK path
- `plugins/withAndroidCleartextTraffic.cjs` — HTTP for tailnet / local relay
- `plugins/withAndroidGoogleServices.cjs` — fails prebuild with a clear message when FCM config is missing

FCM setup: [FIREBASE-ANDROID.md](./FIREBASE-ANDROID.md).

## Verification

Per-PR gate (local):

```bash
scripts/android-parity/gate.sh          # full
scripts/android-parity/gate.sh --quick  # check + typecheck only
```

Maestro smoke (booted emulator):

```bash
./scripts/android-parity/run-maestro-android.sh
```

CI (`/.github/workflows/mobile-qa.yml`):

- `expo-doctor`
- Mobile unit tests with `EXPO_PUBLIC_FORCE_JS_REVIEW=1` and `EXPO_PUBLIC_FORCE_NITRO_MARKDOWN=1`
- Maestro Android smoke on API 34 emulator (**blocking**)

Review perf proxy gate: `src/features/review/reviewPerfGate.test.ts` (REV-007 thresholds).

## Remaining gaps (priority)

1. **Native composer** — port `t3-composer-editor` for inline tokens and rich paste on Android
2. **Native review** — port or further optimize JS review for large diffs
3. **Secondary chrome** — continue aligning Android header toolbars with iOS mail-search patterns
4. **Variant launcher art** — distinct foreground icons per variant (background colors exist today)
5. **Store readiness** — production cleartext / signing / Play internal track validation
