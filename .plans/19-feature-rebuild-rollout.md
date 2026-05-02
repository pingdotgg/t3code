# Feature Rebuild Rollout

This is the execution checklist for rebuilding the planned user-facing features on top of the current T3 Code baseline.

## Goal

Rebuild the feature set in a controlled sequence on one long-lived comparison branch.

Use:

- terminal checks for static/build/test verification
- the Computer Use plugin for manual QA and regression passes

We are not landing each feature to `main` as we go. Another agent is actively working there. Instead, we will build the full rebuild stack on our own branch and compare the final result against whatever lands on `main`.

## Starting point

Before feature work starts, create or switch to a dedicated rebuild branch from `origin/main`.

Why:

- `ClayCode rebrand` is already merged on `origin/main`
- `Sidebar history shortcuts` is already merged on `origin/main`
- rebuilding on the older detached replay baseline would make us redo already-landed work
- keeping our work on one long-lived branch avoids collisions with the separate agent working on `main`

## Global rules

For every feature:

1. Build on the long-lived rebuild branch
2. Implement the feature
3. Run the terminal QA gate
4. Run the Computer Use QA gate
5. Commit the feature as an isolated checkpoint
6. Continue to the next feature on the same branch
7. Periodically compare the branch against updated `main`
8. At the end, compare the final rebuild branch against the other agent's result on `main`

## Terminal QA gate

Run these every time before opening or updating a PR:

- `bun fmt`
- `bun lint`
- `bun typecheck`
- `bun run test`
- `bun run build`
- `bun run build:desktop`

When relevant:

- `bun run test:desktop-smoke`
- feature-targeted browser tests in `apps/web`
- targeted integration or server tests for touched areas

## Computer Use QA gate

Run these in a fresh local project/workspace for each feature unless the feature explicitly needs existing state.

Universal regression pass:

- create a fresh thread and send one message
- send a second message in the same thread
- switch threads while a response is active if the feature can affect thread state
- switch projects and verify sidebar state updates cleanly
- reload the page and confirm the app reconnects without broken state
- open a second tab on the same project and verify no duplicate sends or broken projection state
- hard reload and verify state rehydrates
- clear local storage and verify the app still boots without runtime errors

Accessibility pass for UI changes:

- tab through all new controls
- verify visible focus on all new focusable elements
- verify `Esc` exits menus/dialogs
- verify labels are present for buttons and inputs
- verify state is not communicated by color alone

## Execution order

### 0. Baseline branch setup

Tasks:

- create a dedicated rebuild branch from `origin/main`
- verify `ClayCode rebrand` is present
- verify `Sidebar history shortcuts` are present
- confirm the branch is clean and ready for sequential feature work

Computer Use QA:

- verify the app branding shows `ClayCode` in the desktop/web surfaces that changed
- verify sidebar browser-history navigation works with `Cmd-[` and `Cmd-]`

Exit criteria:

- rebuild branch starts from latest `origin/main`

### 1. Snippet picker

Status:

- completed on `codex/rebuild-feature-rollout`
- restored queued-follow-up → snippet save parity from the earlier implementation
- targeted browser coverage passed for queued-row save and snippet-picker visibility
- Computer Use QA passed on a live running thread: queued a follow-up, saved it as a snippet from the queue panel, and verified it appeared immediately in the picker
- QA notes captured in `.codex/artifacts/qa/snippet-picker.md`

Target:

- add a user-facing snippet picker that makes reusable prompt/code snippets easy to discover and insert

Tasks:

- define where snippets live and how they are loaded
- design insertion UX in the composer
- support keyboard-first filtering and insertion
- add unit coverage for parsing/filtering/insertion logic
- add browser coverage for interaction flow
- update docs if snippet authoring or usage becomes user-visible

Computer Use QA:

- open the picker from the composer
- search/filter snippets
- insert a snippet into an empty composer
- insert a snippet into an already-populated composer without clobbering surrounding text
- verify keyboard-only open, navigate, insert, and dismiss flows

Exit criteria:

- snippets can be found and inserted quickly with mouse and keyboard

### 2. Quick thread search

Status:

- completed on `codex/rebuild-feature-rollout`
- rebuilt as a dedicated modal opened by `Cmd/Ctrl+Shift+F`
- terminal QA gate passed
- Computer Use QA passed on a fresh isolated state dir

Target:

- provide a dedicated fast way to search and jump between threads

Tasks:

