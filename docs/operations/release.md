# Release Checklist

> For maintainers. Using T3 Code? See [docs/user](../user/).

This document covers the unified release workflow for stable and nightly desktop releases.

## What the workflow does

- Workflow: `.github/workflows/release.yml`
- Triggers:
  - manual `workflow_dispatch` with `channel=stable`, the normal way to ship stable. Stable
    and nightly dispatches must select `main`; preview may select any branch. The channel defaults
    to preview so an omitted selection cannot publish a stable release.
  - push tag matching `v*.*.*` for a stable release of an explicit commit
  - scheduled nightly check every 30 minutes
  - manual `workflow_dispatch` with `channel=nightly`
  - manual `workflow_dispatch` with `channel=preview`, the maintainers' test train. It exercises the whole release flow (build, sign, notarize, smoke, publish) for a commit that end users must never receive, which is how an unmerged branch or a risky change gets a real release run before it lands. It builds the triggering commit with nightly's versioning under the `preview` prerelease identifier (`0.0.41-preview.<date>.<run>`) and publishes a GitHub prerelease plus the npm packages under the `preview` dist-tag. Preview is not on the schedule, no default npm dist-tag points at it, its desktop builds carry no update feed, and no updater manifest (`latest*.yml`, `nightly*.yml`, blockmaps) is attached, so a stable or nightly install cannot be offered one. The only ways onto it are downloading the release by hand, `npx t3@preview`, `T3CODE_CHANNEL=preview` for the install scripts, or `t3 update --channel preview` from a terminal; each prints a warning, and the CLI asks for confirmation when the running build is not itself a preview. The release itself is named as a maintainer test build and its body is a warning rather than generated notes: a changelog of unmerged branch history is not a changelog, and nightly and stable notes are unaffected because each series resolves its previous tag within its own channel. The hosted web app, AUR, and Discord announcements are skipped. Keep it; it costs nothing when idle.
- A manual stable release builds the commit of the latest published nightly, not `main` HEAD.
  Nightly is the release candidate: verify the nightly, then promote it. Merges to `main` keep
  landing while you verify and never leak into the stable build.
  - The version defaults to the one the nightly previewed (`0.0.39-nightly.*` ships as `0.0.39`).
    Pass the `version` input to override it, for example for a minor bump.
  - The stable tag is created on the nightly's commit when the GitHub Release is published.
  - Pushing a `vX.Y.Z` tag by hand still works and builds exactly the tagged commit. Use it when
    the commit to ship is not the latest nightly, such as a cherry-picked fix on a release branch.
- Runs lint, typecheck, and tests alongside artifact builds. Publishing waits for every check.
- Reads the shared production T3 Connect relay URL and Clerk client configuration before packaging clients.
- Builds the platform-independent JS (server bundle, web client, Electron main) once in the `build_bundle` job and hands it to every platform job as the `js-bundle` artifact; the platform jobs only package it, so no runner rebuilds it.
- Builds six desktop artifacts in parallel for both channels, each as its own job (`desktop_<platform>_<arch>`, one call of `release-desktop.yml`) on hardware of its own architecture, gated only on the bundle (the Windows jobs also wait for the same-arch Linux job, whose CLI archive they embed as the WSL runtime):
  - macOS `arm64` DMG
  - macOS `x64` DMG
  - Linux `x64` and `arm64` AppImage and `.deb`, from one electron-builder run. The `.deb` updates in the app through electron-updater, which installs it with `dpkg`.
  - Windows `x64` and `arm64` NSIS installer
- Publishes one GitHub Release with all produced files.
  - Stable tags with a suffix after `X.Y.Z` (for example `1.2.3-alpha.1`) are published as GitHub prereleases.
  - Only plain stable `X.Y.Z` releases are marked as the repository's latest release.
  - Nightly runs are always GitHub prereleases and never marked latest.
  - Automatically generated release notes are pinned to the previous tag in the same channel, so stable compares to the previous stable tag and nightly compares to the previous nightly tag.
