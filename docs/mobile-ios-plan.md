# T3Code Mobile iOS Plan

## Goal

Create a production-quality native iOS app for T3Code that feels as fast and polished as Kitty/Litter while staying fully consistent with the T3Code desktop/web application. The iOS app should show the same environments, projects, chat list, chat history, streaming turns, approvals, diffs, proposed plans, and session lifecycle state as desktop.

The mobile app must not embed provider harness logic. Codex, Claude, opencode, ACP, and future providers remain server-side concerns owned by T3Code. iOS consumes the T3Code orchestration sync model.

## Product principles

1. Native iOS first: SwiftUI, Swift concurrency, Apple platform conventions, and excellent App Store-quality performance.
2. One source of truth: T3Code server owns provider runtime, orchestration events, projections, credentials, and session lifecycle.
3. Same sync model as desktop: mobile consumes the same shell/detail projections and dispatches the same client commands.
4. Litter/Kitty components are allowed to be reused directly, with refactors where needed to bind them to T3Code sync instead of Litter's Codex mobile client.
5. Offline-friendly read path: cached shell/thread views should appear immediately, then reconcile from the server.
6. Predictable failure behavior: reconnects, replay, partial streams, token refresh, app backgrounding, and server restarts must be explicit states.

## Architecture summary

```text
apps/mobile/                         Placeholder for native iOS app
docs/mobile-ios-plan.md              Current implementation plan

T3Code server
  packages/contracts                 Source schemas for orchestration model
  apps/server                         Provider sessions, projections, auth, WebSocket/RPC

iOS app
  SwiftUI views copied/refactored from Litter where useful
  T3 sync client over a Swift-friendly protocol
  Local SQLite cache for snapshots/events
  Keychain for saved environment credentials
```

Mobile should speak to T3Code, not directly to Codex app-server. The server already exposes the domain boundaries mobile needs:

- `orchestration.subscribeShell`: projects and thread list shell projection.
- `orchestration.subscribeThread`: selected thread detail projection plus live events.
- `orchestration.replayEvents`: sequence-based catch-up after reconnect.
- `orchestration.dispatchCommand`: create project/thread, start turns, interrupt, approve, answer prompts, archive/delete/fork, stop sessions.
- `getTurnDiff` and `getFullThreadDiff`: diff rendering.
- Remote auth endpoints: bearer bootstrap, session state, and WebSocket token issuance.

## Key decision: Swift-friendly sync gateway

The web app uses Effect RPC over WebSocket. Reimplementing Effect RPC framing in Swift would couple the native app to a TypeScript runtime detail and slow down iteration.

Preferred path:

1. Keep the existing Effect RPC protocol for web/desktop.
2. Add a versioned mobile sync gateway in `apps/server` using the same service layer and schemas.
3. Expose plain JSON messages over WebSocket plus small HTTP endpoints for bootstrap/auth.
4. Generate or hand-maintain Swift `Codable` DTOs from the orchestration contract subset.
5. Treat protocol compatibility as a release constraint because App Store clients cannot update in lockstep with the server.

Hard requirements:

- All mobile endpoints must live under an explicit version prefix, starting with `/mobile/v1/...`.
- Mobile auth endpoints must also be versioned under `/mobile/v1/auth/...`. They may delegate internally to existing `/api/auth/...` services, but released mobile clients should not call unversioned/shared auth routes directly.
- Mobile clients must send a protocol version and client capabilities during HTTP bootstrap and WebSocket connect.
- Server responses must include protocol version and server capabilities so the app can disable unsupported UI instead of guessing.
- Breaking protocol changes require a new versioned route, not an in-place change to `/mobile/v1`.
- The server must keep enough compatibility surface for released App Store clients or fail with a typed unsupported-version response.

Example mobile WebSocket frame shape:

```json
{
  "id": "request-123",
  "type": "request",
  "protocolVersion": "mobile.v1",
  "method": "orchestration.subscribeShell",
  "payload": {}
}
```

```json
{
  "id": "request-123",
  "type": "stream",
  "protocolVersion": "mobile.v1",
  "payload": {
    "kind": "snapshot",
    "snapshot": {
      "snapshotSequence": 42,
      "projects": [],
      "threads": [],
      "updatedAt": "2026-05-10T00:00:00.000Z"
    }
  }
}
```

The gateway must not create a second projection model. It should call the same orchestration services that back existing RPC methods.

## Protocol durability and replay semantics

The first milestone must prove the sync contract before significant UI import work. The mobile app is only production-quality if replay, idempotency, and resnapshot behavior are specified and tested.

### Sequence model

- `OrchestrationEvent.sequence` is the durable event sequence used for replay.
- `snapshotSequence` on shell and thread snapshots represents the highest event sequence included in that projection snapshot.
- Shell snapshots and thread snapshots may project different subsets of the same global event stream, but their `snapshotSequence` values must still be comparable against replay responses.
- Mobile stores sequence cursors per environment and per subscription scope:
  - shell cursor: latest sequence applied to the shell projection
  - thread cursor: latest sequence applied to each subscribed thread projection
- The initial implementation should assume a global per-environment event sequence unless the server explicitly documents a narrower scope. If the server later changes sequence scope, that requires a protocol-versioned capability.
- Because replay is global per environment, mobile should request replay from the minimum relevant durable cursor across shell and active thread projections, then apply only relevant events to each projection. This prevents a fast-advancing shell cursor from masking a lagging thread cursor.

### Snapshot and event rules

