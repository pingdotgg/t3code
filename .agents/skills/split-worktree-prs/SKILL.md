---
name: split-worktree-prs
description: Splits a large dirty git worktree into logical, self-contained branches and GitHub pull requests against a base branch. Use when the user wants uncommitted changes separated into PRs, asks to create logical PRs, or needs a large local diff grouped by feature/domain before pushing.
---

# Split Worktree PRs

Turn a large uncommitted worktree into coherent PRs that are each **self-contained** — every PR is independently mergeable: it installs, and passes the repo's checks (build/typecheck/lint/format) on its own branch. Logical grouping is worthless if a slice is red or references files it doesn't include.

Never lose local work: snapshot first, restore at the end.

## 1. Snapshot the full worktree into one ref

A single ref is easier to slice than a stash (tracked + untracked + deletions in one place) and leaves the working tree byte-identical:

```sh
git add -A && git commit -q -m 'wip: split snapshot (temp)'
git branch snap                    # immutable full snapshot
git reset --soft HEAD~1 && git reset -q   # restore exact dirty state
```

`snap` now holds the complete change. `git diff --name-only origin/main..snap` is the authoritative file set.

## 2. Assess coupling BEFORE splitting

A clean split is only possible if slices don't break each other. Probe for coupling that forces slices to ship together:

- **Shared interfaces/contracts** — if a slice changes a type/schema/API implemented or consumed by other slices, those consumers fail to compile until updated. They must land together. Test empirically: build one candidate slice and count errors in the others.
- **Global lockfile / manifests** — one monorepo `pnpm-lock.yaml` (or equivalent) reflects all manifests at once; a partial branch fails `--frozen-lockfile`. Either regenerate a consistent lockfile per branch, or keep coupled manifest changes together.
- **Global config** — shared catalog/overrides/patched-dependencies referencing packages only present in another slice will error.

Then pick a topology:

- **Independent PRs (base = main):** only when slices are genuinely decoupled and each is green alone.
- **Stacked PRs (base = parent branch):** when slices depend in order (foundation → backend → frontend). Each is self-contained _relative to its base_; retarget with `gh pr edit <n> --base <parent-branch>`.
- **Consolidate:** when a shared change breaks every consumer (e.g. a contract touched by all apps), a green split is impossible. Merge the coupled work into one PR rather than ship red PRs. Prefer this over pretending decoupling exists.

## 3. Build each slice by pathspec

Restore only a slice from `snap` onto a fresh branch. Negative pathspecs make "everything except the apps" trivial and correctly apply additions **and** deletions:

```sh
git switch -C split/foundations origin/main
git restore --source=snap -SW -- ':/' ':(exclude)apps/server' ':(exclude)apps/web'
git commit -q -m "<title>" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

For a stack, branch the next slice from the previous branch instead of `origin/main`, then restore its paths.

Typical seams (dependency order): shared contracts/runtime/manifests → backend/API/relay → web client → mobile/native app + mobile-only patches. Keep each app's manifest/lockfile delta and config (patches, catalog entries) with the branch that introduces the code using it.

## 4. Verify — this is the point of the skill

**Completeness (catches dropped files, the most common failure):** the union of all branch diffs must equal the snapshot exactly.

```sh
git diff --name-only origin/main..snap | sort > /tmp/all.txt
{ for b in <branches>; do git diff --name-only <base-of-b>..$b; done; } | sort -u > /tmp/union.txt
comm -3 /tmp/all.txt /tmp/union.txt   # empty = nothing dropped or duplicated
```

**Green per branch:** on each branch run the smallest install + checks that prove it (e.g. `pnpm install --frozen-lockfile`, then the repo's fmt/lint/typecheck). Use the repo's required Node/toolchain version. If a branch is red because a peer slice is missing, revisit step 2 (stack or consolidate).

## 5. Restore and finish

```sh
git switch <original-branch>   # working tree is already intact from step 1
git branch -D snap             # only after PRs are pushed and verified
```

## Safety rules

- Never `git reset --hard` or destructive-checkout the user's worktree. The snapshot in step 1 keeps the tree unchanged.
- Keep `snap` until PRs are pushed and verified; it's the only recovery path.
- Don't bundle unrelated changes into a PR for convenience, and don't drop files to make a slice smaller.
- Force-pushing over existing PR branches is fine (old heads stay in `refs/pull/<n>/head`), but confirm before closing PRs; note when consolidating supersedes others.
- If a hook warns but commits, or a check has pre-existing warnings, surface that in the final answer.

## Final response

Report each PR's URL, scope, base branch, and green/red status in a compact table. State the topology chosen (independent/stacked/consolidated) and why, confirm completeness (union == snapshot), and note the worktree was restored and whether `snap` remains.
