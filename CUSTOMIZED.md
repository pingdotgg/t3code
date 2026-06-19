# Custom Branch Changes

## Last Upstream Merge

Generated from local merge commit `b94c9e2cd`, `origin/main` at `8dfebb857`, and `upstream/main` at `cdaba7fa8`. Nine new upstream commits were merged since the previously recorded upstream ref `3e01c4bc5`: `5d4e2fae0` (`feat: allow disabling provider update checks (#3130)`), `13917df1f` (`Use idiomatic Effect options for server secret reads (#3110)`), `7dc182337` (`[codex] fix: show nightly badge from primary web server version (#3103)`), `494350cc0` (`feat(composer): clickable PR pill next to branch selector (#3065)`), `a4446e263` (`Improve idiomatic Effect usage in config and Tailscale paths (#3073)`), `d9f59be70` (`feat(sidebar): worktree indicator on session rows (#3057)`), `c08b968f4` (`Use Effect schema decoders for JSON parsing (#3060)`), `fbf626387` (`Only show enabled providers in picker sidebar (#3168)`), and `cdaba7fa8` (`Share thread state idle TTL across client atoms (#3163)`). No new `origin/main` commits were available since the previously recorded worktree-tracking origin ref `8dfebb857`. After this merge and tracking update, local `main` is 226 commits ahead and 0 commits behind `upstream/main`, and 14 commits ahead and 0 commits behind `origin/main`; the remaining fork delta against current `upstream/main` is 257 files changed, 35280 insertions, and 1253 deletions.

No local customization is retired by this merge. Upstream added provider update-check settings, primary-server nightly badge display, clickable pull-request pills near branch controls, sidebar worktree indicators on session rows, enabled-provider filtering in the picker sidebar, shared thread-state idle retention, Effect schema-based JSON decoding, and idiomatic Effect option handling in secret/config/Tailscale paths. These upstream changes are authoritative; the local VS Code host bootstrap, custom Version Control panel, subagent threading, wide conversation defaults, workspace skill loading, terminal action reuse work, and mobile EAS ownership remain preserved around them.

Concrete conflict notes from this merge:

- `apps/web/src/components/Sidebar.logic.test.ts` keeps the local imports and coverage for VS Code project scoping, sidebar option visibility, route class names, and initial-thread resolution, while accepting upstream's `resolveSidebarStageBadgeLabel(...)` coverage for primary-server nightly versions.
- `apps/web/src/components/Sidebar.tsx` keeps local VS Code webview chrome behavior, `primaryServerWelcomeAtom` workspace scoping, grouped-project `projectThreadsOverride` handling, and the exported `SidebarHomeButton`, while accepting upstream's shared `useOpenPrLink()` helper and primary-server nightly stage badge. The local home button now accepts the resolved stage badge label so upstream's nightly badge behavior is not lost.

## Latest Worktree Port

Generated from local `main` at `3cbf5a53d` after inspecting active worktrees `fix/codex-skills`, `split/file-command-activity-boxes`, `split/subagent-threading-work`, `split/terminal-backed-project-actions`, `fix/thread-detail-subscription-race`, `split/version-control-panel-work`, and `split/vscode-extension-work`.

The port retained only targeted branch-local fixes that were absent from `main`: refreshing workspace-scoped provider-skill queries when fallback provider skills change for the same workspace key, including command/file row preview text in expanded-row ARIA labels, preserving subagent `parentRelation` on fresh client-runtime `thread.created` detail initialization, modeling read-only Version Control panel RPCs as query atoms while keeping mutating operations as commands, suppressing stale `Refreshing repository state...` text when only the live VCS status subscription is pending, and refreshing the related `SOURCE_CONTROL.md`, `SUBAGENTS.md`, and VS Code implementation notes. The terminal-backed project action worktree and thread-detail subscription race worktree had no additional code to port; their useful behavior was already represented on `main`. Do not replay split worktrees wholesale: several remaining diffs are stale branch shape or would regress newer `main` behavior.

## Debug Browser Launch

For web/server debug work in this branch, start the backend with browser auto-open disabled, then if needed navigate the intended active browser window manually or through Playwright MCP:

```sh
T3CODE_NO_BROWSER=1 pnpm exec node scripts/dev-runner.ts --dev-url http://127.0.0.1:5173 dev:server
```

