# Release Checklist

> For maintainers. Using T3 Code? See [docs/user](../user/).

This document covers the Jarvis release coordinator. The upstream T3 release graph is retained
below as a disabled reference only; it is not a second Jarvis release path.

## Voice release scope

The stabilized Full GUI voice path for Windows/Linux x64 uses one Electron runtime, an isolated
Node-mode worker, local Parakeet, and the exact shared `node-cpal` `0.1.1` capture implementation.
Full does not embed or launch Companion. `uiohook` supplies true `Ctrl+Shift+J` hold-to-talk;
Electron `globalShortcut` is an explicit tap-toggle fallback when the native hook is unavailable.
The product-owned Rust microphone path is not a production release path. Headless artifacts have
no voice capability. macOS Full packages the same local Parakeet/Pocket resources but uses the
Chromium media-capture adapter; it does not stage `node-cpal`, `uiohook`, or the retired Rust
microphone package.

CI, synthetic tests, and package smoke tests validate wiring, worker/resources, and package
topology only. The deterministic Chromium fake-media/AudioWorklet hook proves capture framing,
release/cancel, and renderer teardown; the packaged smoke proves the preload/worker entries but
cannot validate physical hardware, OS microphone permissions, or device routing. Windows/Linux
x64 and macOS release candidates require a short real-device
acceptance pass, including hidden-window capture and ordered shutdown/quit.

## Jarvis core release (staging first)

The Jarvis desktop macOS arm64/x64 DMG artifacts, Windows setup, and headless artifacts are
released together by
`.github/workflows/jarvis-release.yml`. Dispatch it manually from the current `main` branch with
the exact `X.Y.Z` version in both `apps/desktop/package.json` and `apps/server/package.json`. The
optional Companion is built in parallel at its own `apps/companion/package.json` version and is
staged into this same release; it is not installed beside Full, which already includes UI,
execution, and voice.
The published release body includes the install matrix, optional Companion guidance, and checksum/
provenance verification instructions for these artifacts.
The unified release also carries Companion's updater metadata, `latest.yml` and `latest-linux.yml`;
those manifests belong to Companion and are not used by Jarvis Full.

The coordinator first verifies the dispatch ref, `origin/main` commit, Full package versions,
independent Companion version, and channel tag identity, then runs the five reusable build workflows
in parallel. Choose `stable` (the default)
for a signed production release or `preview` for an unsigned GitHub prerelease. Preview tags are
deterministic for a workflow run: `vX.Y.Z-preview.<run_number>`, and are never marked latest.
Stable tags remain `vX.Y.Z` and are marked latest. The staged release transaction owns draft recovery,
asset upload, remote audit, and publication by immutable release ID. Component workflows support
`workflow_call` and manual debugging only; they do not respond to stable tags or mutate GitHub
Releases.

The coordinator passes `public_release: true` only for stable builds. Stable gates run before
dependency installation and require complete Windows and base Apple signing/notarization
credentials; an incomplete set fails immediately. Stable is also currently fail-closed because
Companion's Windows artifact is unsigned. Preview builds pass `public_release: false`, skip
those credential preflights, publish an explicit unsigned warning in the prerelease body, and are
never latest. Manual component `workflow_dispatch` runs also default to `public_release: false`, so
they can produce unsigned debug builds for packaging, resource, and startup verification. Public Windows builds
pass `--signed` to the desktop artifact builder, sign the outer setup, and verify Authenticode
status and the configured publisher on both the setup executable and the installed
`desktop\\Jarvis.exe` before upload. Public macOS builds similarly require signed/stapled output.

Before any release mutation, the coordinator downloads the exact Actions artifacts, restores the
`Jarvis-Setup.exe` alias, checks the exact filename set, SHA-256 sidecars, provenance versions,
provenance source commit, and artifact digests, then writes `SHA256SUMS`. Only after those checks
does the single promotion job create or reuse a draft release targeting the dispatch commit. A
retry reconciles that draft by immutable release ID: it retains an existing asset only when its
name, size, and `sha256:` digest exactly match one staged local asset; it deletes unexpected,
mismatched, and duplicate assets, then uploads only missing assets. The remote asset set is audited
exactly before publication and again after publication. A failed promotion must
leave a draft release for repair; do not delete it or create a stable tag manually.

Release checklist:

