# Jujutsu

## Detection stops at the nearest marker

[`findVcsMarkerRoot`](../../apps/server/src/vcs/JjRepo.ts) walks up and stops at the first `.jj` or
`.git`, nearest wins. A `.jj` a few levels up must not hijack a nearer Git checkout.
A missing directory returns no marker root; it cannot climb into an unrelated repository above it.
[`VcsProjectConfig`](../../apps/server/src/vcs/VcsProjectConfig.ts) resolves the repository's
`.t3code/vcs.json` preference before driver detection.

## `git.abandon-unreachable-commits=false` on every command we run

A colocated repository imports Git refs during jj commands. The default unreachable-commit abandonment can rewrite local history after an external Git ref moves. [`JjProcess.ts`](../../apps/server/src/vcs/JjProcess.ts) passes `git.abandon-unreachable-commits=false` on T3 Code's jj commands so a later status read does not abandon that history. This does not change the user's jj configuration.

## Repository-local configuration and machine output

Availability probes are cached per repository, not globally: a broken repository configuration
must not disable Jujutsu in another checkout. Failed probes retain jj's stderr rather than
reporting an installed binary as missing.

Machine templates access keywords through `self` methods so user keyword aliases cannot shadow
them. If configuration changes a template function's output, decoding reports the failing field
path without including the output value.

## Checkpoints are raw refs

A checkpoint captures the commit id of `@` and pins it under `refs/t3/` with `git update-ref --create-reflog`. It moves neither the working-copy change nor a bookmark. Bookmarks and tags would appear in ref pickers, `jj commit` would advance `@` every turn, and operation ids stop resolving after operation-log pruning. The ref format stays shared through [`checkpointRefForThreadTurn`](../../apps/server/src/checkpointing/Utils.ts).

What it doesn't give you is jj addressability. After an op log prune the object is still pinned in
Git but jj has forgotten it, so `jj restore --from <id>` fails with `Revision ... doesn't exist`.
Restore recovers by writing a temporary `refs/heads/t3-restore-<uuid>`, running `jj git import`,
and retrying. Cleanup forgets the temporary bookmark, deletes its Git ref, and abandons the
recovery commit and any hidden ancestors revived by import, excluding history visible at the
pre-import operation. Cleanup also runs if import completes just before interruption; a
`present()` revset makes an import that never completed safe to clean up. Every cleanup is
attempted, and the primary failure plus all cleanup failures are retained in the returned cause.
See [`JjCheckpoints.ts`](../../apps/server/src/vcs/JjCheckpoints.ts).

Capture snapshots `@` and pins its object. Checkpoint restore uses `jj restore`, not `git reset`,
`git clean` or `git restore`, so the change id, description, bookmarks and other workspaces
survive. Ordinary restores can be undone with `jj undo`; recovery also records import and cleanup
operations, so use the operation log to select the restore when undoing recovery. Checkpoint code
never abandons the user's changes or prunes the operation log.

Both endpoints of a jj checkpoint diff must be captured refs. Missing-ref restore returns false;
a missing diff endpoint is an error. The shared fallback options remain for the upstream Git
driver, but jj does not substitute a parent tree for a missing checkpoint. Captured merge trees
use the same Git patch and rename-aware NUL-delimited numstat path as other captured trees.

## Turn attribution is separate from restore

The upstream checkpoint pipeline can filter turn diffs to authored paths without narrowing the saved checkpoint. jj implements `listAuthoredPaths` in [`JjCheckpoints.ts`](../../apps/server/src/vcs/JjCheckpoints.ts): it combines working-copy edits at both ends with paths from relevant parent history, using the starting checkpoint's reflog timestamp rather than the jj commit timestamp as capture time. That keeps imported history from becoming the turn's own work.

Ambiguous ancestry, unchanged parents or older refs without capture-time metadata return `null` instead of guessing an authored-path set. Diff filtering is optional; restore always uses the full captured workspace.

## Root is never a revision

jj's synthetic root has an all-zeros id, not a usable Git object. [`JjVcsDriver.ts`](../../apps/server/src/vcs/JjVcsDriver.ts) drops root parents and returns `null` when `changeAt` resolves root. A first change therefore has `parentCommitIds: []`. Review diffs use Git's empty tree when they need an empty base. Default-bookmark, review-diff base and remote-tracking resolution must treat root as absent, never pass its zero id to Git.

Remote-qualified review bases such as `origin/main`, including `branch.<name>.gh-merge-base`,
try the remote bookmark first, then the same-spelled local bookmark only if the remote is absent.
`refs/remotes/origin/main` stays remote-only; `refs/heads/origin/main` explicitly selects local.
