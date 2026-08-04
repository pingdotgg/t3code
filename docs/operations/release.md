# Release Checklist

> For maintainers. Using T3 Code? See [docs/user](../user/).

This document covers the unified release workflow for stable, nightly, and canary desktop releases.

## What the workflow does

- Workflow: `.github/workflows/release.yml`
- Triggers:
  - pushes to `main` for stable or nightly releases
  - pushes to `canary` for canary releases
  - manual `workflow_dispatch` for any channel
- Runs quality gates first: lint, typecheck, test.
- Fork builds use empty relay and Clerk configuration because the production relay config job is disabled.
- Builds four artifacts in parallel for every channel:
  - macOS `arm64` DMG
  - macOS `x64` DMG
  - Linux `x64` AppImage
  - Windows `x64` NSIS installer
- Publishes one GitHub Release with all produced files.
  - Stable runs publish plain `X.Y.Z` versions and mark them as the repository's latest release.
  - Nightly and canary runs are always GitHub prereleases and never marked latest.
  - Automatically generated release notes compare against the previous tag in the same channel.
- Includes Electron auto-update metadata such as `latest*.yml`, `nightly*.yml`, `canary*.yml`, and `*.blockmap` in release assets.
- The fork keeps npm publishing and hosted Vercel deployment disabled. Releases still include the desktop artifacts and hosted web archive.
- Signing is optional and auto-detected per platform from secrets.

## Required release credentials

The release workflow requires these GitHub Actions secrets in addition to the platform and deployment
credentials documented below:

- `RELEASE_APP_ID`
- `RELEASE_APP_PRIVATE_KEY`

The GitHub Release job uses them to mint the token that publishes release assets.

## T3 Connect relay deployment

The relay is a shared control plane versioned separately from client releases. Stable, nightly, and canary
client builds must point at the same relay so users see the same linked environments when switching
release channels.

`.github/workflows/deploy-relay.yml` deploys Alchemy stage `prod` on every push to `main`. The fork's
release workflow does not read this deployment state because its relay config job is disabled.

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

The web project disables automatic Git deployments in `apps/web/vercel.ts` via
`git.deploymentEnabled: false`. The fork also disables the `deploy_web` release
job, so releases do not change Vercel aliases. The configuration below applies
if that job is enabled later.

Required GitHub Actions secrets:

- `VERCEL_TOKEN`
- `VERCEL_ORG_ID`
- `VERCEL_PROJECT_ID`

Optional GitHub Actions variables:

- `VERCEL_TEAM_SLUG`: overrides the Vercel CLI scope when the team slug is preferred over the `VERCEL_ORG_ID` secret.
- `T3CODE_WEB_ROUTER_URL`: defaults to `https://app.t3.codes`.
- `T3CODE_WEB_LATEST_DOMAIN`: defaults to `latest.app.t3.codes`.
- `T3CODE_WEB_NIGHTLY_DOMAIN`: defaults to `nightly.app.t3.codes`.
- `T3CODE_WEB_CANARY_DOMAIN`: defaults to `canary.app.t3.codes`.

Required Vercel domains:

- `app.t3.codes`: the router domain users open, updated by stable releases.
- `latest.app.t3.codes`: channel alias updated by stable releases.
- `nightly.app.t3.codes`: channel alias updated by nightly releases.
- `canary.app.t3.codes`: channel alias updated by canary releases.

The router domain uses `apps/web/vercel.ts` routes. Users opt into a channel by
visiting `/__t3code/channel?channel=latest`,
`/__t3code/channel?channel=nightly`, or
`/__t3code/channel?channel=canary`; the router stores the
`t3code_web_channel` cookie and rewrites future requests on `app.t3.codes` to
the matching channel alias.

The release deploy job rewrites release package versions before upload so the
hosted app's About panel renders the release version. Stable deploys alias the
same deployment to both the `latest` channel and the router domain so the router
rules stay current. Nightly and canary deploy only their matching channel aliases. The job
also passes `VITE_HOSTED_APP_CHANNEL=latest|nightly|canary`, which renders the hosted
update track selector in the About panel. Changing the selector navigates
through `/__t3code/channel` on the router domain so the user's channel cookie is
updated before redirecting to the hosted app root.

One-time Vercel dashboard setup:

1. Confirm the web project root directory remains `apps/web`.
2. Add the four domains above to the web project.
3. Disable automatic Git deployments in the dashboard if desired; the committed
   `vercel.ts` setting is the source-of-truth, but disconnecting Git in the
   dashboard is also safe.
4. Run one stable release deployment, or manually alias the current stable
   deployment, so `app.t3.codes` points at a deployment containing the router
   rules in `apps/web/vercel.ts`. Future stable releases keep this alias current.

## Nightly builds

