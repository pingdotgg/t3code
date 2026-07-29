# Fork Notes

This repository is a fork of `pingdotgg/t3code`. Keep this file focused on fork behavior that intentionally differs from upstream.

## Changes

### Maintenance

- Squash commits when merging fork PRs.
- Exception: upstream actualization PRs may preserve upstream commit structure when that makes future syncs easier to audit.
- Staged formatting tolerates chunks containing only ignored files so large upstream actualization commits can pass the pre-commit hook.

### Release And CI

- Fork workflows create/update a daily stable release PR while main-branch pushes produce nightly releases.
- Stable release PRs list every commit since the previous stable tag, including commits brought in by upstream merges.
- Release PR preparation runs after release publication so tag-based version resolution sees the latest release.
- Release build jobs skip relay client tracing config because the relay config job is disabled.
- Release builds publish updater metadata against the fork repository.
- Fork stable release versions are committed through release PRs before release artifacts are built and tagged.
- macOS release signing is separate from Apple notarization.
- Self-signed macOS signing certificates are trusted during release builds.
- macOS passkey entitlements are only enabled when Apple notarization/profile configuration is present.
- Windows releases can sign with the static certificate when Azure Trusted Signing is not configured.
- Fork GitHub Actions jobs use GitHub-hosted runners instead of upstream private or third-party runner pools.
- Fork test runs limit package task concurrency to two to avoid starving tests on GitHub-hosted runners.
- Web dist release archives are built as hosted static apps and carry the release channel.

### Nix Package

- The fork exposes the server and web bundle as an `x86_64-linux` flake package.
- The package version follows the server manifest by default and supports the generated nightly version override.
- Main-branch pushes verify the pnpm dependency hash, open or update a repair PR when it drifts, and fail the source workflow run.

### Desktop Updater Channels

- Stable builds use `latest`; nightly builds use `nightly`.
- Nightly detection accepts fork release metadata while preserving the upstream channel split.

### Fork Persistence

- Fork-only goal persistence is stored in a sidecar database named `state-tarik02.sqlite`.

### Goals UI

- The fork adds thread goal support, goal activity rendering, and goal sidebar/panel UI.

### Provider Launch Environment

- Provider sessions use a shared launch environment pipeline instead of ad hoc environment assembly.

### Base Path And Remote URLs

- The fork includes base-path handling for served web assets and remote URL normalization.

### UX Changes

- Desktop context-menu style is configurable.
- The sidebar follows the active thread when it appears or when navigation originates elsewhere.
- Sidebar environments can be hidden or shown dynamically from the project toolbar.
- Threads can be archived with middle click.
- Terminal selection has a copy action.
