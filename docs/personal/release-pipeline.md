# Release pipeline: personal T3 Code mobile builds

> Ported 2026-07-25 from the (archived) planning repo [r4iju/t3-code](https://github.com/r4iju/t3-code);
> this copy is now the living runbook. Historical decision links below point at that repo's issues.

Spec for [issue #6](https://github.com/r4iju/t3-code/issues/6). Decisions settled on the
[wayfinder map](https://github.com/r4iju/t3-code/issues/1) on 2026-07-23: v1 is upstream's
`apps/mobile` as-is (#5), fork delta stays env/config-only with ad-hoc `upstream/main` merges (#8),
distribution is personal/internal only, connectivity is direct LAN only.

## Principles

- **The fork ships upstream's app; we ship the pipeline.** No feature delta, so the pipeline is the
  product of this effort.
- **Env/config-only delta.** Pipeline config lives in EAS environment variables, additive files, and
  this repo's docs — upstream files are edited only when unavoidable (e.g. if `app.config.ts` lacks
  an override hook for bundle identity).
- **decent-measure is the style reference, not a template to copy.** Where its choices fight the
  env/config-only rule (local credentials + fastlane), we deviate deliberately.

## Identity

- Own bundle/application ID per variant, own EAS project, own App Store Connect record — upstream's
  `com.t3tools.t3code.*` IDs stay untouched for clean upstream merges:
  - iOS/Android production: `com.raijustudios.t3code`
  - Development variant keeps upstream's dev ID locally (dev builds are never distributed).
- Apple team `C7X9BCC7LP` (same as decent-measure). App name on TestFlight: "T3 Code (personal)".
- Prefer setting identity via EAS env vars / `APP_VARIANT` hooks if upstream's `app.config.ts`
  supports it; otherwise a minimal, well-marked edit in `app.config.ts` (allowed "when unavoidable").

## Build & distribute

| Platform | Profile               | Output | Distribution                                    |
| -------- | --------------------- | ------ | ----------------------------------------------- |
| iOS      | upstream `production` | .ipa   | `eas submit` → **TestFlight internal**          |
| Android  | upstream `production` | .aab   | `eas submit` → **Google Play internal testing** |

> **Decision change (2026-07-23):** Android originally shipped as a preview APK via EAS internal
> link. Changed to match decent-measure: production AAB submitted to the Play internal testing
> track with the same Play service account (`barbellry-…json`). Requires a Play Console app record
> for `com.raijustudios.t3code` (manual — Play has no app-creation API) and the fork's
> `T3CODE_ANDROID_PACKAGE` env hook (upstream has no Android identity override).

- **EAS cloud is the default builder**; the free tier covers occasional personal builds.
  Local `eas build --local` is the documented fallback (needs Xcode 26.1+ — ticket #9 — and
  JDK 17 + `ANDROID_HOME`; see friction log on
  [issue #3](https://github.com/r4iju/t3-code/issues/3)).
- **Credentials: EAS-managed (remote)** for both platforms. This deviates from decent-measure's
  local-credentials + fastlane setup on purpose — remote credentials mean zero credential files in
  the fork, consistent with env/config-only. Submit credentials (ASC API key for iOS, Play service
  account key for Android, both shared with decent-measure) live in the gitignored
  `apps/mobile/credentials/` and are referenced by the `personal` submit profile — nothing secret
  is committed.
- **Versioning:** follow upstream's app version (their `appVersion` runtime policy); build numbers
  auto-increment via EAS remote version source.
- **T3 Connect env vars stay unset.** LAN-only scope; cloud UI stays disabled in our builds.

## Release ritual

```bash
cd ~/code/t3code
git fetch upstream && git merge upstream/main   # ad-hoc sync (#8)
cd apps/mobile
# T3CODE_EAS_OWNER / T3CODE_EAS_PROJECT_ID / T3CODE_ANDROID_PACKAGE env vars required locally
vp run eas:ios:prod                              # → .ipa
vp run eas:android:prod                          # → .aab
eas submit -p ios --latest --profile personal    # → TestFlight internal
eas submit -p android --latest --profile personal # → Play internal testing
```

No CI initially — releases are manual and occasional. If cadence grows, lift upstream's
fingerprint-based EAS workflow (`.github/workflows/mobile-eas-*.yml`) into the fork.

## Server operations (decided with the map)

The LAN server is the **desktop app with Settings → Connections → Network access toggled on**
(binds `0.0.0.0:3773`, stable port, built-in pairing QR). No launchd service, no headless `t3 serve`
for daily use. Device pairing management: `t3 auth` (`pairing create`, `session list/revoke`).
Pairing tokens expire in ~5 minutes — mint right before pairing a new device.

## Implementation checklist (post-map execution)

1. Create the App Store Connect app record for `com.raijustudios.t3code`.
2. `eas init` in the fork's `apps/mobile` against a personal EAS project; set EAS env vars/secrets
   (ASC API key; identity overrides if the env hook exists).
3. First iOS `production` build + submit; install from TestFlight.
4. Create the Play Console app record for `com.raijustudios.t3code` (manual); first Android
   `production` AAB build + submit to the internal testing track; install from Play.
5. Pair both against the desktop app's network endpoint (`http://<lan-ip>:3773`).
6. Verify local-build fallback once Xcode 26.1+ lands (#9).