- Workflow: `.github/workflows/release.yml`
- Triggers:
  - pushes to `main` unless the committed package version is an untagged stable version
  - manual `workflow_dispatch` with `channel=nightly`
- Runs the same desktop quality gates and artifact matrix as the stable release flow.
- Publishes a GitHub prerelease only:
  - current tag format: `vX.Y.Z-nightly.YYYYMMDD.<run_number>`
  - `nightly-v...` is accepted only as a legacy previous-nightly tag
  - release name includes the short commit SHA
  - `make_latest` is always `false`
- Uses the next stable patch version as the nightly base. For example, `0.0.17` produces nightlies on `0.0.18-nightly.*`.
- Publishes Electron auto-update metadata to the dedicated `nightly` updater channel, so desktop users can opt into that track independently from stable.
- Does not publish the CLI package in the fork because `publish_cli` is disabled.
- Does not commit version bumps back to `main`.

## Canary builds

- Every push to the long-lived `canary` branch publishes one immutable GitHub prerelease.
- Tag format: `vX.Y.Z-canary.YYYYMMDD.<run_number>`.
- Uses the next stable patch version as its base, independently of the nightly tag series.
- Publishes Electron metadata to the `canary` updater channel. Canary desktop builds select it by default.
- Uses `T3 Code (Canary)` branding, isolates client and managed server state under `~/.t3/canary`, and stores Electron data under `t3code-canary`. Desktop settings remain shared so switching update tracks persists across restarts.
- Does not publish the CLI package or deploy the hosted web app in the fork.
- Does not change package versions on `canary` or `main`.
- Merge `main` into `canary` regularly. Develop experiments on focused branches and merge them into `canary`; promote proven changes to `main` through separate focused PRs.

## Server self-update release invariant

Connected servers update to the client's exact version, not to an npm dist-tag. The fork disables
`publish_cli`, so its GitHub releases do not create matching `t3@<version>` packages. Remote server
self-update cannot target those release versions unless npm publishing is enabled again. Canary SSH
environments use the published `t3@nightly` runner instead of requesting a missing canary package.

If npm publishing is enabled again, confirm `npm view t3@<version> version` returns the expected
version before testing remote server self-update.

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
  - platform installers (`.exe`, `.dmg`, `.AppImage`, plus macOS `.zip` for Squirrel.Mac update payloads)
  - channel metadata: `latest*.yml` for stable releases, `nightly*.yml` for nightly releases, and `canary*.yml` for canary releases
  - `*.blockmap` files (used for differential downloads)
- macOS metadata note:
  - `electron-updater` reads `latest-mac.yml`, `nightly-mac.yml`, or `canary-mac.yml` for the selected channel, for both Intel and Apple Silicon.
  - The workflow merges the per-arch mac manifests into one channel-specific mac manifest before publishing the GitHub Release.

## 0) npm OIDC trusted publishing setup (CLI)

The fork disables the `publish_cli` job. If it is enabled later, the job invokes
`node apps/server/scripts/cli.ts publish` after aligning package versions. That script temporarily
prepares the `t3` package, then runs `vp pm publish --filter t3 ...` from the repository root.

Checklist:

1. Confirm npm org/user owns package `t3` (or rename package first if needed).
2. In npm package settings, configure Trusted Publisher:
   - Provider: GitHub Actions
   - Repository: this repo
   - Workflow file: `.github/workflows/release.yml`
   - Environment (if used): match your npm trusted publishing config
3. Ensure npm account and org policies allow trusted publishing for the package.
4. Enable the `publish_cli` job and run a stable release; the workflow will:
   - align the release package versions to `X.Y.Z`
   - build web + server
   - invoke the CLI publish script with npm dist-tag `latest`
5. Nightly and canary runs invoke the same publish script with their matching npm dist-tag.

## 1) Release validation and unsigned builds

The workflow has no non-publishing `workflow_dispatch` mode. Use normal CI or local quality gates to
validate checks and builds without shipping. To exercise the complete release graph at lower stable
risk, manually dispatch `channel=nightly` or `channel=canary`; this still publishes a real GitHub
prerelease and desktop updater release. It does not publish npm packages, deploy hosted aliases, or
commit a version bump to `main` in the fork.

Manual `channel=stable` with a version input is also a real stable-channel release. Omitting signing
secrets only makes platform artifacts unsigned; it does not prevent publication.

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
10. Complete the Clerk Native API and AASA setup in [T3 Connect Clerk Setup](../internals/t3-connect.md#desktop-passkeys).
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

1. Ensure `main` is green in CI.
2. Review and merge the generated stable release PR.
3. Verify workflow steps:
   - preflight passes
   - all matrix builds pass
   - the fork's disabled `publish_cli` job remains skipped
   - release job uploads expected files
4. Smoke test downloaded artifacts.

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
