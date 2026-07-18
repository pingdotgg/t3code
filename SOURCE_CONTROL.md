# Version Control Panel

## Current Status

Branch maintenance snapshot for the latest upstream merge resolution:

- Generated from `upstream/main` `fdca15471d92e95e4ec5501f45dbf3ce81f8d991` with starting branch HEAD `1149bb4fb9c8e5cff9d5a4f4addf0e7eb6840e31`. The merge commit is `ae5117e1d4696f0cce3d53240caa3a8278e3572e`; the previous upstream merge is `eba3649a7dfaf5139fb6c336c679a27f450179ee`, whose upstream parent is `ecb35f75839925dd1ac6f854efeef5c9e291d11b`.
- Shared refs at merge time: `origin/main` `32734f8c3ea3776e1d22a7f44de408e62a5882c2`, local `main` `dbddad20887fd3d43531e91ddc7ad5a009ff3aea`, and branch tracking ref `origin/split/version-control-panel-work` `1149bb4fb9c8e5cff9d5a4f4addf0e7eb6840e31`.
- After the merge, pollution audit, and this documentation refresh, the resulting branch is `83 ahead / 0 behind upstream/main`, `92 ahead / 489 behind origin/main`, `92 ahead / 499 behind local main`, and `12 ahead / 0 behind origin/split/version-control-panel-work`. The fork diff is `56 files changed, 15275 insertions(+), 341 deletions(-)` against the `upstream/main` tree.
- Merge note: the nine incoming commits from `b98233702c88fd7a4312b231e68b089d5f3b0e80` through `fdca15471d92e95e4ec5501f45dbf3ce81f8d991` fix onboarding connection status, isolate native diff syntax-highlighter grammar state, correct macOS fullscreen titlebar spacing, prevent duplicate project workspace roots, normalize over-indented Markdown list items, resolve localhost preview URLs for remote environments, send mobile composer images in the upload wire format, fix iOS terminal Enter encoding, and add native mobile share-target support. Git merged all files automatically with no conflicts. The only file touched by both the incoming range and the fork was `packages/contracts/src/ipc.ts`; its additive merge preserves the panel's VCS types, RPC-shaped environment methods, and context-menu separator while adding upstream's fullscreen bridge methods. Duplicate-root normalization improves project identity without changing the panel's active-project/owning-cwd rules, and the mobile draft/share changes remain isolated from the fork's mobile pending-task behavior and web Version Control surface. The singleton panel, live status and sibling-worktree watchers, Actionable/Remotes model, selected-file commit/stash semantics, branch/commit/stash/remote actions, comparison behavior, source-control-only monotonic thread errors, `expectedBranch` writes, and provider/process diagnostic causes remain intact. Upstream still does not provide an equivalent web panel, no customization became redundant, and the incoming code does not expose a worthwhile panel-specific refactor.
- Pollution audit note: the complete `upstream/main...HEAD` history and 56-file tree delta exposed a stale `ChatView` terminal-session memo rewrite and declaration reorder left by earlier merge maintenance. Those terminal-only edits were restored exactly to `upstream/main`; the unrelated punctuation drift in the desktop context-menu comment was also removed. The remaining `ChatView` and desktop context-menu differences are limited to source-control metadata/error routing, cwd-specific sibling-worktree file surfaces, the singleton panel mount, and explicit separators used by panel menus.

T3 Code includes Git-backed Version Control surfaces in the web right panel and the native mobile app. Both are scoped to the active environment and repository cwd, use server-owned Git operations, and reuse the existing VCS status, source-control provider, and WebSocket RPC infrastructure rather than shelling out from client UI code.

The panel does not require an existing provider session or started server thread. Draft/new conversations can open Version Control as soon as they have project context and a repository cwd. Thread metadata updates caused by branch switching or detached checkout are routed by `ChatView` through `ChatView.sourceControl`: server threads persist through `thread.meta.update`, while draft conversations update local draft thread context. Server-thread branch updates include the active thread branch as `expectedBranch`, so the server preserves newer branch/worktree metadata if another update wins while the Git action is in flight. Server-thread metadata failures surface in the chat error banner through source-control-specific per-thread state. Dismissal clears that local metadata error without pretending provider session errors are dismissible, and overlapping metadata updates are sequenced per thread for the hook lifetime so stale in-flight failures cannot overwrite a newer successful checkout even if a thread is closed and reopened with the same key.

The panel is intentionally an overview and high-level workflow surface. It focuses on current work, branch sync state, remotes, stashes, selected-file commit/stash flows, and compact branch/commit inspection. It is not a full VS Code SCM replacement and does not implement hunk-level staging.

