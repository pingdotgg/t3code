# Fork Notes

This repository is a fork of `pingdotgg/t3code`. Keep this file focused on fork behavior that intentionally differs from upstream.

## Maintenance Workflow

- Update this file in the same change whenever fork-only behavior changes.
- Keep workflow-only fork changes narrow and prefer job-level disables over broad refactors.
- Do not commit package version bumps solely to represent fork releases.
- Re-check Electron updater channel behavior when changing version strings, release metadata, or desktop packaging.
- Prepare fork PR branches from `origin/main` and target `tarik02-org/t3code:main`.
- If a fork PR branch includes unintended upstream history, rebuild it from `origin/main` and replay only the intended diff.

## Changes

### Maintenance

- Squash commits when merging fork PRs.
- Exception: upstream actualization PRs may preserve upstream commit structure when that makes future syncs easier to audit.
- Staged formatting tolerates chunks containing only ignored files so large upstream actualization commits can pass the pre-commit hook.

### Compatibility

- Fork backend changes must remain compatible with non-fork clients. Upstream clients must be able to use a fork server without fork-specific assumptions or protocol failures.
- Fork database changes and migrations must leave the database usable by regular upstream builds. The upstream backend must still open and use the database, and the upstream frontend must still work through that backend. Prefer sidecar databases for fork-only data.

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

- Fork workflows create/update a daily stable release PR, main-branch pushes produce nightly releases, and canary-branch pushes produce canary releases.
- Canary releases use immutable `X.Y.Z-canary.YYYYMMDD.RUN` versions and GitHub prereleases without changing stable package versions.
- The Nix dependency hash workflow checks both `main` and `canary`, and targets repair PRs back to the branch that drifted.
- Stable release PRs list every commit since the previous stable tag, including commits brought in by upstream merges.
- Main-branch pushes update the stable release PR immediately when the committed package version is already tagged.
- Stable-version pushes wait for the matching release to finish so tag-based version resolution advances past the published version.
- Release build jobs skip relay client tracing config because the relay config job is disabled.
- Release builds publish updater metadata against the fork repository.
- Fork stable release versions use date-based `YYYY.M.DDSS` numbers without build metadata. Release PRs commit them before release artifacts are built and tagged.
- macOS release signing is separate from Apple notarization.
- Self-signed macOS signing certificates are trusted during release builds.
- macOS passkey entitlements are only enabled when Apple notarization/profile configuration is present.
- Windows releases can sign with the static certificate when Azure Trusted Signing is not configured.
- Fork GitHub Actions jobs use GitHub-hosted runners instead of upstream private or third-party runner pools.
- Fork test runs limit package task concurrency to two to avoid starving tests on GitHub-hosted runners.
- Web dist release archives are built as hosted static apps and carry the release channel.

### Nix Package

- The fork exposes the server and web bundle as an `x86_64-linux` flake package.
- The package version follows the server manifest by default and supports generated nightly and canary version overrides.
- Main- and canary-branch pushes verify the pnpm dependency hash, open or update a repair PR against the affected branch when it drifts, and fail the source workflow run.

### Desktop Updater Channels

- Stable builds use `latest`, nightly builds use `nightly`, and canary builds use `canary`.
- Nightly and canary detection accepts fork release metadata while preserving separate updater feeds.
- Canary desktop builds isolate server and client state under `~/.t3/canary` and Electron data under `t3code-canary`. Desktop settings stay shared so update-track changes survive channel switches.

### Fork Persistence

- Fork-only goal persistence is stored in a sidecar database named `state-tarik02.sqlite`.
- Bounded live-thread snapshots use fork-namespaced cache keys, so the fork never decodes legacy
  unbounded snapshot JSON during startup and upstream clients ignore the fork cache entries.
- The web client keeps fetched thread-history rows in an unbounded, normalized sidecar IndexedDB
  cache. Messages, activities, and plans are stored once and reused for covered history ranges.
  Cached records are schema-decoded independently so large activity batches cannot stall on a
  cooperative runtime yield. An authoritative bounded snapshot clears cached segments because it
  may replace an event replay that contained a thread revert.
- The mobile client keeps recently fetched thread-history pages in a bounded, session-only
  in-memory LRU. It avoids repeat requests while browsing nearby segments without adding mobile
  database state or migrations, and it does not request the web-only minimap outline.

### Goals UI

- The fork adds thread goal support, goal activity rendering, and goal sidebar/panel UI.

### Provider Launch Environment

- Provider sessions use a shared launch environment pipeline instead of ad hoc environment assembly.

### Provider Instructions

- Default-mode Codex instructions allow `request_user_input` when configured instead of treating it as unavailable.

### Base Path And Remote URLs

- The fork includes base-path handling for served web assets and remote URL normalization.

### UX Changes

- Progressive thread history is a client-local beta setting and defaults to off. Disabled clients
  use the full-history subscription and do not request bounded message pages.
- Thread detail snapshots keep a bounded live tail. Historical browsing uses bounded,
  bidirectional keyset windows cut only at user-turn boundaries, while the web minimap indexes every
  user message across the full thread and loads the selected segment on demand. One LegendList owns
  both live and historical scrolling, and its visible-content anchoring stabilizes page changes and
  late row measurements. The local scrollbar only represents the current bounded segment; the
  minimap is the global conversation-indexed scrubber. Historical windows retain every raw message
  and work-telemetry row belonging to their turns, and only display activity for turns represented
  by the active message window. Reaching a segment edge loads the adjacent window
  without moving visible rows. Scroll-to-end returns directly to the bounded live tail.
- Paginated history responses use the same client-facing activity payload projection as full thread
  snapshots, and command output omitted by that projection is removed in SQLite before schema decode.
  The persisted activity remains unchanged.
- Failed segment requests release their pending navigation target. Keyboard, pointer, touch, or wheel
  input immediately cancels target alignment. Minimap dragging follows the pointer immediately while
  throttling segment requests, and only the latest explicit jump may replace the active segment.
- Desktop context-menu style is configurable from Appearance settings.
- The sidebar follows the active thread when it appears or when navigation originates elsewhere.
- Sidebar environments can be hidden or shown dynamically from the project toolbar.
- Threads can be archived with middle click.
- Terminal selection has a copy action.
