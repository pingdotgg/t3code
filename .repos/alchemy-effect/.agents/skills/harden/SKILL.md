---
name: harden
description: Harden one or more providers' live test suites until they are stable — repeat full suite runs with a leak census after each, root-cause every failure and leak (provider bug first, then distilled patch, then test, timeouts last), make every name and stage deterministic and isolated per user and worktree, and stop only when consecutive runs are green and clean. Use for "harden cloudflare", "harden the aws provider", "/harden gcp neon", "make the X suite stable", "do a few more runs to see how stable it is", or as the per-provider loop inside prepare-release.
metadata:
  internal: true
---

# Harden a provider's test suite

A suite is hardened when it passes **two consecutive full runs** and the
account census after each run shows nothing left behind. One green run proves
little: most of what this skill finds only shows up in some runs — eventual
consistency, retries that leak, other users or worktrees deploying the same
names, an API that sometimes ignores a write.

The arguments name the providers (`cloudflare`, `aws gcp`, …). You own the
runs, the fixes, the census and the commits. Work in this checkout, one test
process at a time. Fixes land in the branch you are on (the release PR when
prepare-release invoked you). The user merges; you never do.

## The loop

1. **Run the provider's full suite once.** Detach it and write its output to
   a numbered file, then census:

   ```sh
   pnpm test:integration test/<Provider> --profile testing > /tmp/harden/run-N.out 2>&1
   pnpm nuke --profile testing --include '<Provider>.*' --dry-run --no-input > /tmp/harden/census-N.out
   echo "run N: $(grep '^Tests:' /tmp/harden/run-N.out)" >> /tmp/harden/stability.log
   ```

   Keep `stability.log` as the table you report: one line per run, plus what
   the census found.

2. **List the failures and leaks.** Failed tests are the `^✗ ` lines in the
   summary. Each one's error follows it in the run output; the full record,
   including retried attempts, is in the run log under
   `packages/integration-tests/.alchemy/log/test/`.

3. **Root-cause every one.** In this order, stop at the first that applies:

   | Cause | Fix |
   | --- | --- |
   | Provider bug (wrong read/diff/reconcile/delete, leak, name the API rejects) | the provider |
   | Untyped or mis-typed error | a distilled patch |
   | Test bug (shared name or stage, missing lock, unbounded or missing retry) | the test |
   | Eventual consistency the provider can't own | a bounded retry in the test |
   | Genuinely slow work (image builds, cold starts) | a longer timeout, matching its neighbors |
   | Permanent account blocker (quota, entitlement) | `test.provider.skip` with a comment quoting the exact error |
   | Platform outage (every test of a service fails at once with a 5xx-style error) | nothing; note it |

   A longer timeout is the last resort, and only for work that is slow by
   nature. A test that fails because a call raced the cloud is not slow.

   **Never widen a permission to make a test pass.** An IAM `Resource: ["*"]`,
   a dropped `Condition`, a broader Cloudflare permission group or GCP role is
   a security regression, not a fix. When a cloud's own check rejects a scoped
   grant (Lambda checks a Kafka event source's ENI-delete permission with no
   subnet in the request), find the scoping that passes the check and still
   limits real calls: `ArnEqualsIfExists` / `StringEqualsIfExists` skip a key
   the check leaves out and enforce it on every real request. Assert the
   scoping out of band (`iam.simulatePrincipalPolicy`: allowed inside the
   scope, denied outside it).

4. **Verify each fix by rerunning the affected files, not the whole suite.**
   Rerun them several times when the failure was intermittent:

   ```sh
   for i in 1 2 3 4 5; do pnpm test:integration <files> --profile testing 2>&1 | grep -E "^✗ |^Tests:"; done
   ```

5. **Type-check, commit and push** each fix as its own conventional commit
   (`fix(cloudflare): …`, `test(cloudflare/queues): …`).

6. **Clean up leaks you've root-caused** with a scoped nuke once no suite is
   running, then start the next full run. Stop after two consecutive runs
   with zero failures and a clean census. If a failure stays intermittent
   after three fix attempts, stop fixing it and report it with its evidence.