- A snapshot replaces the affected projection and advances that projection cursor to `snapshotSequence`.
- An event applies only if its `sequence` is greater than the stored cursor for the affected projection.
- Duplicate events are ignored by `(sequence, eventId)`.
- Out-of-order events are buffered only within a small bounded window. If the gap is not filled quickly, mobile marks a replay gap and requests a fresh snapshot.
- Shell stream events update only shell/list projections.
- Thread stream events update only the subscribed thread detail projection, except where a server-sent shell upsert also arrives through the shell stream.

### Replay gap behavior

The mobile replay response must distinguish:

- full replay available
- replay range partially unavailable
- requested cursor is too old
- requested cursor is from an incompatible protocol/schema version

`/mobile/v1` replay must not simply expose the existing `orchestration.replayEvents` RPC shape unchanged, because the existing RPC returns only an event array. The mobile response needs an explicit envelope with replay status, returned event range, server high-water sequence, and resnapshot instructions for gap cases.

If replay has a gap, mobile must:

1. Stop applying events for the affected projection.
2. Mark the projection as stale/degraded, not empty.
3. Request a fresh shell or thread snapshot.
4. Replace the local projection from that snapshot.
5. Store the new cursor transactionally with the snapshot.

### Command idempotency

- Every mobile command must include a stable client-generated `commandId`.
- The server must treat repeated `commandId` submissions as idempotent within the command retention window.
- `/mobile/v1` needs a server-side command receipt/idempotency store or equivalent retention rule. This is server behavior, not just mobile retry behavior.
- Mobile stores pending commands with lifecycle state: `created`, `sent`, `accepted`, `rejected`, `reconciled`, `expired`.
- `accepted` means the server accepted the command for processing; it does not mean the requested domain state is visible yet.
- `reconciled` means the expected event/projection state has arrived.
- On reconnect, mobile may resend commands in `created` or `sent` states. It must not duplicate UI state optimistically unless the server confirms idempotent acceptance.

## iOS app module layout

Initial target layout once the empty scaffold becomes a project:

```text
apps/mobile/
  project.yml                         XcodeGen source of truth
  T3CodeMobile.xcodeproj              Generated, not hand-edited
  Sources/T3CodeMobile/
    App/
      T3CodeMobileApp.swift
      AppRoute.swift
      AppEnvironment.swift
    DesignSystem/
      Theme/
      Components/
      Markdown/
      Diff/
    Sync/
      T3SyncClient.swift
      T3WebSocketTransport.swift
      T3HttpClient.swift
      T3SyncEngine.swift
      T3SyncReducer.swift
      T3SyncCursorStore.swift
    Contracts/
      Generated/
      Manual/
    Persistence/
      MobileDatabase.swift
      ShellSnapshotStore.swift
      ThreadSnapshotStore.swift
      EventCursorStore.swift
      CredentialStore.swift
    Features/
      Environments/
      Projects/
      Threads/
      Chat/
      Approvals/
      Diffs/
      Settings/
      Onboarding/
    Shared/
      Logging/
      Connectivity/
      Haptics/
      BackgroundTasks/
  Tests/
    SyncTests/
    ReducerTests/
    SnapshotDecodeTests/
```

Use separate Swift files for separate types. Prefer feature folders over large monolithic files.

## Litter/Kitty code reuse plan

The Litter iOS app already has a strong native UX and useful production code. Reuse should be deliberate: copy components, then replace their data/runtime dependencies with T3Code sync concepts.

Treat Litter as UX/component source material, not as the mobile architecture. T3Code mobile should avoid importing Litter's app model, runtime controller shape, Codex bridge ownership, SSH bootstrap flow, voice/watch runtime, or local harness management unless a specific piece maps cleanly onto T3 projections.

High-value source areas:

- `Views/SessionsScreen.swift`: home/list shell for sessions.
- `Views/HomeSessionsScrollView.swift`: rich session rows and live session affordances.
- `Views/ConversationView.swift`: conversation container, composer placement, scroll behavior.
- `Views/ConversationTimelineView.swift`: timeline rows, turn diffs, activity display patterns.
- `Views/MessageBubbleView.swift`: message bubble, markdown, selectable content.
- `Views/DiffRendering.swift`: syntax-highlighted diff rendering.
- `Views/DiscoveryView.swift`: server discovery and connection UX.
- `Views/SettingsView.swift`, `AppearanceSettingsView.swift`: native settings structure.
- `Views/ProjectChip.swift`, `ServerPillRow.swift`, `ChatWallpaperBackground.swift`: reusable visual components.
- `LitterApp.swift` approval prompt sections: adapt to T3Code approval/user-input events.

Refactor rules when copying:

1. Keep SwiftUI view code, styling, animations, and interaction design where it fits T3Code.
2. Delete or isolate direct Codex mobile client dependencies.
3. Replace Litter session/runtime models with T3Code orchestration DTOs and view models.
4. Move copied components into focused files; do not preserve very large source files if they mix app lifecycle, runtime, and UI.
5. Preserve attribution and provenance in a repo-level third-party notice or source headers according to the approved arrangement.
6. Prefer rows, visual components, composer behavior, diff rendering, and interaction patterns over runtime/discovery/control-plane code.

## T3Code contract mapping

### Shell projection

Swift model equivalents:

- `OrchestrationShellSnapshot`
- `OrchestrationProjectShell`
- `OrchestrationThreadShell`
- `OrchestrationSession`
- `OrchestrationLatestTurn`

Used by:

- environment switcher
- project list
- chat/session list
- unread/running/pending approval indicators
- app badge/live activity candidates

### Thread detail projection

Swift model equivalents:

- `OrchestrationThreadDetailSnapshot`
- `OrchestrationThread`
- `OrchestrationMessage`
- `OrchestrationThreadActivity`
- `OrchestrationCheckpointSummary`
- `OrchestrationProposedPlan`

Used by:

- chat transcript
- streaming assistant content
- tool/activity rows
- proposed plan cards
- checkpoint and diff cards
- thread metadata headers

### Client commands

MVP is **read + chat**. Swift command builders should first support only the commands needed for reading, chatting, approvals, user input, session stop, and on-demand diffs.

MVP commands:

- `thread.turn.start`
- `thread.turn.interrupt`
- `thread.approval.respond`
- `thread.user-input.respond`
- `thread.session.stop`
- `getTurnDiff`
- `getFullThreadDiff`

Later parity commands:

- `project.create`
- `project.meta.update`
- `project.delete`
- `thread.create`
- `thread.checkpoint.revert`
- `thread.archive`
- `thread.unarchive`
- `thread.delete`
- `thread.fork`
- `thread.runtime-mode.set`
- `thread.pending-runtime-mode.set`
- `thread.interaction-mode.set`

Every command should carry a client-generated `commandId` and client timestamp. The server remains responsible for validation and resulting event sequence.

## Sync engine design

The mobile sync engine should be an explicit state machine:

```text
idle
  -> loadingCache
  -> authenticating
  -> connecting
  -> hydrating
  -> live
  -> reconnecting
  -> degraded
  -> signedOut
```

Startup flow:

1. Load saved environment records from local persistence.
2. Load cached shell snapshot and selected thread snapshots.
3. Render cached UI immediately with stale/connectivity indicators.
4. Issue/refresh WebSocket token through HTTP.
5. Connect WebSocket.
6. Exchange protocol version and capabilities.
7. Subscribe to shell.
8. Replay events from the last durable sequence if needed.
9. Subscribe to visible/active thread details.
10. Persist snapshots and sequence cursors transactionally.

Reconnect flow:

1. Mark UI as reconnecting, not empty.
2. Keep cached shell/thread visible.
3. Reissue short-lived WebSocket token.
4. Reconnect.
5. Re-exchange protocol version and capabilities.
6. Replay from last acknowledged durable sequence.
7. If replay has a gap, discard the affected projection cache and resnapshot.
8. Resume shell and active thread streams.
9. Drop duplicate events by sequence/event id.

Backgrounding flow:

1. Finish in-flight persistence writes.
2. Close or suspend active WebSocket according to iOS lifecycle.
3. Keep enough state to resume from last sequence.
4. Use push notifications or background refresh later for remote updates, not as the primary sync mechanism.

## Persistence

Use SQLite for production predictability and fast cold start. SwiftData can be revisited later, but the sync model is event/projection oriented and benefits from explicit tables.

Proposed tables:

- `environments`: saved server records, display metadata, health, last connected time, and last negotiated protocol version.
- `shell_snapshots`: latest shell snapshot per environment, including protocol version and snapshot schema version.
- `thread_snapshots`: latest thread detail snapshot per environment/thread, including protocol version and snapshot schema version.
- `event_cursors`: last durable sequence per environment and stream scope.
- `subscription_cursors`: latest sequence per active or recently active thread subscription.
- `replay_gaps`: gap/error state for projections that require a resnapshot.
- `pending_commands`: command lifecycle (`created`, `sent`, `accepted`, `rejected`, `reconciled`, `expired`) plus command id, payload hash, and timestamps.
- `attachments`: local upload metadata and preview cache.

Credentials belong in Keychain, not SQLite:

- bearer/session token material
- pairing secrets
- any future SSH/tunnel credentials

The app should tolerate schema migrations from day one.

## UI feature plan

### Onboarding and environments

Start with direct/Tailscale T3Code server connection:

- paste pairing URL/token
- manual HTTP/WebSocket URL entry
- LAN, Tailscale MagicDNS/IP, or manually entered HTTPS/WSS URL
- saved environment list
- connection test
- token bootstrap
- sign out/remove environment

Later additions can borrow from Litter:

- LAN discovery
- SSH tunnel setup
- Tailnet-friendly connection helpers
- QR pairing

No SSH bootstrap, relay dependency, ngrok/pgrok flow, or local harness launch should be part of v1. Those add a second runtime setup surface and should wait until the T3 sync contract is proven.

### Chat/session list

Backed by `OrchestrationShellSnapshot`.

Requirements:

- group by project/environment
- show thread title, project, branch/worktree, model/provider instance
- running/ready/error/stopped indicators
- latest user message time
- pending approval/user input indicators
- archive/delete context menus
- search/filter
- fast scroll on thousands of threads

### Chat detail

Backed by `OrchestrationThreadDetailSnapshot` and live thread events.

Requirements:

- stable transcript rendering during streaming
- user/assistant/system message bubbles
- activity/tool rows
- markdown/code rendering
- proposed plan cards
- checkpoint cards
- diff detail sheet
- jump to latest
- preserve scroll position across live updates and background/resume
- reply composer
- image attachments only if T3 orchestration has verified end-to-end mobile upload support

### Approvals and user input

Map T3 provider runtime requests to mobile-native prompts:

- command execution approval
- file read approval
- file change/apply patch approval
- dynamic tool/user input forms
- auth/token refresh prompts if surfaced by server

Actions dispatch `thread.approval.respond` or `thread.user-input.respond`. The app should never assume approval succeeded until server events confirm resolution.

### Diffs and checkpoints

Use `getTurnDiff` and `getFullThreadDiff`.

Requirements:

