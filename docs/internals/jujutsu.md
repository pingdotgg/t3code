# Jujutsu

Why the jj lane looks the way it does. The actual commands, templates and revsets live in
[`apps/server/src/vcs`](../../apps/server/src/vcs) and [`apps/server/src/jj`](../../apps/server/src/jj),
this page is just the decisions you can't work out from one file.

## jj owns the working copy, Git owns the object store

In a colocated repo every jj commit, `@` included, is a real Git object in
`<mainWorkspaceRoot>/.git` pinned by `refs/jj/keep/<sha>`. So the split is fixed:

- Snapshot and restore are jj only. Git can't see `@` (`git rev-parse HEAD` is `@-`), and
  `git restore` or `git clean` desyncs jj from disk.
- Every diff byte is Git plumbing with `--git-dir` at that store. The client diff parsers expect
  `git diff` output and jj has no numstat, so [`Diffs.ts`](../../apps/server/src/checkpointing/Diffs.ts)
  and the review pipeline stay untouched instead of growing a second parser.
- PRs, hosting CLIs and per-thread merge-base config keep running against the same `.git` from the
  main workspace root, since they read `.git/config` themselves. A bookmark is `refs/heads/<name>`
  in that store, so the PR half of the product doesn't fork.

Hence the scope limit: a jj repo with no reachable `.git` is detected as jj and reported unusable,
never quietly treated as Git. [`JjRepo.resolveJjRepoPaths`](../../apps/server/src/vcs/JjRepo.ts)
follows a secondary workspace's `.jj/repo` pointer back to the main root so every Git call still has
a `--git-dir`.

## Detection stops at the nearest marker

[`findVcsMarkerRoot`](../../apps/server/src/vcs/JjRepo.ts) walks up and stops at the first `.jj` or
`.git`, nearest wins. A `.jj` a few levels up must not hijack a nearer Git checkout.

That's also what makes the flip safe for existing repos. A thread environment made before jj support
is a Git worktree (`.git` file, no `.jj`) and keeps resolving as Git against the same colocated
store. It only holds while path-scoped ops pick the driver from the path they're given, not the
project, which is why `removeWorktree` and `pruneWorktrees` dispatch on `input.path` in
[`GitWorkflowService`](../../apps/server/src/git/GitWorkflowService.ts), and why jj's prune also runs
`git worktree prune`.

The walk returns `null` for a missing directory, so a deleted thread dir can't climb into some
unrelated repo above it.

## Checkpoints are raw refs

A checkpoint is the commit id of `@` at the end of a turn, pinned with `git update-ref`. Everything
else fails somewhere: bookmarks and tags show up in the ref picker and `git branch`, `jj commit` moves
`@` and drops a visible commit in the user's log every turn, and op ids stop resolving once the op
log is pruned. A ref under `refs/t3/` is durable, invisible and moves nothing, and it's what Git
checkpoints already write, so
[`checkpointRefForThreadTurn`](../../apps/server/src/checkpointing/Utils.ts) stays shared.

What it doesn't give you is jj addressability. After an op log prune the object is still pinned in
Git but jj has forgotten it, so `jj restore --from <id>` fails with `Revision ... doesn't exist`.
Restore recovers by writing a temp `refs/heads/t3-restore-<uuid>`, running `jj git import`, retrying,
then deleting both. See [`JjCheckpoints.ts`](../../apps/server/src/vcs/JjCheckpoints.ts).

Capture is one snapshot read plus one `update-ref`, which is why nothing in T3 Code may run
`jj abandon`, `jj op abandon`, `jj util gc`, `git reset`, `git clean` or `git restore` in a jj repo.
Restore is `jj restore`, so change id, description, bookmarks and other workspaces all survive, and
the user can `jj undo` it.

## `@-` is HEAD, and root is never a revision

Every fall-back-to-HEAD in checkpoints and review diffs means `@-`, never `@`. `jj restore` from
`@`'s own id prints `Nothing changed.` and exits 0, so you'd report a revert that did nothing.

The root commit is the other trap. jj lists it as the parent of a first change and `trunk()` resolves
to it in a repo with no remote, and both hand Git an all-zeros id: `jj restore --from 0000...` empties
the working copy and `git diff 0000...` exits 128. So the change decoder in
[`JjVcsDriver.ts`](../../apps/server/src/vcs/JjVcsDriver.ts) drops root parents (a first change gets
`parentCommitIds: []`) and `changeAt` returns `null` for a revset that lands on root. That one `null`
covers default-bookmark, review-diff base and remote-tracking resolution. Treat the base as absent,
not as zero.

## `git.abandon-unreachable-commits=false` on every command we run

A colocated repo imports Git refs on every jj command that touches the working copy, and jj's default
is to abandon commits those refs moved off, rewriting files on disk. A plain `git fetch`,
`git branch -f` or `gh pr checkout` followed by the 30s status poll is enough to lose committed work.
The guard lives in the global arg prefix in [`JjProcess.ts`](../../apps/server/src/vcs/JjProcess.ts)
so every future call site inherits it. It's never applied to the user's own jj, their config is
theirs.

## Unusable is not Git

Missing `jj`, older than [`JJ_MINIMUM_VERSION`](../../apps/server/src/vcs/JjAvailability.ts), or not
colocated: detection still says jj. Falling back to Git would write a Git worktree into a jj repo.
Every op instead fails with a named reason that reaches clients as
`VcsStatusLocalResult.vcs.unsupportedReason` and disables the action menu with that text.

Checkpoints are the exception. `checkpointsUsable` answers `false` there so
[`CheckpointStore.supportsCheckpoints`](../../apps/server/src/checkpointing/CheckpointStore.ts) skips
capture silently, same as a directory with no repo, instead of writing a failed-capture activity into
every turn.
