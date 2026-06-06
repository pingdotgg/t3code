# Changes From Main

This document summarizes the changes on `codex/mobile-ui-polish` compared with
`main`.

## Comparison Scope

- Current branch: `codex/mobile-ui-polish` at `e36764ae`
- Local `main`/`origin/main`: `447236d5`
- `upstream/main` merged into this branch: `d1e85c4e`
- Full local-main comparison: `git diff main...HEAD`
  - 212 files changed
  - 13,951 insertions
  - 3,530 deletions
- Branch-specific comparison after the merged upstream main: `git diff upstream/main...HEAD`
  - 129 files changed
  - 8,430 insertions
  - 825 deletions

Because local `main` is behind `upstream/main`, a raw comparison against local
`main` includes both branch work and upstream work merged into this branch. The
"Branch-Specific Changes" section below covers the work unique to this branch.
The "Merged Upstream Changes Also Present Versus Local Main" section lists the
additional upstream changes that also show up in `git diff main...HEAD`.

## Branch-Specific Changes

### Mobile And PWA App Shell

- Added PWA metadata and install assets for the web app:
  - `apps/web/public/manifest.webmanifest`
  - `apps/web/public/salchi-pwa-192.png`
  - `apps/web/public/salchi-pwa-512.png`
  - iOS and standalone web app meta tags in `apps/web/index.html`
- Extended the brand asset pipeline so production, nightly, and development
  builds copy PWA icons into the web output.
- Added `isStandalonePwa()` detection and installed an iOS standalone back-swipe
  guard to prevent system history gestures from interfering with the app.
- Disabled Chromium overscroll history navigation in the Electron shell before
  app startup.
- Added a route-level back-navigation blocker so browser back gestures do not
  accidentally leave the active app surface.
- Changed settings exit behavior to navigate back to `/` with `replace: true`
  instead of relying on browser history.
- Added desktop IPC support for `desktopBridge.forceReload()` and exposed a
  "Force refresh" action in the chat header overflow menu.

### Mobile Panel Gestures And Layout

- Added `useMobileEdgeSwipe`, a shared gesture hook for opening and closing
  panels from full-screen or edge swipes.
- Wired mobile swipe gestures into the left sidebar and right-side panels.
- Added `rightPanelGesture` registration so the app can open the last-used right
  panel and coordinate plan, diff, and file-preview panels.
- Updated `Sheet` and `RightPanelSheet` to mark swipe panels and respect mobile
  safe-area padding.
- Reduced mobile chat chrome padding around the branch toolbar and composer to
  reclaim vertical space.
- Prevented the plan sidebar from auto-opening as a sheet on small screens.

### Chat Header And Compact Controls

- Reworked the chat header for compact widths:
  - Project script controls and Git controls move into an overflow menu on
    narrow screens.
  - The overflow menu also exposes the force refresh action.
- Added `inMenu` rendering modes for `ProjectScriptsControl` and
  `GitActionsControl` so they can appear either as header controls or nested
  menu items.
- Preserved the existing quick-action Git and script behavior for wider
  layouts.

### Model Picker And Composer Access Controls

- Made the provider model picker full-screen and modal on phone-sized coarse
  pointer devices.
- Avoided auto-focusing model search on mobile so opening the picker does not
  immediately raise the soft keyboard.
- Added an explicit mobile close button to the model picker.
- Ignored mobile model-picker outside-press and focus-out dismissals caused by
  keyboard or touch behavior.
- Extracted access-mode menu content into `ComposerAccessMenuContent`.
- Added Codex "Auto Review" as a first-class access mode when the active Codex
  provider reports support for the `guardian_approval` experimental feature.
- Hid access-only model options such as `autoReview` from the traits picker.
- Added settings model capability labeling for Auto Review.

### Codex Auto Review Support

- Probes Codex App Server experimental features and current config to detect
  automatic approval-review support.
- Adds an `autoReview` boolean model option to Codex model capabilities when
  supported.
- Maps the selected `autoReview` option to Codex App Server
  `approvalsReviewer` values:
  - `true` -> `auto_review`
  - `false` -> `user`
- Sends `approvalsReviewer` through both thread start and turn start flows.
- Added tests for Codex runtime parameter generation and adapter dispatch.

### Usage And Rate-Limit Telemetry

- Added provider runtime support for `account.rate-limits.updated` events.
- Projects provider usage events into orchestration thread activities while
  keeping them out of the visible work log.
- Added a `server.refreshUsageLimits` RPC that asks active providers to refresh
  usage telemetry.