Primary implementation files:

- `apps/web/src/components/source-control/SourceControlPanel.tsx`
- `apps/web/src/components/source-control/SourceControlPanel.logic.ts`
- `apps/web/src/state/sourceControlPanel.ts`
- `apps/mobile/src/features/version-control/VersionControlRouteScreen.tsx`
- `apps/mobile/src/features/version-control/versionControlModel.ts`
- `apps/mobile/src/features/version-control/useVersionControlPanelApi.ts`
- `apps/web/src/components/ChatView.tsx`
- `apps/web/src/components/ChatView.sourceControl.ts`, which exports source-control right-panel availability/surface helpers and `useSourceControlThreadMetadataRouting` for server and draft thread metadata routing
- `apps/web/src/components/RightPanelTabs.tsx`
- `apps/server/src/sourceControl/SourceControlPanelService.ts`
- `apps/server/src/vcs/VcsStatusBroadcaster.ts`
- `apps/server/src/vcs/VcsLocalWatch.ts`
- `apps/server/src/ws.ts`
- `packages/contracts/src/rpc.ts`
- `packages/contracts/src/ipc.ts`
- `packages/client-runtime/src/state/sourceControl.ts`

## Entry Points And Host Behavior

Version Control is a singleton right-panel surface with kind `source-control`. Users open it from the existing right-panel surface picker; it is not duplicated into the main chat header, project sidebar, or conversation timeline. Availability is project/repository based: the surface is enabled when a thread or draft-thread ref exists for right-panel state and the active project resolves to a repository cwd.

On mobile, `Version Control` is a native full-screen route over the active thread. It is available directly in the Git header menu beside the quick commit/push action and from the existing Git overview menu that contains commit and branch/worktree actions. Returning from the route closes it without changing the active workspace/thread selection.

Version Control uses the shared right-panel tab shell, including the standard context menu, middle-click tab close behavior, and centralized add-surface metadata in `RightPanelTabs` for both the empty state and the add-surface menu.

`ChatView` keys the mounted `SourceControlPanel` by active environment, thread, and effective Git cwd. Switching between conversations, projects, or worktrees therefore creates a fresh panel instance for that context instead of letting repository state from the previous thread bleed into the next one. The panel pairs that remount boundary with a bounded in-memory state cache keyed by environment, thread, cwd, and worktree path, so returning to a previously opened Version Control panel can render its last snapshot and UI state immediately while the normal refresh/fetch path updates it in the background.

`ChatView.sourceControl.ts` owns the source-control-specific right-panel availability, visible-surface filtering, and open-surface callback so upstream chat timeline and minimap changes in `ChatView.tsx` stay separate from Version Control panel glue.

Right-panel integration is owned by:

- `apps/web/src/rightPanelStore.ts`
- `apps/web/src/components/RightPanelTabs.tsx`
- `apps/web/src/components/ChatView.tsx`
- `apps/web/src/components/ChatView.sourceControl.ts`
- `apps/web/src/state/sourceControlPanel.ts`

Native navigation integration is owned by:

- `apps/mobile/src/Stack.tsx`
- `apps/mobile/src/features/threads/ThreadGitControls.tsx`
- `apps/mobile/src/features/threads/git/GitOverviewSheet.tsx`

## Native Mobile Screen

The mobile screen preserves the web panel's compact repository summary plus `Actionable` and `Remotes` information architecture, adapted to native touch interaction. The summary is deliberately unboxed so it cannot be mistaken for an interactive row: it shows the current branch, compact `↑x`/`↓y` sync counts, `No upstream` only when applicable, and either `Clean` or the current `x file(s) +x -x` working-tree totals. Resizable desktop sections become collapsible native sections, row actions are touch-sized pills shown only while their owning row is expanded, and pull-to-refresh complements live VCS status updates and the same best-effort fetch-on-open behavior.

Native snapshot refreshes are sequenced so an older fetch, status-triggered refresh, or mutation refresh cannot overwrite newer repository state. Every emitted VCS status value triggers a refresh even when its serialized summary is unchanged. When an accepted snapshot changes, cached branch and stash details are invalidated together with their expanded/loading rows, and late detail responses from the previous snapshot are ignored. Supplemental working-tree enrichment failures are isolated per checkout so one unavailable sibling worktree does not hide the rest of the repository snapshot. Failed mutations still refresh repository state before preserving their action error in mutation-owned state, so a racing status refresh cannot erase the failure while conflict-producing operations remain visible. Failed remote creation keeps the add-remote form open with its entered values intact.