1. Confirm `main` contains the intended package versions, including the independent Companion
   version. For `stable`, confirm the complete Apple
   signing/notarization and Azure Trusted Signing secret sets are present. The optional macOS
   passkey configuration is an all-or-none set and is not required for a Tailscale-first release.
   Dispatch the coordinator with the exact version and `channel=stable` or `channel=preview`.
2. Wait for all five build jobs and the local staging verifier to pass. The macOS jobs use native
   GitHub-hosted runners: arm64 uses `macos-15` and x64 uses `macos-15-intel`. They produce both
   arm64 and x64 DMG artifacts and fail closed if the target architecture does not match the
   runner. Do not copy upstream-only private runner labels into a fork.
3. If promotion fails, inspect the retained draft and rerun the same coordinator after correcting
   the cause. An unpublished draft may be retargeted by that retry when no existing tag points at a
   different commit; published releases and conflicting tags remain immutable. Never upload assets
   from a component workflow directly.
4. After publication, confirm the release contains the verified asset set plus `SHA256SUMS`. Stable
   releases are latest; preview releases are prereleases and must remain non-latest and visibly
   marked unsigned.

## Headless Node release

The dedicated `.github/workflows/headless-node-release.yml` workflow builds the Linux headless
archive, checksum, and provenance sidecars from the requested version in
`apps/server/package.json`. It supports reusable `workflow_call` and manual `workflow_dispatch`
invocations only; it has no stable tag trigger and never publishes a GitHub Release itself. The
Jarvis core coordinator downloads its verified 14-day Actions artifacts and owns the draft and
publication steps described above.

## Disabled upstream T3 release workflow (reference only)

The following sections describe the upstream `.github/workflows/release.yml` graph from T3 Code.
That workflow is disabled for this fork and must not be used to publish Jarvis artifacts. Jarvis
releases use only `.github/workflows/jarvis-release.yml` and its reusable component workflows above.

- Workflow: `.github/workflows/release.yml`
- Triggers:
  - push tag matching `v*.*.*` for stable releases
  - scheduled nightly check every three hours
  - manual `workflow_dispatch` for either channel
- Runs lint, typecheck, and tests alongside artifact builds. Publishing waits for every check.
- Reads the shared production T3 Connect relay URL and Clerk client configuration before packaging clients.
- Builds four artifacts in parallel for both channels:
  - macOS `arm64` DMG
  - macOS `x64` DMG
  - Linux `x64` AppImage
  - Windows `x64` NSIS installer
- Publishes one GitHub Release with all produced files.
  - Stable tags with a suffix after `X.Y.Z` (for example `1.2.3-alpha.1`) are published as GitHub prereleases.
  - Only plain stable `X.Y.Z` releases are marked as the repository's latest release.
  - Nightly runs are always GitHub prereleases and never marked latest.
  - Automatically generated release notes are pinned to the previous tag in the same channel, so stable compares to the previous stable tag and nightly compares to the previous nightly tag.
- Includes Electron auto-update metadata (for example `latest*.yml`, `nightly*.yml`, and `*.blockmap`) in release assets.
- Publishes the CLI package (`apps/server`, npm package `t3`) with OIDC trusted publishing from the same workflow file:
  - stable releases publish npm dist-tag `latest`
  - nightly releases publish npm dist-tag `nightly`
- Deploys the hosted web app to Vercel only after a release is published:
  - stable releases are aliased to the `latest` hosted app channel
  - nightly releases are aliased to the `nightly` hosted app channel
- Stable macOS publication is fail-closed: the Mac workflow requires the complete Developer ID,
  notarization API-key, team, and provisioning-profile inputs. It never promotes unsigned Mac
  artifacts as public-ready. Before upload it verifies the mounted DMG's bundle identity, native
  Darwin voice binaries and model resources, hardened-runtime signature, Gatekeeper assessment,
  notarization ticket stapling, and an exact event-driven startup receipt (`version`, `platform`,
  and `phase`). Signed macOS builds also require either `CLERK_PUBLISHABLE_KEY` or
  `CLERK_PASSKEY_RP_DOMAINS`; this is checked before dependency installation so a missing
  passkey source cannot consume a full packaging run.

## Required release credentials

Stable releases require these GitHub Actions secrets in addition to the platform and deployment
credentials documented below:

- `RELEASE_APP_ID`
- `RELEASE_APP_PRIVATE_KEY`

The finalize job uses them to commit and push aligned package versions to `main` as the Release App.
GitHub Release publication uses the repository-scoped workflow token so it has a rate-limit quota
independent from the shared Release App installation.