Then in a separate terminal:

```sh
VITE_DEV_SERVER_URL=http://127.0.0.1:5173 VITE_WS_URL=ws://127.0.0.1:13773 pnpm exec vp run --filter @t3tools/web dev -- --host 127.0.0.1 --port 5173
```

If a pairing URL is required, open the printed `/pair#token=...` URL in the already-open browser window being used for the debug session.

There should be a `throwaway` project already existing, located at `~/Sites/throwaway`. This project is a playground to test git workflow freely where you can perform any git operations including destructive ones. It is ok to leave in it temporary artifacts, commits, branches, staged and unstaged changes, etc, for posterior runs or reference.

## Installable Build Commands

Use these commands from the repository root when producing local installable artifacts for this customized branch.

### VS Code Extension

Build a local VSIX:

```sh
pnpm --filter t3code-vscode package
```

Install the newest generated package into VS Code:

```sh
code --install-extension "$(ls -t apps/vscode-extension/*.vsix | head -1)"
```

### Desktop App

Build a macOS arm64 DMG using the same desktop artifact path used for this branch:

```sh
pnpm run dist:desktop:dmg:arm64
```

Build a local macOS arm64 DMG, then hand the install step to Terminal.app so it can finish after the running T3 Code app quits:

```sh
scripts/install-desktop-dmg-from-t3.zsh
```

### Mobile App

Build the installable Android preview APK locally, avoiding the EAS cloud worker queue, then install it directly over USB:

```sh
cd apps/mobile
JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home ANDROID_HOME=/opt/homebrew/share/android-commandlinetools ANDROID_SDK_ROOT=/opt/homebrew/share/android-commandlinetools PATH="/opt/homebrew/opt/openjdk@17/bin:/opt/homebrew/share/android-commandlinetools/platform-tools:$PATH" EAS_SKIP_AUTO_FINGERPRINT=1 EAS_BUILD_DISABLE_EXPO_DOCTOR_STEP=1 pnpm dlx eas-cli@latest build --profile preview -p android --local --output ./build/android/t3-code-preview.apk
adb install -r ./build/android/t3-code-preview.apk
```

Upload the local APK to EAS when a shareable install link is needed:

```sh
cd apps/mobile
pnpm dlx eas-cli@latest upload -p android --build-path ./build/android/t3-code-preview.apk --non-interactive
```

This branch carries local conversation-rendering and orchestration changes that are not assumed to exist upstream. Keep this file current when changing local behavior so future merges can preserve the intended UX, and so these patches can be removed when upstream covers the same behavior.

## Conversation Tool Activity Rendering

The custom behavior is focused on making tool activity easier to read in long-running Codex threads without changing agent execution semantics.

### File Change And Command Activity Boxes

File-change and command activities are rendered as clickable, expandable rows in the conversation work log.

Expected behavior:

- A file-change row keeps the compact `Changed files - path/to/file` style preview while collapsed.
- Clicking a file-change row expands it inline and renders any available patch with the same `FileDiff` diff viewer used by other conversation diff surfaces.
- If a file-change event only has paths and no patch, the expanded row still lists the changed paths instead of opening the full turn diff panel.
- A command row keeps the compact `Ran command - command` style preview while collapsed.
- Clicking a command row expands it inline and shows the command, raw command when it differs, stdout, stderr, exit code, and duration.
- Differing raw command text is rendered inline as a normal detail block in the expanded row, not hidden behind a second nested disclosure.
- Stdout and stderr show only the last 40 lines by default when longer than 40 lines; clicking either output block toggles the full stream.

Primary files:

- `apps/web/src/session-logic.ts`
- `apps/web/src/components/chat/MessagesTimeline.tsx`

## Tests Covering The Custom Behavior

Relevant tests live in:

- `apps/web/src/components/chat/MessagesTimeline.test.tsx`
- `apps/web/src/session-logic.test.ts`

Useful focused commands:

```sh
(cd apps/web && pnpm exec vp test run --passWithNoTests --project unit src/session-logic.test.ts)
(cd apps/web && pnpm exec vp test run --passWithNoTests --project unit src/components/chat/MessagesTimeline.test.tsx)
(cd apps/web && pnpm exec vp test run --passWithNoTests --project unit src/components/chat/ThreadConversationWidth.test.tsx)
```