- Added a sidebar usage indicator that summarizes Codex and Claude limits by
  five-hour and weekly windows.
- The sidebar refreshes usage data when it becomes visible or when the usage
  indicator is expanded.
- Codex sessions periodically call `account/rateLimits/read` and emit normalized
  usage updates.
- Claude sessions refresh usage from multiple sources:
  - Claude SDK context usage via `getContextUsage`
  - OAuth usage endpoint data from local Claude credentials
  - Claude statusline capture data
  - SDK rate-limit events
- Added raw provider event source literals for `claude.oauth.usage` and
  `claude.statusline`.
- Added optional `costUsd` to thread token usage snapshots.

### Startup Performance And Resilience

- Added a bounded localStorage startup cache for orchestration environment
  state.
  - Caches recent projects, thread shells, selected thread details, messages,
    activities, proposed plans, and turn diffs.
  - Caps cache size and number of retained environments.
  - Debounces writes and evicts oldest cached environments on quota pressure.
- Hydrates primary and saved environment state from the startup cache before the
  network snapshot arrives.
- Clears saved-environment startup cache when a saved environment is removed.
- Persists and restores the primary environment descriptor by target URL so the
  app can bootstrap faster.
- Added projection sequence-gap detection on the client.
- Recovers projection gaps by replaying orchestration events from the last
  applied sequence and reconnects if replay cannot produce a contiguous stream.
- Disposes thread detail subscriptions and UI state when replayed events delete
  a thread.
- On the server, shell and thread subscriptions now replay events after the
  snapshot sequence and merge them with live events in sequence order, removing
  duplicates.
- Thread detail snapshot reads now include the snapshot sequence used to build
  the detail payload.

### Chat Timeline And Scroll Reliability

- Added a reusable `stickToBottom` scheduler that scrolls across animation
  frames and short settle delays.
- Reworked chat auto-scroll so sends, browser resume, focus, resize, and mobile
  keyboard changes keep the timeline pinned when the user was already at the
  bottom.
- Added user-scroll intent detection so manual scrolling detaches the timeline
  from auto-scroll.
- Kept the scroll-to-bottom affordance from flashing during thread switches.
- Added test coverage for timeline stick-to-bottom scheduling and user-scroll
  behavior.

### Workspace File Preview

- Added `projects.readFile` contracts, RPC client methods, and WebSocket routing.
- Added server-side workspace text file reads with:
  - Workspace-root path containment
  - Non-file rejection
  - Binary null-byte rejection
  - 512 KiB read cap
  - Truncation and byte-size metadata
- Added `WorkspaceFilePreviewPanel`, a right-side file preview surface with:
  - Syntax highlighting
  - Line-number gutter
  - Target line scrolling
  - Copy contents
  - Word wrap toggle
  - Empty, loading, error, and truncated states
- Added shared code-highlighting helpers with LRU caches for highlighted HTML
  and token lines.
- File links in markdown, diffs, Git status, and terminal output now attempt to
  open in the preferred local editor first, then fall back to the in-app file
  preview when local editor access is unavailable.

### Terminal Drawer Mobile Behavior

- Added visual-viewport keyboard handling so the terminal drawer shrinks and
  shifts above the mobile keyboard.
- Added touch scrolling for terminal output with line-based accumulation.
- Marked the terminal viewport as `touch-none` to prevent browser gestures from
  stealing terminal scroll interactions.
- Updated terminal file-link handling to use the shared editor-or-preview path.

### Empty State And Startup Navigation

- Added recent chat groups to the no-active-thread state, grouped by recent
  projects with recent threads.
- Added logic tests for deriving recent thread groups.
- Changed startup bootstrap navigation so standalone PWAs do not auto-navigate
  to the bootstrap thread on launch.
- Added startup navigation tests.

### API And Contract Additions

- `DesktopBridge.forceReload()`
- `LocalApi.server.refreshUsageLimits()`
- `EnvironmentApi.projects.readFile()`
- `WS_METHODS.serverRefreshUsageLimits`
- `WS_METHODS.projectsReadFile`
- `ProjectReadFileInput`
- `ProjectReadFileResult`
- `ProjectReadFileError`
- Provider raw event sources:
  - `claude.oauth.usage`
  - `claude.statusline`
- `ThreadTokenUsageSnapshot.costUsd`

### Tests Added Or Updated

