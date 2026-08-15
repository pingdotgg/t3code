# Fork-to-upstream development

Use a fork as a staging point for small, focused contributions to T3 Code. The
fork is not a long-lived patch distribution: fixes should be proposed upstream,
and local installations should return to an official release after the change
ships.

The examples below use these remotes:

- `upstream`: [`pingdotgg/t3code`](https://github.com/pingdotgg/t3code), the
  canonical repository and pull request target.
- `origin`: [`clintebbesen/t3code`](https://github.com/clintebbesen/t3code), the
  working fork used to publish feature branches.

After cloning the working fork, add the canonical repository once, then confirm
the mapping before doing any work. If either remote already exists with the
wrong URL, correct it with `git remote set-url <name> <url>`.

```sh
git remote add upstream https://github.com/pingdotgg/t3code.git
git remote -v
git fetch --all --prune
```

Never put a token, key, password, `.env` value, or authenticated URL in a
command that will be copied into an issue, commit, document, or transcript. Use
GitHub CLI authentication or another approved credential store.

## Check for existing work first

Before opening an issue or writing code, search the upstream issues, pull
requests, current source, and recent releases. Search both open and closed work
and try the names of the visible symptom and the owning component.

```sh
gh issue list --repo pingdotgg/t3code --state all --search "search terms"
gh pr list --repo pingdotgg/t3code --state all --search "search terms"
gh release list --repo pingdotgg/t3code
git fetch upstream main --prune
git log --oneline upstream/main -- path/to/owner
```

Record the exact upstream commit inspected and links to matching issues, pull
requests, and releases. If an upstream pull request already covers the defect,
fetch and test its branch. Contribute only a missing regression, edge case, or
other demonstrated gap; do not recreate the same fix on another branch.

```sh
gh pr checkout <pull-request-number> --repo pingdotgg/t3code --detach
```

## Start each fix from upstream

The fork's `main` tracks upstream. Do not commit fixes to it or turn it into a
permanent overlay branch. Create one short-lived branch per concern from the
latest upstream `main`:

```sh
git fetch upstream main --prune
git switch -c fix/short-description upstream/main
git push -u origin fix/short-description
```

Keep the pull request narrow enough to describe without “also.” Before editing,
reproduce the defect with a regression test, trace all callers, and identify the
existing owner or layer to extend. Record the starting commit, reproduction,
material decisions, and exact verification results. Run the focused tests,
lint, type checks, and repository completion checks required by
[`AGENTS.md`](../../AGENTS.md); do not replace a real entry-point check with a
mock-only proof.

Tests must use isolated state. Copy data into a disposable worktree environment
when realistic data is needed. Never start a development server against the
live T3 home, write to the live database, restart the live service, deploy, or
mutate another environment without explicit authorization.

## Open and maintain the upstream pull request

Push only the feature branch to the fork. Then open a pull request from that
branch to `pingdotgg/t3code:main`, with the source and target explicit:

```sh
git push origin fix/short-description
gh pr create \
  --repo pingdotgg/t3code \
  --base main \
  --head clintebbesen:fix/short-description
```

Link the upstream issue and any fork coordination issue, state what was
reproduced, and include the exact checks run. Verify the pull request's base,
head, and CI result after creation. Do not merge it automatically.

While review is open, respond to current upstream source and maintainer
feedback. Fetch `upstream/main` before each revision, keep new commits within
the original purpose, and use the repository's normal review workflow to
synchronize the branch when required. If upstream has independently fixed the
defect, test that implementation and close or reduce the pull request instead
of preserving duplicate code.

After the change merges and appears in an official release, update the local
installation to that release, confirm the supported behavior, and retire the
fork build and short-lived branch. Do not accumulate merged fixes as permanent
overlay patches.

## Current reliability coordination

These links are starting points, not a substitute for the duplicate and release
search above:

- Provider command lockout: upstream
  [#6517](https://github.com/pingdotgg/t3code/issues/6517), coordinated in fork
  [#1](https://github.com/clintebbesen/t3code/issues/1).
- Quadratic Codex JSONL framing: upstream
  [#5389](https://github.com/pingdotgg/t3code/issues/5389), coordinated in fork
  [#2](https://github.com/clintebbesen/t3code/issues/2).
- This workflow: fork
  [#3](https://github.com/clintebbesen/t3code/issues/3).

The provider lifecycle defect and JSONL framing defect have different owners,
reproductions, and acceptance criteria. Keep their branches and pull requests
separate unless a current reproduction proves that they share an owner.