- compact diff summary card in timeline
- full-screen diff viewer
- syntax-highlighted additions/deletions
- file list with additions/deletions
- revert checkpoint action via `thread.checkpoint.revert`

### Activity and tool rows

T3 currently exposes tool calls, reasoning, and many provider-runtime details as `OrchestrationThreadActivity` with `tone`, `kind`, `summary`, `payload`, `turnId`, and timestamp.

MVP behavior:

- render `kind` and `summary`
- use `tone` for visual treatment
- show generic JSON/details sheet only when useful
- do not depend on provider-specific raw payloads

Later parity work should add typed mobile activity payload variants for command execution, file changes, approvals, reasoning summaries, dynamic tool calls, and tool user input.

### Settings

Initial settings:

- environments
- appearance/theme
- default notification preferences
- diagnostics/log export
- privacy/security
- about/build info

## SwiftUI implementation standards

Use modern SwiftUI patterns:

- `NavigationStack` for iPhone flows.
- `NavigationSplitView` only if adding iPad/macOS layout later.
- `navigationDestination(for:)` route registration rather than old `NavigationLink(destination:)` patterns.
- `@Observable @MainActor` models for UI-owned shared state.
- `actor` types for network and persistence workers.
- `task()` for async view work; avoid expensive work in `body`.
- Break heavy rows into dedicated `View` files to preserve performance and readability.
- Avoid `AnyView` unless there is no cleaner generic or `@ViewBuilder` alternative.
- Use `LazyVStack`/`List` appropriately for long transcripts and shell lists.
- Respect Dynamic Type, VoiceOver labels, Reduce Motion, and high-contrast settings from the start.

Suggested app-level observable models:

- `AppModel`: selected environment, navigation, app lifecycle.
- `EnvironmentListModel`: saved environments and connection summaries.
- `ShellModel`: projected shell state for one environment.
- `ThreadDetailModel`: selected thread state and command actions.
- `ComposerModel`: text, attachments, send/interrupt state.

Network/persistence should not be `@Observable`; keep them as actors/services injected into models.

## Server work required

### Mobile gateway

Add a server module beside existing WebSocket RPC handling:

- HTTP route for mobile descriptor/capabilities.
- HTTP route for `/mobile/v1/auth/bootstrap/bearer`, implemented by delegating to existing auth services.
- HTTP route for `/mobile/v1/auth/session`, implemented by delegating to existing auth services.
- HTTP route for `/mobile/v1/auth/ws-token`, implemented by delegating to existing auth services.
- WebSocket route for `/mobile/v1/ws` JSON protocol.
- Explicit protocol/capabilities handshake.
- Stream subscription management.
- Request/response correlation.
- Backpressure and cancellation handling.
- Mobile replay envelope with status, returned range, high-water sequence, replay gap responses, and typed resnapshot requirements.
- Command idempotency by `commandId`.
- Schema validation using existing Effect schemas before sending to Swift clients.

### Contract export

Pick one of:

1. Generate JSON Schema from `@t3tools/contracts`, then generate Swift `Codable` models.
2. Maintain hand-written Swift DTOs for the orchestration subset and add fixture-based compatibility tests.

Preferred initial path: hand-written DTOs for speed, backed by golden JSON fixtures from TypeScript tests. Move to generation once the mobile gateway stabilizes.

Hand-written DTOs require a drift alarm in CI:

- TypeScript emits canonical payload fixtures from `@t3tools/contracts` schemas.
- Swift decodes every emitted server fixture.
- Swift emits command fixtures for mobile command builders.
- TypeScript validates every Swift command fixture against server schemas.
- Any fixture/schema mismatch fails CI before a mobile release can drift from server contracts.

### Compatibility tests

Add shared fixtures:

- shell snapshot
- thread detail snapshot
- each shell stream event kind
- each thread event kind mobile renders
- command receipt success/failure
- reconnect/replay event batch

Swift tests decode fixtures. TypeScript tests ensure server emits fixture-compatible payloads.

The first compatibility suite should include bidirectional fixtures:

- TypeScript -> Swift: shell snapshot, thread detail snapshot, shell stream events, thread stream events, replay responses, replay gap responses, command receipts, typed errors.
- Swift -> TypeScript: `thread.turn.start`, `thread.turn.interrupt`, `thread.approval.respond`, `thread.user-input.respond`, `thread.session.stop`, `getTurnDiff`, `getFullThreadDiff`.

## Performance targets

Initial production thresholds:

- cached shell visible under 300ms after app launch on a recent iPhone
- active thread cached transcript visible under 500ms
- live assistant deltas render without scroll jank
- shell list remains smooth with 5,000 threads
- selected thread remains smooth with 2,000 messages/activities
- reconnect path keeps visible cached content and reconciles without flicker

Implementation tactics:

- render cached projections immediately
- avoid expensive sorting/filtering in SwiftUI `body`
- precompute shell sections in models
- keep rows small and identifiable
- persist snapshots off the main actor
- coalesce high-frequency streaming deltas before UI writes if needed
- avoid full transcript replacement during small live updates

Measurement hooks belong in the first Swift slices, not late hardening. Add signposts/log timings for:

- app launch start
- cached shell load complete
- first shell render
- WebSocket connected
- first shell snapshot received
- first thread snapshot received
- first live event applied
- active transcript render complete
- replay gap detected
- resnapshot complete

## Implementation slices

### Slice 0: Repo scaffold and plan

- Create `apps/mobile/` placeholder.
- Keep detailed plan in `docs/mobile-ios-plan.md`.

### Slice 1: Versioned mobile gateway contract spike