The native `Actionable` section includes the current and dirty sibling working trees, local branches requiring attention, same-name fork branch notices, and stashes. Working-tree cards preserve newly-added-file default selection, remove selections for checkouts that become clean, use tri-state-style select-all behavior, show aggregate staged-plus-unstaged stats and rename source paths, and expose selected-file commit/stash/discard operations. Pressing a working-tree, commit, or stash file opens a dedicated diff screen backed by the same native Review renderer, parsed diff model, syntax highlighting, theme, display metrics, and horizontal scrolling as the rest of the mobile app; unsupported patches retain a raw-text fallback. Native snapshot loading applies the cwd-scoped working-tree enrichment RPC before composing those cards, so untracked files contribute their real inserted-line totals; selected-file discard separately clears unstaged and staged sides for mixed rows, and conflict-only selections that have neither side stay excluded from the discard count and action availability. Branch cards expose thread-aware checkout, publish/push/pull/fetch/diverged sync choices, merge, rebase, delete confirmation, and comparison details. Expanding an actionable branch renders its ahead and behind commits rather than the aggregate comparison-file list; every commit carries a right-aligned green ahead or yellow behind arrow, and only expanding that commit reveals its changed files. Returning from a file diff preserves the expanded branch and commit state. Branches checked out in sibling worktrees keep deletion disabled, while merge sync is offered only when the current cwd or a branch-owned worktree actually has that branch checked out. Stash cards expose apply, pop, drop, and expandable changed-file details, including rename source paths.

The native `Remotes` section supports fetch, add, remove, and a deliberately shallower branch inspection model than desktop. Remote branches do not load commit trees on mobile; their rows show local/remote identity icons, current/default/worktree tags, and available ahead/behind counts, then reveal applicable checkout, fetch/sync, merge, rebase, and delete actions when pressed. All mutations use the existing panel RPC atom families; branch switching deliberately reuses the mobile thread Git action path so server-thread metadata and active checkout context continue to update together.

Cross-platform panel presentation rules that affect both web and mobile live in `@t3tools/shared/sourceControl`, including staged/unstaged file merging and sync-vs-compare branch state. Mobile-only list composition and touch presentation helpers remain in `versionControlModel.ts`.

## Layout

The Version Control panel has a compact repository summary at the top and two resizable, collapsible sections:

- `Actionable`
- `Remotes`

`Remotes` is collapsed by default. The sections share the available panel height, each section owns its own overflow area, and section edges can be dragged to resize them relative to each other.

The repository summary shows the current ref, upstream status, changed-file count and line stats, ahead-of-default context, and current error state. Git operation progress is shown in the action button that started the operation. There are no separate `Repository`, `Commit`, `Sync`, or `Diagnostics` sections in the current layout.

## Live Updates

The panel refreshes from the VCS status stream, explicit panel operations, window focus, and document visibility changes. `VcsStatusBroadcaster` also maintains ref-counted filesystem watchers per cwd while a repository is subscribed, with local path filtering and debounced refresh signal handling factored into `VcsLocalWatch`. Internal `.git/` events are ignored before any refresh decision, file events are debounced, remaining paths are checked against Git ignore rules when possible, and explicit local refreshes publish a local status update even when the summary fingerprint is unchanged so same-path/same-stat file edits can refresh live working-tree diffs. If a local watch fiber has already terminated while an entry remains subscribed, the next subscriber replaces the stale watcher instead of attaching to a dead fiber.

This keeps externally-created changes visible without requiring a window blur/refocus cycle, while avoiding repeated no-op refreshes for gitignored files and unrelated background churn. Root panel streams also retain local watchers for sibling worktrees discovered from `git worktree list --porcelain`; stale/prunable worktree paths that no longer exist on disk are filtered before watcher retention, and sibling filesystem events force-publish a root local update so the panel can reload sibling `Actionable` rows even when the root checkout status fingerprint is unchanged. Local watcher subscriptions are acquired with stream-scoped finalizers before the initial status load, so a failed stream setup still releases every watcher retained for the subscription.

The panel only shows the full `Loading repository state...` placeholder when no cached or loaded snapshot exists for the active thread/cwd. When a cached snapshot exists, the panel renders that previous repository state immediately and shows the existing refresh indicator while `panelSnapshot` and remote fetch work catch up, even if the fetched snapshot fingerprint matches the cache. Cached panel state is process-local rather than local-storage persisted and is bounded to recent contexts; it includes the panel snapshot, collapsed/expanded sections, branch and stash detail maps, compare-base overrides, selected paths, lazy working-tree enrichment data, and loaded file diffs. In-flight diff loading rows are intentionally not restored from cache, so a reopened panel does not get stuck showing an old loading row without a live request.

## Actionable