## T3 Connect relay deployment

The relay is a shared control plane versioned separately from client releases. Stable and nightly
client builds must point at the same relay so users see the same linked environments when switching
release channels.

`.github/workflows/deploy-relay.yml` deploys Alchemy stage `prod` on every push to `main`. The
release workflow reads the relay URL and Clerk client configuration from the existing `production`
GitHub Actions environment before building desktop, CLI, or hosted web artifacts.

Required repository variables shared by relay deployments:

- `CLOUDFLARE_ACCOUNT_ID`
- `PLANETSCALE_ORGANIZATION`
- `AXIOM_ORG_ID`

Required repository secrets shared by relay deployments:

- `CLOUDFLARE_API_TOKEN`
- `PLANETSCALE_API_TOKEN_ID`
- `PLANETSCALE_API_TOKEN`
- `AXIOM_TOKEN`

Required `production` environment variables:

- `RELAY_API_ZONE_NAME`
- `RELAY_TUNNEL_ZONE_NAME`
- `CLERK_PUBLISHABLE_KEY`
- `CLERK_JWT_AUDIENCE`
- `CLERK_JWT_TEMPLATE`
- `CLERK_CLI_OAUTH_CLIENT_ID`
- `APNS_ENVIRONMENT`
- `APNS_TEAM_ID`
- `APNS_KEY_ID`
- `APNS_BUNDLE_ID`

Optional `production` environment variables:

- `RELAY_DOMAIN` when overriding the derived `relay.<RELAY_API_ZONE_NAME>` domain

Required `production` environment secrets:

- `CLERK_SECRET_KEY`
- `APNS_PRIVATE_KEY`

The account-scoped repository credentials are consumed by Alchemy while provisioning relay stages; they
are not bound into the relay Worker. The production deployment uses an Axiom personal access token,
so `AXIOM_ORG_ID` must accompany `AXIOM_TOKEN`. The `prod` stage owns the retained PlanetScale
database. Local personal stages provision isolated branches from it and are never deployed by CI.
Production adopts the configured relay API and tunnel DNS zones as retained Cloudflare resources.
Personal stages reference the production-owned zones.

Developers deploy personal stages locally rather than through pull-request automation:

```sh
vp run --filter t3code-relay deploy -- --stage "$USER" --env-file .env.local
```

## Hosted web app release deployment

The hosted app is intentionally not deployed by Vercel's Git integration. The
web project disables automatic Git deployments in `apps/web/vercel.ts` via
`git.deploymentEnabled: false`, and `.github/workflows/release.yml` deploys the
web app with Vercel CLI after the GitHub Release succeeds.

Required GitHub Actions secrets:

- `VERCEL_TOKEN`
- `VERCEL_ORG_ID`
- `VERCEL_PROJECT_ID`

Optional GitHub Actions variables:

- `VERCEL_TEAM_SLUG`: overrides the Vercel CLI scope when the team slug is preferred over the `VERCEL_ORG_ID` secret.
- `T3CODE_WEB_ROUTER_URL`: defaults to `https://app.t3.codes`.
- `T3CODE_WEB_LATEST_DOMAIN`: defaults to `latest.app.t3.codes`.
- `T3CODE_WEB_NIGHTLY_DOMAIN`: defaults to `nightly.app.t3.codes`.

Required Vercel domains:

- `app.t3.codes`: the router domain users open, updated by stable releases.
- `latest.app.t3.codes`: channel alias updated by stable releases.
- `nightly.app.t3.codes`: channel alias updated by nightly releases.

The router domain uses `apps/web/vercel.ts` routes. Users opt into a channel by
visiting `/__t3code/channel?channel=latest` or
`/__t3code/channel?channel=nightly`; the router stores the
`t3code_web_channel` cookie and rewrites future requests on `app.t3.codes` to
the matching channel alias.

The release deploy job rewrites release package versions before upload so the
hosted app's About panel renders the release version. Stable deploys alias the
same deployment to both the `latest` channel and the router domain so the router
rules stay current. Nightly deploys only alias the `nightly` channel. The job
also passes `VITE_HOSTED_APP_CHANNEL=latest|nightly`, which renders the hosted
update track selector in the About panel. Changing the selector navigates
through `/__t3code/channel` on the router domain so the user's channel cookie is
updated before redirecting to the hosted app root.