- Add `/mobile/v1` HTTP descriptor/capabilities route.
- Add `/mobile/v1/auth/...` wrappers for bearer bootstrap, session, and WebSocket token issuance.
- Add `/mobile/v1/ws` plain JSON WebSocket protocol route.
- Add protocol/capabilities handshake.
- Add mobile replay envelope rather than exposing the existing replay RPC array unchanged.
- Add server-side command receipt/idempotency retention for `/mobile/v1`.
- Add shell/thread snapshot fixtures.
- Add replay, replay-gap, command receipt, and typed error fixtures.
- Add TypeScript tests proving payloads are emitted from existing orchestration services/schemas.

### Slice 2: Minimal Swift fixture-only client

- Add a minimal Swift package or test target under `apps/mobile`; it does not need to be an app target yet.
- Add hand-written Swift DTOs for the initial fixture set.
- Decode TypeScript-emitted fixtures.
- Emit Swift command fixtures and validate them in TypeScript.
- Add signpost/log timing helpers.

### Slice 3: Native iOS project skeleton

- Add XcodeGen `project.yml`.
- Add SwiftUI app target.
- Add basic navigation shell.
- Add empty feature folders.
- Add build/test scripts.

### Slice 4: Real Swift network sync client

- Extend the fixture-proven Swift DTOs as needed for runtime use.
- Add HTTP client for descriptor/auth/ws token.
- Add WebSocket transport with request/stream correlation.
- Integrate protocol handshake, replay envelope handling, stream subscriptions, command receipts, typed errors, and reconnection behavior into the app target.

### Slice 5: Local persistence and cache-first boot

- Add SQLite database.
- Persist shell snapshot, thread snapshots, event cursors, subscription cursors, replay gaps, pending commands, saved environments, protocol/schema versions.
- Render shell from cache before network.

### Slice 6: Read-only sync app

- Connect to a T3Code server over direct/Tailscale URL.
- Show environments, projects, session list, and selected thread transcript with basic native UI.
- Handle reconnect/replay/resnapshot gaps.

Implementation notes:

- The app target now opens a real `/mobile/v1/ws` shell subscription during initial sync and keeps that subscription alive for live shell updates instead of creating a throwaway initial stream.
- Selecting a thread opens a thread-detail subscription, renders cached transcript data immediately when available, then replaces/reconciles it from the server snapshot and subsequent thread events.
- Thread detail rendering is intentionally basic for Slice 6: user/assistant/system messages and generic activity rows are shown with native SwiftUI, while rich markdown, diffs, plan cards, and Litter component imports remain later slices.
- Shell and thread snapshots are persisted through the SQLite cache path. Thread snapshots are stored as the original mobile JSON snapshot so they can be decoded before the network returns.
- Reconnect now reuses stored event cursors for replay. Complete replay updates cursors and applies relevant thread events to the selected transcript; replay gap responses are persisted and force resnapshot of the active read model.
- Shell stream item decoding now preserves the typed JSON fields needed by live shell updates (`project`, `thread`, `projectId`, `threadId`) instead of only snapshot/event payloads.

### Slice 7: Litter component import pass

- Copy/adapt visual components and selected screens.
- Replace Litter runtime models with T3 projection models.
- Keep copied code split into focused Swift files.

Implementation notes:

- Slice 7 imported the Litter visual direction as focused first-party SwiftUI components rather than copying runtime-coupled source directly. The referenced Litter files depend on Litter-specific models, Hairball/HairballUI, UIKit-hosted zoom infrastructure, and Codex mobile runtime state, so the T3Code implementation keeps only the reusable UX patterns.
- Added focused T3-bound components: `ChatWallpaperBackground`, `MobileThreadHeaderView`, `MobileMessageBubbleView`, `MobileActivityRowView`, and `MobileConversationTimelineView`.
- Replaced the Slice 6 placeholder transcript with a real native timeline shell: selectable/readable message bubbles, activity rows, live/connected state in the header, automatic jump-to-latest on new messages, and long user/assistant message expansion.
- Upgraded thread rows with compact status treatment inspired by Litter's rich session rows while keeping data strictly sourced from `MobileThread` shell projections.
- No Litter runtime controller, Codex client, SSH/bootstrap, UIKit zoom list, or third-party markdown/rendering dependency was imported. Rich markdown, diff cards, and advanced gestures remain later UX hardening work.

### Slice 8: Interactive chat

- Send new turns.
- Interrupt running turns.
- Render streaming assistant output.
- Support approval and user-input responses.
- Support image attachments only if server attachment flow is verified end-to-end for mobile.

Implementation notes:

- Added a native composer bound to the selected T3 thread. Sends dispatch `thread.turn.start` commands through the mobile WebSocket command receipt path and clears only after command submission is accepted by the transport layer.
- Added interrupt support for running/starting sessions using `thread.turn.interrupt` with the selected thread detail's active turn id when available.
- Thread detail now carries session `activeTurnId`, message streaming state, and activity request ids parsed from T3 projection payloads so the UI can drive interactive controls without provider-specific runtime coupling.
- Approval activities with request ids render Approve/Deny buttons that dispatch `thread.approval.respond`. User-input-like activities with request ids render a small response field that dispatches `thread.user-input.respond`.
- Streaming assistant output remains projection-driven: the timeline renders messages with `streaming == true` using the existing progress indicator and updates only when server stream events mutate the thread detail.
- Image attachments remain intentionally disabled for Slice 8 because the plan requires verified end-to-end mobile upload support before enabling them.
- Added app-target regression coverage proving the view model emits `thread.turn.start` and `thread.turn.interrupt` mobile commands via the WebSocket path.

