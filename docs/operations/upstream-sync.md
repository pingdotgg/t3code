# Keeping the fork current with upstream

`main` is an upstream nightly (`PATCH_BASE` in `patched-nightly.yml`) plus the fork's own commits.
Two workflows keep it current and build it:

- **Upstream sync** (`upstream-sync.yml`, daily 13:17 UTC, or run it by hand): opens one PR that merges the
  newest upstream nightly into `main` and moves `PATCH_BASE` / `PATCH_BASE_SHA` to it, waits for the
  PR's checks, and merges it with a merge commit.
- **Patched nightly** (`patched-nightly.yml`, daily 20:23 UTC): builds `main` as it is, tagged from the
  upstream nightly in `PATCH_BASE`. It skips the build when that source and `main` commit are already published.

Git remembers a conflict resolution once the sync PR is merged, so a drift is fixed one time, not on every build.

## When it needs you

A conflict or failing check in the sync wakes the fix-forward agent through the webhook (secret
`NIGHTLY_FIX_WEBHOOK_URL`); the health workflow also reports a sync PR open for over 36 hours. The one conflict the
sync resolves itself is `agentContextBudget.json`, which upstream and the fork both move: it takes upstream's file,
re-measures it with `AgentContextBudget.test.ts` on the merged tree, and commits the merge. A conflict in any other
file aborts the merge and wakes the agent. To do it by hand from a fresh `main`:

```sh
git fetch origin && git fetch upstream --tags
git switch -c chore/upstream-sync-<tag> origin/main
git merge <tag>            # resolve, keep the fork's behavior
# set PATCH_BASE and PATCH_BASE_SHA in .github/workflows/patched-nightly.yml to the tag and its commit
vp run check:changed
```

Open the PR with "Keep this change out of patched nightlies" ticked and merge it with a **merge commit**. While a
`chore/upstream-sync-*` PR is open the workflow does nothing, so close or merge it first.

## Sending a change upstream

Branch from `upstream/main`, not `main`. Cherry-pick the fork commit onto it, reword the subject without
`patch:`, and open the PR against `pingdotgg/t3code`. When upstream lands it, the next sync merges it in; delete
the fork copy if it conflicts or is now redundant.

## If upstream rewrites its history again

The sync fails with "does not descend from the pinned base". Rebuild the fork's commits on the new upstream,
join the old `main` with an `-s ours` merge, set `PATCH_BASE` and `PATCH_BASE_SHA`, and merge with a merge commit.

## Needs

The secret `PATCHED_NIGHTLY_RELEASE_TOKEN` (fine-grained, this repository, Contents, Pull requests and
Workflows write). Without it the job falls back to the default token: pushing a branch that adds upstream
workflow files is refused, and a PR it opens does not start CI.
