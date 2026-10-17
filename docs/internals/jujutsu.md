# Jujutsu

## Detection stops at the nearest marker

[`findVcsMarkerRoot`](../../apps/server/src/vcs/JjRepo.ts) walks up and stops at the first `.jj` or
`.git`, nearest wins. A `.jj` a few levels up must not hijack a nearer Git checkout.

## `git.abandon-unreachable-commits=false` on every command we run

A colocated repository imports Git refs during jj commands. The default unreachable-commit abandonment can rewrite local history after an external Git ref moves. [`JjProcess.ts`](../../apps/server/src/vcs/JjProcess.ts) passes `git.abandon-unreachable-commits=false` on T3 Code's jj commands so a later status read does not abandon that history. This does not change the user's jj configuration.

## Checkpoints are raw refs

A checkpoint captures the commit id of `@` and pins it under `refs/t3/` with `git update-ref --create-reflog`. It moves neither the working-copy change nor a bookmark. Bookmarks and tags would appear in ref pickers, `jj commit` would advance `@` every turn, and operation ids stop resolving after operation-log pruning. The ref format stays shared through [`checkpointRefForThreadTurn`](../../apps/server/src/checkpointing/Utils.ts).

What it doesn't give you is jj addressability. After an op log prune the object is still pinned in
Git but jj has forgotten it, so `jj restore --from <id>` fails with `Revision ... doesn't exist`.
Restore recovers by writing a temp `refs/heads/t3-restore-<uuid>`, running `jj git import`, retrying,
then deleting both. See [`JjCheckpoints.ts`](../../apps/server/src/vcs/JjCheckpoints.ts).

Capture snapshots `@` and pins its object. Checkpoint restore uses `jj restore`, not `git reset`, `git clean` or `git restore`, so the change id, description, bookmarks and other workspaces survive. The user can undo the restore with `jj undo`. Checkpoint code must not abandon changes or prune the user's operation log.

## Turn attribution is separate from restore

The upstream checkpoint pipeline can filter turn diffs to authored paths without narrowing the saved checkpoint. jj implements `listAuthoredPaths` in [`JjCheckpoints.ts`](../../apps/server/src/vcs/JjCheckpoints.ts): it combines working-copy edits at both ends with paths from relevant parent history, using the starting checkpoint's reflog timestamp rather than the jj commit timestamp as capture time. That keeps imported history from becoming the turn's own work.

Ambiguous ancestry, unchanged parents or older refs without capture-time metadata return `null` instead of guessing an authored-path set. Diff filtering is optional; restore always uses the full captured workspace.

## `@-` is the committed base, and root is never a revision

The jj equivalent of the checkpoint pipeline's fallback-to-HEAD is the parent tree, not `@` itself. Missing-ref restore uses the current working copy's merged parents. A historical checkpoint diff instead uses the captured endpoint's merged parents and captured tree, so later edits or parent changes in `@` cannot alter the result. None of these bases resolve through the shared Git `HEAD`. `jj restore` from `@`'s own id prints `Nothing changed.` and exits 0, which would report a revert that did nothing.

jj's synthetic root has an all-zeros id, not a usable Git object. [`JjVcsDriver.ts`](../../apps/server/src/vcs/JjVcsDriver.ts) drops root parents and returns `null` when `changeAt` resolves root. A first change therefore has `parentCommitIds: []`. Restore has no committed fallback there; diffs use Git's empty tree when they need an empty base. Default-bookmark, review-diff base and remote-tracking resolution must treat root as absent, never pass its zero id to Git.

## jj owns the working copy, Git owns the object store

In a colocated repo every jj commit, `@` included, is a real Git object in
`<mainWorkspaceRoot>/.git` pinned by `refs/jj/keep/<sha>`. So the split is fixed:

- Snapshot and restore are jj only. Git's `HEAD` is not the working-copy change `@`; `git restore` or `git clean` bypasses jj's working-copy state even in a colocated secondary workspace.
- Diff patches and numstat use Git plumbing against the resolved object store for changes with a single parent. For merge changes, checkpoint and review diffs use `jj diff --git` so the patch reflects jj’s merged-parent semantics.
- Hosting operations and per-thread merge-base config use the main workspace root and its `.git/config`. Local bookmarks are exported as Git branch refs in the colocated store. Explicit fetch, push and bookmark movement belong to jj, not Git checkout commands. Background status fetches use Git with noninteractive authentication and write only `refs/t3/remotes/<encoded-remote>/*`, a namespace jj does not import. Fetch disables Git's configured remote-tracking ref mappings as well. Ahead counts use jj's nonempty changes above the Git merge bases; behind counts read the fetched Git objects. A background remote update therefore cannot move a tracked local bookmark or detach the workspace from it.

Hence the scope limit: a jj repo with no reachable `.git` is detected as jj and reported unusable,
never quietly treated as Git. [`JjRepo.resolveJjRepoPaths`](../../apps/server/src/vcs/JjRepo.ts)
follows a secondary workspace's `.jj/repo` pointer back to the main root so every Git call still has
a `--git-dir`.

Private behind counts are bounded by time, output size and commit count. Timeouts and output limits retain jj's known remote-bookmark count. Reaching the commit cap reports a lower bound of 1000 rather than a potentially stale zero, so Pull remains available. Remote discovery failures still surface as errors.

## Unusable is not Git

Missing `jj`, older than 0.46.0 ([`JJ_MINIMUM_VERSION`](../../apps/server/src/vcs/JjAvailability.ts)), or not
colocated: detection still says jj. Falling back to Git would write a Git worktree into a jj repo.
Every op instead fails with a named reason that reaches clients as
`VcsStatusLocalResult.vcs.unsupportedReason` and disables the action menu with that text.

Checkpoints are the exception. `checkpointsUsable` answers `false` there so
[`CheckpointStore.supportsCheckpoints`](../../apps/server/src/checkpointing/CheckpointStore.ts) skips
capture silently, same as a directory with no repo, instead of writing a failed-capture activity into
every turn.