One-time Vercel dashboard setup:

1. Confirm the web project root directory remains `apps/web`.
2. Add the three domains above to the web project.
3. Disable automatic Git deployments in the dashboard if desired; the committed
   `vercel.ts` setting is the source-of-truth, but disconnecting Git in the
   dashboard is also safe.
4. Run one stable release deployment, or manually alias the current stable
   deployment, so `app.t3.codes` points at a deployment containing the router
   rules in `apps/web/vercel.ts`. Future stable releases keep this alias current.

## Nightly builds

- Workflow: `.github/workflows/release.yml`
- Triggers:
  - scheduled check every three hours
  - manual `workflow_dispatch` with `channel=nightly`
- Runs the same desktop quality gates and artifact matrix as the tagged release flow.
- Publishes a GitHub prerelease only:
  - current tag format: `vX.Y.Z-nightly.YYYYMMDD.<run_number>`
  - `nightly-v...` is accepted only as a legacy previous-nightly tag
  - release name includes the short commit SHA
  - `make_latest` is always `false`
- Uses the next stable patch version as the nightly base. For example, `0.0.17` produces nightlies on `0.0.18-nightly.*`.
- Publishes Electron auto-update metadata to the dedicated `nightly` updater channel, so desktop users can opt into that track independently from stable.
- Publishes the CLI package (`apps/server`, npm package `t3`) to the `nightly` npm dist-tag using the same nightly version.
- Does not commit version bumps back to `main`.

## Server self-update release invariant

Connected servers update to the client's exact version, not to an npm dist-tag. Every released
desktop or hosted client version must therefore have a matching `t3@<version>` package available on
npm before users can receive that client.

The workflow enforces this ordering:

1. `publish_cli` publishes the exact stable or nightly version to npm.
2. `release` depends on `publish_cli` before exposing desktop artifacts in GitHub Releases.
3. `deploy_web` depends on `release` before moving the hosted channel to the new client.

Preserve these dependencies when changing the release graph. Publishing a client first would leave
the **Update server** action targeting a package version that does not exist yet.

For a release smoke test, confirm `npm view t3@<version> version` returns the expected version, then
connect the new client to a server on the previous version and verify that the update action
reconnects to the matching server. Use releases with identical migration manifests for the
automatic path. When the manifest changed, verify that the remote action stops before restart and
shows the exact local `npx t3@<version> service update` command. Also test the manual or
desktop-managed guidance when those environments are available.

## Desktop auto-update notes

Automatic updates for official Jarvis Full releases are disabled. The desktop runtime reports
that ownership belongs to Jarvis Releases; the DMG is the macOS install artifact, and Jarvis Full
does not publish or consume its own updater manifests or ZIP payloads.

- Updater runtime: `apps/desktop/src/updates/DesktopUpdates.ts`.
- `electron-updater` adapter: `apps/desktop/src/electron/ElectronUpdater.ts`.
- `apps/desktop/src/main.ts` only wires the updater layers into the desktop runtime.
- Update UX:
  - Background checks run on startup delay + interval.
  - No automatic download or install.
  - The desktop UI shows a rocket update button when an update is available; click once to download, click again after download to restart/install.
- Provider: GitHub Releases (`provider: github`) configured at build time.
- Repository slug source:
  - `T3CODE_DESKTOP_UPDATE_REPOSITORY` (format `owner/repo`), if set.
  - otherwise `GITHUB_REPOSITORY` from GitHub Actions.
- Historical upstream updater assets (not published by Jarvis Full):
  - platform installers (`.exe`, `.dmg`, and `.AppImage`)
  - channel metadata: `latest*.yml` for stable releases, `nightly*.yml` for nightly releases
  - `*.blockmap` files (used for differential downloads)
- macOS metadata note:
  - Jarvis Full does not publish macOS updater ZIPs or macOS updater manifests. Its signed and stapled DMG is the macOS release/install artifact.
  - Companion still publishes `latest.yml` and `latest-linux.yml` in the unified release for its own updater.

### Windows payload topology and update validation

Windows packages the bundled server and only its runtime-external/native
dependency closure in `resources/server.asar`. Native modules and helper
executables declared as unpacked by that archive must be present at the matching
paths below `resources/server.asar.unpacked`. The Windows-native backend reads
the archive in place through Electron. WSL cannot read ASAR files, so enabling
the WSL backend extracts the server tree once into the desktop state directory
under `wsl-server-tree/<version>` and reuses the completed version until the app
is updated.