- Includes Electron auto-update metadata (for example `latest*.yml`, `nightly*.yml`, and `*.blockmap`) in release assets.
- Builds a self-contained CLI archive per platform (`t3-<version>-<platform>-<arch>.tar.gz`, `.zip` on Windows) in the same job as that target's desktop artifact and attaches them to the GitHub Release with a `SHA256SUMS` file, on every channel, for five targets: macOS arm64, Linux x64 and arm64, Windows x64 and arm64. Every archive is built, signed, and smoke-tested on hardware of its own architecture. There is no macOS x64 archive: Node single-executables are unsupported on x64 macOS (the SEA docs list macOS as arm64 only) and the binary segfaults on start; the x64 desktop app is Electron and unaffected.
  - The archive holds the server as a Node single-executable (`scripts/build-cli-archive.ts`), so unpacking it needs neither Node, npm, nor a compiler. It is the only form in which T3 Code manages a runtime: the desktop's SSH environments, the boot service, `t3 update`, and the install scripts all download and verify this archive against `SHA256SUMS`. The npm packages exist for people who run `npx t3` or `npm install -g t3` themselves and carry the same archive contents; nothing in the product installs from npm. The `curl | sh` installers are `scripts/install.sh` and `scripts/install.ps1`; the marketing site copies them into its `public/` at build time (`apps/marketing/scripts/stage-install-scripts.mjs`) and serves them at `t3.codes/install.sh` and `/install.ps1`.
  - The executable is built with a Node that supports `--build-sea` (`VP_NODE_VERSION=26.8.2`, kept in step with `SEA_NODE_VERSION` in `apps/server/vite.config.ts`), while the repo stays on `engines.node`.
  - macOS archives are signed with the Developer ID certificate and notarized when the Apple secrets are present (ad hoc otherwise, which still runs from `curl`/`tar` installs). Windows executables use the same Azure Trusted Signing setup as the installer. Every native addon in the macOS archive is signed too, since the hardened runtime refuses unsigned libraries.
  - Each archive is extracted and executed on its build runner (`scripts/smoke-cli-archive.ts`) before it is uploaded.
- Publishes the CLI to npm with OIDC trusted publishing from the same workflow file, as the same bytes the GitHub Release carries: `scripts/build-npm-platform-packages.ts` unpacks the five CLI archives into `@t3code/t3-<platform>-<arch>` packages (each with `os`/`cpu` set so npm installs only the matching one) and generates the `t3` launcher, whose `bin/t3.js` lists them as `optionalDependencies` and execs the installed executable. `npx t3` therefore needs Node only to run the launcher, never to run the server. `node apps/server/scripts/cli.ts publish` publishes the platform packages first and the launcher last, after a `--dry-run` pass over all of them so an auth or scope error fails before anything is live.
  - stable releases publish npm dist-tag `latest`
  - nightly releases publish npm dist-tag `nightly`
  - preview releases publish npm dist-tag `preview`, which nothing resolves unless asked for by name
  - one-time setup: the `@t3code` npm scope (org) must exist, and `t3` and each `@t3code/t3-<platform>-<arch>` package needs a trusted publisher registered for this workflow file (see below).
- Deploys the hosted web app to Vercel only after a release is published:
  - stable releases are aliased to the `latest` hosted app channel
  - nightly releases are aliased to the `nightly` hosted app channel
- Signing is optional and auto-detected per platform from secrets.

## Pull request macOS previews

Labeling a PR `preview:mac` publishes a signed, notarized Apple Silicon DMG with T3 Connect enabled
to the rolling `desktop-preview` prerelease, and works for fork PRs. The label is a one-shot request
for the commit it is applied to: the trusted workflow removes it once the build is in hand, and later
pushes do not build until a maintainer applies it again. Every signed preview is therefore a
per-commit maintainer decision, which matters because the result carries the Developer ID signature.
Vouching a contributor lets their labeled commits be signed; it is not a standing grant. The build is
split so the Developer ID certificate never shares a job with PR code:

- `.github/workflows/desktop-macos-preview.yml` runs on `pull_request` with no secrets and builds
  only the JS bundle from the PR (the same `js-bundle` artifact `release.yml` produces).
