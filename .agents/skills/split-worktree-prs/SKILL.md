---
name: split-worktree-prs
description: Splits a large dirty git worktree into logical branches and GitHub pull requests against a base branch. Use when the user wants uncommitted changes separated into PRs, asks to create logical PRs, or needs a large local diff grouped by feature/domain before pushing.
---

# Split Worktree PRs

Turn a large uncommitted worktree into coherent PRs without losing local work.

## Quick start

```sh
git --no-pager status --short
git --no-pager diff --stat
git stash push -u -m 'copilot-pr-split-full-worktree'
git switch -C split/<scope> origin/main
git restore --source=stash@{0} --staged --worktree -- <tracked-paths>
git checkout stash@{0}^3 -- <untracked-paths>
git add -- <paths>
git commit -m "<message>" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
git push -u origin split/<scope>
gh pr create --base main --head split/<scope> --title "<title>" --body "<body>"
```

## Workflow

1. Inspect the full worktree: `git status --short`, `git diff --stat`, `git diff --name-status`, and `git ls-files --others --exclude-standard`.
2. Identify PR seams by dependency order and reviewability: shared contracts/runtime first, server/API next, web/client next, app/mobile/UI last.
3. Save a durable safety copy before changing branches:

```sh
mkdir -p .copilot-pr-split
git --no-pager diff --binary > .copilot-pr-split/tracked.patch
git ls-files --others --exclude-standard > .copilot-pr-split/untracked-files.txt
git stash push -u -m 'copilot-pr-split-full-worktree'
```

4. For each PR, create a fresh branch from the base branch and restore only that slice from the stash.
5. Commit and push each branch. Include the required co-author trailer unless the user opted out.
6. Create each PR with `gh pr create --base <base> --head <branch>`.
7. Restore the original local worktree at the end with `git switch <original-branch>` and `git stash apply stash@{0}`. Leave the safety stash unless the user asks to drop it.

## Choosing PR boundaries

Prefer small dependency-respecting slices:

- **Foundations:** package manifests, lockfile, shared utilities, contracts, generated protocol wrappers.
- **Backend:** server routes, protocol handlers, auth, persistence, relay/cloud services.
- **Frontend web:** browser UI and web-specific client integration.
- **Mobile/app:** React Native/Expo app shell, native modules, mobile feature screens, mobile-only patches.
- **Docs/config:** keep with the code they explain unless they are independently useful.

Avoid PRs that cannot build because required types or dependency metadata were split away. If a slice depends on another new slice, say so in the PR body.

## Restoring tracked and untracked stash content

Tracked files are in the stash commit:

```sh
git restore --source=stash@{0} --staged --worktree -- <paths>
```

Untracked files are usually in the third stash parent:

```sh
git checkout stash@{0}^3 -- <path>
```

Check path existence before restoring untracked paths:

```sh
git cat-file -e "stash@{0}^3:<path>"
```

## Safety rules

- Never use `git reset --hard` or destructive checkout commands to clean the user's worktree.
- Do not drop the safety stash unless explicitly asked.
- Do not include unrelated user changes in a PR just because they are convenient.
- If a commit hook reports warnings but still commits, mention that caveat in the final answer and PR notes.
- If branch creation or PR creation fails, preserve the stash and report the exact branch/state.

## Final response

Report the created PR URLs and scopes in a compact table. State whether the original worktree was restored and whether the safety stash remains.
