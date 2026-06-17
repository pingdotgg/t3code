# Version Control Panel

## Current Status

T3 Code includes a Git-backed Version Control surface in the thread right panel. The panel is scoped to the active thread environment and repository cwd, uses server-owned Git operations, and reuses the existing VCS status, source-control provider, and WebSocket RPC infrastructure rather than shelling out from React.

The panel is intentionally an overview and high-level workflow surface. It focuses on current work, branch sync state, remotes, stashes, selected-file commit/stash flows, and compact branch/commit inspection. It is not a full VS Code SCM replacement and does not implement hunk-level staging.

Primary implementation files:

- `apps/web/src/components/source-control/SourceControlPanel.tsx`
- `apps/server/src/sourceControl/SourceControlPanelService.ts`
- `apps/server/src/vcs/VcsStatusBroadcaster.ts`
- `apps/server/src/ws.ts`
- `packages/contracts/src/rpc.ts`
- `packages/contracts/src/ipc.ts`
- `packages/client-runtime/src/wsRpcClient.ts`
- `apps/web/src/environmentApi.ts`

## Entry Points And Host Behavior

Version Control is a singleton right-panel surface with kind `source-control`. Users open it from the existing right-panel surface picker; it is not duplicated into the main chat header, project sidebar, or conversation timeline.

Right-panel integration is owned by:

- `apps/web/src/rightPanelStore.ts`
- `apps/web/src/components/RightPanelTabs.tsx`
- `apps/web/src/components/ChatView.tsx`

The VS Code extension exposes the shared T3 Code panel through the `t3code.ui.enableSourceControlPanel` display setting. Browser and desktop hosts enable the panel by default; VS Code webviews hide it by default so it does not compete with VS Code's native Source Control view. The setting only controls visibility of the shared panel; it does not fork source-control behavior or change backend capabilities.

## Layout

The Version Control panel has a compact repository summary at the top and two resizable, collapsible sections:

- `Actionable`
- `Remotes`

`Remotes` is collapsed by default. The sections share the available panel height, each section owns its own overflow area, and section edges can be dragged to resize them relative to each other.

The repository summary shows the current ref, upstream status, changed-file count and line stats, ahead-of-default context, and current error state. Git operation progress is shown in the action button that started the operation. There are no separate `Repository`, `Commit`, `Sync`, or `Diagnostics` sections in the current layout.

## Live Updates

The panel refreshes from the VCS status stream, explicit panel operations, window focus, and document visibility changes. `VcsStatusBroadcaster` also maintains ref-counted filesystem watchers per cwd while a repository is subscribed. File events are debounced, checked against Git ignore rules when possible, and only publish a new status when the working-tree fingerprint actually changes.

This keeps externally-created changes visible without requiring a window blur/refocus cycle, while avoiding repeated no-op refreshes for gitignored files or unchanged status.

## Actionable

`Actionable` is the default operational overview. It lists only work that needs attention:

- A dirty `Working tree` row, shown first and omitted when the tree is clean.
- Local branches that are local-only, ahead, behind, diverged, or otherwise require action.
- Same-name local branches that are behind likely fork branches on other remotes.
- Stashes.
- Other checked-out worktree branch labels when available.

Fully synced local branches are omitted from `Actionable`; they remain visible under `Remotes` when they track a remote branch.

When a repository has multiple remotes, the server checks local branches against same-name branches on other remotes. A same-name remote branch is treated as a likely fork only when the refs share ancestry. The Actionable row is shown only when the local branch is behind that remote branch; a local branch that is only ahead of the other remote branch is omitted because it is rarely meant to push directly to that upstream. These fork rows use the other remote branch as their default `vs. ...` compare base and still show `↑x`/`↓y` counts against that remote branch.

The `Actionable` header has a `Fetch` action. The panel also periodically fetches remotes every few minutes so local upstream status and same-name fork status stay fresh without requiring a manual refresh.

Items are sorted by operational urgency, then recency. An unclean working tree is always first. Branch urgency is based on conflicts/diverged, behind, unpushed, dirty, and stale states. Branch and commit rows include succinct relative dates such as `5 minutes ago`, `yesterday`, `4 days ago`, and `last week`.

## Working Tree

The `Working tree` row expands to a compact changed-file list. There is no staged-versus-unstaged grouping in the panel UI. Each changed file has a selector, and newly appearing changed files are selected by default.

