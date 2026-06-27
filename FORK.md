# Fork Notes

This repository is a fork of `pingdotgg/t3code`. Keep this file focused on fork behavior that intentionally differs from upstream.

## Changes

### Release And CI

- Fork workflows create/update a daily stable release PR while main-branch pushes produce nightly releases.
- Release build jobs skip relay client tracing config because the relay config job is disabled.
- Release builds publish updater metadata against the fork repository.
- Fork stable release versions are committed through release PRs before release artifacts are built and tagged.
- macOS release signing is separate from Apple notarization.
- Self-signed macOS signing certificates are trusted during release builds.
- macOS passkey entitlements are only enabled when Apple notarization/profile configuration is present.
- Windows releases can sign with the static certificate when Azure Trusted Signing is not configured.

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
- Threads can be archived with middle click.
- Terminal selection has a copy action.
