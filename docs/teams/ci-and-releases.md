# Fork CI & Release Process

This document explains how CI and releases work on the T3 Code Teams fork while staying as close as possible to upstream's release architecture ([03_release.md](../operations/03_release.md)) and keeping merges from `upstream/main` low-conflict.

---

## 1. Workflow isolation strategy

To avoid recurring merge conflicts in upstream's large workflow files (`.github/workflows/ci.yml` and `.github/workflows/release.yml`), we leave upstream workflows untouched and maintain two dedicated fork workflows:

- **[`.github/workflows/teams-ci.yml`](../../.github/workflows/teams-ci.yml)** — Fork CI on standard GitHub-hosted runners (`ubuntu-24.04`), running lint, typecheck, desktop/CLI build, unit/web/server tests, Rust checks, release smoke tests, and (once configured in Milestone 1) the multi-member `test_teams_e2e` suite.
- **[`.github/workflows/teams-release.yml`](../../.github/workflows/teams-release.yml)** — Fork release pipeline mirroring upstream's exact release graph:
  1. `resolve_commit` & `preflight` (reuses upstream's `.github/scripts/check-nightly-release.cjs` and `scripts/resolve-nightly-release.ts`).
  2. `quality`, `test`, `test_web`, `test_server` (skippable on `preview` dispatch with `skip_tests=true`).
  3. `build_bundle` (builds server/web/Electron JS bundle once, reading public relay config from repo `vars.*` or falling back to `.env.example`).
  4. **Direct reuse of upstream's [`.github/workflows/release-desktop.yml`](../../.github/workflows/release-desktop.yml)** for all 6 platform targets (`macOS arm64`, `macOS x64`, `Linux x64`, `Linux arm64`, `Windows x64`, `Windows arm64`) on standard GitHub-hosted runners (`macos-15`, `ubuntu-24.04`, `ubuntu-24.04-arm`, `windows-2025`, `windows-11-arm`) with `relay_client_tracing: false`.
  5. `release` — publishes CLI archives (`t3-*.tar.gz` / `t3-*.zip`), `SHA256SUMS`, desktop installers (`.dmg`, `.AppImage`, `.deb`, `.exe`), and merged updater manifests (`latest*.yml` / `nightly*.yml`).
  6. `update_feed` — maintains the `update-feed` release (`nightly.json`) for nightly desktop auto-updates.
  7. `finalize` *(optional)* — bumps package versions on `main` after a stable release.

### Disabling upstream-only workflows in GitHub Actions

In the fork's GitHub UI (**Actions → Workflows**), disable upstream workflows that target `pingdotgg`'s private infrastructure or Blacksmith runners:
- `ci.yml`, `release.yml`, `deploy-relay.yml`, `relay-preview*.yml`, `desktop-macos-preview*.yml`, `web-preview.yml`, `publish-aur.yml`, `pr-vouch.yml`, `issue-vouch.yml`, `pr-limits.yml`, `pr-size.yml`, `mobile-*.yml`.

Because `teams-ci.yml` and `teams-release.yml` carry `github.repository != 'pingdotgg/t3code'`, they run exclusively on the fork.

---

## 2. Code references to override for self-update

`scripts/build-desktop-artifact.ts` already reads `GITHUB_REPOSITORY` (or `T3CODE_DESKTOP_UPDATE_REPOSITORY`) when generating `electron-updater` config, so packaged desktop apps automatically check the fork's GitHub Releases.

However, the following places still default to `pingdotgg/t3code` and must be pointed at the fork's repository (e.g., via a shared build-time/runtime constant `T3CODE_RELEASE_REPOSITORY`) before cutting the first production release so servers do not self-update back to upstream:

| File | What it controls |
| --- | --- |
| [`packages/shared/src/cliRelease.ts`](../../packages/shared/src/cliRelease.ts) | **Critical:** Server/CLI self-update archive URLs and GitHub Releases API checks |
| [`apps/web/src/components/desktopUpdate.logic.ts`](../../apps/web/src/components/desktopUpdate.logic.ts) | Fallback release repository in the web update UI |
| [`apps/desktop/src/app/DesktopStartupRecovery.ts`](../../apps/desktop/src/app/DesktopStartupRecovery.ts) | "Open releases" recovery link |
| [`scripts/install.sh`](../../scripts/install.sh) & [`scripts/install.ps1`](../../scripts/install.ps1) | Curl/PowerShell CLI installer repository |
| [`scripts/npm-launcher/t3.mjs`](../../scripts/npm-launcher/t3.mjs) & [`scripts/build-npm-launcher.ts`](../../scripts/build-npm-launcher.ts) | Only needed if publishing a scoped npm launcher (e.g. `@your-org/t3`) |

---

## 3. Secrets & Variables Reference

### Zero-secret bootstrap (works out of the box)

No external secrets are required to cut working `preview`, `nightly`, or `stable` releases with `teams-release.yml` — only the built-in `GITHUB_TOKEN`.
- **Linux** (AppImage, `.deb`, CLI archives, server self-update): works 100% with no signing certificates.
- **macOS & Windows**: installers and CLI archives build and run, with ad-hoc/unsigned binaries (macOS Gatekeeper / Windows SmartScreen warnings apply, and macOS `electron-updater` requires a signed+notarized build to auto-install updates).

### Optional Signing Secrets (for seamless desktop auto-updates & zero OS warnings)

Because `teams-release.yml` forwards `secrets: inherit` to upstream's `release-desktop.yml`, adding these secrets activates full code signing with **zero workflow edits**:

#### macOS (Apple Developer Program — $99/year)
- **`CSC_LINK`**: Base64-encoded `.p12` **Developer ID Application** certificate exported from macOS Keychain. Used by `electron-builder` and macOS `codesign` to sign the `.app`, `.dmg`, and CLI binary so macOS trusts the publisher and `electron-updater` can apply updates automatically.
- **`CSC_KEY_PASSWORD`**: Passphrase that unlocks the `.p12` file in `CSC_LINK`.
- **`APPLE_API_KEY`**, **`APPLE_API_KEY_ID`**, **`APPLE_API_ISSUER`**: App Store Connect API key (`.p8` contents, Key ID, Issuer UUID) used for **Apple Notarization** (`notarytool`) so macOS Gatekeeper lets users open the `.dmg` without "damaged / unidentified developer" warnings.
- **`MACOS_PROVISIONING_PROFILE`** *(optional)* & repo var **`APPLE_TEAM_ID`**: Only needed if enabling Apple Passkey / Associated Domains entitlements.

#### Windows (Microsoft Azure Trusted Signing)
- **`AZURE_TENANT_ID`**, **`AZURE_CLIENT_ID`**, **`AZURE_CLIENT_SECRET`**: Microsoft Entra ID service principal credentials authenticating CI to Azure.
- **`AZURE_TRUSTED_SIGNING_ENDPOINT`**: Regional Trusted Signing endpoint URL (e.g., `https://eus.codesigning.azure.net`).
- **`AZURE_TRUSTED_SIGNING_ACCOUNT_NAME`**: Name of your Azure Trusted Signing account.
- **`AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME`**: Certificate profile name configured in Azure Trusted Signing.
- **`AZURE_TRUSTED_SIGNING_PUBLISHER_NAME`**: Exact publisher subject name (`CN=...`) matching the signing certificate.
- Together, these sign the Windows `.exe` installer and binaries via Azure Trusted Signing so Windows SmartScreen trusts the installer and `electron-updater` can verify signatures.

### Optional Repository Variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `ENABLE_NIGHTLY_SCHEDULE` | unset (`false`) | Set to `true` to enable daily scheduled nightlies (`03:18 UTC`). |
| `PAUSE_NIGHTLY` | unset (`false`) | Set to `true` to temporarily pause scheduled nightlies. |
| `ENABLE_VERSION_BUMP` | unset (`false`) | Set to `true` to let `finalize` commit stable version bumps to `main` via `GITHUB_TOKEN` (or configure `RELEASE_APP_ID` + `RELEASE_APP_PRIVATE_KEY` for protected branches). |
| `T3CODE_RELAY_URL`, `CLERK_*` | `.env.example` | Override only if hosting your own T3 Connect relay & Clerk instance. |
| `OPENAI_API_KEY` *(secret)* | unset | Optional AI-summarized release notes; falls back to GitHub's native generated release notes when unset. |

---

## 4. Tagging & Upstream Merge Hygiene

1. **Never import upstream tags into your fork:**
   ```sh
   git config remote.upstream.tagOpt --no-tags
   ```
   This guarantees upstream `vX.Y.Z` tags never collide with your fork's own release tags or push your nightlies out of `releases.atom`.
2. **Cutting a release on the fork:**
   - **Test build (safe draft):** Actions → **Teams Release** → `channel=preview` (optionally `skip_tests=true`).
   - **Nightly:** Actions → **Teams Release** → `channel=nightly` on `main`.
   - **Stable:** Actions → **Teams Release** → `channel=stable` on `main` (leave `version` empty to promote the latest nightly, or specify e.g. `0.2.0`), or push a tag `git tag v0.2.0 && git push origin v0.2.0`.
3. **Never delete the `update-feed` release** once created—nightly desktop clients read `nightly.json` from it.