The working-tree subsection header shows a tri-state checkbox before the selection summary. Checked means all files are selected, unchecked means none are selected, and partial means some files are selected; clicking a partial or unchecked checkbox selects all files, while clicking a checked checkbox unselects all files. The summary reads `x of y files selected` and shows selected-file `+x`/`-y` line stats immediately after the label when non-zero.

The working-tree header actions are:

- Commit selected files.
- Stash selected files.
- Discard selected files, with confirmation.

Commit selected and stash selected generate their messages by default. Holding Shift while pressing either action opens the same optional-message dialog path used by the existing Git action control: the commit field is labeled `Commit message (optional)`, its placeholder is `Leave empty to auto-generate`, and a blank message still uses the generation flow. The stash dialog behaves the same way for stash messages.

Branch sync actions such as push, pull, fetch, publish, and undo latest commit are intentionally not rendered on the `Working tree` row. They belong to branch rows, where the target branch is explicit.

File rows are compact. They show a one-letter status indicator such as `A`, `D`, or `M`, line change counts, and hover/focus-only action buttons. `+x` uses the added-line color and `-y` uses the removed-line color. Zero counts are hidden. Expanding a file row opens an inline diff for that file change in working-tree, commit, stash, branch, and compare file lists. The row actions are:

- Open file in the right-panel File surface.
- Open in VS Code through the preferred editor or host bridge.
- Discard changes, with confirmation.

Untracked directories are expanded to file-level rows instead of being shown as a single folder row. Untracked files get `A` rows with line stats computed from a `/dev/null` comparison. The server also runs rename detection for unstaged untracked destinations through a temporary Git index, so staged and unstaged renames both collapse matching old/new paths into a single `R` row when Git can match them. If Git cannot match the similarity threshold, entries remain file-level `A` and `D` rows rather than a folder row.

The `Working tree` context menu includes selected-file commit and stash actions plus a separated destructive `Discard selected changes` action.

## Branch Rows

Branch rows are compact tree items used both in `Actionable` and under `Remotes`. They show branch identity, sync indicators, head labels, and a relative activity date.

Ahead and behind status is rendered as `↑x` and `↓y`; zero sides are hidden. `↑x` uses the same green as added-line indicators. `↓y` uses the warning/yellow download color. If a branch has both indicators it is diverged; no separate diverged badge is needed.

Synced local branches shown under `Remotes` use a muted target icon before the branch label. Local-only or not-fully-synced branches use the same branch row model and expose the same expandable details wherever they appear.

Branch action buttons appear only on row hover/focus and are absolutely positioned over the right side of the row. Supported branch actions include:

- Switch to branch.
- Fetch, pull, push, publish, or smart sync, using state-specific icons.
- Delete branch.
- Undo latest commit when the current branch has commits not yet synced upstream.
- Merge branch into the current branch.
- Rebase current branch onto branch, using the `git-pull-request-arrow` icon.

Smart sync handles diverged branches by prompting for one of three choices: force pull, normal merge sync, or force push. Modifier-key tooltips stay terse; for example pull can note `Shift: reset` and `Option: fetch`.

## Branch Details

Expanding a branch reveals branch details:

- `vs. ...`, a non-expandable compare-base row.
- `X Ahead`
- `Y Behind`
- `History`
- `Changes`

Every expanded branch shows the `vs. ...` row first. Its default base is the branch's upstream when available, otherwise the repository default comparison ref. Actionable same-name fork rows default this base to the other remote branch they are tracking for updates. Clicking the row opens a searchable ref picker so the user can choose another compare base. Compare rows do not show count prefixes or extra choose labels. Empty ahead and behind subsections are hidden. Ahead and behind labels include the count directly in the title and use the same colored upload/download icons as branch sync indicators. `History` is collapsed by default and loads commits in pages of 10. When more commits are available, a load-more row appends the next page inline until no more history remains.

The branch-level `Changes` row summarizes the selected comparison as file count and line stats before expanding to the changed-file list.

Branch-level `X Ahead` and `Y Behind` rows are only shown for branches that have an upstream. Local-only branches still support the `vs. ...` compare-base row, but they do not render upstream ahead/behind rows because there is no upstream relationship.

Ahead, behind, history, and changes file lists use the shared compact file-change row model.

## Commit Rows