- decide whether to extend the command palette or add a dedicated thread-search entry point
- ensure ranking is stable and useful across title, project, branch, and recency
- add shortcut and discoverability affordances
- add unit coverage for search/ranking behavior
- add browser coverage for opening, filtering, and navigating

Computer Use QA:

- open thread search from the intended shortcut/entry point
- search by thread title
- search by project name
- search by branch name if available
- verify archived threads do not appear unless intentionally supported
- jump into a result and verify routing/state hydration are correct

Exit criteria:

- thread search is noticeably faster than manual sidebar navigation

### 3. Draft threads hardening

Status:

- completed on `codex/rebuild-feature-rollout`
- terminal QA gate passed
- Computer Use QA passed on a fresh isolated state dir
- verified that starting a second new draft creates a fresh `/draft/<id>` route and that navigating back restores the earlier unsent draft content

Target:

- treat draft threads as a first-class feature and harden the current implementation

Tasks:

- audit current draft-thread behaviors already present in the app
- close gaps around creation, promotion, reuse, routing, and project/worktree context
- simplify any brittle state transitions in draft-thread logic
- expand tests around draft creation, promotion, and reuse

Computer Use QA:

- create a new draft thread from an empty project context
- create a draft thread from a project context
- verify draft reuse behavior when expected
- verify a promoted draft canonicalizes to the server thread route
- verify new drafts do not incorrectly reuse a promoting draft

Exit criteria:

- draft-thread lifecycle feels deterministic and unsurprising

### 4. GitHub PR pills

Status:

- completed on `codex/rebuild-feature-rollout`
- terminal QA gate passed (`bun fmt`, `bun lint`, `bun typecheck`, `bun run test`, `bun run build`, `bun run build:desktop`)
- Computer Use QA passed in Safari on a fresh isolated state dir
- verified that a real thread mentioning `https://github.com/pingdotgg/t3code/pull/49` rendered a merged `#49` pill in the sidebar and that clicking it opened the GitHub PR in a new tab

Target:

- upgrade PR status from a minimal indicator into a clearer, more intentional pill treatment

Tasks:

- define the pill states and visual treatment for open, closed, and merged
- decide where pills appear: sidebar, thread header, or both
- preserve accessibility and avoid relying on color alone
- add unit tests for pill state resolution
- add browser tests for rendering and click/open behavior

Computer Use QA:

- verify open, closed, and merged states render distinctly
- verify pills remain legible in dense sidebar layouts
- verify clicking a pill opens the expected PR destination or action
- verify pills do not break thread row truncation or keyboard navigation

Exit criteria:

- PR state is obvious at a glance without cluttering the sidebar

### 5. Queue + Steer

Status:

- completed on `codex/rebuild-feature-rollout`
- terminal QA gate passed (`bun fmt`, `bun lint`, `bun typecheck`, `bun run test`, `bun run build`, `bun run build:desktop`)
- Computer Use QA passed on a fresh isolated state dir
- verified live queueing with `Tab`, in-place queued edit, automatic FIFO dispatch after the active turn settled, and immediate steering with `Enter` during a running turn
- QA notes captured in `.codex/artifacts/qa/queue-steer.md`

Target:

- rebuild the queue-and-steer experience as the marquee feature

Tasks:

- define the exact user model for queued sends and steering queued work
- separate UI state from server/orchestration guarantees
- rebuild the composer, queue controls, and queued-turn rendering together
- add strong regression coverage for queue ordering, recovery, retries, and interruptions
- add end-to-end browser coverage for primary queue flows
- validate reconnect/reload behavior under queued work

Computer Use QA:

- queue a send without dispatching immediately if the design supports it
- steer or edit queued work before execution
- dispatch queued work and confirm ordering is preserved
- verify multiple queued items do not collapse into broken state
- reload during queued or active work and confirm recovery
- switch threads/projects during queued work and confirm state stays coherent
- verify error handling on failed queued dispatch is actionable

Exit criteria:

- queued work behaves predictably across reloads, reconnects, and rapid user input

### 6. Tailscale remote access

Status:

- completed on `codex/rebuild-feature-rollout`
- terminal QA gate passed (`bun fmt`, `bun lint`, `bun typecheck`, `bun run test`, `bun run build`, `bun run build:desktop`)
- Computer Use QA passed on a fresh isolated desktop state dir
- verified that the desktop Connections settings page renders the new `Tailnet access` row with the live Tailnet hostname/IP
- verified that enabling network exposure restarts the desktop backend into `network-accessible` mode and returns a reachable endpoint used to derive the Tailnet URL
- verified that the confirmation dialog is accessible through Computer Use and that the relaunched app returns directly to the exposed Connections state without the earlier backend-readiness timeout symptom
- QA notes captured in `.codex/artifacts/qa/tailscale-remote-access.md`

