# T3 Dulli development

T3 Dulli is the `YJJosh/t3dulli` community fork of **T3 Code v0.1.10** (`7d32075e37`). It uses T3's native provider, subagent, schedule, usage, and MCP infrastructure. The retired Dulli provider, Pi extensions, Pi sessions, and Pi judge are not part of this fork. Upstream's own Pi provider remains available.

## Identity and coexistence

Build desktop artifacts with `--brand dulli`; omitting the flag retains upstream's desktop identity. `vp run dev` and the Portler preview set `VITE_DESKTOP_BUILD_BRAND=dulli`, so the web preview reads T3 Dulli (Dev); desktop dev keeps upstream's injected identity. The fork uses:

| Property                         | Value                                       |
| -------------------------------- | ------------------------------------------- |
| Product                          | T3 Dulli                                    |
| Application ID                   | `com.yjjosh.t3dulli`                        |
| Desktop distribution package     | `t3-dulli`                                  |
| npm package / command            | `@yjosh/t3` / `t3`                          |
| Linux executable / desktop entry | `t3-dulli-clean` / `t3-dulli-clean.desktop` |
| Linux WM class                   | `t3-dulli`                                  |
| Internal desktop origin          | `t3dulli://app/`                            |
| Desktop artifact prefix          | `T3-Dulli-`                                 |
| Updates                          | `YJJosh/t3dulli` prereleases                |
| Default T3 home                  | `~/.t3-dulli`                               |

The fork never claims upstream's `t3code://` callbacks. Its Chromium profile is `t3-dulli` under the platform's application-data directory, separate from upstream profiles. Its systemd service is `t3-dulli.service`, its launchd label is `com.yjjosh.t3dulli.service`, and its Windows task is `t3-dulli-<domain>-<user name>`. The npm CLI and desktop shim both use `t3`, matching the old fork. Choose which installation owns `t3` on PATH; the desktop installer refuses to replace a foreign command and only removes its own shim.

Existing fork userdata stays in `~/.t3-dulli/userdata`. `T3CODE_HOME` and `--base-dir` still override the home explicitly. Never test against either live `~/.t3/userdata` or `~/.t3-dulli/userdata`: copy read-only snapshots into the worktree's `.t3` instead. Dev uses isolated worktree state, not the installed application's data.

The server workspace retains the **private internal name `t3`** for upstream's build graph. The publishable npm manifest is generated as `@yjosh/t3`; do not publish `apps/server` directly. Release CLI archives retain upstream's `t3-<version>-<platform>-<arch>` filenames and inner `t3` executable because SSH, runtime installers, and Windows WSL consume that protocol.

## Artwork

Sources and generated icons live in `assets/dulli`. `logo.svg` is the full tile; `mark.svg` is the Android foreground/notification glyph. Regenerate with `bash scripts/dulli/generate-assets.sh` (ImageMagick required). The macOS icon has transparent margins around the squircle; preserve them so macOS does not add a light compatibility tile. The desktop build stages the platform icons and all six web/PWA icon sizes. Dulli's installer background is in `apps/desktop/resources/dmg/dmg-background-dulli.svg`.

## Building

Use the Node version pinned in root `package.json` (26.13.1 for this baseline), then `vp i`. See [development](operations/development.md) for the upstream toolchain and native prerequisites.

```sh
vp run dist:dulli:desktop --platform mac --target dmg --arch arm64 --build-version 0.1.10-dulli.1
vp run dist:dulli:desktop --platform linux --target AppImage --arch x64 --build-version 0.1.10-dulli.1
vp run dist:dulli:desktop --platform win --target nsis --arch x64 --build-version 0.1.10-dulli.1
```

Without `--signed`, macOS builds do not need Apple signing secrets. For a local ad-hoc build, set `T3CODE_MACOS_COMMUNITY_SIGNING_IDENTITY=-`; `CSC_IDENTITY_AUTO_DISCOVERY=false` leaves only Electron's linker signature, which fails `codesign --verify`. The same variable selects a persistent community certificate; it signs without Apple's restricted passkey entitlements or notarization. Do not change an installed release's signing identity casually: macOS validates the next update against it.

Build the CLI's web client with `VITE_DESKTOP_BUILD_BRAND=dulli`, then run `node apps/server/scripts/cli.ts build --brand dulli`. Build native executables with `node apps/server/scripts/cli.ts build-exe`; assemble their runtime dependencies with `scripts/build-cli-archive.ts`. The upstream archive builder preserves executable permissions and stages only runtime externals. Use `node scripts/build-npm-launcher.ts --version 0.1.10-dulli.1 --output-dir npm-packages` to generate `yjosh-t3.tgz`. This launcher downloads and checksum-verifies the matching GitHub archive; it is not the old JavaScript-only npm bundle.