### Slice 9: Diffs, checkpoints, and proposed plans

- Add diff viewer.
- Add checkpoint cards and revert.
- Add proposed plan rendering/actions.

Implementation notes:

- Thread detail projection mapping now includes proposed plans and checkpoint summaries from T3 orchestration snapshots and live events.
- The mobile timeline renders proposed plan cards inline and checkpoint cards with changed-file summaries.
- Checkpoint cards can fetch a turn diff through `orchestration.getTurnDiff`; diffs render in a native sheet with selectable monospaced text. Syntax-highlighted diffs remain a future polish item.
- Added mobile checkpoint revert support through `thread.checkpoint.revert`, including Swift command DTOs, cross-language client fixture coverage, mobile contract allow-listing, and server gateway dispatch allow-listing.
- The UI dispatches checkpoint revert commands through the same idempotent mobile command receipt path used by chat and approvals.
- Post-review hardening moved composer draft ownership into `ShellViewModel`; the composer no longer clears user text until an accepted or duplicate command receipt arrives, so failed sends preserve the draft for retry.
- Interactive approval/user-input rows now use a typed `MobileActivityInteractionKind` derived from explicit projection metadata/tone instead of substring matching on activity kind. Request controls are disabled/marked responded after accepted receipts to prevent duplicate taps.
- Checkpoint revert now requires a confirmation dialog, interrupt dispatch is guarded by an in-flight flag, and checkpoint diff requests default to the single-turn range (`turnCount - 1` to `turnCount`) instead of cumulative thread diffs.
- Timeline ordering is precomputed on `MobileThreadDetail` when projection state changes rather than sorting messages/activities/plans/checkpoints on every SwiftUI body evaluation.
- The thread detail view now groups display state/actions into `ThreadDetailViewState` and `ThreadDetailActions` so future interactive features do not keep expanding the view initializer.
- Added app-target regression coverage for draft retention, duplicate response suppression, scoped diff requests, typed activity interactions, proposed plan events, checkpoint events, and timeline item ordering.

### Slice 10: Production hardening

- Push notifications.
- Diagnostics and log export.
- Accessibility audit.
- Performance profiling.
- App Store metadata/release checklist.

Implementation notes:

- Added an in-app Diagnostics sheet, reachable from the shell toolbar, that reports connection/thread state, projection counts, selected thread and cursor sequences, in-flight command counts, recent sync/command events, and selectable export text for support/debugging.
- `ShellViewModel` now records bounded diagnostic events for initial sync, cache load, stream failures, reconnect/health failures, command receipts, diff loads, and command failures. The log is capped to the most recent 100 events to avoid unbounded memory growth.
- Added regression coverage for diagnostics snapshot/export generation and command diagnostics alongside the existing mobile sync tests.
- Completed a first accessibility pass on production-hardening surfaces: connection status exposes a clear VoiceOver label/value, diagnostics rows combine related content, the diff export has an explicit accessibility label, and decorative wallpaper content is hidden from accessibility.
- The chat wallpaper now respects Reduce Motion and Reduce Transparency by removing the blur pass and lowering accent opacity, addressing the previously noted scroll/GPU risk on older devices and accessibility-sensitive settings.
- Slice 10 does not enable push notifications yet because the server-side notification-worthy state and push delivery model remain open questions; the current hardening focuses on observable failure behavior, support diagnostics, and UI accessibility/performance safeguards that are fully local to the mobile app.

## Open questions

1. Should `apps/mobile` be iOS-only permanently, or should the folder name become `apps/ios` before the first real project files land?
2. What is the source of truth for notification-worthy state: shell projection, push service, or server-side subscription state?
3. What is the required minimum iOS version? New SwiftUI code should bias modern, but this affects `@Observable`, concurrency, navigation, and background behavior.
4. Are image attachments supported end-to-end in T3 orchestration today? If not, keep them out of the first interactive slice.
5. Which Litter dependency choices should be copied as-is, and which should be replaced with first-party SwiftUI code?
6. Should push notifications be part of the MVP or the first post-MVP production hardening slice?

## Immediate next step

Implement Slice 1 first: a versioned `/mobile/v1` gateway contract spike with fixtures and TypeScript tests. Then add the minimal Swift fixture client. Do not import substantial Litter UI or build the SwiftUI shell until shell/thread snapshots, replay, replay gaps, command idempotency, and fixture drift alarms work against real T3Code server state.

## Implementation Notes

### Slice 1:

- `/mobile/v1` now has its own externally versioned descriptor, auth wrappers, and WebSocket route. The auth wrappers delegate to the shared server auth services internally, but mobile clients should treat `/mobile/v1/auth/...` as the only stable auth surface.
- The mobile WebSocket contract is plain JSON over a short-lived WS token: `hello`, request/response correlation, stream snapshots, replay envelopes, command receipts, and typed protocol errors are all schema-validated through `packages/contracts`.
- Replay is envelope-shaped for mobile, but true `cursor-too-old` / unavailable range detection still needs durable event-store retention metadata. Until that exists, the gateway can only report complete replay for currently available event reads or request a resnapshot on hard failures.
- Command idempotency is implemented at the gateway contract level with command IDs, payload hashes, accepted/duplicate/rejected receipts, and bounded in-memory retention. Production multi-process/restart safety needs a durable or shared command receipt store before relying on retry semantics across server restarts.
- Shell and thread subscriptions currently send initial snapshots from projections. Live streaming is intentionally scoped to protocol shape and should be hardened with per-subscription cursor persistence, minimum-cursor replay, and resnapshot-on-gap behavior when the mobile cache layer lands.
- Server tests now act as TypeScript-side mobile fixtures. Slice 2 should convert representative response/request payloads into committed fixture files and require the Swift DTO package to decode them in CI.