Commit rows appear in branch history and ahead/behind lists. They show an author avatar, commit message, branch/tag labels, line-change indicators, and a relative date. Author avatars come from commit author email when possible and fall back to compact initials when no avatar is available. The short SHA is available from the commit tooltip and context-menu copy action rather than the row label.

Commit labels are de-duplicated:

- A commit that is head of a local branch and its synced upstream shows the local branch label with a muted target icon.
- A commit that is head of a local branch but not synced upstream shows the local branch label.
- A commit that is only head of the upstream-tracking branch shows a muted target icon before the branch name.
- Tag labels use a tag icon before the tag name.

Commit tooltips are structured panels with author name and avatar, relative and readable commit time, branch/tag labels, message, and line-change indicators.

Commit rows expand to their changed files. Hover/focus-only commit actions include:

- Revert commit.
- Rebase current branch onto commit.
- Checkout as detached HEAD.
- Create branch from commit.

## Stashes

Stashes are listed as `Actionable` tree rows. Each stash shows its message, ref, branch context when available, and relative date. Expanding a stash loads and shows the stash's changed files using the same compact file-change row model used by commits and compare results.

Stash row actions appear on hover/focus and include:

- Apply stash.
- Pop stash.
- Drop stash.

Creating a stash is done from the dirty `Working tree` row through `Stash selected`.

## Remotes

`Remotes` remains a separate section because it is the most useful way to inspect remote activity at a glance. The section header exposes:

- Fetch all remotes.
- Add remote, via a modal form.

Each remote row shows the remote name and fetch URL. Remote action buttons appear on hover/focus and include fetch and remove.

When local-only branches exist, `Remotes` also shows an `unpublished` tree row with those branches and an `x branch(es)` secondary label. Publishing one local-only branch sets its upstream. If the repository has multiple remotes, the panel prompts for the remote to publish to.

Expanding a remote lists actual remote branches; pseudo-ref rows such as the remote name itself are de-duplicated. Remote branch rows use the same branch item model as `Actionable`, including local tracking state, `↑x`/`↓y` sync indicators, synced-local target icons, selectable compare bases, branch details, and branch actions.

## Git Operations

The panel routes all repository mutations through server-side RPC methods and refreshes status after operations. Implemented operation groups include:

- Snapshot and detail loading: panel snapshot, same-name fork ancestry checks, branch details, branch commit pages, stash details, compare data, and file-change details.
- Working tree operations: selected-file commit, selected-file stash, discard selected files, discard individual changed files, read/open file data, stage/unstage helpers kept at the service boundary for compatibility.
- Branch operations: fetch branch, pull, push, publish, switch, delete, undo latest commit, merge branch into current branch, and rebase current branch onto another branch or commit.
- Commit operations: revert commit, checkout detached HEAD, and create branch from commit.
- Stash operations: apply, pop, and drop.
- Remote operations: list, add, remove, fetch one remote, fetch one branch ref, periodic Actionable fetch, and fetch all remotes.

Non-current branch fetches are scoped to the selected branch. Operation busy state is keyed per action target so fetching one branch does not disable equivalent actions on other branches or remote entries.

Discard operations split staged and unstaged portions explicitly and preserve rename source paths when needed. Server-side discard handling partitions tracked, untracked, HEAD-backed, and newly added paths before running Git restore/reset/clean commands, so mixed selections such as tracked edits plus untracked files do not cause one path class to prevent the rest of the selected discard from applying.

## Error Handling

Git action failures surface through the panel error state and existing toast/error paths. Panel errors are capped to a short scrollable block so large Git output cannot consume the full panel, and the error block has a floating copy action for debugging. Destructive actions such as discard selected changes, discard an individual file, delete branch, remove remote, drop stash, force pull, and force push require confirmation or an explicit dialog choice before execution.

The panel keeps version-control actions server-authoritative across browser, desktop, VS Code, and remote clients. Client code does not directly execute Git commands.

## Validation

The current implementation has been exercised against the throwaway repository at `~/Sites/throwaway` with Playwright for the main panel flows: section resizing/collapse behavior, Actionable selection, selected-file commit and stash dialogs, branch sync indicators, remotes tree expansion, stash expansion, hover-only actions, failure reporting, and live filesystem updates including gitignored-file suppression.

Before considering source-control changes complete, run:

```sh
pnpm exec vp check
pnpm exec vp run typecheck
```

If native mobile code changes in a future pass, also run:

```sh
pnpm exec vp run lint:mobile
```