Target:

- make remote access easier and more reliable for real usage, likely building on the existing network-access + pairing foundation

Tasks:

- define the Tailscale-specific user flow and assumptions
- map that flow onto current server exposure, pairing, and remote connection primitives
- add any missing UI guidance and recovery states
- add tests for the configuration and state transitions we can cover locally
- document the exact setup flow

Computer Use QA:

- verify the remote-access settings flow is understandable from scratch
- verify pairing-link creation and copy flows
- verify error states explain what to do next
- verify remote entry points are discoverable and not misleading when unavailable

Exit criteria:

- a user can understand how to expose and pair a remote environment without guesswork

### 7. Historical parity follow-up

Status:

- completed on `codex/rebuild-feature-rollout`
- restored the sidebar `Grouped` / `Recent` mode toggle to the fuller historical behavior:
  - recent view now buckets threads by recency (`Today`, `Yesterday`, `Earlier this week`, `Older`)
  - recent rows now show project labels and reuse the same row actions as grouped mode
- restored the Codex transcript import workflow beyond preview-only:
  - `Cmd/Ctrl+Shift+I` opens the import dialog
  - local Codex sessions are listed and searchable
  - importing creates a durable local thread with the transcript content and import provenance
  - re-importing an already-imported session reopens the existing durable thread instead of duplicating it
- restored the deeper historical search surfaces that existed in the earlier rebuild work:
  - `Cmd/Ctrl+Alt+F` opens `Search All Threads` for title/message/plan search across loaded threads
  - `Cmd/Ctrl+Alt+P` opens `Search Project Folders` and starts a new draft thread in the selected project
- restored the sidebar rename shortcut parity:
  - `Cmd/Ctrl+Shift+R` now triggers inline rename for the active sidebar thread
  - the rename flow works from the global shortcut path rather than only from thread-row context menus
- targeted coverage passed:
  - `apps/web/src/components/Sidebar.logic.test.ts`
  - `apps/web/src/components/ChatView.browser.tsx -t "imports a Codex transcript into a durable thread from the global shortcut"`
  - `apps/server/src/codexImport/Layers/CodexImport.test.ts`
  - `apps/web/src/components/GlobalThreadSearchDialog.browser.tsx`
  - `apps/web/src/components/ProjectFolderSearchDialog.browser.tsx`
  - `apps/web/src/components/ChatView.browser.tsx -t "global thread search shortcut"`
  - `apps/web/src/components/ChatView.browser.tsx -t "project folder search shortcut"`
  - `apps/web/src/components/ChatView.browser.tsx -t "opens sidebar rename from the global shortcut and submits the rename"`
  - `apps/server/src/keybindings.test.ts`
  - `apps/web/src/keybindings.test.ts`
- Computer Use QA:
  - passed for grouped/recent toggle parity
  - passed in Chrome for the durable Codex-import flow, including live import into a real thread and reopening the same imported thread from the dialog
  - passed for both restored search dialogs in Chrome via the command palette entry points
  - passed in the branch-local Electron dev app for the restored sidebar rename shortcut, including opening inline rename from `Cmd+Shift+R` and committing the updated title with `Enter`
  - the live app still displayed older shortcut hints for project/global search because this machine has saved keybindings in `~/.t3` overriding the new defaults; the checked-in defaults and tests now reflect the updated `Cmd/Ctrl+Alt+F` and `Cmd/Ctrl+Alt+P` bindings
- QA notes captured in `.codex/artifacts/qa/sidebar-recent-and-codex-import.md`
- QA notes captured in `.codex/artifacts/qa/codex-import-durable-thread.md`
- QA notes captured in `.codex/artifacts/qa/deep-search-and-project-search.md`
- QA notes captured in `.codex/artifacts/qa/sidebar-rename-hotkey.md`

Target:

- close the last historical parity gaps that were not part of the original feature ordering but were present in the prior rebuild work

## Checkpoint checklist

Before considering a feature checkpoint complete on the rebuild branch:

- terminal QA gate is green
- Computer Use QA pass is complete
- docs are updated if behavior changed
- commit scope is feature-shaped, not a grab bag of unrelated cleanup
- known follow-ups are captured before moving to the next feature

## Suggested branch

- `codex/rebuild-feature-rollout`