## Isolation: names, stages, locks

A test may only collide with itself. Most intermittent failures in a shared
account came from two runs — another user, another worktree, or the same
suite's retry — touching the same cloud object.

- **Names.** Let the resource generate the physical name. Only a test about
  explicitly provided names passes one, built with `testName(base)` from
  `packages/integration-tests/test/names.ts` (a short hash of the test stage),
  or derived from `stack.stage`. Hostnames in a test zone follow the same rule.
  Never `Date.now()`, UUIDs or random values in a name. A resource the API can
  never delete (RealtimeKit apps, Intel indicator feeds) keeps one shared
  constant name that every run adopts.
- **Stages.** A suite that sets its own stage (per-variant stages in
  `describe.each`, a `stage:` on `Test.make`) prefixes it with
  `Test.defaultStage()`. A linked git worktree defaults to
  `test_$USER_<worktree>`, so two worktrees running the same suite never share
  deployments; `--stage` overrides it.
- **Account-wide singletons.** Tests that contend for one account-level object
  (Cloudflare allows one event subscription per source per account; SES
  sending is account-wide) take the same `exclusive: "<label>"` in every file
  that touches it.
- **Content-addressed ids.** Some APIs return the same id when you upload the
  same content twice (Cloudflare mTLS certificates). Whatever a run attached to
  that id comes back on the next upload, so its delete must be complete before
  the parent is deleted.

## Patterns that were provider bugs

Each of these looked like a flaky test and was fixed in the provider:

- **Generated names longer than the API allows** (Cloudflare managed networks
  cap at 50, a DNS label at 63). Pass `maxLength` to `createPhysicalName`;
  short names that already worked don't change.
- **A listing that lags a fresh write.** A Worker's attached-domain list
  missed a domain attached seconds earlier, so the redirect rule for it was
  never cleaned up. Fall back to a direct lookup instead of trusting the list.
- **A write the API sometimes ignores.** Clearing a CA's hostname association
  occasionally didn't take. Re-send the write until a read shows it, and fail
  the delete with a typed error rather than continue and leak.
- **A cold read with an unresolved Output.** Treating an unresolved id as
  absent read a different singleton (the zone's managed CA) and reported a
  conflict. Return `undefined` until the id resolves.

## Investigating

- **Probe the API directly** with a throwaway test file (`ZZProbe.test.ts`
  next to the suite, using `test.provider` and distilled calls), run it alone,
  and delete it afterwards. Use it to settle a hypothesis ("does a re-upload
  reuse the id?") instead of guessing.
- **Provider `console.log` doesn't reach the run log.** Log with
  `yield* Effect.logInfo(...)` while debugging, and remove it after.
- **Before deleting a leftover, find its owner.** Check
  `ps -eo etime,command | grep alchemy-test` for other worktrees running
  suites against the same account; their live resources show up in your
  census. Leave them alone.
- **Never run `pnpm` inside `submodules/distilled`** (`pnpm exec oxfmt`,
  `pnpm exec tsrs`): it installs distilled's own workspace, a second `effect`
  copy every alchemy type then mismatches ("Property '[NodeInspectSymbol]' is
  missing"). Run every command from the repo root. If it happened, move
  `submodules/distilled/node_modules` and `submodules/distilled/packages/*/node_modules`
  aside, run `pnpm install` at the root, and type-check with
  `pnpm exec tsrs -b --force` — a plain `-b` keeps the stale build state.
- **Credentials expire mid-run.** A suite that also deploys to another cloud
  (Cloudflare bindings on an AWS Lambda) fails its teardown when that cloud's
  session expires, and leaks its resources. Refresh sessions (`aws sso login`)
  before each round, and rerun the file to clean up.
- **An error with an empty message hides the cause.** Give the tagged error a
  `message` getter naming what failed, so the next occurrence is diagnosable.

## Reporting

Report each round briefly: the run table, then one line per failure with its
cause, fix and verification. End with what is not fixed and why (outage,
account blocker, residual flake with evidence). Put fixes in the PR you are
on; report test results, not CI status.