Before considering the branch healthy, also run:

```sh
pnpm exec vp check
pnpm exec vp run typecheck
```

## Conversation Width Defaults

This branch intentionally removes the default max width from the main chat conversation and composer surfaces across browser, desktop, and VS Code extension hosts.

Expected behavior:

- By default, conversation rows, the composer, composer banners, and the branch toolbar expand across the available chat window space.
- The VS Code `t3code.ui.threadConversationMaxWidth` setting remains available as an explicit opt-in max-width override.
- Leaving the VS Code setting empty means no maximum width, not the upstream narrow conversation width.

Primary files:

- `apps/web/src/components/chat/ThreadConversationWidth.tsx`
- `apps/web/src/components/chat/ComposerBannerStack.tsx`
- `apps/web/src/components/BranchToolbar.tsx`
- `apps/vscode-extension/package.json`

Relevant tests live in:

- `apps/web/src/components/chat/ThreadConversationWidth.test.tsx`

## Terminal-backed Project Actions

This branch should treat terminal-backed project actions as reusable terminal workflows, not as fire-and-forget terminal creation.

Expected behavior:

- Running a project action should reuse a stable terminal for that action when possible instead of opening a new terminal instance on every click.
- If action-specific reuse is not available, terminal-backed actions should still prefer a shared action terminal group so repeated runs do not leave many stale terminal instances behind.
- A project action must not write its command until the target terminal session is ready to receive input. This avoids shells with slow startup, such as login `bash`, rendering the command before the prompt and leaving the command unexecuted.
- If the selected reusable terminal is busy running a subprocess, the action may choose another action terminal rather than injecting input into a live process.
- The readiness wait uses the current terminal session summary when available, and otherwise attaches to the terminal stream and waits briefly for prompt-like output before writing. If the prompt is never observed, the wait times out and the action still writes rather than hanging indefinitely.

Primary files:

- `apps/web/src/components/ChatView.tsx`
- `apps/web/src/components/ThreadTerminalDrawer.tsx`
- `apps/web/src/projectScriptTerminals.ts`
- `apps/web/src/state/projectActionTerminal.ts`
- `apps/server/src/terminal/Layers/Manager.ts`

Relevant tests live in:

- `apps/web/src/projectScriptTerminals.test.ts`

Useful focused command:

```sh
(cd apps/web && pnpm exec vp test run --passWithNoTests --project unit src/projectScriptTerminals.test.ts)
```

## Codex Workspace Skill Loading

Fix Codex repo-local skill discovery in the composer by resolving skills for the active project/worktree cwd, instead of relying on the global provider status snapshot.

Expected behavior:

- Repo-local Codex skills for the active workspace appear in the `$` skill picker.
- The server exposes a workspace-aware `server.listProviderSkills` path and validates enabled Codex skill-listing requests against the requested cwd.
- The server routes skill listing through a bounded request lister that coalesces concurrent requests for the same provider/cwd, limits cross-workspace concurrency, and applies a short TTL so reconnects or repeated composer renders do not repeatedly spawn Codex app-server probes.
- The Codex provider requests `skills/list` with the current workspace cwd, times out hung app-server probes, and terminates the probe process when a timeout occurs.
- Non-Codex or disabled providers keep returning provider snapshot skills instead of failing workspace skill search.
- The client runtime keys provider-skill query state by environment, provider instance, and cwd, with a bounded stale window so reconnects refresh workspace-local skills without reusing another workspace's snapshot.
- The composer preserves already loaded repo-local skills while refreshing the same workspace, treats an empty loaded skill list as authoritative data, and clears stale skills during workspace switches or settled failures.

Primary files:

- `apps/server/src/ws.ts`
- `apps/server/src/provider/ProviderSkillsLister.ts`
- `apps/server/src/provider/Layers/CodexProvider.ts`
- `apps/web/src/lib/providerWorkspaceSkillsState.ts`
- `packages/contracts/src/server.ts`
- `packages/client-runtime/src/state/server.ts`

Relevant tests live in:

- `apps/server/src/server.test.ts`
- `apps/server/src/provider/ProviderSkillsLister.test.ts`
- `apps/server/src/provider/Layers/CodexProvider.test.ts`
- `apps/server/src/provider/Layers/CursorProvider.test.ts`
- `apps/server/src/provider/Layers/GrokProvider.test.ts`
- `apps/web/src/lib/providerWorkspaceSkillsState.test.ts`
- `packages/client-runtime/src/state/runtime.test.ts`

Useful focused commands:

```sh
(cd apps/server && pnpm exec vp test run --passWithNoTests src/provider/ProviderSkillsLister.test.ts src/provider/Layers/CodexProvider.test.ts src/provider/Layers/CursorProvider.test.ts src/provider/Layers/GrokProvider.test.ts)
(cd apps/web && pnpm exec vp test run --passWithNoTests --project unit src/lib/providerWorkspaceSkillsState.test.ts)
```

## Thread Detail Subscription Reliability

This branch carries a server-side fix for a race in thread-detail websocket subscriptions. The bug can make the initial user prompt disappear from newly started conversations in packaged/static hosts such as the desktop app and VS Code extension, because those hosts are more likely to dispatch the first `thread.message-sent` event while the server is still loading the initial thread snapshot for `subscribeThread`.

Expected behavior:

- A new conversation's first user message remains visible after the optimistic row is replaced by server state.
- `ORCHESTRATION_WS_METHODS.subscribeThread` attaches to the live orchestration event stream before loading the initial thread detail snapshot.
- Thread-detail events emitted during the snapshot read are buffered and replayed after the snapshot when their sequence is newer than the snapshot sequence.
- The fix is host-agnostic server reliability work. Preserve it for desktop, VS Code extension, and web clients unless upstream has equivalent snapshot-plus-live-tail subscription behavior.

Primary files:

- `apps/server/src/ws.ts`
- `apps/server/src/server.test.ts`

## VS Code Extension Work

This branch also carries the VS Code extension work that is not assumed to exist on `main`. Treat the VS Code extension, its desktop-backed integration model, workspace-scoped webview behavior, host-injected primary-environment bootstrap, host MCP bridge, release packaging, and related tests as part of this branch's customization set during upstream merges.

VS Code workspace-folder identity should stay aligned with the shared desktop/host-MCP workspace helpers in `packages/shared/src/workspaceFolders.ts`; do not reintroduce independent active-folder matching in the extension.

The VS Code webview is a host-managed workspace surface, not a normal hosted web app. The web app should register the primary environment directly from `window.t3HostBridge.getLocalEnvironmentBootstrap()` when that bootstrap includes the environment id, label, HTTP URL, WebSocket URL, and bearer token. Do not reintroduce a dependency on `/.well-known/t3/environment` before the VS Code sidebar can load workspace threads.

The implementation details are intentionally kept in `apps/vscode-extension/IMPLEMENTATION.md` instead of being duplicated here. Unlike the other sections in this file, `CUSTOMIZED.md` should only preserve the merge-maintenance rule for this area: keep the extension work unless `main` has gained an equivalent VS Code extension architecture, then reconcile against the detailed implementation note.

Primary reference:

- `apps/vscode-extension/IMPLEMENTATION.md`

## Subagent Threading Work

This branch also carries the Codex subagent-threading work that is not assumed to exist on `main`. Treat Codex subagent lineage, child-thread projection, contextual active sidebar rows, parent subagent reference blocks, child-thread output isolation, child stop behavior, and related tests as part of this branch's customization set during upstream merges.

Thread archive/delete lifecycle behavior is enforced server-side in the orchestration decider: archiving or deleting a parent thread cascades through active subagent descendants before the parent event, and force-deleting a project delegates through lifecycle roots so descendant subagents are not double-deleted.

The implementation details are intentionally kept in `SUBAGENTS.md` instead of being duplicated here. Unlike the other sections in this file, `CUSTOMIZED.md` should only preserve the merge-maintenance rule for this area: keep the subagent threading work unless `main` has gained an equivalent UI-aware subagent architecture, then reconcile against the detailed subagent note.

Primary reference:

- `SUBAGENTS.md`

## Version Control Panel Work

This branch includes a first-class Version Control panel that is not assumed to exist on `main`. Treat the Version Control singleton right-panel surface, VS Code host display setting, live VCS status watcher, Actionable and Remotes panel model, selected-file commit/stash flow, branch/commit/stash/remote actions, and Version Control panel RPC/contracts as part of this branch's customization set during upstream merges.