The artifact builder rejects a Windows package when any of these invariants
break:

- `resources/server.asar` is absent or does not contain the server entry.
- Any file marked unpacked in the ASAR header is absent from
  `resources/server.asar.unpacked`.
- On same-architecture Windows builds, the packaged primary cannot load the fff
  native library from inside `server.asar` through its `.unpacked` sibling.
- The isolated, extracted sidecar cannot load the server entry with plain Node.
- The external Windows resource monitor is absent.
- The loose Windows payload contains an unknown path. The allowlist covers Electron's runtime
  files, `resources/app.asar`, `resources/server.asar`, the resource monitor, and the exact
  unpacked file paths declared by the app/server ASAR headers.
- Both isolated native-voice worker entry points are present inside `resources/app.asar`; they
  are not accepted as loose application files.
- The Windows payload exceeds its byte budgets: 640 MiB total, or 256 MiB for either app/server
  ASAR. The validator records the deterministic loose-file manifest and file count as telemetry;
  the count is not a release gate.

Cross-architecture Windows builds retain every structural and extracted-sidecar
check, but skip executing the target Electron binary. A same-architecture build
for each release target must exercise the primary native-load probe.

NSIS differential packaging remains enabled. A sidecar layout transition can
produce a larger one-time download; subsequent small releases retain their
blockmaps, with a 60 MB maximum for a representative sidecar-to-sidecar update.

## 0) npm OIDC trusted publishing setup (CLI)

The workflow invokes `node apps/server/scripts/cli.ts publish` after aligning package versions. That
script temporarily prepares the `t3` package, then runs `vp pm publish --filter t3 ...` from the
repository root so workspace publish configuration is applied correctly.

Checklist:

1. Confirm npm org/user owns package `t3` (or rename package first if needed).
2. In npm package settings, configure Trusted Publisher:
   - Provider: GitHub Actions
   - Repository: this repo
   - Workflow file: `.github/workflows/release.yml`
   - Environment (if used): match your npm trusted publishing config
3. Ensure npm account and org policies allow trusted publishing for the package.
4. Create release tag `vX.Y.Z` and push; workflow will:
   - align the release package versions to `X.Y.Z`
   - build web + server
   - invoke the CLI publish script with npm dist-tag `latest`
5. Nightly runs invoke the same publish script with npm dist-tag `nightly`.

## 1) Release validation and unsigned builds

There is no dry-run tag path. Pushing any accepted non-nightly tag, including
`v0.0.0-test.1`, classifies the run as the stable channel. It publishes `t3` with npm dist-tag
`latest`, creates a real GitHub Release, aliases the hosted app to `latest.app.t3.codes` and
`app.t3.codes`, and can commit a version bump to `main` in the finalize job. Do not push a test tag
to validate the workflow.

The core workflow has no non-publishing `workflow_dispatch` mode. Use component workflow manual
dispatches (including the macOS workflow with its default `public_release: false`) or local quality
gates to validate checks and builds without shipping. To exercise the complete release graph at lower
stable risk, manually dispatch `channel=nightly`; this still publishes a real nightly npm package,
GitHub prerelease, desktop updater release, and hosted nightly alias, but it does not update stable
aliases or commit a version bump to `main`. Only run it when a real nightly release is acceptable.

Manual `channel=stable` with a version input is also a real stable-channel release. Omitting signing
secrets fails the public release before artifact publication. Local unsigned builds remain possible
by invoking the artifact builder without `--signed`, but they are not release inputs.

## 2) Apple signing + notarization setup (macOS)

Stable Jarvis builds require these base signing/notarization secrets:

- `CSC_LINK`
- `CSC_KEY_PASSWORD`
- `APPLE_API_KEY`
- `APPLE_API_KEY_ID`
- `APPLE_API_ISSUER`

The optional native passkey set is enabled only when all of the following are supplied:

- `APPLE_TEAM_ID`
- `MACOS_PROVISIONING_PROFILE` (base64-encoded provisioning profile with Associated Domains)
- either `CLERK_PUBLISHABLE_KEY` or `CLERK_PASSKEY_RP_DOMAINS`

The passkey values are all-or-none. A signed macOS build without them still receives the base
Electron entitlements and can be released over Tailscale; it simply does not claim native Clerk
passkey support. The Chromium media-capture path still requires the real-device microphone and
TCC checklist below. Preview releases do not require signing credentials.