### Slice 2:

- `apps/mobile` is now a fixture-only Swift package, not an app target. It should stay focused on protocol DTOs, fixture decoding, Swift command fixture encoding, and sync timing primitives until the native iOS shell slice starts.
- Committed fixtures live under `apps/mobile/Fixtures/mobile-v1`. Server-authored fixtures cover descriptor, hello, shell snapshot, thread snapshot, replay complete, replay gap, command receipt, diff, and protocol error payloads. Client-authored fixtures cover the read+chat MVP commands.
- `packages/contracts/src/mobile.fixtures.test.ts` is the TypeScript drift alarm: it decodes server fixtures with `MobileDescriptorResult`/`MobileServerMessage`, and validates Swift-emitted command fixtures with `MobileClientMessage`.
- Swift DTOs intentionally decode rich protocol envelopes and classify response payloads, while leaving deep orchestration snapshot/event bodies as `JSONValue` for this slice. Slice 4 should replace the highest-value raw areas with typed projection DTOs as real network sync code needs them.
- Swift command DTOs currently model only MVP mutation scope: turn start, interrupt, approval response, user-input response, and session stop. Desktop parity mutations should not be added until the gateway explicitly promotes them out of post-MVP scope.
- The timing helper uses static OS signpost names for the first sync milestones. The app slice should call these from launch/cache/network/replay paths rather than inventing parallel metric names.

### Slice 3:

- `apps/mobile/project.yml` is the source of truth for the generated Xcode project. The generated `T3Mobile.xcodeproj` is intentionally ignored to avoid committing XcodeGen output drift.
- The native app shell now targets iOS 26 and depends on the local `T3MobileProtocol` Swift package. This resolves the minimum-iOS open question for the initial app skeleton; revisit only if a product requirement demands older OS support.
- `apps/mobile/App` contains the first SwiftUI app target: `T3MobileApp`, `AppRootView`, preview domain models, and a `NavigationSplitView` shell for servers, chats, and a placeholder thread detail.
- Feature folders for Approvals, Chat, Diffs, and Settings exist as placeholders. Keep feature code split by domain as these slices land, rather than growing a single shell file.
- The shell currently renders deterministic preview data only. Slice 4 should replace the preview view model inputs with the real network sync client while preserving the navigation structure.
- App build/test scripts are available through `apps/mobile/package.json`: `generate:xcode`, `build:app`, and `test:app`.

### Review fixes after Slices 1-3:

- `/mobile/v1` dispatch is now restricted to the read+chat MVP command set. Post-MVP desktop mutations and `thread.turn.start` bootstrap payloads are rejected at the mobile contract boundary until shared desktop/mobile dispatch orchestration is extracted.
- The WebSocket route now preflights `protocolVersion` before full schema decode, so unsupported versions return the typed `unsupported-protocol-version` error instead of a generic validation failure.
- The WebSocket route now requires a successful `hello` before requests and checks the negotiated client capabilities per method.
- The Swift shell view model now precomputes thread sections and thread-to-project lookup data. `ProjectThreadListView` renders stable section data instead of filtering threads inside `body`.

### Slice 4:

- The app target now has a real Swift sync client under `apps/mobile/App/Sync`: HTTP descriptor/auth/ws-token calls, URLSession WebSocket transport, hello negotiation, shell/thread subscriptions, replay, diff requests, command receipts, typed errors, and bounded reconnect retry for initial sync.
- Runtime configuration is intentionally minimal until pairing UI exists. The app reads `T3_MOBILE_SERVER_URL` plus either `T3_MOBILE_BEARER_TOKEN` or `T3_MOBILE_BOOTSTRAP_TOKEN` from process environment; without those it stays in a not-configured shell state.
- `ShellViewModel` now owns connection state and can apply an initial shell snapshot from the sync client into the preview-domain models. Persistence is still not included; Slice 5 should make this cache-first instead of network-first.
- Swift snapshot projection mapping is deliberately typed only for the shell data needed by the skeleton: environment, projects, threads, status badges, and summaries. Thread transcript/detail projection typing should be added as the read-only sync UI slice consumes it.
- App tests use a fixture URLProtocol and fake WebSocket transport to prove descriptor -> bearer session validation -> WS token -> hello -> shell subscription, and direct replay/diff/command receipt decoding.

### Slice 5:

- The app now has a first-party SQLite cache under `apps/mobile/App/Persistence`, linked through the system `sqlite3` library. No third-party persistence framework was added.
- `MobileCacheStore` creates explicit tables for metadata/protocol versions, shell cache, thread snapshots, event cursors, per-subscription cursors, replay gaps, pending command lifecycle, and attachment metadata.
- `ShellViewModel.loadInitialSync` is cache-first: it applies a cached shell immediately when available, then attempts network sync and persists the fresh shell snapshot on success.
- The current cache stores shell projection rows as JSON blobs inside SQLite for fast Slice 5 delivery. Slice 6/7 should decide whether high-volume transcript rows need normalized message/activity tables before rendering large threads.
- Pending command persistence is schema-ready with created/sent/accepted/rejected/reconciled/expired statuses, but command dispatch paths do not yet enqueue offline commands. That belongs with interactive chat/offline behavior.

### Review fixes after Slices 4-5:

- `MobileWebSocketClient` now uses a single reader loop and correlates messages by envelope `id`, so live subscription frames no longer corrupt replay, diff, or command receipt requests on the same socket.
- `/mobile/v1` command dispatch now reuses the shared startup-gated dispatch path for MVP commands. Desktop bootstrap handling remains desktop-only because mobile still rejects bootstrap turn-start payloads.
- Cache reads/writes are now accessed through an actor-backed `MobileCacheService`; `ShellViewModel` only applies decoded cache/network results on the main actor.
- The Swift client validates descriptor/auth/hello protocol envelopes and required server capabilities before issuing shell sync requests.
- Cached environments are forced offline/stale until a live sync succeeds, preventing cached `isConnected: true` from rendering as online.
- `MobileCacheStore` now uses `PRAGMA user_version` with an explicit version-1 migration and rejects caches created by newer schema versions.
- The WebSocket reader now records terminal close/error state, clears reader lifecycle state on exit, fails pending continuations on close/error, and uses deterministic request IDs for fixture-backed replay/diff/command tests.
- `URLSessionMobileWebSocketSession` is actor-isolated instead of `@unchecked Sendable` around `URLSessionWebSocketTask`.
- SQLite `query` now verifies the final `sqlite3_step` result is `SQLITE_DONE`, so locked/corrupt reads cannot masquerade as empty or partial cache results.
- `MobileSyncSession` carries negotiated server capabilities for UI feature gating beyond initial shell sync.
- `MobileCacheService` runs blocking SQLite work on a dedicated serial utility queue instead of occupying Swift concurrency executor threads.
- `ShellViewModel` starts a ping-based health monitor after live sync and triggers reconnect after transport failure.

## Future Revisit Items

These are known low-severity observations and debt items to revisit during production hardening (Slice 10+) or before App Store release.

### State hygiene

- `respondedRequestIDs` is never cleared when switching threads. It grows for the ViewModel lifetime. For long sessions traversing many threads, old IDs accumulate. Consider clearing on thread selection change or scoping the set per thread ID.
- `respondingRequestIDs` is transient (cleared by `defer`) but is never persisted. If the app is killed mid-dispatch, the user will see the buttons re-enabled on next launch with no indication the response was already accepted server-side. Consider reconciling responded state from the thread snapshot on load.

### Performance

- `makeTimelineItems` runs on every `applyThreadEvent` call, including no-op events (unknown type → default branch returns `next` unchanged but still triggers the sort). During rapid streaming text updates, this re-sorts on every text mutation. Consider a dirty flag or structural equality check before recomputing.
- `applyShellStream` sorts projects/threads by title on every upsert event. For large project/thread lists (500+), this is O(n log n) per event. Consider insertion-sort for single upserts or pre-sorted binary insertion.
- `ChatWallpaperBackground` uses a 240×240 `Circle` with `blur(radius: 36)` rendered every frame during scroll. On older devices, consider rasterizing this with `.drawingGroup()` or replacing with a static asset.

### UX polish

- `MobileCheckpointCardView` truncates the file list to `prefix(4)` with no "and N more" indicator. Threads with many changed files give an incomplete picture.
- `MobileProposedPlanCardView` uses `lineLimit(12)` with no expand/collapse toggle (unlike `MobileMessageBubbleView` which has show more/less). Long plans are silently truncated.
- `MobileDiffSheetView` renders raw monospaced text with no syntax highlighting, +/- coloring, or file-level collapsing. Acceptable for now but should be replaced with a proper diff renderer before production.
- The app has no haptic feedback on command dispatch success/failure. Consider `UIImpactFeedbackGenerator` on send, interrupt, and approval.

### Protocol / contract

- `ThreadCheckpointRevertCommand` uses the field name `turnCount`. The checkpoint DTO reads `checkpointTurnCount` from server payloads. Verify the server command handler expects `turnCount` and not `checkpointTurnCount`, or the revert may silently fail.
- `MobileThreadActivityDTO.interactionKind` detection checks `tone == "approval"` OR an explicit `"interactionKind": "user-input"` field OR `kind == "user-input"` / `kind == "user-input-request"`. If the server introduces new interaction kinds (e.g., `"confirmation"`, `"multi-select"`), they will fall through to `.generic`. Add a protocol extension mechanism or catch-all interactive treatment.
- The mobile gateway does not yet define a dedicated endpoint for thread-scoped replay (only global replay). The current `recoverSession` replays from the global sequence for both shell and thread, which works because `applyReplayEvent` filters by `threadId`. But for environments with thousands of events, a scoped thread replay API would reduce bandwidth.

### Test coverage gaps

- No ViewModel-level integration tests for `sendMessage`, `interruptSelectedThread`, `respondToApproval`, `respondToUserInput`, `revertToCheckpoint`, or `loadDiff` error paths with a fake WebSocket.
- No test for the health monitor → reconnect → replay → thread recovery cycle end-to-end.
- No test for `loadSelectedThreadDetail` cache → subscription → stream event application flow.
- No test for `respondedRequestIDs` / `respondingRequestIDs` gate preventing duplicate dispatch.

### Architecture

- `ShellViewModel` is growing large (~370 lines). Consider extracting command dispatch into a dedicated `MobileCommandDispatcher` actor/class and thread subscription management into a `ThreadDetailSyncController`.
- `ThreadDetailViewState` is constructed on every `body` evaluation in `ShellView`. Consider a computed property on the ViewModel that returns the struct, or make it a stored `@Observable` property updated when relevant state changes.
- The app currently has no concept of multiple environments in a single session. `selectedEnvironmentID` exists but environment switching has no UI or sync re-binding logic. Decide before Slice 10 whether multi-environment is in-scope.