`Actionable` is the default operational overview. It lists only work that needs attention:

- A dirty `Working tree` row, shown first and omitted when the tree is clean.
- Local branches that are local-only, ahead, behind, diverged, or otherwise require action.
- Same-name local branches that are behind likely fork branches on other remotes.
- Local branches with open GitHub, GitLab, Azure DevOps, or Bitbucket change requests whose base branch exists on the matching remote and is ahead of the local branch.
- Stashes.
- Other checked-out worktree branch labels when available.

Checked-out worktree labels are resolved from `git worktree list --porcelain` first. When that output is unavailable or empty, the service falls back to `git branch --format` worktree placeholders where supported; older Git versions that do not support `%(worktreepath)` fall back to the branch format without paths instead of failing the whole panel snapshot.

When the panel is opened from the root checkout and other non-root worktrees are active, dirty sibling worktrees are shown as separate Actionable entries keyed by their checked-out branch and worktree path. These entries are populated by running the same status and diff snapshot commands in the sibling worktree cwd, so staged, unstaged, untracked, and conflicted files remain scoped to the checkout where they exist. Sibling worktree rows use the same lazy file enrichment path as the root working tree, keyed by worktree cwd so same relative paths in different checkouts cannot share stale rename or untracked-stat details. Sibling worktree rows are omitted when clean.

Fully synced local branches are omitted from `Actionable`; they remain visible under `Remotes` when they track a same-name remote branch.

Actionable branch sync state is intentionally separate from branch comparison state. A local branch can have a configured Git upstream/base such as `upstream/main` because it was created from that ref, while still being unpublished as `origin/<local-branch-name>` or another remote branch. The panel treats only same-name remote tracking refs as publish/sync upstreams for branch actions. Different-name refs remain valid compare bases and can still make the branch appear in `Actionable`, but they do not make the branch `behind` or `diverged` for sync purposes. In that state the row's sync action is `Publish`, and publishing targets the local branch name on the chosen remote rather than the base ref.

When a repository has multiple remotes, the server checks local branches against same-name branches on other remotes. A same-name remote branch is treated as a likely fork only when the refs share ancestry. The Actionable row is shown only when the local branch is behind that remote branch; a local branch that is only ahead of the other remote branch is omitted because it is rarely meant to push directly to that upstream. These fork rows use the other remote branch as their default `vs. ...` compare base and still show `↑x`/`↓y` counts against that remote branch.

The server also checks open change requests for every local branch across all configured remotes whose fetch URL maps to a supported provider: GitHub, GitLab, Azure DevOps, and Bitbucket. For each matching open PR/MR where the local branch is the head branch, the panel compares the local branch only against the found change request's base branch on that same remote. A PR/MR-derived Actionable row is shown only when the local branch is behind that remote base branch; if the branch is already current with, ahead of, or unrelated to the base branch, no Actionable entry is shown. Self-hosted GitLab lookups scope `glab mr list --repo` with a full project URL instead of an ambiguous scheme-less host/path locator, without duplicating a configured base-URL path prefix that is already present in the remote repository path; GitLab.com keeps the normal namespace/project form. Provider lookup is best-effort: authentication, CLI/API, or unsupported-remote failures omit PR/MR-derived rows without blocking the Git snapshot, but provider-specific errors still preserve structured causes for diagnostics.

Client-side Actionable/Remotes expansion, row selection, working-tree enrichment state, and the per-thread/per-worktree panel-state cache are owned by `apps/web/src/components/source-control/SourceControlPanel.tsx`, while `apps/web/src/state/sourceControlPanel.ts` owns the environment-scoped panel RPC wrapper and presentation-state helper.

The `Actionable` header has a `Fetch` action. The panel runs the same fetch-all-remotes path once when it first opens for a cwd, including after switching to a different conversation/worktree cwd, so upstream changes that have not yet been fetched can appear without requiring the user to press `Fetch`. The panel also periodically fetches remotes every five minutes so local upstream status and same-name fork status stay fresh while keeping idle network and Git churn conservative.

Items are sorted by operational urgency, then recency. An unclean working tree is always first. Branch urgency is based on conflicts/diverged, behind, unpushed, dirty, and stale states. Branch and commit rows include succinct relative dates such as `5 minutes ago`, `yesterday`, `4 days ago`, and `last week`.

## Working Tree

The `Working tree` row expands to a compact changed-file list. There is no staged-versus-unstaged grouping in the panel UI. Each changed file has a selector, and newly appearing changed files are selected by default.

