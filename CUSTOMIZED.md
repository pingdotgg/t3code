# Custom Branch Changes

> Keep this file readable for humans: do not hard-wrap prose lines; let editors wrap long lines visually. Keep headings, lists, tables, and code blocks structurally formatted.

## Last Upstream Merge

Generated after upstream merge commit `f4409e95e`, with `origin/main` at `7b378ec6d` and `upstream/main` at `82a9bcc7f`. One hundred sixty new upstream commits were merged since the previously recorded upstream ref `cc69aef4d`, spanning `40d14647d` (`[codex] Structure catalog dependency resolution failures (#3298)`) through `82a9bcc7f` (`[codex] add session context to credential errors (#3349)`). No new `origin/main` commits were available beyond the current fork-tracking origin ref `7b378ec6d`. After this merge, reconciliation, and inventory refresh, local `main` is 255 commits ahead and 0 commits behind `upstream/main`, and 250 commits ahead and 0 commits behind `origin/main`; the remaining fork delta against current `upstream/main` is 276 files changed, 37720 insertions, and 1100 deletions.

The old local GitLab CLI string normalizer is retired by this merge because upstream now owns typed GitLab CLI errors (`GitLabCliUnavailableError`, `GitLabCliAuthenticationError`, `GitLabMergeRequestNotFoundError`, decode errors, and command errors) with structured operation/cwd/cause fields. No user-facing fork behavior was retired: the previously retired `?diff=1` right-panel override remains absent because upstream owns diff opening through dedicated diff panel state. Upstream broadly enforced Effect error-handling conventions and added structured or cause-preserving failures across desktop app/backend/update flows, primary auth and environment targeting, theme and local storage sync, ACP/Codex app-server protocols, VCS process boundaries, source-control provider CLIs, Git workflow operations, preview automation, mobile pairing/waitlist/notification/outbox/storage/review flows, relay auth/APNs/activity/env-link flows, release scripts, workspace search/filesystem/probe flows, and text-generation providers. These upstream changes are authoritative; the local VS Code host bootstrap, custom Version Control panel, subagent threading, wide conversation defaults, workspace skill loading, terminal action reuse work, host appearance/theme integration, and mobile EAS ownership remain preserved around them.

Concrete merge notes from this merge:

- Textual conflicts occurred in `apps/desktop/src/backend/DesktopBackendManager.ts`, `apps/server/src/auth/SessionStore.test.ts`, `apps/server/src/provider/Layers/CodexSessionRuntime.test.ts`, `apps/server/src/sourceControl/AzureDevOpsSourceControlProvider.test.ts`, `apps/server/src/sourceControl/GitHubSourceControlProvider.test.ts`, `apps/server/src/sourceControl/GitLabCli.ts`, `apps/web/src/environments/primary/auth.ts`, `apps/web/src/environments/primary/target.ts`, `apps/web/src/hooks/useTheme.ts`, `packages/effect-acp/src/client.test.ts`, and `packages/effect-acp/src/protocol.test.ts`.
- `apps/desktop/src/backend/DesktopBackendManager.ts` keeps the local desktop backend advertisement write/cleanup path while adopting upstream's exported structured readiness timeout error context.
- `apps/server/src/provider/Layers/CodexSessionRuntime.test.ts` keeps the local host MCP server config regression coverage for `thread/start`; the production Codex app-server changes from upstream remain in place.
- `apps/server/src/sourceControl/AzureDevOpsSourceControlProvider.test.ts` and `apps/server/src/sourceControl/GitHubSourceControlProvider.test.ts` now cover both local remote-repository targeting and upstream's sanitized provider error wrapping. `apps/server/src/sourceControl/GitLabCli.ts` uses upstream typed CLI errors instead of the local text normalizer.
- `apps/web/src/environments/primary/auth.ts` keeps the local host bearer/bootstrap credential path from `hostBootstrap` while adopting upstream's structured primary-auth request, rejected-credential, timeout, and required-credential errors.
- `apps/web/src/environments/primary/target.ts` keeps the local host bridge accessor (`getHostLocalEnvironmentBootstrap`) for desktop and VS Code hosts while adopting upstream's typed URL/protocol/incomplete-bootstrap errors.
- `apps/web/src/hooks/useTheme.ts` keeps host appearance application and subscriptions while adopting upstream's structured localStorage and desktop theme sync errors.
- `packages/effect-acp/src/client.test.ts` and `packages/effect-acp/src/protocol.test.ts` follow upstream's structured ACP error expectations because the merged protocol implementation now owns those error shapes.
- The local Mobile EAS project ownership in `apps/mobile/app.config.ts` remains intentional; upstream's mobile error-structure changes do not alter the `quicksaver` owner or local preview build project id.
- The local terminal-backed project action reuse remains in `apps/server/src/terminal/Manager.ts`, `apps/web/src/projectScriptTerminals.ts`, `apps/web/src/state/projectActionTerminal.ts`, and `apps/web/src/components/ChatView.tsx`; upstream's new VCS process/PTy/app-server error structure is complementary and should be preserved on future terminal conflicts.
- The local conversation activity rendering remains in `apps/web/src/session-logic.ts` and `apps/web/src/components/chat/MessagesTimeline.tsx`; upstream's protocol/client-state/activity persistence error structure does not replace the custom expandable command and file-change rows.
- The local VS Code host bootstrap and Version Control panel surfaces remain separate customizations; upstream's primary environment target/auth, source-control provider, Git workflow, and VCS process error improvements should be kept if future conflicts touch these areas.

