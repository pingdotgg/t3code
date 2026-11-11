---
name: release-overnight
description: Prepare an alchemy release unattended overnight, in series — after one go-ahead, nuke the testing account, then walk every provider's live suite one at a time (Cloudflare → core unit → core integration → small providers → Fly → GCP → AWS), fixing each until its whole suite passes in one run AND the account census is clean, then run `pnpm test:examples`, and finish with one alchemy PR plus at most one distilled PR and one floci PR, all linked, that merge into a release passing every test. Use for "prepare the release overnight", "/release-overnight", "run the release suite in series while I sleep"; for the parallel, interactive version use prepare-release.
metadata:
  internal: true
---

# Release overnight

This thread runs the whole release unattended, **one suite at a time**. It owns
every step: the clean slate, each run, the fixes, type-checking, the census
and the PRs. It launches no subagents or threads, and it runs nothing in
parallel with a live suite. Going slowly in series is the point. A live suite
under load produces fake failures, and parallel fixers on one account leak
into each other's census.

A provider is **done** when its whole suite passes in one run at the current
head and the census shows nothing new. The release is done when every
provider is done at the final head, `pnpm test:examples` passes, and the
account is clean. The user merges; you never do.

## 0. One question, then unattended

Ask once, up front, in a single question. Confirm three things: the scope
(default: everything in §2), that you'll nuke the testing account before each
step for the whole run, and any opt-in tags or paid add-ons to include
(default: none). **Nuking is destructive, so get an explicit yes.** After
that, never ask again. Take every decision yourself, record it in
`STATE.md`, and keep going. An answer you would have asked for goes in
the final report.

Don't end the turn until §6 is done. Ending the turn ends the night. Wait on
long runs with `t3_background_wait`, never with `sleep` or a polling loop.

## 1. Preflight and durable state

Start from the latest `origin/main`, on a fresh branch:

```sh
git status                      # must be clean; never git stash
git fetch origin main
git checkout -b release/overnight-$(date +%Y-%m-%d) origin/main
git log -1 --format='%H %s' origin/main   # record as "Base" in STATE.md
git submodule update --init -- submodules/distilled
```