- New tests for:
  - Workspace file reads and read errors
  - WebSocket `projects.readFile`
  - Provider rate-limit ingestion
  - Codex Auto Review parameter mapping
  - Claude OAuth and statusline usage events
  - Sidebar usage derivation
  - Mobile edge-swipe decisions
  - iOS standalone back-swipe guard
  - File preview target resolution
  - Code highlighting helpers
  - Recent chat grouping
  - Startup bootstrap navigation
  - Projection gap recovery
  - Terminal drawer keyboard and touch scrolling
  - Stick-to-bottom scheduling
- Existing tests were updated for the new projection snapshot API,
  `refreshUsage` provider service method, desktop bridge `forceReload`, and
  additional RPC methods.

## Merged Upstream Changes Also Present Versus Local Main

The following upstream commits are included in the raw diff against local
`main`, but they are already present on `upstream/main`:

- `d1e85c4e` - release prep for `v0.0.24`
- `ea20e800` - moved workspace packages out of desktop runtime dependencies
- `9e632f5c` - diagnostics resource history
- `4120e945` - VCS remote refresh failure backoff
- `34bb18c8` - marketing site rewrite and marketing assets
- `90eea047` - skipped healthy environment reconnects after browser resume
- `f92e1e1b` - simplified workspace package builds and dependencies
- `556c4245` - hardened GitHub workflow permissions
- `7e20b23e` - constrained provider update popover overflow
- `b83e9c95` - refactored composer refs and context providers
- `a41f4895` - reduced chat timeline activity rerenders
- `d15909af` - replaced the `open` package with an Effect child-process
  launcher for editor/external launches

These upstream commits account for the marketing files, package/build cleanup,
diagnostics monitor changes, external launcher refactor, release metadata, and
workflow updates that appear in `git diff main...HEAD`.

## Branch-Specific File Inventory

Generated with `git diff --name-status upstream/main...HEAD`.

