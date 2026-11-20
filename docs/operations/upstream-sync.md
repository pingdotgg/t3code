# Keeping the fork current with upstream

`main` is an upstream nightly (`PATCH_BASE` in `patched-nightly.yml`) plus the fork's `patch:` commits.
Two workflows keep that true. They do different jobs and do not touch each other's output:

- **Patched nightly** (`patched-nightly.yml`, daily): replays every `patch:` commit on `main`
  onto the newest upstream nightly and builds from that. It reads `main` and never writes to it.
- **Upstream sync** (`upstream-sync.yml`, Mondays, or run it by hand): opens one PR that merges the
  newest upstream nightly into `main` and moves `PATCH_BASE` / `PATCH_BASE_SHA` to it. It never pushes
  to `main` and never builds. Both workflows choose "latest" with the same query.

Without the sync, releases stay current but `main` ages, and the replay gets harder to apply.

## Merging a sync PR

1. The `Prepare latest upstream nightly` check is the dry run: it replays the patches onto the newest
   nightly. Green means they still apply.
2. Merge with a **merge commit**. Squash or rebase drops upstream's history and breaks the next sync.
3. Only one sync PR is open at a time; the workflow skips while one exists.

## When the merge conflicts

The workflow fails and lists the files. Do it locally from a fresh `main`:

```sh
git fetch origin upstream --tags
git switch -c chore/upstream-sync-<tag> origin/main
git merge <tag>            # resolve, keep the fork's behavior
# set PATCH_BASE and PATCH_BASE_SHA in .github/workflows/patched-nightly.yml to the tag and its commit
vp run check:changed
```

Open the PR with the "Keep this change out of patched nightlies" box ticked. Upstream commits are
ignored by the patch-prefix gate, so they need no `patch:` subject.

## When a patch stops applying

Fix it in a normal `patch:` commit, or send the change upstream and drop the fork copy. A patch that
upstream has absorbed still replays and may conflict or come out empty; patched-nightly has no skip list,
so add one deliberately (a reviewed change to the selection loop) rather than reverting, because a revert
commit does not remove the original from the replay.

## If upstream rewrites its history again

The sync fails with "does not descend from the pinned base". Repeat the one-off reconcile: rebuild on the
new upstream with the `patch:` commits, join the old `main` with an `-s ours` merge, set `PATCH_BASE_SHA`
and `LEGACY_MAIN_SHA` (the old head, so its `patch:` commits are not replayed), and merge with a merge commit.

## Needs

The secret `PATCHED_NIGHTLY_RELEASE_TOKEN` (fine-grained, this repository, Contents, Pull requests and
Workflows write). Without it the job falls back to the default token: pushing a branch that adds upstream
workflow files is refused, and a PR it opens does not start CI.