Then run the rest of
[prepare-release §0](../prepare-release/SKILL.md#0-preflight): `pnpm install`,
pinned bun/node in `/tmp/release/env.sh`, `.env`, `aws sso login`, and
`pnpm exec tsrs -b`.

Don't merge `main` into the branch mid-run. A moving base would make every
`Passed at` meaningless. §6 picks up whatever landed overnight.

Keep the run's state in `/tmp/release/STATE.md` and update it after every
event. Context will be compacted many times overnight, and this file is how
you resume:

```md
# Release overnight 2026-10-31 — branch release/overnight-2026-10-31
Base: origin/main <sha> · Scope: all · opt-in: none · nuke authorized: yes
PRs: alchemy #— · distilled #— · floci #—

| # | Step | Command | Status | Passed at | Notes |
| - | ---- | ------- | ------ | --------- | ----- |
| 1 | Cloudflare | pnpm test:integration test/Cloudflare | done | a1b2c3d | |
| 2 | core unit | pnpm test | fixing (iter 2) | | Plan diff regression |

Gated: <test → typed tag + exact error>
Blocked (account, not code): <step → exact error>
```

**On every start, read `STATE.md` first.** If it exists, resume at the first
step that isn't `done`. Don't restart the night.

## 2. The steps, in order

Cloudflare goes first. State and most other suites deploy through
`packages/cloudflare`, so getting it green first keeps its failures out of
every later step. After that, cheap and narrow first, so a broken shared
layer shows up in minutes, not after AWS. Paths are relative to
`packages/integration-tests`:

| # | Step | Paths | `--concurrency` |
| - | ---- | ----- | --------------- |
| 1 | Cloudflare | `test/Cloudflare` | 16 |
| 2 | core unit | `pnpm test` (packages/alchemy) | default |
| 3 | core integration | `test/*.test.ts test/Bundle test/Cli test/Local test/Runtime test/Util test/Website` | 8 |
| 4 | building blocks | `test/Docker test/Redis test/Kubernetes test/SQL test/Drizzle test/Domain test/Auth test/DNS test/ACME` | 8 |
| 5 | Git, GitHub, Axiom, Stripe | one step each | 8 |
| 6 | Turso, Neon, Planetscale, Prisma | one step each | 8 |
| 7 | Hetzner, Railway, Fly | one step each | 8 |
| 8 | GCP | `test/GCP` | 16 |
| 9 | AWS | `test/AWS` | 32 |
| 10 | examples | `pnpm test:examples --profile testing` | — |

Every new top-level directory under `packages/integration-tests/test` gets a
step. If one is missing from this table, add it to steps 5–7 by size, and fix
this skill in the release PR. Never pass `--concurrency unbounded` or go
over 32. Never run a sequential monster file unfiltered in a fix iteration
(e.g. `Fly/BlueGreen.test.ts`). Its confirming run is the step's run.

## 3. One step

1. **Clean slate.** Run `pnpm nuke --yes --profile testing` and wait for it
   to finish. Then save `pnpm nuke --dry-run --profile testing` to
   `/tmp/release/census-<step>-before.txt`. What's left is residue
   (`scripts/nuke.sh` excludes). A holdout that survives two nukes is a stuck
   delete in that provider. Fix it in this step.
2. **Run** the step in the background, with the output written to a file:
   ```sh
   source /tmp/release/env.sh
   pnpm test:integration <paths> --profile testing --concurrency <n> \
     > /tmp/release/<step>-run-<k>.out 2>&1
   ```
   Wait on it with `t3_background_wait`. Start triage as soon as failures
   stream in (`grep -E "\] ✗ |failed to run|^Tests:"`). A test running far
   past its timeout is a hang. Read its log under `.alchemy/log/test/` and fix
   the cause.
3. **Census.** Once the run has finished, save `pnpm nuke --dry-run --profile
   testing` to `census-<step>-after.txt` and diff it against `-before`. Every
   new line is a leak, even from a green test. Leave leaks live while you fix
   them, since they're your evidence.
4. **Fix**, using the buckets and root-cause priority in
   [prepare-release §4](../prepare-release/SKILL.md#4-triage):
   provider bug > distilled patch > test fix. Never paper over a leak or an
   untyped error in a test. Re-run only the failing files, with `-t` when a
   file is long, until each one passes. A failure that also fails on `main`
   is still yours to fix.
5. **Budget.** Give a failure three fix iterations. If the blocker is
   platform behavior (entitlement, slow async provisioning, beta API), gate it
   on the typed tag with the exact error, keep an ungated probe, and move on.
   If the blocker is the account (billing, token permissions, a retired
   service), mark the step `blocked` with the exact error and move on. Never
   enable billing or edit shared tokens.
6. **Confirm.** Nuke, then run the **whole step once more** and take another
   census. The step is `done` only when that single run is green and the
   census diff is empty. Record the HEAD sha in `Passed at`.
7. **Gate and push.** Run `pnpm exec tsrs -b` and `pnpm docs:check-jsdoc` if
   any props changed. Commit one commit per fix, scoped (`fix(aws/ec2): …`),
   then push the alchemy branch and any distilled/floci branch (§5).

## 4. Keep earlier steps valid

A later fix can break an earlier step. The release needs every step to pass
at the **final** head, not just at the head where it once passed. After each
step, check what has changed since each `done` step passed:

```sh
git diff --name-only <passed-at>..HEAD
```

Mark a step `stale` when that list touches `packages/alchemy/`,
`packages/alchemy-test/`, its own provider packages, a package its tests
deploy through (most suites deploy through `packages/cloudflare` for state),
or the distilled/floci pins. Before step 10, re-run every stale step (§3.1–6)
in order until none is left. When a fix only touches one provider's own
package, the other steps stay valid.

## 5. PRs, linked

There are at most three PRs: alchemy, distilled and floci. Open the alchemy PR as a **draft** at
the first fix commit, and push after every step, so a crash at 4am loses
nothing. Use
[prepare-release §9](../prepare-release/SKILL.md#9-prs) for the standalone
distilled/floci clones, titles and bodies. On top of that:

- alchemy's branch pins `submodules/distilled` / `submodules/floci` at the
  current heads of their PR branches, and pushes a bump each time those
  branches move.
- Link them both ways. Put `Requires alchemy-run/distilled#X` (and floci) in
  the alchemy body, and `Required by alchemy-run/alchemy#Y` in each upstream
  body. Write the merge order distilled → floci → alchemy into the alchemy
  body.
- `link_pull_request` every PR to this thread.
- Mark the PRs ready (`gh pr ready`) only at §6, once everything is `done`.

## 6. Finish

After step 10 is done and no step is stale, `git fetch origin main`. If
`main` has moved past `Base`, merge it, resolve any conflicts, run
`pnpm exec tsrs -b`, and apply §4 to the merged changes. Re-run every step it
marks stale, and step 10 if any step re-ran. Repeat until a fetch finds
nothing new. The PR must be mergeable at a head that already contains the
latest `main`. Then nuke one last time and take a final census. It must show residue only. Then, and only then, end the
turn with the report:

```md
### Release ready at <sha> after one overnight pass. I recommend merging, in this order:

1. distilled — <what it types> — https://github.com/alchemy-run/distilled/pull/X
2. floci — <what it fixes> — https://github.com/alchemy-run/floci/pull/Z
3. alchemy — <K> fixes, <G> gated tests — https://github.com/alchemy-run/alchemy/pull/Y

| Step | Tests | Result | Passed at |
| ---- | ----- | ------ | --------- |
| Cloudflare | 1577 | ✅ | a1b2c3d |
| AWS | 3361 | ✅ 3349 · 12 gated | f00ba47 |
| examples | 38 | ✅ | f00ba47 |

Gated: <test → typed tag + exact error>.
Blocked (account): <step → exact error>.
Decisions taken overnight: <ones you'd have asked about>.
Census: clean except <documented residue>.
```

After each upstream PR merges, the submodule has to be repointed at its
`main` merge commit and the steps that commit invalidates have to be re-run.
Say so in the report rather than claiming the release is final. Say plainly
what didn't run (out-of-scope steps, opt-in tags, blocked steps). Don't report
CI status in place of these results.

## Pitfalls

Everything in
[prepare-release's pitfalls](../prepare-release/SKILL.md#pitfalls-seen-in-practice)
applies here. In addition:

- **The SSO session expires overnight.** An AWS step failing in ~100ms at
  setup means the token is gone. Run `aws sso login` again. If that needs a
  human, mark the step `blocked` and go on to the non-AWS steps, then come
  back to it.
- **Never overlap nuke with a run**, and never start a step's run before its
  nuke has finished.
- **Steps share one account.** A leak from step 4 shows up in step 5's census
  unless step 4's confirming census was clean. Don't move on with a dirty
  census.
