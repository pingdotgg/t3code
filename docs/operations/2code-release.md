# 2code desktop release takeover

The `2code Release` workflow publishes the legacy macOS Electron update channel from the
`main-2code` branch without changing the upstream T3 Code release workflow. Existing 2code clients
continue to poll the same Cloudflare R2 feed.

The native Swift/Sparkle application is a separate product and is not part of this workflow.

## Production identity

Do not change these values without intentionally ending compatibility with installed 2code clients:

- Bundle identifier: `dev.hafencity.dev.agents`
- Product and executable name: `2code`
- Apple team: `D78YC33UVC`
- Architecture: `arm64`
- Update feed: `https://pub-cb9e18e7e55d46cf9c297e4b612881f7.r2.dev/releases/desktop`
- Updater cache: `2code-updater`
- Legacy URL scheme: `twentyfirst-agents`
- GitHub tag namespace: `2code-v*`

The release verifier checks the bundle identity, exact Developer ID authority, designated
requirement, hardened-runtime entitlements, protocol schemes, embedded distribution/runtime
metadata, updater configuration, architecture, notarization ticket, Gatekeeper assessment, and all
manifest hashes before publication.

## GitHub setup

Protect `main-2code` before enabling publishing:

1. Make `main-2code` the fork repository's default branch so GitHub exposes the manual dry-run,
   promote, and recovery controls. Keep `main` as the clean upstream-sync mirror.
2. Require pull requests and the `Validate 2code release` check.
3. Disallow force pushes and branch deletion.
4. Require owner review for the release workflow, `distributions/2code`, the desktop distribution
   profile, and `scripts/fork/2code-release`.
5. Create a protected environment named `2code-production` restricted to `main-2code`.
6. Require a production reviewer at least for the first takeover releases.

Configure these signing secrets in the protected `2code-production` environment:

- `CSC_LINK`
- `CSC_KEY_PASSWORD`
- `APPLE_ID`
- `APPLE_APP_SPECIFIC_PASSWORD`
- `APPLE_TEAM_ID`

Configure the R2 secrets in that same protected environment:

- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `CLOUDFLARE_ACCOUNT_ID`

The R2 credential should be scoped to the `2code` bucket. Pull requests receive none of these
secrets. The workflow uses GitHub's short-lived `GITHUB_TOKEN` for the supplementary GitHub release.

## Safe bootstrap

The checked-in release version intentionally matches the current live version, `1.0.107`. Therefore
the first push only reads and compares `latest-mac.yml` and `beta-mac.yml`, then exits without a build,
tag, release, or R2 mutation.

Never start the takeover by changing the bundle identifier or by resetting the version to the T3
runtime version. The desktop updater version and embedded T3 runtime version are deliberately
separate.

## Signed dry run

Run the workflow manually with action `dry-run` to build, sign, notarize, and verify the configured
version without creating a tag or writing to R2. The verified candidate is retained as a GitHub
Actions artifact for 30 days.

The signing build and every mutation job use the protected production environment. Inspect the
signed dry-run artifact before approving the first real version bump.

The workspace pins `@electron/notarize` to at least `3.1.1`. Earlier releases pass the bare
digit-leading name `2code.app` to `codesign`, which macOS parses as a process selector instead of a
path. Keep the override during upstream syncs until Electron Builder itself depends on a version
containing [electron/notarize#245](https://github.com/electron/notarize/pull/245).

## Publish a release

1. Increase only `version` in `distributions/2code/release.json`. It must never be below the live
   version and must not be reused for different app bytes.
2. Optionally set `stagingPercentage` from `1` to `99` for a staged rollout. `100` removes the staging
   field and releases to everyone.
3. Merge the change into `main-2code`.
4. Inspect the signed build and approve the `2code-production` environment.

Publication is serialized and cannot be canceled by a newer run. It proceeds in this order:

1. Verify the transferred candidate again.
2. Create a draft `2code-v<version>` GitHub release and upload assets without overwriting different
   bytes.
3. Upload content-addressed ZIP, DMG, and blockmap objects to R2.
4. Download every object through the public CDN and verify its size and SHA-512.
5. Archive the previous latest and beta manifests independently.
6. Upload and verify `beta-mac.yml`.
7. Upload `latest-mac.yml` as the final updater mutation and verify it publicly.
8. Publish the prepared GitHub draft.

Retries are safe. Existing immutable objects must contain identical bytes. If a beta-first pointer
activation was interrupted, preflight resumes the exact already-live, content-addressed candidate
without rebuilding different bytes under the same version. A rerun after full R2 activation verifies
the release plan, every GitHub asset, the tag commit, and both live manifests before publishing the
draft GitHub release.

## Promote a staged rollout

Run the workflow manually on `main-2code` with:

- action: `promote`
- staging percentage: an integer greater than the current percentage and no greater than `100`

Both latest and beta channels must already contain the configured version. Their previous rollout
manifests are archived independently before beta and then latest are advanced.

## Recovery

Run the workflow manually on `main-2code` with:

- action: `recovery`
- recovery version: the currently live version whose rollout should be stopped

The job restores the independently archived latest and beta manifests, with latest again written
last. It also archives the manifests that were live when recovery started.

Recovery stops additional clients from receiving the bad version. It does **not** downgrade clients
that already installed it because the legacy updater has downgrades disabled. Ship the actual fix as
a new, higher patch version.

## Cut over from the old repository

The old and new workflows must never retain concurrent write authority over the production feed.
Immediately before approving the first production job from this repository:

1. Disable `Build And Publish Main Release` in `hafencity-dev/2code`.
2. Confirm no old release job is running.
3. Approve the new protected production job.
4. Verify both public manifests and perform an isolated `1.0.107` to new-version update.
5. Remove or revoke the old repository's R2 write credentials after the successful cutover.

Do not delete the old repository or its immutable release assets. Do not modify the separate native
macOS/Sparkle workflow as part of the Electron updater takeover.