- `.github/workflows/desktop-macos-preview-publish.yml` runs on `workflow_run` from `main`. It
  refuses unless the PR is open, still labeled, its head is the built commit, and the author is a
  bot, a collaborator, or listed in `.github/VOUCHED.td` (read from the default branch, so a PR cannot vouch
  for itself). It then packages and signs the bundle through `release-desktop.yml` checked out at
  `main`, so packaging, native helpers, and the Electron/desktop dependencies come from `main`, not
  the PR. Only the version and the public T3 Connect identifiers in `.env.example` are read from the
  PR commit, as data, so the signed app's passkey entitlement matches the bundle. A PR that changes
  packaging must use the `channel=preview` release train above instead.

Before handing the bundle to the signing runner, the trusted workflow validates its ZIP entries
and accepts only regular files under `server/dist` and `desktop/dist-electron`, plus the directory
entries that lead to those roots. The artifact cannot
overwrite packaging code or installed dependencies. The bundle is copied into the app, never executed,
on the signing runner. The
`pull_request_target` cleanup job in the publish workflow removes the download when the PR closes, or
when the label is removed by hand before a build consumed it, and never checks out PR code.

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
- `RELAY_TUNNEL_CLEANUP_MODE` with `off`, `dry-run`, or `enabled`. Missing and blank values use
  `off`.

Required `production` environment secrets:

- `CLERK_SECRET_KEY`
- `APNS_PRIVATE_KEY`