Dirty sibling worktree rows expand to the same compact changed-file list and selection model. File diff, right-panel File preview, open-in-editor, stash, commit, and discard operations for those rows target the sibling worktree path, not the panel's root cwd. The File surface can carry a source-control cwd override for these rows while normal file surfaces remain workspace-relative. This prevents same relative paths in different checkouts from sharing diff state or executing Git actions against the wrong worktree.

The working-tree subsection header shows a tri-state checkbox before the selection summary. Checked means all files are selected, unchecked means none are selected, and partial means some files are selected; clicking a partial or unchecked checkbox selects all files, while clicking a checked checkbox unselects all files. The summary reads `x of y files selected` and shows selected-file `+x`/`-y` line stats immediately after the label when non-zero. When staged and unstaged entries for the same file are merged into one displayed row, the displayed stats sum both sides instead of taking only the larger staged or unstaged count. These numbers are aggregate staged-plus-unstaged churn, not a de-duplicated net diff against `HEAD`; for example, a selected file with `+2/-1` staged and `+3/-4` unstaged is shown as `+5/-5`.

The working-tree header actions are:

- Commit selected files.
- Stash selected files.
- Discard selected files, with confirmation.

Commit selected and stash selected generate their messages by default. Holding Shift while pressing either action opens the same optional-message dialog path used by the existing Git action control: the commit field is labeled `Commit message (optional)`, its placeholder is `Leave empty to auto-generate`, and a blank message still uses the generation flow. The stash dialog behaves the same way for stash messages.

Branch sync actions such as push, pull, fetch, publish, and undo latest commit are intentionally not rendered on the `Working tree` row. They belong to branch rows, where the target branch is explicit.

File rows are compact. They show a one-letter status indicator such as `A`, `D`, `M`, or `R`, line change counts, and hover/focus-only action buttons. `+x` uses the added-line color and `-y` uses the removed-line color. Zero counts are hidden. Expanding a file row opens an inline diff for that file change in working-tree, commit, stash, branch, and compare file lists. Rename diff requests preserve both the destination path and original path, so `R` rows compare against the deleted source side instead of rendering the destination as a whole new file. Mixed staged-plus-unstaged working-tree rows open the unstaged diff by default because it is the still-editable part of the row; staged-only rows open the staged diff. The row actions are:

- Open file in the right-panel File surface.
- Open in VS Code through the preferred editor or host bridge.
- Discard changes, with confirmation.

Untracked directories are expanded to file-level rows instead of being shown as a single folder row. Untracked files get `A` rows with line stats computed from a `/dev/null` comparison. The server also runs rename detection for unstaged untracked destinations through a temporary Git index, so staged and unstaged renames both collapse matching old/new paths into a single `R` row when Git can match them. If Git cannot match the similarity threshold, entries remain file-level `A` and `D` rows rather than a folder row.

The working-tree file list is not a nested vertical scroller. Rows render in normal flow inside the `Actionable` section's existing overflow area, so mouse-wheel and mobile swipe gestures over changed-file rows scroll the panel section itself. Working-tree enrichment remains lazy: each rendered row registers with an `IntersectionObserver` and queues enrichment when it enters the viewport or the 600px prefetch margin, with a fallback that queues immediately when the observer API is unavailable.

The `Working tree` context menu includes selected-file commit and stash actions plus a separated destructive `Discard selected changes` action.

## Branch Rows

Branch rows are compact tree items used both in `Actionable` and under `Remotes`. They show branch identity, sync indicators, head labels, and a relative activity date. The sync-state rules are isolated in `SourceControlPanel.logic.ts` so Actionable and Remotes use the same definition of published, behind, ahead, diverged, and local-only.

Ahead and behind status is rendered as `↑x` and `↓y`; zero sides are hidden. `↑x` uses the same green as added-line indicators. `↓y` uses the warning/yellow download color. If a branch has both indicators against its same-name sync upstream it is diverged; no separate diverged badge is needed. Ahead/behind counts against a different compare base may still appear in fork/change-request rows or expanded branch details, but those counts do not drive the branch sync action.

Synced local branches shown under `Remotes` use a muted target icon before the branch label. Local-only or not-fully-synced branches use the same branch row model and expose the same expandable details wherever they appear.

Branch action buttons appear only on row hover/focus and are absolutely positioned over the right side of the row. Row-level keyboard expansion only handles key events targeted at the row itself, so pressing Enter or Space on a nested action button does not also expand or collapse the row. Supported branch actions include:

- Switch to branch.
- Fetch, pull, push, publish, or smart sync, using state-specific icons.
- Delete branch.
- Undo latest commit when the current branch has commits not yet synced upstream.
- Merge branch into the current branch.
- Rebase current branch onto branch, using the `git-pull-request-arrow` icon.

