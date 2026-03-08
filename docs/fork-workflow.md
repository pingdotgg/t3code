# Personal Fork Workflow

Use this if you are developing on your own fork while the original T3 Code repo keeps moving.

For this clone:

- `origin` = your fork (`cschubiner/t3code`)
- `upstream` = Theo's repo (`pingdotgg/t3code`)
- local `main` tracks `origin/main`

## Mental model

Treat `upstream/main` as the clean base from Theo.

Treat `origin/main` as your personal product branch. You can push your own commits there, but when Theo ships new work you should not blindly merge `upstream/main` into your customized `main` if you want a clean history. The safer default is:

1. Back up your current fork `main`
2. Identify the commits that exist only on your fork
3. Re-apply those commits on top of the latest `upstream/main`

This is a "replay" workflow. It keeps Theo's history intact and makes your custom work sit cleanly on top.

## One-time safety checks

Verify remotes:

```bash
git remote -v
```

Expected shape:

```text
origin   https://github.com/cschubiner/t3code.git (fetch)
origin   https://github.com/cschubiner/t3code.git (push)
upstream https://github.com/pingdotgg/t3code.git (fetch)
upstream DISABLED (push)
```

If `upstream` is still push-enabled, disable it:

```bash
git remote set-url --push upstream DISABLED
```

## Normal case: push your own changes to your repo

If you are just working on your fork and do not need Theo's latest changes yet:

```bash
git switch main
git pull --ff-only origin main

# make your changes

git add -A
git commit -m "Describe your change"
git push origin main
```

That is the simple, day-to-day path.

## Pull Theo's latest changes into your fork

Use this when Theo has pushed to `upstream/main` and you already have fork-only commits on `origin/main`.

### 1) Fetch everything and make a safety backup

```bash
git fetch origin
git fetch upstream

git branch -f backup/origin-main-$(date +%Y-%m-%d) origin/main
git push -u origin backup/origin-main-$(date +%Y-%m-%d)
```

Why: the replay workflow eventually force-pushes your fork's `main`. The backup branch gives you an easy rollback point.

### 2) List the commits that exist only on your fork

```bash
git rev-list --reverse --no-merges upstream/main..origin/main
```

If this prints nothing, your fork has no unique commits and you can fast-forward your fork to Theo:

```bash
git switch main
git reset --hard upstream/main
git push origin main --force-with-lease
```

### 3) Create a replay branch from Theo's latest `main`

```bash
git switch -C replay/fork-onto-upstream-$(date +%Y-%m-%d) upstream/main
```

### 4) Cherry-pick your fork-only commits onto that branch

Replay them one at a time, in order:

```bash
git cherry-pick <sha1>
git cherry-pick <sha2>
git cherry-pick <sha3>
```

If a cherry-pick conflicts:

- prefer Theo's current structure over old fork structure
- re-apply only the intent of your change
- if a commit is already effectively upstream, use `git cherry-pick --skip`

### 5) Verify the replayed stack

```bash
git range-diff upstream/main..origin/main upstream/main..HEAD
```

If you are replaying from an older simulated base while testing, compare the old base range against the new one:

```bash
git range-diff <old-base>..<old-branch> upstream/main..HEAD
```

Why: `git range-diff` is the fastest way to confirm that the replay preserved the meaning of your fork-only commits.

### 6) Push the replay branch

```bash
git push -u origin replay/fork-onto-upstream-$(date +%Y-%m-%d)
```

At this point you have a safe branch on your fork containing Theo's latest code plus your replayed changes.

### 7) Flip your fork `main` back to Theo's base, then move it to the replayed result

If you want the cleanest history, make `origin/main` line up with Theo again and then advance it to the replayed result.

Solo maintainer path:

```bash
git switch main
git reset --hard upstream/main
git push origin main --force-with-lease

git merge --ff-only replay/fork-onto-upstream-$(date +%Y-%m-%d)
git push origin main
```

PR path:

1. Push the replay branch
2. Open a PR from the replay branch into your fork `main`
3. Reset `origin/main` to `upstream/main`
4. Merge the PR once GitHub recalculates the diff

The PR path is slower but gives you a visible review surface.

## Recommended habits

- Before a risky sync, create a `backup/origin-main-YYYY-MM-DD` branch and leave it on the remote.
- Use `--force-with-lease` instead of plain `--force` when rewriting your fork `main`.
- Replay commits one by one. Do not bulk cherry-pick a large stack if you expect conflicts.
- Prefer replay over merge when your fork carries long-lived custom behavior.
- Prefer merge over replay only if you specifically want to preserve a merge history and can tolerate a noisier graph.

## What not to do

- Do not push to `upstream`
- Do not merge `upstream/main` into a heavily customized `origin/main` just because it is quick
- Do not skip the backup branch before rewriting `origin/main`

## Current validated repo setup

Validated in this clone after forking on 2026-03-07:

- fork: `cschubiner/t3code`
- upstream: `pingdotgg/t3code`
- backup branch created: `backup/origin-main-2026-03-07`
