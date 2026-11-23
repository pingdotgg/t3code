---
name: sync-upstream
description: Merge upstream T3 Code (pingdotgg/t3code) into the PseudoCode fork and release the result, keeping every fork change. Use when asked to sync, pull, or merge upstream (Chris also calls it "origin", meaning the repo the fork came from) into the fork, or to cut a release after such a sync.
---

# Sync upstream

The goal is **parity**: after the sync, the fork has every upstream change and every fork change.
Fork changes are fork-only features, fork behaviour inside upstream code, and renamed product text
("PseudoCode" for "T3 Code", "Cloud Connect" for "T3 Connect").

**Names.** Chris says "origin" or "upstream" for pingdotgg/t3code. In git, that repo is the remote
`upstream`, which has pushing disabled. The git remote `origin` is the fork, pseudoseed/t3code_dev.
Every push and PR in this routine goes to the fork.

Scripts live in `.agents/skills/sync-upstream/scripts/`. Run them from the repo root.

## Steps

### 1. Branch from fork main

```sh
git fetch origin main && git fetch upstream main
git switch -c t3/sync-upstream-$(date +%Y%m%d) origin/main
git config user.email
```

The email must print `27822378+pseudoseed@users.noreply.github.com`. Chris keeps his address
private, and GitHub refuses a push whose commits carry it. Done when the branch exists and the email
matches.

### 2. Merge

```sh
git merge --no-ff upstream/main
```

Resolve every conflict so both sides survive: upstream's change and the fork's behaviour or text.
When upstream rewrote code the fork had changed, carry the fork's intent into upstream's new shape,
including its conventions (for example `Effect.fn` in place of plain arrow functions). Resolving a
whole file to one side is how fork changes go missing. Chris wants no comments in code unless
absolutely needed, so a fork comment that conflicts or that upstream's comment lint rejects is
deleted, not trimmed. Done when `git diff --name-only --diff-filter=U` prints nothing and the merge
is committed.

### 3. Prove fork changes survived

```sh
.agents/skills/sync-upstream/scripts/fork-delta-check.py -v
```

It compares the fork's changes (fork main against the last upstream commit it merged) with the
working tree and prints 2 groups:

- **DROPPED**: nothing upstream did explains the loss. Restore the line, or name in the PR body
  the upstream change that does the same job.
- **REWRITTEN**: upstream rewrote the code the fork had changed. Read the new code and confirm the
  fork's intent is in it.

Run it before the sync PR merges. Its defaults compare against `origin/main`, which stops holding
the old fork once the PR lands. Done when every line it lists is restored or accounted for in the PR
body.

### 4. Bump the version

Raise the version in the 4 files [ship-pseudocode](../ship-pseudocode/SKILL.md) names, and commit
it separately: `chore(release): bump PseudoCode to <version>`.

### 5. Run every check

```sh
vp run check:changed
vp run lint
.agents/skills/sync-upstream/scripts/run-suites.sh
```

`vp run lint` is CI's whole-repo lint. A sync brings upstream's new lint rules, and they fail fork
files the merge never touched, which `check:changed` does not read.

`run-suites.sh` runs every package's tests one at a time, the one place in this repo where the full
suites run locally: Chris needs a sync green before it ships. Fix each failure at its cause. When
you believe a failure belongs to this machine rather than the code, prove it: run the same test in
a clean upstream worktree (`git worktree add ../t3-upstream-check upstream/main`, then `vp i`
there). If it fails there too, report it with that evidence as a failure, never as a pass, and
remove the worktree. Done when all 3 commands pass, or every remaining failure carries that proof.

### 6. Check the app live

Drive web with [test-t3-app](../test-t3-app/SKILL.md) and iOS with
[test-t3-mobile](../test-t3-mobile/SKILL.md), against copied real data. Cover the fork features the
merge touched. Done when each surface was driven and what you saw is written down for the PR.

### 7. Open the PR

Push the branch to `origin` and open a PR into the fork's `main`. The body names the upstream
commit merged, the fork changes restored, each DROPPED line accepted and why, the test counts, and
what the live check covered. Merge it yourself with a **merge commit** once CI is green and review
is done; a squash would orphan the commits the release tag points at. Hand the merge to Chris only
when the change is high risk.

The PR's CI must pass. This Mac is arm64 and CI runs on x64 Linux, so some failures only show up
there; fix them at their cause like any other. A job GitHub cancels with "not acquired by Runner"
never got a macOS runner: rerun it with
`gh run rerun <run-id> --failed --repo pseudoseed/t3code_dev`. Done when the PR is open and every CI
job passes and the PR is merged.

### 8. Release from merged main

```sh
git fetch origin main && git switch --detach origin/main
.agents/skills/ship-pseudocode/scripts/ship-mac.sh
.agents/skills/ship-pseudocode/scripts/ship-ios.sh
```

`ship-mac.sh` refuses any commit other than a clean `origin/main` and leaves the release as a
draft. Publish it once both builds verify; there is no approval gate:
`gh release edit pseudocode-v<version> --repo pseudoseed/t3code_dev --draft=false --latest`.

## When something fails

| Symptom                                                                    | Cause                                                                                                                                                    |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A replay test hangs for 2 minutes, or mismatches on product text           | Upstream's fixtures say "T3 Code" where the fork's code now says "PseudoCode" (Codex `clientInfo`, Muse `runtime_info`). Rename the text in the fixture. |
| A test expects "T3 Code" or "T3 Connect" copy                              | Same rename; the fork's string is the one the app shows. Update the expectation.                                                                         |
| A migration test fails under Node 26 only                                  | Node 26 bundles SQLite 3.54, which drops the JSON subtype of a subquery inside `json_set`. Wrap the subquery in `json(...)`.                             |
| React Compiler coverage test names a fork component                        | The compiler skips components with `try`/`finally`. Rewrite as a promise chain with `.finally`.                                                          |
| Lint `t3code/no-unreasoned-state-sync` on a fork effect                    | Upstream's rule now covers fork code. Add the reason comment the rule asks for, or remove the effect.                                                    |
| Tests killed with exit 137                                                 | Suites ran in parallel and ran out of memory. Use `run-suites.sh`.                                                                                       |
| Desktop suite: "Electron failed to install correctly" after a fresh `vp i` | Parallel test workers raced to download Electron. It is installed by the end of the run; run `run-suites.sh apps/desktop` again.                         |
| Push declined "due to email privacy restrictions"                          | A commit carries Chris's private email. Fix `user.email`, then re-author only the commits not yet pushed.                                                |
| GuestPage browser test: distance from bottom 2074, expected under 2        | Fails on this Mac on clean upstream as well, and passes on upstream's Linux CI. Not root-caused. Report it with the clean-upstream run as evidence.      |
