# Version Control Panel Work

The first-class Version Control panel includes a singleton right-panel surface, live VCS status watcher, Actionable and Remotes panel model, selected-file commit/stash flow, branch/commit/stash/remote actions, compare-base semantics, and Version Control panel RPC/contracts.

VCS status ignores internal `.git/` watcher events before refreshing local status and uses a conservative default automatic remote Git fetch interval.

Provider-backed change-request lookups remain best-effort in the panel service. Provider/auth/CLI failures must not fail the whole panel snapshot or hide git-derived actionable branch rows.

Version Control and source-control provider failures should preserve structured causes when normalized for panel RPC errors. GitLab, GitHub, Azure DevOps, and Bitbucket provider paths should keep provider-specific not-found/auth/missing-CLI details without collapsing structured process failures into generic strings.

Thread source-control metadata update failures should surface on the thread without overwriting unrelated thread errors, and successful source-control updates should clear only the source-control metadata error for that thread. Metadata update sequencing stays monotonic for the hook lifetime so a reopened thread key cannot let an old in-flight failure overwrite a newer successful checkout. Server-thread updates carry the active branch as `expectedBranch`, allowing the server to reject a stale metadata write instead of overwriting a newer branch/worktree transition.

Required edge cases: the current default branch remains a valid default compare ref, status-derived default branch names such as `develop` are preferred over hardcoded `main`/`master` guesses, compare-history pagination queries the selected comparison range, branch pull/fetch parsing handles slashful remotes and remote-looking local branch names without treating slashless local upstreams as remote refs, diverged normal merge sync is available only for the current branch, checked-out branch worktree paths fall back from porcelain worktree output to branch-format placeholders without failing on older Git versions, sibling worktree watcher refreshes keep root Actionable rows live while skipping stale/prunable worktree paths, branch sync and undo operations for checked-out branches target the owning worktree cwd, checkout and deletion remain disabled for branches already checked out in any worktree, cwd-scoped working-tree enrichment avoids cross-worktree file-detail reuse, selected-file commits omit pathspecs after staging, merge refs are passed after `--`, tracked discard restore failures surface instead of being swallowed, fallback rename parsing preserves original paths, merged staged-plus-unstaged row stats are summed, and late-month relative dates do not fall through to `0 years ago`.

`SOURCE_CONTROL.md` contains the detailed implementation requirements.

Primary reference:

- `SOURCE_CONTROL.md`

## Development Ports

- Web: `5742`
- Server/WebSocket: `13782`
