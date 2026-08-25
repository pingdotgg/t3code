# Fork Releases

> For maintainers of `nolaurence/t3code-chinese`.

This fork has one GitHub Actions workflow: [`.github/workflows/release.yml`](../../.github/workflows/release.yml).
Upstream CI, deployment, npm, mobile, and AUR workflows are intentionally not carried by the fork.

## Schedule and triggers

- The workflow checks `main` once a day at 18:00 UTC (02:00 Asia/Shanghai).
- A scheduled run exits after the change check when `main` still points at the last nightly tag.
- `workflow_dispatch` always builds a nightly and can be used to validate workflow changes.
- Pushing an exact `vX.Y.Z` tag builds a stable release. Suffixed versions such as `-dev` are rejected.
- Concurrency is limited to one release run; an active release is never cancelled by a newer run.

## Published artifacts

Every release runs the workspace quality gates and release smoke checks, then builds:

- macOS arm64 DMG and update ZIP
- macOS x64 DMG and update ZIP
- Linux x64 AppImage
- Windows x64 NSIS installer
- Electron update manifests and blockmaps for those artifacts

The workflow publishes nightly files as a GitHub prerelease and stable files as the latest GitHub
release in this repository. It does not publish the `t3` npm package, deploy T3 Connect Relay or the
hosted web app, update AUR, or send announcements.

Because the fork does not publish `t3`, a client cannot automatically update an independently
installed remote server to the nightly's exact version through npm. The desktop-bundled server and
manually deployed compatible remote servers remain available. Restoring exact-version remote updates
requires a fork-owned npm package plus matching client/server update configuration.

Nightly tags use `vX.Y.Z-nightly.YYYYMMDD.<run_number>`. The base is the next patch after the version
in `apps/desktop/package.json`. Package versions are changed only inside the release runners.
Stable tags and package versions use exact `X.Y.Z` versions.

## Optional public configuration

Desktop artifacts work without T3 Connect. Define these repository variables only when the fork has
its own compatible services:

- `RELAY_URL`
- `CLERK_PUBLISHABLE_KEY`
- `CLERK_JWT_TEMPLATE`
- `CLERK_CLI_OAUTH_CLIENT_ID`
- `CLERK_PASSKEY_RP_DOMAINS`

The updater repository is derived from `GITHUB_REPOSITORY`, so fork builds check this repository for
updates instead of the upstream repository.

## Optional signing

Unsigned artifacts are the default. macOS signing and notarization require all of:

- Secrets: `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_API_KEY`, `APPLE_API_KEY_ID`,
  `APPLE_API_ISSUER`, `MACOS_PROVISIONING_PROFILE`
- Variable: `APPLE_TEAM_ID`
- Either `CLERK_PUBLISHABLE_KEY` or `CLERK_PASSKEY_RP_DOMAINS` for the passkey entitlement

Windows Azure Trusted Signing requires all of:

- `AZURE_TENANT_ID`
- `AZURE_CLIENT_ID`
- `AZURE_CLIENT_SECRET`
- `AZURE_TRUSTED_SIGNING_ENDPOINT`
- `AZURE_TRUSTED_SIGNING_ACCOUNT_NAME`
- `AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME`
- `AZURE_TRUSTED_SIGNING_PUBLISHER_NAME`

If a complete credential set is absent, that platform builds unsigned. A partially configured
credential set should be treated as an error and completed or removed.

## Validation

1. Push the workflow to a branch in this repository.
2. Open **Actions > Fork Release > Run workflow** and select that branch.
3. Confirm all four build variants and the quality job pass.
4. Confirm the GitHub release contains installers, macOS ZIPs, manifests, and blockmaps.
5. Install at least one artifact per operating system before relying on the daily schedule.

The local release-only checks are:

```bash
vp run release:smoke
vp test run scripts/resolve-nightly-release.test.ts \
  scripts/resolve-previous-release-tag.test.ts \
  scripts/update-release-package-versions.test.ts \
  scripts/merge-update-manifests.test.ts
```