```text
M	apps/desktop/src/app/DesktopApp.ts
M	apps/desktop/src/ipc/DesktopIpcHandlers.ts
M	apps/desktop/src/ipc/channels.ts
M	apps/desktop/src/ipc/methods/window.ts
M	apps/desktop/src/preload.ts
M	apps/server/src/checkpointing/Layers/CheckpointDiffQuery.test.ts
M	apps/server/src/orchestration/Layers/CheckpointReactor.test.ts
M	apps/server/src/orchestration/Layers/OrchestrationEngine.test.ts
M	apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts
M	apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts
M	apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts
M	apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts
M	apps/server/src/orchestration/Services/ProjectionSnapshotQuery.ts
M	apps/server/src/project/Layers/ProjectSetupScriptRunner.test.ts
M	apps/server/src/provider/Layers/ClaudeAdapter.test.ts
M	apps/server/src/provider/Layers/ClaudeAdapter.ts
M	apps/server/src/provider/Layers/CodexAdapter.test.ts
M	apps/server/src/provider/Layers/CodexAdapter.ts
M	apps/server/src/provider/Layers/CodexProvider.ts
M	apps/server/src/provider/Layers/CodexSessionRuntime.test.ts
M	apps/server/src/provider/Layers/CodexSessionRuntime.ts
M	apps/server/src/provider/Layers/ProviderService.ts
M	apps/server/src/provider/Layers/ProviderSessionReaper.test.ts
M	apps/server/src/provider/Services/ProviderAdapter.ts
M	apps/server/src/provider/Services/ProviderService.ts
M	apps/server/src/server.test.ts
M	apps/server/src/serverRuntimeStartup.test.ts
M	apps/server/src/workspace/Layers/WorkspaceFileSystem.test.ts
M	apps/server/src/workspace/Layers/WorkspaceFileSystem.ts
M	apps/server/src/workspace/Services/WorkspaceFileSystem.ts
M	apps/server/src/ws.ts
M	apps/web/index.html
M	apps/web/public/apple-touch-icon.png
M	apps/web/public/favicon-16x16.png
M	apps/web/public/favicon-32x32.png
M	apps/web/public/favicon.ico
A	apps/web/public/manifest.webmanifest
A	apps/web/public/salchi-pwa-192.png
A	apps/web/public/salchi-pwa-512.png
A	apps/web/src/codeHighlighting.test.ts
A	apps/web/src/codeHighlighting.ts
A	apps/web/src/components/BackNavigationBlocker.tsx
M	apps/web/src/components/BranchToolbar.tsx
M	apps/web/src/components/ChatMarkdown.tsx
M	apps/web/src/components/ChatView.tsx
M	apps/web/src/components/DiffPanel.tsx
M	apps/web/src/components/GitActionsControl.tsx
A	apps/web/src/components/NoActiveThreadState.logic.test.ts
A	apps/web/src/components/NoActiveThreadState.logic.ts
M	apps/web/src/components/NoActiveThreadState.tsx
M	apps/web/src/components/PlanSidebar.tsx
M	apps/web/src/components/ProjectScriptsControl.tsx
M	apps/web/src/components/RightPanelSheet.tsx
M	apps/web/src/components/Sidebar.tsx
M	apps/web/src/components/ThreadTerminalDrawer.test.ts
M	apps/web/src/components/ThreadTerminalDrawer.tsx
A	apps/web/src/components/WorkspaceFilePreviewPanel.tsx
M	apps/web/src/components/chat/ChatComposer.tsx
M	apps/web/src/components/chat/ChatHeader.test.ts
M	apps/web/src/components/chat/ChatHeader.tsx
M	apps/web/src/components/chat/CompactComposerControlsMenu.browser.tsx
M	apps/web/src/components/chat/CompactComposerControlsMenu.tsx
A	apps/web/src/components/chat/ComposerAccessMenuContent.tsx
M	apps/web/src/components/chat/MessagesTimeline.browser.tsx
M	apps/web/src/components/chat/MessagesTimeline.test.tsx
M	apps/web/src/components/chat/MessagesTimeline.tsx
M	apps/web/src/components/chat/ModelPickerContent.tsx
M	apps/web/src/components/chat/ProposedPlanCard.tsx
M	apps/web/src/components/chat/ProviderModelPicker.tsx
M	apps/web/src/components/chat/TraitsPicker.tsx
M	apps/web/src/components/chat/composerProviderState.test.tsx
A	apps/web/src/components/chat/stickToBottom.test.ts
A	apps/web/src/components/chat/stickToBottom.ts
M	apps/web/src/components/settings/ProviderModelsSection.tsx
M	apps/web/src/components/settings/SettingsPanels.browser.tsx
M	apps/web/src/components/settings/SettingsSidebarNav.tsx
A	apps/web/src/components/sidebar/SidebarUsageIndicator.logic.test.ts
A	apps/web/src/components/sidebar/SidebarUsageIndicator.logic.ts
A	apps/web/src/components/sidebar/SidebarUsageIndicator.tsx
M	apps/web/src/components/ui/popover.tsx
M	apps/web/src/components/ui/sheet.tsx
M	apps/web/src/components/ui/sidebar.tsx
M	apps/web/src/env.ts
M	apps/web/src/environmentApi.ts
M	apps/web/src/environments/primary/context.ts
M	apps/web/src/environments/runtime/connection.test.ts
M	apps/web/src/environments/runtime/service.savedEnvironments.test.ts
M	apps/web/src/environments/runtime/service.test.ts
M	apps/web/src/environments/runtime/service.threadSubscriptions.test.ts
M	apps/web/src/environments/runtime/service.ts
A	apps/web/src/hooks/useMobileEdgeSwipe.test.ts
A	apps/web/src/hooks/useMobileEdgeSwipe.ts
M	apps/web/src/index.css
A	apps/web/src/iosStandaloneBackSwipeGuard.test.ts
A	apps/web/src/iosStandaloneBackSwipeGuard.ts
M	apps/web/src/lib/gitStatusState.test.ts
M	apps/web/src/localApi.test.ts
M	apps/web/src/localApi.ts
M	apps/web/src/main.tsx
A	apps/web/src/navigationBlocking.test.ts
A	apps/web/src/navigationBlocking.ts
A	apps/web/src/orchestrationStartupCache.ts
A	apps/web/src/rightPanelGesture.ts
M	apps/web/src/routes/__root.tsx
M	apps/web/src/routes/_chat.$environmentId.$threadId.tsx
M	apps/web/src/routes/settings.tsx
M	apps/web/src/rpc/wsRpcClient.ts
M	apps/web/src/session-logic.test.ts
M	apps/web/src/session-logic.ts
A	apps/web/src/startupNavigation.test.ts
A	apps/web/src/startupNavigation.ts
M	apps/web/src/store.ts
A	apps/web/src/workspaceFilePreview.test.ts
A	apps/web/src/workspaceFilePreview.ts
M	apps/web/tsconfig.json
M	apps/web/vercel.ts
M	apps/web/vite.config.ts
A	assets/salchi/salchi-web-pwa-192.png
A	assets/salchi/salchi-web-pwa-512.png
M	packages/contracts/src/ipc.ts
M	packages/contracts/src/project.ts
M	packages/contracts/src/providerRuntime.ts
M	packages/contracts/src/rpc.ts
M	scripts/lib/brand-assets.test.ts
M	scripts/lib/brand-assets.ts
```