Still-relevant conflict-prone areas from the previous upstream merge:

- `apps/server/src/config.ts`, `apps/server/src/provider/ProviderSkillsLister.ts`, `apps/server/src/ws.ts`, `apps/server/src/server.ts`, `apps/server/src/vscodeWorkspaceBootstrap/http.ts`, and `apps/server/src/vscodeWorkspaceBootstrap/bootstrap.ts` keep the local VS Code host bootstrap, host MCP server injection, workspace-scoped Codex skill listing, and legacy auth compatibility routes while adapting them to upstream's root Effect service modules and new auth error taxonomy.
- `apps/server/src/sourceControl/*` keeps the local remote-repository targeting for GitHub, GitLab, Azure DevOps, and Bitbucket change-request discovery while accepting upstream's source-control service refactor, decoder/import naming, and typed provider-error conventions.
- `apps/server/src/terminal/Manager.ts`, `apps/server/src/terminal/Manager.test.ts`, and `apps/web/src/components/ChatView.tsx` keep the fork's terminal action reuse safety: stable project-action terminal ids, fallback action terminal labels, readiness waits, and conservative POSIX subprocess detection now live on upstream's root terminal manager module.
- `apps/server/src/vcs/VcsStatusBroadcaster.ts` and `apps/server/src/vcs/VcsLocalWatch.ts` keep the local git-ignore-aware filesystem watcher for local status refresh while accepting upstream's exported `make` service constructor and remote poller changes; the Version Control panel still does not add an independent periodic fetch timer.
- `apps/web/src/components/ChatView.tsx`, `apps/web/src/rightPanelStore.test.ts`, `apps/web/src/components/Sidebar.tsx`, and `apps/web/src/components/Sidebar.logic.ts` keep the custom Source Control panel, VS Code project scoping, `primaryServerWelcomeAtom` workspace scoping, and exported sidebar home button while accepting upstream's `diffPanelStore`, environment-scoped settings hooks, server-backed stage labels, and sidebar/server config state.

Post-merge consistency refactor: host MCP discovery now exposes Effect-native helpers plus compatibility Promise wrappers, provider adapters call the Effect path directly, VS Code workspace bootstrap logic is split out of the HTTP route, the host-integration portion of `ServerConfig` has a named shape, and local VCS filesystem watch filtering lives in `apps/server/src/vcs/VcsLocalWatch.ts`. A follow-up diagnostic alignment keeps provider skill-list failures, host MCP discovery skips, and source-control provider/panel failures structured with stable user-facing messages, operation/reason metadata where available, and sanitized cause diagnostics. The provider skill-list contract lives in `packages/contracts/src/server.ts`, while `apps/server/src/provider/ProviderSkillsLister.ts`, `apps/server/src/provider/hostMcpDiscovery.ts`, `apps/server/src/sourceControl/SourceControlPanelService.ts`, and the source-control provider adapters populate the runtime `reason`, `operation`, and diagnostic fields. Source-control provider adapters now route common command/API wrapping through `sourceControlProviderError`, so provider, operation, cwd, sanitized reference/repository, detail, command, and cause fields stay aligned across GitHub, GitLab, Azure DevOps, and Bitbucket. Host bootstrap helpers now use desktop-managed naming for upstream consistency while exporting legacy host-named aliases for VS Code host compatibility, and VS Code diagnostics keep both new `desktopManaged*` and old `local*` fields. Terminal-backed project action readiness now exposes typed attach/timeout errors on the strict Effect path while preserving the best-effort command-write fallback. These are intended to reduce future conflict pressure with upstream's service-module and structured-error conventions without changing the preserved custom behavior.