Smart sync handles diverged branches by prompting for force pull, normal merge sync, or force push. Normal merge sync is available only when the diverged row is the currently checked-out branch, matching Git's working-tree merge semantics; the merge button is disabled for non-current diverged branch rows. Non-current diverged branch rows keep force pull and force push available without implicitly changing the user's checkout. Modifier-key tooltips stay terse; for example pull can note `Shift: reset` and `Option: fetch`.

When a branch row represents a branch checked out in another worktree, branch sync operations target that branch's worktree path instead of the panel root cwd. This applies to publish, push, pull, fetch, force-pull, force-push, and the current-branch merge-sync path, so Git operations run from the checkout that owns the branch.

## Branch Details

Expanding a branch reveals branch details:

- `vs. ...`, a non-expandable compare-base row.
- `X Ahead`
- `Y Behind`
- `History`
- `Changes`

Every expanded branch shows the `vs. ...` row first. Its default base is the branch's configured upstream/base when available, otherwise the repository default comparison ref. The repository default comparison ref remains available even when it is the currently checked-out branch, so current-default-branch rows still have a stable compare target. The default ref uses VCS status default-branch detection when the checked-out branch is the repository default, so repositories whose default branch is named something like `develop` do not fall back to an unrelated non-current branch. This base can be a different-name ref such as `upstream/main`; in that case it is a comparison base only, not proof that the branch has been published. Actionable same-name fork rows default this base to the other remote branch they are tracking for updates. Actionable PR/MR-derived rows default this base to the found change request's remote base branch. Clicking the row opens a searchable ref picker so the user can choose another compare base. Compare rows do not show count prefixes or extra choose labels. Empty ahead and behind subsections are hidden. Ahead and behind labels include the count directly in the title and use the same colored upload/download icons as branch sync indicators. `History` is collapsed by default and loads commits in pages of 10. When more commits are available, a load-more row appends the next page inline until no more history remains.

Branch detail loading is keyed by the rendered detail surface, not only by branch name. Canonical branch rows keep the branch `name` and `fullRefName` entries synchronized, while actionable fork rows use an isolated `fork-details:<local>:<remote>` key so paging or loading one comparison base does not overwrite the branch-owned details for another base. Commit pages append in server order and de-duplicate by SHA, which keeps reloads and overlapping pages from duplicating rows. If cached expanded tree state is restored without a matching branch detail payload, the next panel snapshot refresh hydrates the missing expanded branch details even when the snapshot fingerprint itself is unchanged.

The branch-level `Changes` row summarizes the selected comparison as file count and line stats before expanding to the changed-file list.

Branch-level `X Ahead` and `Y Behind` rows follow the selected comparison base in the expanded details. Local-only or unpublished branches still support the `vs. ...` compare-base row, including configured base refs such as `upstream/main`; their branch sync action remains publish unless they track a same-name remote branch.

Ahead, behind, history, and changes file lists use the shared compact file-change row model.

## Commit Rows

Commit rows appear in branch history and ahead/behind lists. They show an author avatar, commit message, branch/tag labels, line-change indicators, and a relative date. Showing a user avatar image for commit authors is required and intended behavior, but provider avatar lookup is opt-in per source-control provider and disabled by default. When enabled for a supported repository remote, the server resolves the provider account avatar URL for the commit author (for example GitHub account `avatar_url`, GitLab Avatar API URLs, Azure DevOps commit author `imageUrl`, or Bitbucket commit author avatar link) and sends it as `authorAvatarUrl`; the web panel falls back to compact initials only when the setting is disabled, the provider/avatar URL is unavailable, or image loading fails. The panel must not silently regress to initials-only rows when the option is enabled, and provider avatar lookup must not be replaced by generated local avatars or unofficial email-derived third-party avatar URLs. GitLab's official Avatar API is allowed because it is the provider's documented lookup path; that endpoint may return external avatar-service URLs such as Gravatar or Libravatar, and those URLs are passed through because enabling the setting is an explicit opt-in to provider avatar lookup. The short SHA is available from the commit tooltip and context-menu copy action rather than the row label.

Commit labels are de-duplicated:

- A commit that is head of a local branch and its synced upstream shows the local branch label with a muted target icon.
- A commit that is head of a local branch but not synced upstream shows the local branch label.
- A commit that is only head of the upstream-tracking branch shows a muted target icon before the branch name.
  Branch/tag labels classify remote refs using the repository's known remote names, not a slash heuristic, so local branch names such as `feature/login` remain local labels.
- Tag labels use a tag icon before the tag name.

Commit tooltips are structured panels with author name and avatar, relative and readable commit time, branch/tag labels, message, and line-change indicators.

