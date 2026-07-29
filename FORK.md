# Fork Notes

This repository is a fork of `pingdotgg/t3code`. Keep this file focused on fork behavior that intentionally differs from upstream.

## Maintenance Workflow

- Update this file in the same change whenever fork-only behavior changes.
- Keep workflow-only fork changes narrow and prefer job-level disables over broad refactors.
- Do not commit package version bumps solely to represent fork releases.
- Re-check Electron updater channel behavior when changing version strings, release metadata, or desktop packaging.
- Prepare fork PR branches from `origin/main` and target `tarik02/t3code:main`.
- If a fork PR branch includes unintended upstream history, rebuild it from `origin/main` and replay only the intended diff.

## Changes

### Maintenance

- Squash commits when merging fork PRs.
- Exception: upstream actualization PRs may preserve upstream commit structure when that makes future syncs easier to audit.
- Staged formatting tolerates chunks containing only ignored files so large upstream actualization commits can pass the pre-commit hook.

### Protocol Compatibility

- Fork protocol extensions use separate extension RPC methods and additive optional capabilities.
- Existing upstream RPC methods keep their upstream request, response, and behavior contracts so upstream clients remain compatible with the fork backend.
- Fork clients call a fork RPC only when the backend advertises its capability and otherwise retain the upstream RPC path.
- Fork backends keep the upstream RPC handler alongside each fork extension.

### Thread Delta Subscription

- Fork backends advertise `threadDeltaSubscription` and expose `orchestration.subscribeThread.withDelta` alongside the upstream thread subscription.
- Fork clients use the fork subscription only when advertised. Upstream backends therefore continue receiving the upstream subscription.
- The fork subscription replays gaps of at most 1,000 orchestration events and sends a fresh thread snapshot for larger or invalid gaps. If the thread no longer exists, it sends `not-found` so clients clear stale cached state.

### Release And CI

- Fork workflows create/update a daily stable release PR while main-branch pushes produce nightly releases.
- Stable release PRs list every commit since the previous stable tag, including commits brought in by upstream merges.
- Main-branch pushes update the stable release PR immediately when the committed package version is already tagged.
- Stable-version pushes wait for the matching release to finish so tag-based version resolution advances past the published version.
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

### Provider Instructions

- Default-mode Codex instructions allow `request_user_input` when configured instead of treating it as unavailable.

### Base Path And Remote URLs

- The fork includes base-path handling for served web assets and remote URL normalization.

### UX Changes

- Desktop context-menu style is configurable from Appearance settings.
- The sidebar follows the active thread when it appears or when navigation originates elsewhere.
- Sidebar environments can be hidden or shown dynamically from the project toolbar.
- Threads can be archived with middle click.
- Terminal selection has a copy action.