## Releases and channels

Dispatch **T3 Dulli Release** (`.github/workflows/fork-desktop-release.yml`) with an explicit `0.<minor>.<patch>-dulli.<build>` version. No scheduled or tag-triggered fork publication occurs. The workflow:

- validates the version and Android versionCode bounds, and generates notes since the previous Dulli tag rather than an upstream tag;
- runs typecheck and release integration tests, including the server GitVcsDriver and packaged Workler suites, before any artifact build or publication;
- builds desktop installers, a signed Android APK, and native CLI archives on runners of each supported CLI architecture;
- publishes a GitHub **prerelease** with updater manifests and `SHA256SUMS`, then publishes the `@yjosh/t3` npm launcher with the `latest` npm tag using OIDC provenance.

Desktop's normal Latest track reads the `dulli` prerelease feed. The old same-base `-pi.N` to `-dulli.N` handoff is retired; v0.1.10 is a normal forward version upgrade. Upstream release, AUR, EAS/store/OTA, web-preview, Android-mirror, and relay publishing workflows are manual-only and repository-guarded so they cannot deploy from this fork. CI runs on GitHub-hosted runners.

Repository setup required before publication:

- npm trusted publisher for **`@yjosh/t3`**, repository `YJJosh/t3dulli`, workflow `fork-desktop-release.yml`. The repository was renamed from `YJJosh/t3code`; the trusted publisher must name the new repository, or the npm publish step fails.
- Secrets `DULLI_MACOS_CERTIFICATE_P12_BASE64` and `DULLI_MACOS_CERTIFICATE_PASSWORD`, plus variable `DULLI_MACOS_CERTIFICATE_SHA1`, for the persistent macOS community identity. The workflow handles RC2 PKCS#12 files on OpenSSL 3 and imports trust noninteractively on the ephemeral runner.
- Java 21 and the Android SDK/NDK selected by Expo SDK 58 / React Native 0.88.1 for APK builds. Both clean Expo prebuild and Gradle inherit all four `T3CODE_ANDROID_RELEASE_*` settings through the job environment; for v0.1.10, Android versionCode is `10,100,000 + build`.
- Secrets `DULLI_ANDROID_KEYSTORE_BASE64`, `DULLI_ANDROID_KEYSTORE_PASSWORD`, `DULLI_ANDROID_KEY_ALIAS`, and `DULLI_ANDROID_KEY_PASSWORD`, plus variable `DULLI_ANDROID_CERT_SHA256`. Keep the same Android key to upgrade existing installs. APK identity and signer fingerprint are verified before publication.

The repository was called `YJJosh/t3code` up to v0.1.9-dulli.3. GitHub redirects the old name, so installs from those releases still find updates and downloads under `YJJosh/t3dulli`. Never create a new repository named `YJJosh/t3code`: that breaks the redirect for every older install.

macOS community builds are not notarized: first launch may require **System Settings → Privacy & Security → Open Anyway**. Windows builds are unsigned and can trigger SmartScreen. Android APKs are sideloaded and have no upstream OTA channel; install newer APKs manually. Only approve artifacts you trust.

## Portler local development

If Portler is installed and `portler.yml` is present, use the repository's Portler configuration to expose the local dev origin. Portler manages local routing; it is not T3 Connect or a production relay deployment. Start the normal worktree dev command and use the origin reported by Portler. Never set `VITE_HTTP_URL` or `VITE_WS_URL`: Vite's same-origin proxies must remain responsible for API, WebSocket, and OAuth traffic. Without Portler, use the origin printed by `vp run dev`; for remote access use `vp run dev --share` and its fresh pairing URL.

## Fork database migrations

Fork migrations belong in `apps/server/src/persistence/Migrations/dulli/` and the fork's separate migration ledger. Never allocate an ID in upstream's numbered sequence for a fork feature. Keep the upstream sequence intact so later upstream upgrades remain unambiguous. The upgrade moves retired Dulli-provider threads to the Pi provider and archives Dulli-only data in `dulli_archived_*` tables; there is no Dulli provider compatibility bridge. Back up state read-only before testing upgrades, and run only against a sandbox copy.

## Fork features

- **Workler workspaces and multi-repo projects:** fork workspace selection and repository grouping (workstream C).
- **Agent terminals:** grouped thread terminals that the user and agent take turns controlling (workstream D).
- **1Password agent vaults:** per-vault allowed or denied agent access, with no approval mode (workstream E).
- **Profiles:** reusable prompt parts, skills and provider settings from a folder the app copies between environments (workstream F).