Commit rows expand to their changed files. Hover/focus-only commit actions include:

- Revert commit.
- Rebase current branch onto commit.
- Checkout as detached HEAD.
- Create branch from commit.

## Stashes

Stashes are listed as `Actionable` tree rows. Each stash shows its message, ref, branch context when available, and relative date. Expanding a stash loads and shows the stash's changed files using the same compact file-change row model used by commits and compare results. Restored stash expansion and cached stash details are keyed by the stash commit hash when Git reports one, falling back to the positional ref only when no hash is available, so `stash@{n}` renumbering after stash create/drop operations does not show details for the wrong stash.

Stash row actions appear on hover/focus and include:

- Apply stash.
- Pop stash.
- Drop stash.

Creating a stash is done from the dirty `Working tree` row through `Stash selected`. If cached expanded tree state is restored without a matching stash detail payload, the next panel snapshot refresh hydrates the missing expanded stash details instead of leaving the expanded row empty until the user collapses and reopens it.

## Remotes

`Remotes` remains a separate section because it is the most useful way to inspect remote activity at a glance. The section header exposes:

- Fetch all remotes.
- Add remote, via a modal form.

Each remote row shows the remote name and fetch URL. Remote action buttons appear on hover/focus and include fetch and remove.

When local-only or unpublished branches exist, `Remotes` also shows an `unpublished` tree row with those branches and an `x branch(es)` secondary label. Publishing one branch sets its same-name remote upstream. If the repository has multiple remotes, the panel prompts for the remote to publish to.

Expanding a remote lists actual remote branches; pseudo-ref rows such as the remote name itself are de-duplicated. Remote branch rows use the same branch item model as `Actionable`, including local tracking state, `↑x`/`↓y` sync indicators, synced-local target icons, selectable compare bases, branch details, and branch actions.

## Git Operations

The panel routes all repository mutations through server-side RPC methods and refreshes status after operations. Implemented operation groups include:

- Snapshot and detail loading: panel snapshot, same-name fork ancestry checks, open PR/MR base-branch checks across configured GitHub/GitLab/Azure DevOps/Bitbucket remotes, branch details, branch commit pages, stash details, compare data, and file-change details.
- Working tree operations: selected-file commit, selected-file stash, discard selected files, discard individual changed files, read/open file data, stage/unstage helpers kept at the service boundary for compatibility.
- Branch operations: fetch branch, pull, push, publish, switch, delete, undo latest commit, merge branch into current branch, and rebase current branch onto another branch or commit.
- Commit operations: revert commit, checkout detached HEAD, and create branch from commit.
- Stash operations: apply, pop, and drop.
- Remote operations: list, add, remove, fetch one remote, fetch one branch ref, periodic Actionable fetch, and fetch all remotes.

Non-current branch fetches are scoped to the selected branch. Operation busy state is keyed per action target so fetching one branch does not disable equivalent actions on other branches or remote entries. Publish/push handling on the server only reuses a configured upstream when that upstream resolves to the same branch name; otherwise it pushes `<local-branch>:refs/heads/<local-branch>` on the selected/default remote so a base ref such as `upstream/main` cannot become the push target. Branch deletion accepts only the branch name from the client; the server resolves whether that name is a local branch or a remote branch from the current panel snapshot before choosing local `git branch -d/-D` or remote `git push <remote> --delete`.

Selected-file commit, stash, and discard operations preserve rename source paths when needed, so selecting an `R` row sends both the destination path and the original path to the Git operation. Rename source paths are preserved for normal porcelain status entries and for fallback numstat parsing, including line-based fallback output. Porcelain status paths are decoded from Git's quoted path format before matching numstat output or rendering rows, so non-ASCII and escaped path names use the real repository path. Selected-file commits stage the selected paths first and then commit the staged index without passing pathspecs to `git commit`, so mixed staged/unstaged files do not leak unstaged edits into the commit. Discard operations also split staged and unstaged portions explicitly. Server-side discard handling partitions tracked, untracked, HEAD-backed, and newly added paths before running Git restore/reset/clean commands, so mixed selections such as tracked edits plus untracked files do not cause one path class to prevent the rest of the selected discard from applying. If the tracked unstaged restore step fails, the failure is reported to the panel instead of being swallowed after staged cleanup succeeds. Merge operations pass the selected ref after a positional `--` separator so option-shaped branch names cannot be interpreted as merge flags.

## Error Handling