The relay Worker reads these variables and secrets when it is deployed. Alchemy does not redeploy the
Worker when only one of these values changes ([alchemy-run/alchemy#1831](https://github.com/alchemy-run/alchemy/issues/1831)),
so a push to `main` without relay code changes leaves the old value in place. After changing one, run
the **Deploy T3 Connect relay** workflow manually from `main` with **force** checked.

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

### Managed tunnel cleanup rollout

Keep `RELAY_TUNNEL_CLEANUP_MODE=off` for the first production deploy. That deploy applies the
nullable allocation migration and adds the recovery endpoints. Web and mobile clients need no
coordinated release. CLI and desktop server builds must reach users before cleanup is enabled,
because those builds register recovery and replace a deleted tunnel after wake.

1. Deploy the relay and migration with cleanup `off`.
2. Release the server build and confirm current hosts register recovery. Older hosts stay marked
   legacy and are never candidates.
3. Set `dry-run`, run a forced relay deploy, and read the sweep counters (`scanned`, `wouldDelete`,
   `skippedLegacy`, `skippedOrphan`, `failed`, `truncated`) across several sweeps. Each sweep records
   them, and the active `mode`, as `relay.managed_endpoint_reaper.*` attributes on its
   `relay.managed_endpoint_reaper.sweep` span in Axiom.
4. Run the disposable-host canary below.
5. Set `enabled` only after the canary recovers without a server restart.

The job runs every five minutes with a five-minute grace period for tunnels that lost their
connector, so a candidate is usually removed five to ten minutes after it goes down. Tunnels that
never connected wait an hour. One sweep attempts at most 100 deletions, so a backlog takes longer.
Changing `RELAY_TUNNEL_CLEANUP_MODE`, including turning cleanup off during an incident, needs a forced
relay deploy. Confirm the new `mode` on the next sweep span.

To roll back, set cleanup to `off` and run a forced relay deploy before downgrading any host. Keep the
recovery endpoints deployed while current server builds are in use. The nullable columns can stay.

### Disposable-host canary

This test has not been run against a real Cloudflare account. Run it against a disposable relay
stage, test Cloudflare account, disposable host, and disposable T3 home. Keep production cleanup at
`off` or `dry-run` until it passes. Do not stop a daily-use T3 server.

1. Deploy the disposable stage with cleanup `dry-run`. Link a first disposable environment through
   web or mobile settings and confirm its tunnel is healthy and recovery is registered.
2. Stop that host and restart the same T3 home on a different local port. Confirm the public
   hostname reaches the new port and sends nothing to the old one.
3. Link a second disposable environment with a server build that predates recovery registration.
   Capture its managed `cloudflared` child PID, confirm it belongs to that host, and pause only that
   child with `kill -STOP <legacy-pid>`. Wait until Cloudflare reports it down for over five minutes.
4. Capture the first environment's `cloudflared` child PID from its server logs, confirm ownership,
   and pause it with `kill -STOP <first-pid>`. Wait until Cloudflare reports it down for over five
   minutes.
5. Confirm dry-run counts the first tunnel in `wouldDelete` and the second in `skippedLegacy`.
6. Set cleanup `enabled` on the disposable stage and deploy it with `--force`. Confirm in the test
   Cloudflare account that the first tunnel is deleted and the legacy tunnel still exists.
7. Resume the first child with `kill -CONT <first-pid>`. Confirm the running server detects the
   repeated rejection, requests recovery, and becomes reachable at the same hostname without a
   restart.
8. Resume the legacy child with `kill -CONT <legacy-pid>` and confirm its tunnel reconnects.
9. Repeat with a physical sleep and wake cycle on a disposable laptop before broad rollout.

## Marketing site deployment

After a nightly release is published, the release workflow deploys the same commit
to the marketing site's Vercel production project. Stable releases do not deploy
the marketing site because they can promote an older nightly commit.

The job looks up the `t3code-marketing` project using the existing `VERCEL_TOKEN`
and `VERCEL_ORG_ID` secrets. It also respects the optional `VERCEL_TEAM_SLUG`
variable. The Vercel project's root directory must be `apps/marketing`.
Git deployments remain disabled in `apps/marketing/vercel.ts`.

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
  - scheduled check every 30 minutes
  - manual `workflow_dispatch` with `channel=nightly`
- Automatic nightlies require new commits and at least six hours since the last nightly was published, including manual nightlies.
- Manual nightlies bypass the time and change checks. Nightly runs remain serialized. Scheduled runs wait for an active nightly to finish, then check the publication gap before building.
- Runs the same desktop quality gates and artifact matrix as the tagged release flow.
- Publishes a GitHub prerelease only:
  - current tag format: `vX.Y.Z-nightly.YYYYMMDD.<run_number>`
  - `nightly-v...` is accepted only as a legacy previous-nightly tag
  - release name includes the short commit SHA
  - `make_latest` is always `false`
- Uses the next stable patch version as the nightly base. For example, `0.0.17` produces nightlies on `0.0.18-nightly.*`.
- Publishes Electron auto-update metadata to the dedicated `nightly` updater channel, so desktop users can opt into that track independently from stable.
- Publishes the CLI npm packages (`t3` and `@t3code/t3-<platform>-<arch>`) to the `nightly` npm dist-tag using the same nightly version.
- Does not commit version bumps back to `main`.

## Server self-update release invariant

Connected servers update to the client's exact version, not to an npm dist-tag. Every released
desktop or hosted client version must therefore have a matching `t3@<version>` package available on
npm before users can receive that client.

The workflow enforces this ordering:

1. `publish_cli` publishes the exact release version to npm, on every channel.
2. `release` depends on `publish_cli` before exposing desktop artifacts in GitHub Releases.
3. `deploy_web` depends on `release` before moving the hosted channel to the new client.

Preserve these dependencies when changing the release graph. Publishing a client first would leave
the **Update server** action targeting a package version that does not exist yet.

For a release smoke test, confirm `npm view t3@<version> version` returns the expected version, then
connect the new client to a server on the previous version and verify that the update action
reconnects to the matching server. When the release adds database migrations, verify that the
remote update applies them and reconnects. A failed trial must restore the database snapshot and
restart the previous server. If the installed launcher does not support the target protocol,
verify that the update stops before restart and run `npx t3@<version> service update` once on the
server machine. Also test the manual or desktop-managed guidance when those environments are
available.

## Desktop auto-update notes

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
- Required release assets for updater:
  - platform installers (`.exe`, `.dmg`, `.AppImage`, `.deb`, plus macOS `.zip` for Squirrel.Mac update payloads)
  - channel metadata: `latest*.yml` for stable releases, `nightly*.yml` for nightly releases
  - `*.blockmap` files (used for differential downloads)
- macOS metadata note:
  - `electron-updater` reads `latest-mac.yml` on stable and `nightly-mac.yml` on nightly, for both Intel and Apple Silicon.
  - The workflow merges the per-arch mac manifests into one channel-specific mac manifest before publishing the GitHub Release.

### Windows payload topology and update validation

Windows packages the bundled server and only its runtime-external/native
dependency closure in `resources/server.asar`. Native modules and helper
executables declared as unpacked by that archive must be present at the matching
paths below `resources/server.asar.unpacked`. The Windows-native backend reads
the archive in place through Electron. Packaged Windows builds also ship
`resources/wsl-runtime.tar.gz` plus its SHA-256 sidecar: the Linux CLI archive
(`t3-<version>-linux-<arch>.tar.gz`, the same arch as the Windows host) built
by the Linux desktop job and handed to the Windows desktop build as
`--wsl-runtime`, copied in verbatim so WSL runs the exact bytes a Linux user
downloads. WSL verifies and extracts that archive
into `~/.t3/wsl-runtime/sha256-<archive-digest>` inside the selected distro,
then reuses it for later launches of the same update.

Windows keeps JavaScript and package metadata inside `app.asar` and unpacks only
native libraries and helper executables. Avoid enabling whole-package smart
unpacking: each loose file adds work to NSIS installation and counts against
the payload limit.

The artifact builder rejects a Windows package when any of these invariants
break:

- `resources/server.asar` is absent or does not contain the server entry.
- Any file marked unpacked in the ASAR header is absent from
  `resources/server.asar.unpacked`.
- On same-architecture Windows builds, the packaged primary cannot load the fff
  native library from inside `server.asar` through its `.unpacked` sibling.
- The isolated, extracted sidecar cannot load the server entry with plain Node.
- A Windows build given `--wsl-runtime` omits the WSL archive or SHA-256
  sidecar, or the sidecar digest does not match the emitted archive.
- The emitted WSL archive is not a Linux CLI release archive: it must unpack to
  a single `t3-<version>-linux-<arch>` directory holding `t3`, `client/`, and
  `node_modules/` with the Linux node-pty binary, and must not carry a loose
  server bundle (`bin.mjs`).
- The external Windows resource monitor is absent.
- The unpacked Windows application contains more than 80 files.

Cross-architecture Windows builds retain every structural and extracted-sidecar
check, but skip executing the target Electron binary. A same-architecture build
for each release target must exercise the primary native-load probe.

NSIS differential packaging remains enabled. A sidecar layout transition can
produce a larger one-time download; subsequent small releases retain their
blockmaps, with a 60 MB maximum for a representative sidecar-to-sidecar update.

## 0) npm OIDC trusted publishing setup (CLI)

The workflow runs `node scripts/build-npm-platform-packages.ts` on the downloaded CLI archives, then
`node apps/server/scripts/cli.ts publish --packages-dir npm-packages`, which runs `npm publish` on
each `@t3code/t3-<platform>-<arch>.tgz` and finally on `t3.tgz`, the launcher. The script publishes
tarballs it built itself rather than directories: `npm publish <dir>` strips `node_modules/` from the
tarball no matter what `files` says, and the executable loads its native addons from there. Seven
packages are published per release: `t3`, `@t3code/t3-darwin-arm64`, `@t3code/t3-darwin-x64`,
`@t3code/t3-linux-arm64`, `@t3code/t3-linux-x64`, `@t3code/t3-win32-arm64`,
`@t3code/t3-win32-x64`.

Checklist:

1. Confirm the npm org owns package `t3` and the `@t3code` scope exists on npm (create the org if
   it does not).
2. For `t3` and each `@t3code/t3-<platform>-<arch>` package, configure a Trusted Publisher in the
   npm package settings (a package that has never been published needs a first publish or a
   placeholder before the setting exists; the `--dry-run` step in `publish_cli` reports which
   names are still rejected):
   - Provider: GitHub Actions
   - Repository: this repo
   - Workflow file: `.github/workflows/release.yml`
   - Environment (if used): match your npm trusted publishing config
3. Ensure npm account and org policies allow trusted publishing for every package.
4. Create release tag `vX.Y.Z` and push; workflow will:
   - build and smoke-test the five CLI archives
   - build the npm packages from those archives
   - publish them with npm dist-tag `latest`
5. Nightly runs publish with npm dist-tag `nightly`; preview runs with `preview`.

## 1) Release validation and unsigned builds

There is no dry-run tag path. Pushing any accepted non-nightly tag, including
`v0.0.0-test.1`, classifies the run as the stable channel. It publishes `t3` with npm dist-tag
`latest`, creates a real GitHub Release, aliases the hosted app to `latest.app.t3.codes` and
`app.t3.codes`, and can commit a version bump to `main` in the finalize job. Do not push a test tag
to validate the workflow.

The workflow has no non-publishing `workflow_dispatch` mode. Use normal CI or local quality gates to
validate checks and builds without shipping. To exercise the complete release graph at lower stable
risk, manually dispatch `channel=nightly`; this still publishes a real nightly npm package, GitHub
prerelease, desktop updater release, hosted nightly alias, and marketing site, but it does not update stable app aliases or
commit a version bump to `main`. Only run it when a real nightly release is acceptable.

Manual `channel=stable` is also a real stable-channel release. Omitting signing secrets only makes
platform artifacts unsigned; it does not prevent publication.

## 2) Apple signing + notarization setup (macOS)

Required secrets used by the workflow:

- `CSC_LINK`
- `CSC_KEY_PASSWORD`
- `APPLE_API_KEY`
- `APPLE_API_KEY_ID`
- `APPLE_API_ISSUER`
- `MACOS_PROVISIONING_PROFILE` (base64-encoded provisioning profile with Associated Domains)

Required repository variables:

- `APPLE_TEAM_ID`

Optional repository variables:

- `CLERK_PASSKEY_RP_DOMAINS`: comma-separated RP-domain override. By default, the build derives the
  domain from the production Clerk publishable key.

Checklist:

1. Apple Developer account access:
   - Team has rights to create Developer ID certificates.
2. Create an explicit App ID for `com.t3tools.t3code` and enable Associated Domains.
3. Create a `Developer ID Application` certificate and a compatible provisioning profile for that
   App ID with Associated Domains enabled.
4. Export the certificate + private key as `.p12` from Keychain.
5. Base64-encode the `.p12` and store as `CSC_LINK`.
6. Base64-encode the provisioning profile and store it as `MACOS_PROVISIONING_PROFILE`.
7. Store the `.p12` export password as `CSC_KEY_PASSWORD`, and set `APPLE_TEAM_ID` to the
   10-character Apple Developer Team ID.
8. In App Store Connect, create an API key (Team key).
9. Add API key values:
   - `APPLE_API_KEY`: contents of the downloaded `.p8`
   - `APPLE_API_KEY_ID`: Key ID
   - `APPLE_API_ISSUER`: Issuer ID
10. Complete the Clerk Native API and AASA setup in [T3 Connect setup](./connect-setup.md#desktop-passkeys).
11. Re-run a tag release and confirm macOS artifacts are signed/notarized and contain the expected
    `com.apple.developer.associated-domains` entitlement.

Notes:

- `APPLE_API_KEY` is stored as raw key text in secrets.
- The workflow writes it to a temporary `AuthKey_<id>.p8` file at runtime.
- The workflow decodes `MACOS_PROVISIONING_PROFILE`, validates it with `security cms`, and passes it
  to the desktop packager.

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
7. Re-run a tag release and confirm Windows installer is signed.

## 4) Ongoing release checklist

1. Pick the latest nightly and verify it: run the smoke test above against its artifacts and
   check the nightly channel for regressions.
2. Dispatch the Release workflow with `channel=stable`. Leave `version` empty unless the version
   should differ from the one the nightly previewed.
3. Confirm the `Resolve release commit` notice names the nightly tag and commit you verified. If a
   newer nightly published in between, the run builds that one instead.
4. Verify workflow steps:
   - preflight passes
   - release quality checks pass
   - `build_bundle` and all platform builds pass
   - `publish_cli` publishes the exact release version before the release job
   - release job uploads expected files
5. Smoke test downloaded artifacts.

## 5) Troubleshooting

- macOS build unsigned when expected signed:
  - Check all Apple secrets plus `APPLE_TEAM_ID` are populated and non-empty.
  - Confirm the provisioning profile belongs to `APPLE_TEAM_ID.com.t3tools.t3code` and includes
    Associated Domains.
- Windows build unsigned when expected signed:
  - Check all Azure ATS and auth secrets are populated and non-empty.
- Build fails with signing error:
  - Retry with secrets removed to confirm unsigned path still works.
  - Re-check certificate/profile names and tenant/client credentials.