Optional repository variables for the passkey set:

- `CLERK_PUBLISHABLE_KEY`: production Clerk publishable key used to derive the passkey RP domain.
- `CLERK_PASSKEY_RP_DOMAINS`: comma-separated RP-domain override. By default, the build derives the
  domain from `CLERK_PUBLISHABLE_KEY`.

Checklist:

1. Apple Developer account access:
   - Team has rights to create Developer ID certificates.
2. When native passkeys are required, create an explicit App ID for `com.abstergo.jarvis` and
   enable Associated Domains.
3. Create a `Developer ID Application` certificate and a compatible provisioning profile for that
   App ID with Associated Domains enabled.
4. Export the certificate + private key as `.p12` from Keychain.
5. Base64-encode the `.p12` and store as `CSC_LINK`.
6. If enabling passkeys, base64-encode the provisioning profile and store it as
   `MACOS_PROVISIONING_PROFILE`.
7. Store the `.p12` export password as `CSC_KEY_PASSWORD`, and set `APPLE_TEAM_ID` to the
   10-character Apple Developer Team ID.
8. In App Store Connect, create an API key (Team key).
9. Add API key values:
   - `APPLE_API_KEY`: contents of the downloaded `.p8`
   - `APPLE_API_KEY_ID`: Key ID
   - `APPLE_API_ISSUER`: Issuer ID
10. If enabling passkeys, complete the Clerk Native API and AASA setup in [T3 Connect Clerk Setup](../internals/t3-connect.md#desktop-passkeys).
11. Dispatch the Jarvis coordinator with `channel=stable` and confirm macOS artifacts are
    signed/notarized. When passkeys are configured, also confirm the expected
    `com.apple.developer.associated-domains` entitlement.

Notes:

- `APPLE_API_KEY` is stored as raw key text in secrets.
- The workflow writes it to a temporary `AuthKey_<id>.p8` file at runtime.
- When configured, the workflow decodes `MACOS_PROVISIONING_PROFILE`.
  It validates the profile with `security cms` and passes it to the desktop packager.

## 3) Azure Trusted Signing setup (Windows)

Required secrets used by the workflow:

- `AZURE_TENANT_ID`
- `AZURE_CLIENT_ID`
- `AZURE_CLIENT_SECRET`
- `AZURE_TRUSTED_SIGNING_ENDPOINT`
- `AZURE_TRUSTED_SIGNING_ACCOUNT_NAME`
- `AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME`
- `AZURE_TRUSTED_SIGNING_PUBLISHER_NAME`

Checklist:

1. Create Azure Trusted Signing account and certificate profile.
2. Record ATS values:
   - Endpoint
   - Account name
   - Certificate profile name
   - Publisher name
3. Create/choose an Entra app registration (service principal).
4. Grant service principal permissions required by Trusted Signing.
5. Create a client secret for the service principal.
6. Add Azure secrets listed above in GitHub Actions secrets.
7. Dispatch the Jarvis core coordinator and confirm the Windows installer and installed
   `desktop\\Jarvis.exe` report Authenticode `Valid` with the configured publisher.

## 4) Ongoing release checklist

1. Ensure `main` is green in CI.
2. Bump app version as needed.
3. Create release tag: `vX.Y.Z`.
4. Push tag.
5. Verify workflow steps:
   - preflight passes
   - release quality checks pass
   - all matrix builds pass
   - `publish_cli` publishes the exact release version before the release job
   - release job uploads expected files
6. Smoke test downloaded artifacts.

## 5) Troubleshooting

- macOS build unsigned when expected signed:
  - Check all five base Apple secrets are populated and non-empty.
  - If native passkeys are intended, check the complete optional set: `APPLE_TEAM_ID`,
    `MACOS_PROVISIONING_PROFILE`, and `CLERK_PUBLISHABLE_KEY` or `CLERK_PASSKEY_RP_DOMAINS`.
  - Confirm the provisioning profile belongs to `APPLE_TEAM_ID.com.abstergo.jarvis` and includes
    Associated Domains.
- Windows build unsigned when expected signed:
  - Check all Azure ATS and auth secrets are populated and non-empty.
  - Confirm the coordinator passed `public_release: true`; partial secret sets are rejected.
- Build fails with signing error:
  - Retry with secrets removed to confirm unsigned path still works.
  - Re-check certificate/profile names and tenant/client credentials.