Git action failures surface through the panel error state and existing toast/error paths. Panel errors are capped to a short scrollable block so large Git output cannot consume the full panel, and the error block has a floating copy action for debugging. Interrupt-only atom command results are treated as cancellation rather than user-visible failures. Generated selected-file commits inspect the returned command result, so failed commit generation or execution keeps the dialog path honest by surfacing the failure instead of silently refreshing. Destructive actions such as discard selected changes, discard an individual file, delete branch, remove remote, drop stash, force pull, and force push require confirmation or an explicit dialog choice before execution.

Server-side panel errors preserve a sanitized cause diagnostic when wrapping lower-level failures into `GitCommandError`, so diagnostics can still distinguish process failures, provider failures, and command output failures even when the UI receives a normalized panel error. The preserved cause is bounded to a small plain object before it crosses the server contract, and the existing capped panel error block remains the user-facing size guard. Source-control provider adapters keep provider-specific missing-CLI, authentication, not-found, decode, and API details in their typed errors, then wrap common provider failures through `sourceControlProviderError` so GitHub, GitLab, Azure DevOps, and Bitbucket expose aligned `SourceControlProviderError` fields: provider, operation, cwd, sanitized reference/repository, detail, command when available, and original cause. GitLab no longer needs the old fork-local string-normalizer path because upstream typed GitLab CLI errors now own that behavior.

The panel keeps version-control actions server-authoritative across browser, desktop, VS Code, and remote clients. Client code does not directly execute Git commands.

## Validation

The current implementation has been exercised against the throwaway repository at `~/Sites/throwaway` with Playwright for the main panel flows: section resizing/collapse behavior, Actionable selection, selected-file commit and stash dialogs, branch sync indicators, remotes tree expansion, stash expansion, hover-only actions, failure reporting, and live filesystem updates including internal `.git/` event filtering and gitignored-file suppression. Rename coverage includes committing an unstaged `R` row and undoing that commit, verifying that the panel returns to a single `R` row rather than separate `A` and `D` rows.

Focused unit coverage now also covers the sync-vs-compare split: a local branch configured against `upstream/main` is treated as unpublished/publishable instead of diverged, a same-name remote tracking branch remains a normal sync upstream, server-side publishing targets the local branch name even when Git reports a different configured upstream/base ref, branch sync operations use a branch worktree cwd when one is present, branch deletion is resolved from the server snapshot, Source Control thread metadata updates send the prior active branch as `expectedBranch`, the current default branch remains the default compare ref, branch worktree paths fall back from porcelain worktree output to branch-format placeholders without failing on older Git versions, sibling worktree watcher paths are parsed from porcelain output, missing sibling worktree paths are skipped before watcher retention, stream-scoped watcher acquisition releases retained local watchers if initial status loading fails, tracked discard restore failures are surfaced, fallback line-based rename parsing preserves source paths, porcelain quoted paths decode to real paths, rename diff loading sends both original and destination paths for staged and unstaged working-tree rows, mixed staged-plus-unstaged rows keep their unstaged side, merged working-tree row stats are summed, selected-file commits omit pathspecs after staging, merge refs are passed after `--`, fork-branch load-more loading state is keyed by rendered details key, cached snapshots still show the ready-state refresh indicator while revalidating, restored expanded branch/stash rows hydrate missing details even on same-fingerprint refreshes, late-month relative dates do not fall through to `0 years ago`, panel error wrapping preserves original causes, provider adapter errors preserve sanitized transport context through `sourceControlProviderError`, self-hosted GitLab MR lookup uses a full project URL for `--repo` without duplicating URL path prefixes, sibling right-panel File previews carry a cwd override so they read from the source worktree, and upstream typed GitLab CLI errors preserve structured process failures without the retired local string normalizer.

Before considering source-control changes complete, run the focused source-control checks plus the repository-wide checks:

```sh
pnpm exec vp test run apps/server/src/sourceControl/SourceControlPanelService.test.ts apps/server/src/vcs/VcsStatusBroadcaster.test.ts apps/server/src/vcs/GitVcsDriverCore.test.ts
pnpm exec vp test run apps/web/src/components/source-control/SourceControlPanel.logic.test.ts apps/web/src/state/sourceControlPanel.test.ts
pnpm exec vp test run packages/contracts/src/git.test.ts packages/shared/src/git.test.ts packages/client-runtime/src/state/vcsAction.test.ts
pnpm exec vp check
pnpm exec vp run typecheck
```

If native mobile code changes in a future pass, also run:

```sh
pnpm exec vp run lint:mobile
```

Native Version Control model coverage lives in `apps/mobile/src/features/version-control/versionControlModel.test.ts` and can be run with:

```sh
(cd apps/mobile && pnpm exec vp test run src/features/version-control/versionControlModel.test.ts)
```