Current post-merge refactor validation passed with focused source-control provider/panel tests, focused web host-bootstrap/project-action-terminal tests, `pnpm exec vp check`, and `pnpm exec vp run typecheck`. `vp check` still reports seven pre-existing mobile schema-hoisting warnings in `apps/mobile/src/connection/catalog-store.ts` and `apps/mobile/src/connection/storage.ts`; no native mobile code changed in this refactor, so `vp run lint:mobile` was not required.

## Latest Worktree Port

Generated from local `main` at `29d667b96` after a PR-comment pass and follow-up port inspection across active worktrees `fix/codex-skills`, `split/file-command-activity-boxes`, `split/subagent-threading-work`, `split/terminal-backed-project-actions`, `fix/thread-detail-subscription-race`, `split/version-control-panel-work`, and `split/vscode-extension-work`.

The port retained only targeted branch-local fixes that were absent from `main`: command output extraction and merge hardening for blank-only streams, whitespace-only incremental chunks, split chunks, shorter completed/updated snapshots, and shorter single-line repeated-prefix snapshots; terminal-backed project action terminal id collision fixes, fallback action terminal labels such as `Action: build (2)`, and conservative busy detection when POSIX process-tree inspection is incomplete; subagent parent metadata propagation, parent-collab child-shell synthesis, child-stop no-root-fallback behavior, resumed-child parent block de-duplication, item/turn-aware live-status matching, hidden terminal ancestor traversal, and active route subagent sidebar path visibility; Version Control panel fixes for default compare refs, non-current diverged merge sync, discard failure surfacing, fallback rename parsing, merged staged-plus-unstaged row stats, and late-month relative dates; and related `SOURCE_CONTROL.md` and `SUBAGENTS.md` documentation refreshes. The workspace-scoped skill-loading, thread-detail subscription race, and VS Code extension worktrees had no additional production code to port because their useful behavior was already represented on `main`. Do not replay split worktrees wholesale: several remaining diffs are stale branch shape or would regress newer `main` behavior.

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
- Command output extraction ignores blank-only completed stdout/stderr fallbacks so aggregated command output is still shown, but preserves whitespace-only incremental `tool.updated` chunks, including raw output `content`, so streamed output is not collapsed away.
- Incremental command output chunks concatenate without injected separators, while shorter completed snapshots, newline-terminated shorter updated snapshots, and shorter single-line repeated-prefix snapshots do not overwrite a previously merged longer output snapshot.

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
- The Effect-based readiness wait exposes a strict typed-error path for attach failures and prompt timeouts, while the project action command path deliberately keeps the existing best-effort fallback that writes after failure/timeout instead of blocking the action.
- Action terminal ids encode script ids and reserve numeric `:<suffix>` ids for fallback terminals, so script ids such as `build-2` or legacy colon ids such as `build:dev` cannot be mistaken for fallback terminals of another action.
- Fallback action terminal tabs include their instance suffix in parentheses, such as `Action: build (2)`, while script ids that naturally end in digits, such as `build-2`, keep readable labels such as `Action: build 2`.
- POSIX subprocess detection is conservative when full process-tree inspection fails: a shell child is treated as busy rather than idle so commands are not injected into a terminal that may still have a hidden descendant process.

Primary files:

- `apps/web/src/components/ChatView.tsx`
- `apps/web/src/components/ThreadTerminalDrawer.tsx`
- `apps/web/src/projectScriptTerminals.ts`
- `apps/web/src/state/projectActionTerminal.ts`
- `apps/server/src/terminal/Layers/Manager.ts`

Relevant tests live in:

- `apps/web/src/projectScriptTerminals.test.ts`
- `apps/server/src/terminal/Layers/Manager.test.ts`
- `packages/shared/src/terminalLabels.test.ts`

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
- Provider skill-list failures preserve structured reason, operation, provider instance, cwd, and bounded cause diagnostics for missing providers, invalid cwd, settings failures, Codex home preparation, probe timeouts, and probe failures while keeping stable user-facing messages. Raw thrown values are not sent directly to clients; the server keeps a small plain diagnostic shape so file paths, process output, and unexpected objects do not expand the wire payload.
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