Preserve the branch-local idle-power safeguards for VCS status: ignore internal `.git/` watcher events before refreshing local status, and keep the default automatic remote Git fetch interval conservative unless upstream provides equivalent lower-churn VCS status behavior.

Provider-backed change-request lookups remain best-effort in the panel service. Provider/auth/CLI failures must not fail the whole panel snapshot or hide git-derived actionable branch rows.

The implementation details are intentionally kept in `SOURCE_CONTROL.md` instead of being duplicated here. Unlike the other sections in this file, `CUSTOMIZED.md` should only preserve the merge-maintenance rule for this area: keep the Version Control panel work unless `main` has gained an equivalent agent-aware version-control panel, then reconcile against the detailed source-control note.

Primary reference:

- `SOURCE_CONTROL.md`

## Mobile EAS Project Ownership

This branch points the mobile Expo/EAS project at the local `quicksaver` owner instead of upstream's `pingdotgg` owner so installable internal mobile builds can be produced without requiring access to the upstream Expo organization.

Expected behavior:

- `apps/mobile/app.config.ts` uses `owner: "quicksaver"` for EAS project ownership.
- `apps/mobile/app.config.ts` uses EAS project id `c65ac46d-6488-49af-b61e-ab9bef78f96e`.

Important merge rule:

If upstream changes the mobile EAS project metadata, preserve the local `quicksaver` owner and project id unless this branch intentionally switches back to the upstream Expo organization or to a new local EAS project. Re-check this before resolving conflicts in `apps/mobile/app.config.ts`, because accepting upstream's `pingdotgg` owner can make local `eas build --profile preview` fail with Expo authorization errors.

Primary file:

- `apps/mobile/app.config.ts`

## Merge Guidance

When merging from upstream, keep these local behaviors unless upstream has an equivalent implementation:

1. Command and file-change activities stay readable as compact expandable rows in the conversation work log.
2. Codex subagent threading work remains preserved as a local customization unless `main` has an equivalent UI-aware subagent architecture; use `SUBAGENTS.md` as the detailed source of truth.
3. Chat conversation and composer surfaces default to no maximum width across all host types.
4. VS Code extension work remains preserved as a local customization unless `main` has an equivalent implementation; use `apps/vscode-extension/IMPLEMENTATION.md` as the detailed source of truth.
5. Workspace-scoped Codex skill loading remains preserved so repo-local Codex skills for the active workspace continue to appear in the `$` skill picker without repeated unbounded provider probes or stale skill leakage across workspaces.
6. Version Control panel work remains preserved as a local customization unless `main` has an equivalent agent-aware version-control panel; use `SOURCE_CONTROL.md` as the detailed source of truth.
7. Version Control idle-power safeguards continue to ignore internal `.git/` watcher churn and use a conservative automatic remote Git fetch interval unless upstream ships equivalent low-churn behavior.
8. Thread-detail subscriptions preserve first-message events emitted during initial snapshot loading unless upstream ships equivalent snapshot-plus-live-tail buffering.
9. Terminal-backed project actions reuse action terminals where possible and wait for terminal readiness before writing commands.
10. Expanded command activity rows show differing raw command text inline with the other command details.
11. Mobile EAS project ownership remains pointed at the local Expo project used for installable preview builds unless deliberately changed.

## Retirement Criteria

These local patches can be removed when upstream provides all of the following:

- A canonical parent-child relationship for subagent/collab tool events.
- A UI model that treats subagents as routeable child threads with parent reference blocks.
- Sidebar, routing, archive/delete, and stop behavior that match `SUBAGENTS.md`.
- Tests or contracts that guarantee child output and actions stay scoped to the child conversation view.

When retiring the local changes, remove the corresponding tests or update them to assert the upstream behavior directly.

## Worktrees Tracking

> Here are referenced the latest commit SHAs for the `main` branch of both the `origin` and `upstream` remotes. These SHAs are used to determine if any worktrees need to be updated with changes from `upstream/main` and `origin/main`.

**Last origin/main commit SHA:** 8dfebb857
**Last upstream/main commit SHA:** cdaba7fa8
