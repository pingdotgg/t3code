# Per-PR audit procedure

Shared by the `audit` and `pr-queue` skills. Each skill builds its own list of
PRs in §1 (`audit`: the PRs the user names; `pr-queue`: a searched,
ranked shortlist) and then works through that list here, one PR at a time:
fix it, push it, and ask the user to merge or close it. The user merges; you
never do. "The list" below means whichever list the skill built.

If the audit finds a problem shared across the list (e.g. an existing suite
full of fakes), propose fixing that first in its own PR off main, then work
through the list. When the user asks, sweep main into every listed PR before
the one-by-one pass.

## 2. Check out and merge main

Start from a clean tree (`git status`). Never `git stash` — the stash stack is
shared with other worktrees and sessions.

```sh
gh pr view <n> --json headRepositoryOwner,headRepository,headRefName,baseRefName,maintainerCanModify,body,files,commits
gh pr checkout <n>
git fetch origin main && git merge origin/main
git submodule update --init -- submodules/distilled   # checkout moved it to the PR's old pin
```

After every checkout/merge, check `git status` for hook fallout: a
rewritten `pnpm-lock.yaml` (restore main's unless the PR changes deps), a
stray untracked `distilled/` git worktree at the root (`git worktree remove`),
regenerated example files (e.g. the Prisma fixture's `generated/`). Never
commit any of it.

- Fork head repos can be named differently from upstream; read
  `headRepository`/`headRepositoryOwner` before pushing.
- Resolve conflicts by intent. Main wins on code it has since refactored; port
  the PR's change onto the new shape. Many conflicts are formatting-only (main
  moved to oxfmt) — check whether main made a real change, keep the PR's logic,
  reformat.
- **A clean textual merge can still be wrong.** Read main's intervening
  changes to the files the PR rewrites and check them semantically (a
  dropped argument can silently disable behavior). Port the PR's tests into
  main's restructured test file and keep main's timeouts.
- **A PR far behind main may no longer test anything** — main may have fixed
  half the bug or changed the code path. Re-check after merging.
- **Stacks:** merge main into the base PR first and push, then merge the base
  branch into the child. After the base squash-merges, retarget the child to
  `main`; resolve its conflicts by confirming main's file equals the base's
  final version.
- After each merge, other listed PRs touching the same files (`Providers.ts`,
  barrel `index.ts`) may conflict — re-merge main when you pick them up.
- A fresh worktree needs `git submodule update --init` and `pnpm install`
  before anything runs.

## 3. Review the code

Read the full diff against `origin/main` and apply AGENTS.md. The standards:

- **There is a regression test.** No test changes → add one, preferably by
  extending an existing test.
- **Tests live in the existing suite** for the resource (e.g.
  `Worker.test.ts`), or extend an existing deployed fixture with a new route.
  A new one-off test file — especially one with mocks — fails the audit. Move
  pure-helper cases into the canonical unit file and delete the one-off.
- **Tests are end-to-end.** Only `test.provider` with
  `stack.deploy`/`stack.destroy`, or `beforeAll(deploy(Stack))` fixtures. No
  mocked HTTP/SDK/CLI responses, fake layers, direct lifecycle calls, or
  fake-cloud engine tests. Cause drift for real through the cloud API (e.g.
  a point-in-time restore swapped into place), then redeploy and verify. Use
  real local infrastructure where it helps (a `registry:2` container, a kind
  cluster, Docker Postgres + `cloudflared`). Assume Docker is installed:
  never `skipIf` on Docker availability; a missing daemon fails the test.
  A spy that wraps the real service is fine; a fake is not.
- **Also audit the existing tests the PR touches.** If a suite already fakes
  what it claims to test, say so plainly — don't mention it in passing.
- **Pure utilities are the exception:** one shared implementation in
  `src/` with a broad unit suite over in-memory fixtures is welcome. Where a
  real tool defines the behavior (git, docker), check the cases against it.
- **The test covers what a reviewer would worry about** (e.g. a worker with
  the database bound, when the change is about replacing that database).
- **Tests never modify checked-in files.** Copy fixtures into the gitignored
  `packages/alchemy/.tmp` and edit the copy (import `alchemy/...` there; `@/`
  doesn't resolve from `.tmp`).
- **Per-user isolation:** no hard-coded account- or zone-unique physical
  names. Use engine-generated names, or derive them from `stack.stage`.
- Reconciler doctrine, Typed Error Doctrine (tagged errors, never
  `Effect.fail(new Error(...))` or catching catch-alls by status), no
  `Effect.orDie` in lifecycle ops, no raw Promise/`node:fs`.
- **Environment through `effect/Config`.** Inside Effect code, read env vars
  with `Config.String(...)` (`Config.withDefault`/`Config.option` when
  optional), never `process.env` — wrapping `process.env` in `Effect.sync`
  is not enough. `Effect.sync` is for facts `Config` can't express
  (`process.platform`, `process.cwd()`). Module-scope test gates
  (`skipIf(!!process.env.FAST)`) are exempt. Fix violations in the PR's
  diff, including ones the contributor wrote.

**Design review — answer these in the report before the user has to ask:**
does a change replace a resource, and can that lose data (a database bound to
a worker)? Are names spelled out rather than abbreviated
(`CertificateTransparencyAlerting`, not `CtAlerting`)? What are the defaults?
Does it slow the happy path? Are values assumed resolved that could be
`Output`s? Does it put things in the right namespace? Does it follow the
library's design rules, or is it really user error? Surface product decisions
(e.g. a change in how resources are named per stage) with their migration cost
rather than making them silently.

Fix what's fixable yourself — rewrite a contributor's mocked test into the
right shape, and fix the problems you flag rather than only listing them. Keep
the PR to its scope; out-of-scope gaps become follow-ups.

**Distilled:** before adding a patch, find the root cause upstream — the
vendor may have changed the schema on purpose. A new typed error goes in its
own distilled PR; once merged, point the submodule at the distilled `main`
commit, never a side branch. A distilled bump with breaking fallout gets its
own alchemy PR (`fix(...)` if it repairs something); trim the contributor's PR
back to its own files. Unexplained cross-provider diffs in a PR confuse the
user — remove them or explain them.

**Bugs on main** found while testing get their own PR, merged first.

**Close or park:**
- Recommend closing when superseded on main, a duplicate, or the wrong
  approach. Cite what supersedes it. For overlapping PRs, run the weaker PR's
  tests against the stronger PR's code, and credit the closed author.
- If a closed PR has one good unrelated part, suggest the author narrow it.
- If a bug can't be reproduced, ask the author for a repro, park it, move on.
  Treat upvotes as a reason to ask rather than close.
- Parked PRs wait for an external update; don't keep reporting "nothing
  changed" on them.

## 4. Update JSDoc

Every changed or new prop/attribute has field-level JSDoc (`@default` where
relevant), and the resource-level JSDoc has `###` sections with
`**Example:**` snippets for the new behavior, metadata tags last. Run
`pnpm docs:check-jsdoc`, and `pnpm docs:gen` to check generation. The
generated pages under `website/src/content/docs/providers/` are gitignored —
remove any a contributor committed.

## 5. Run the tests

- Run **every touched test file in full**, plus the suites covering the
  changed source — not just the new case via `-t`. Wide-impact changes get
  the broad suites (e.g. all of `test/Cloudflare/Workers`, plus
  `test:examples`). Dev-mode changes also need the `*.local.test.ts` suites.
- **Prove it fails on main.** Commit first, then put the `src/` files back to
  main's version (`git show origin/main:<path> > <path>`), run the new case,
  confirm it fails *for the right reason*, and restore from git (never from a
  `/tmp` backup — a crash loses it, and `git checkout <file>` discards
  uncommitted edits). A test that passes on main isn't testing the bug: an
  identical redeploy plans a no-op and never reaches `reconcile`, an unchanged
  fixture reuses a cached image, dev mode skips the code path. Check the logs
  or timing to confirm the path actually ran. `packages/frontend-frameworks`
  is consumed from `dist/`, so rebuild with `npx tsdown` around this check.
- Run with `pnpm test <file> --profile testing`. "0 files"
  or "0 tests" is an invocation bug (bad path, zsh word-splitting — use
  arrays or `xargs`), never a pass.
- Credentials: for Cloudflare live, `set -a; source .env; set +a`
  (`pnpm download:env` if missing). AWS live uses SSO; a ~100ms setup failure
  means an expired session — ask the user to run `aws sso login`. Never set or
  unset `CI` for tests: a profile-store migration can wipe `~/.alchemy`.
- Flaky failures: re-run the file alone, run it on main, then alternate. Report
  a verdict table: `Failure | Re-run alone | On main | Verdict`. Lower
  `--concurrency` (e.g. 8) for a clean signal on big suites. A flake you fix
  gets its own PR.
- Don't overlap two runs of the same stack: the second run's opening
  `stack.destroy()` tears down the first's resources.
- Runs against main and interrupted runs leak resources. Clean up (delete
  out-of-band resources before `stack.destroy()`) and verify out-of-band that
  nothing is left. `OwnedBySomeoneElse` on a named resource is a leftover
  from an earlier run — ask before deleting anything, offering a full
  `pnpm nuke` or deleting only that stack/stage's resources.
- After a crash: check for surviving test processes, files still swapped to
  main, leaked resources, and background agents' progress before rerunning.
- Long suites block the worktree. Advance the next PR in a separate worktree
  meanwhile. A large refactor can go to a background agent in its own
  worktree with "commit, don't push"; review its result before pushing.
- Before pushing, run the CI Check steps your change can break:
  `pnpm exec tsrs -b`, `pnpm lint`, `pnpm format:check`,
  `pnpm docs:check-jsdoc` and `pnpm exports:check`. They're in
  `.github/workflows/check.yml`. A new test file or fixture is type-checked
  too.

## 6. Push and update the PR

- **Push every change as soon as it's made** — the user reviews GitHub, not
  your local branch.
- Before each push: `git fetch` and merge any new commits from the author;
  check `git diff --stat origin/main...HEAD` for unrelated files the
  repo-wide pre-commit formatter swept in, and revert them. Run
  `pnpm exec oxfmt --check` on every file the PR changes and read the whole
  output.
- **Leave every PR with CI passing.** After each push, wait for every check
  on the new head to finish (`gh pr checks <n>`). When one fails, read its log
  (`gh run view <id> --log-failed`), fix the cause, push, and wait again.
  Don't end your turn while a local suite is still running: wait on it with
  `t3_background_wait`, since ending the turn is your report. To wait on CI,
  `watch_pull_request` the PR after the push and end the turn; you're woken
  when its checks finish. Ask to merge only once they pass, then
  `unwatch_pull_request`.
- Make sure CI actually runs. First-time contributors' runs sit at
  `action_required` and pushes don't start them. Read the whole diff first:
  approve the runs (`gh run approve <id>`) only when it doesn't touch
  `.github/`, scripts CI executes, or anything that reads secrets or sends
  data out. Otherwise ask the user. Don't approve runs on parked PRs. If no
  checks appear at all, find out why (a draft, a push that didn't trigger
  `pull_request`) and get them started.
- "Ready" means: tests pass locally, every CI check on the final head has
  passed, not a draft, mergeable. A pending, failing or empty check list is
  not ready. Then `gh pr ready <n>`.

**Rewrite the description to show the developer experience** — every PR you
touch, even when the author's body looks fine. Explain the change through the
code a user writes, not through prose or bullet points about the
implementation. Contributor bodies usually arrive as Change/Tests/Checks
bullet lists; replace them rather than appending to them.

- one plain sentence on what changes and why, no heading above it
- then `ts` snippets of the user's code that is new or now works — the props,
  values and variants they can now write. For a fix or a changed API, a
  before/after `diff` of the user's code
- check every API signature in a snippet against the source
- prose only for the "why" a snippet can't show, one or two sentences
- no `#`/`##` headings, bullet dumps, Change/Tests/Checks sections or test
  plans
- end with the attribution line your harness asks for, if any

Bad — describes the implementation:

```md
## Changes
- Added `retention` prop to `LogGroup`
- Updated reconcile to call `putRetentionPolicy` when retention changes
- Added tests
```

Good — shows the user's code:

````md
`LogGroup` now takes a retention period, so logs stop growing forever.

```ts
const logs = yield* AWS.Logs.LogGroup("Logs", {
  retention: "30 days", // or "forever"
});
```

Changing `retention` updates the group in place; it no longer replaces it.
````

Write it to a file:

```sh
gh pr edit <n> --body-file /tmp/pr-<n>.md
# gh pr edit can fail on the deprecated Projects (classic) API — use REST:
gh api -X PATCH repos/alchemy-run/alchemy/pulls/<n> -F body=@/tmp/pr-<n>.md
gh api -X PATCH repos/alchemy-run/alchemy/pulls/<n> -f base=main   # retarget
```

**Comments posted on GitHub must stand alone** — no references to this
conversation. State what's allowed, what was fixed, and why the rule exists,
with a code example.

If the T3 `link_pull_request` tool is available, link every PR you touch or
open to this thread.

## 7. Report and ask

Keep it short — longer explanations only when asked. End the turn after each
PR with:

```md
### #N: <behavior>. I recommend merging.

<Why: the bug or gap, with the error text if there is one.>
<The fix, often a short diff.>
<What I changed on top of the author's work.>

| Test | Code | Result |
| --- | --- | --- |
| test/AWS/RDS/DBInstance.test.ts (full, live) | PR | ✅ 6/6 |
| … "refresh after restore" | main (expected to fail) | ❌ fails as expected: <error> |

Not run: <suites and why>.
<Design-review answers, decisions for you, follow-ups.>
Next in the list: #M (omit when it was the only one).

https://github.com/alchemy-run/alchemy/pull/N
```

- Say which tests ran and whether they passed. Every CI check must have
  passed on the head you report before you call it "ready", but CI status
  doesn't replace the test report.
- Label deliberate runs against main as expected failures.
- Say plainly what was **not** run.
- When fixes span several PRs, say which PR holds each fix and give the merge
  order as a numbered list with one URL per line, closes included.
- When a decision is the user's, give numbered options with a recommendation.
- **The last line of every message about a PR is its full URL** — progress
  notes and questions included. Several PRs → all URLs at the end.

## 8. Keep the list moving

- Don't wait idle on a merge: start the next PR and keep the pending link in
  each message.
- On "merged, next": check it really merged (`gh pr view <n> --json state` —
  the user sometimes names the wrong number), re-merge the new main into the
  next PR, then continue.
- On "merge", "close", "park", "skip": update the table and act. Close only on
  explicit instruction, with a standalone comment crediting the author and
  naming what supersedes it.
- Answer "why" or "justify" questions directly with the error text and a diff
  snippet. "Refresh my memory" gets the status table plus open items.