Host MCP discovery remains best-effort during provider startup, but skipped advertisements should retain diagnostics for duplicate server names, missing sockets, socket-check failures, failed probes, rejected probes, and advertisement-read failures so the desktop/VS Code bridge can be debugged without turning stale advertisements into provider-start failures. Diagnostic emission is best-effort and non-blocking; focused tests can collect it through the `onDiagnostic` callback, and production troubleshooting currently relies on server-side instrumentation rather than a dedicated end-user UI.

The implementation details are intentionally kept in `apps/vscode-extension/IMPLEMENTATION.md` instead of being duplicated here. Unlike the other sections in this file, `CUSTOMIZED.md` should only preserve the merge-maintenance rule for this area: keep the extension work unless `main` has gained an equivalent VS Code extension architecture, then reconcile against the detailed implementation note.

Primary reference:

- `apps/vscode-extension/IMPLEMENTATION.md`

## Subagent Threading Work

This branch also carries the Codex subagent-threading work that is not assumed to exist on `main`. Treat Codex subagent lineage, child-thread projection, contextual active sidebar rows, active terminal subagent ancestor visibility, parent subagent reference blocks, resumed-child parent activity rows, child-thread output isolation, child stop behavior, parent metadata ingestion, and related tests as part of this branch's customization set during upstream merges.

Thread archive/delete lifecycle behavior is enforced server-side in the orchestration decider: archiving or deleting a parent thread cascades through active subagent descendants before the parent event, and force-deleting a project delegates through lifecycle roots so descendant subagents are not double-deleted.

Child runtime events that arrive with parent-collab metadata may synthesize the missing child shell before their output/actions are ingested. Child stop requests must target the selected child turn when known, and if no active child turn can be identified the server records a child interrupt failure and marks the child stopped instead of falling back to the root session's active turn.

The implementation details are intentionally kept in `SUBAGENTS.md` instead of being duplicated here. Unlike the other sections in this file, `CUSTOMIZED.md` should only preserve the merge-maintenance rule for this area: keep the subagent threading work unless `main` has gained an equivalent UI-aware subagent architecture, then reconcile against the detailed subagent note.

Primary reference:

- `SUBAGENTS.md`

## Version Control Panel Work

This branch includes a first-class Version Control panel that is not assumed to exist on `main`. Treat the Version Control singleton right-panel surface, VS Code host display setting, live VCS status watcher, Actionable and Remotes panel model, selected-file commit/stash flow, branch/commit/stash/remote actions, compare-base semantics, and Version Control panel RPC/contracts as part of this branch's customization set during upstream merges.

Preserve the branch-local idle-power safeguards for VCS status: ignore internal `.git/` watcher events before refreshing local status, and keep the default automatic remote Git fetch interval conservative unless upstream provides equivalent lower-churn VCS status behavior.

Provider-backed change-request lookups remain best-effort in the panel service. Provider/auth/CLI failures must not fail the whole panel snapshot or hide git-derived actionable branch rows.

Version Control and source-control provider failures should preserve structured causes when normalized for panel RPC errors. GitLab, GitHub, Azure DevOps, and Bitbucket provider paths should keep provider-specific not-found/auth/missing-CLI details without collapsing structured process failures into generic strings.

Preserve the panel's review-hardened edge cases: the current default branch remains a valid default compare ref, diverged normal merge sync is available only for the current branch, tracked discard restore failures surface instead of being swallowed, fallback rename parsing preserves original paths, merged staged-plus-unstaged row stats are summed, and late-month relative dates do not fall through to `0 years ago`.

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
11. Command output merging preserves meaningful streamed output across blank fallbacks, whitespace chunks, split chunks, and shorter snapshots.
12. Terminal-backed project action terminal ids remain collision-resistant and busy detection stays conservative when subprocess inspection is incomplete.
13. Mobile EAS project ownership remains pointed at the local Expo project used for installable preview builds unless deliberately changed.

## Retirement Criteria

These local patches can be removed when upstream provides all of the following:

- A canonical parent-child relationship for subagent/collab tool events.
- A UI model that treats subagents as routeable child threads with parent reference blocks.
- Sidebar, routing, archive/delete, and stop behavior that match `SUBAGENTS.md`.
- Tests or contracts that guarantee child output and actions stay scoped to the child conversation view.

When retiring the local changes, remove the corresponding tests or update them to assert the upstream behavior directly.

## Worktrees Tracking

> Here are referenced the latest commit SHAs for the `main` branch of both the `origin` and `upstream` remotes. These SHAs are used to determine if any worktrees need to be updated with changes from `upstream/main` and `origin/main`.

**Last origin/main commit SHA:** 7b378ec6d
**Last upstream/main commit SHA:** cc69aef4d
