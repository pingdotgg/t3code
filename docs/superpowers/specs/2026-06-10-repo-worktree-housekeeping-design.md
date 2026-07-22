# Repo-level worktree housekeeping — design

## Problem

T3 Code creates a git worktree per thread (in worktree mode) under a server-managed base directory.
Today the only cleanup is per-thread: deleting a thread removes its single orphaned worktree (`apps/web/src/hooks/useThreadActions.ts:225` via `vcs.removeWorktree`).
After finishing a set of tasks for a repo, stale worktrees accumulate and must be removed one by one.
There is no repo-scoped "clean up all worktrees" action, and no way to see how much disk space cleanup would reclaim.

This implements [pingdotgg/t3code#684](https://github.com/pingdotgg/t3code/issues/684), which is closed as COMPLETED but has no linked PR and is not present in the codebase as of v0.0.26.

## Goals

- Provide a repo-scoped "Clean up worktrees" action that removes multiple t3code-managed worktrees in one flow.
- Show, upfront, the on-disk size of each worktree and the total reclaimable space for the current selection.
- Never silently destroy work: dirty worktrees require an explicit per-row opt-in, and active-thread worktrees are never auto-selected.
- Fix the related discoverability gap where archived-thread Delete is hidden behind a right-click context menu.

## Non-goals

- No background/scheduled automatic cleanup.
- No cross-repo "clean up everything" action; every invocation is scoped to a single repository.
- No change to how worktrees are created or to the per-thread delete-time cleanup.

## Definitions

A **managed worktree** is any entry from `git worktree list` whose path is under the server's `worktreesDir` (`apps/server/src/config.ts:95`, `<baseDir>/worktrees`) for the given repo, excluding the repo's main checkout.
All t3code worktrees are created under `worktreesDir/<repoName>/<sanitizedBranch>` (`apps/server/src/vcs/GitVcsDriverCore.ts:2057`), so the path-prefix test reliably distinguishes managed worktrees from worktrees the user created manually.

A managed worktree is classified, client-side, relative to the threads it is referenced by:

- **active** — referenced by at least one non-archived thread; never auto-selected, shown as protected.
- **archived-only** — referenced only by archived threads.
- **orphaned** — referenced by no thread.

A worktree is **dirty** when it has uncommitted changes or commits not present on its upstream (unpushed work).

## Scope setting

A new global setting `worktreeCleanupScope` controls which worktrees are pre-selected when the dialog opens:

- `"orphaned"` (default) — orphaned worktrees only.
- `"orphaned-archived"` — orphaned plus archived-only worktrees.

Active-thread worktrees are never auto-selected under either value.
The dialog follows the setting and lets the user deselect individual rows; there is no per-run scope dropdown.

## Architecture

Responsibilities split along the existing client/server boundary.
The server enumerates managed worktrees on disk and computes sizes and dirty status (filesystem + git knowledge).
The client classifies worktrees against thread state, applies the scope setting, renders the dialog, and orchestrates removal (thread knowledge).

### Server

Three new VCS operations, each added to contracts (`packages/contracts/src/git.ts`, `rpc.ts`), the git driver (`GitVcsDriverCore.ts`, `GitVcsDriver.ts`), the workflow service (`GitWorkflowService.ts`), and WS wiring + auth (`apps/server/src/ws.ts`).
All three use the same auth scope as the existing single remove (`AuthOrchestrationOperateScope`).

1. `vcsListManagedWorktrees({ cwd }) -> { worktrees: { path, refName, isDirty }[] }`
   - Runs `git worktree list --porcelain`, filters to paths under `worktreesDir`, drops the main worktree.
   - Computes `isDirty` per worktree (uncommitted changes or unpushed commits).
   - Does not compute size, so the dialog can open immediately.

2. `vcsWorktreeSize({ path }) -> { sizeBytes }`
   - Recursive on-disk byte size for a single worktree path.
   - Called lazily per row and cached on the client; this is the "exact size with caching" behavior.

3. `vcsRemoveWorktrees({ cwd, items: { path, force }[] }) -> { results: { path, ok, error? }[] }`
   - Batch remove with per-path `force`, reusing the existing single-remove git logic internally.
   - Returns per-path results so partial failures surface individually.
   - One source-control status refresh after the batch, instead of one per worktree.

### Client

- `wsRpcClient` (`packages/client-runtime/src/wsRpcClient.ts`) and `environmentApi` (`apps/web/src/environmentApi.ts`) gain `listManagedWorktrees`, `worktreeSize`, and `removeWorktrees`.
- A pure classification helper (extending `apps/web/src/worktreeCleanup.ts`) maps the server's managed-worktree list against the store's threads and archived snapshots into `active | archived-only | orphaned`, then applies `worktreeCleanupScope` to produce the default selection.
- `WorktreeCleanupDialog` renders the in-scope rows:
  - branch / worktree name and path,
  - size column (spinner while `worktreeSize` resolves, then formatted value, cached),
  - dirty badge plus a per-row "force" checkbox (a dirty row cannot be selected for removal without force),
  - per-row selection checkbox (active worktrees shown but locked off),
  - a footer total of reclaimable size for the current selection.
  - Confirm calls `removeWorktrees`, shows a summary toast (removed count, freed bytes, any per-path failures), and invalidates source-control state.

### Entry points

Both open the same `WorktreeCleanupDialog`, scoped to one repo:

- Archived Threads panel (`apps/web/src/components/settings/SettingsPanels.tsx`, `ArchivedThreadsPanel`): a "Clean up worktrees" button in each per-project section header.
- Sidebar repo context menu (`apps/web/src/components/Sidebar.tsx`): a "Clean up worktrees…" item.

### Discoverability fix

Archived thread rows currently render only a visible Unarchive button; Delete exists but only via right-click (`SettingsPanels.tsx:1412`).
Add a visible Delete (trash) button to each archived row, invoking the existing `confirmAndDeleteThread` path.

## Data flow

1. User triggers "Clean up worktrees" for a repo from the sidebar or archived panel.
2. Client calls `listManagedWorktrees({ cwd })`; classifies each result against threads + archived snapshots; applies `worktreeCleanupScope` for the default selection.
3. Dialog opens immediately; for each visible row the client calls `worktreeSize({ path })` lazily and caches the result; the footer total updates as sizes resolve and as the user toggles rows.
4. User adjusts selection, toggles force on any dirty rows, confirms.
5. Client calls `removeWorktrees({ cwd, items })`; on response shows a summary toast and invalidates source-control state.

## Error handling

- `listManagedWorktrees` on a non-repo or empty result yields an empty list; the dialog shows a "nothing to clean up" empty state.
- `worktreeSize` failure for a row shows an unknown-size indicator for that row and excludes it from the footer total; it does not block removal.
- `removeWorktrees` returns per-path results; failures (for example a still-dirty worktree removed without force) are listed in the summary toast while successful removals still apply.
- Removing a worktree that is gone on disk but still registered is treated as success after a prune, consistent with the current force-remove behavior.

## Testing (TDD)

- Git driver, against a real temporary repo with managed and unmanaged worktrees: `listManagedWorktrees` filtering and `isDirty`, `worktreeSize`, and `removeWorktrees` batch + per-path force + partial failure.
- Contract schema round-trips for the three new input/result types.
- Client classification helper: active / archived-only / orphaned and scope-setting selection.
- `WorktreeCleanupDialog` logic: lazy size loading and caching, force gating for dirty rows, locked active rows, footer total.
- Settings: `worktreeCleanupScope` default is `"orphaned"`.
- Archived panel: visible Delete button invokes the delete path.

## Open questions

None outstanding; all design decisions are resolved.
