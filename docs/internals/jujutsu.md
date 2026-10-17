# Jujutsu

## Detection stops at the nearest marker

[`findVcsMarkerRoot`](../../apps/server/src/vcs/JjRepo.ts) walks up and stops at the first `.jj` or
`.git`, nearest wins. A `.jj` a few levels up must not hijack a nearer Git checkout.
A missing directory returns no marker root; it cannot climb into an unrelated repository above it. An explicit `.t3code/vcs.json` selection is resolved by [`VcsProjectConfig`](../../apps/server/src/vcs/VcsProjectConfig.ts) before automatic driver detection.

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
