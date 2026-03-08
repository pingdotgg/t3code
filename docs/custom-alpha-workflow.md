# Custom Alpha Workflow

This document is the maintainer playbook for keeping a fast local alpha build of T3 Code while still tracking:

- your fork: `aaditagrawal/t3code`
- upstream OSS repo: `pingdotgg/t3code`
- selected open PRs that have not merged yet

It is written so future agents can follow one consistent workflow.

## Goals

- Keep one always-runnable local alpha branch.
- Pull upstream `main` updates quickly.
- Pull selected PR updates without merging stale stacked branches blindly.
- Use the same validation path that upstream CI uses, with a smaller fast loop for day-to-day feature work.

## Required Gates

Before considering a feature or PR integration complete in this repo:

```bash
bun lint
bun typecheck
```

Project rule:

- Never run `bun test`.
- Always use `bun run test`.

## Validation Matrix

Use this matrix for every feature addition or PR transplant.

### Fast loop for most changes

```bash
bun lint
bun typecheck
```

### When runtime, orchestration, provider, or persistence code changes

Run the required gates plus targeted tests for the touched area:

```bash
bun run test -- --run apps/server/integration/orchestrationEngine.integration.test.ts
```

Adjust the test target to the files you touched. Prefer targeted runs over the full suite while iterating.

### When web UI, session UX, or browser-facing behavior changes

Run:

```bash
bun lint
bun typecheck
bun run test -- --run apps/web/src
bun run --cwd apps/web test:browser
```

If the targeted `apps/web/src` run is too broad, narrow it to the specific spec file(s).

### When desktop packaging, preload, or cross-app wiring changes

Run:

```bash
bun lint
bun typecheck
bun run build:desktop
```

### Before pushing a branch you expect to behave like upstream CI

Upstream CI currently checks:

```bash
bun install --frozen-lockfile
bun run lint
bun run typecheck
bun run test
bun run --cwd apps/web test:browser
bun run build:desktop
```

That mirrors [ci.yml](/Users/mav/Documents/Projects/Experiments/vibes/t3code/.github/workflows/ci.yml).

## Recommended Remote Layout

Use:

- `origin` for your fork: `aaditagrawal/t3code`
- `upstream` for OSS source: `pingdotgg/t3code`

If this clone currently points `origin` at upstream, rewire it once:

```bash
git remote rename origin upstream
git remote add origin https://github.com/aaditagrawal/t3code.git
git fetch origin
git fetch upstream
```

Verify:

```bash
git remote -v
```

## Branch Model

Keep these branch roles stable:

- `main`: clean mirror of `upstream/main`
- `codex/alpha`: long-lived integration branch for your custom local app
- `codex/pr-<number>-track`: one local tracking branch per upstream PR you want to follow

Do not do active feature work directly on `main`.

## Worktree Layout

To keep the alpha build always available locally, use a separate worktree:

```bash
git worktree add ../t3code-alpha codex/alpha
```

Recommended usage:

- original repo directory: maintenance, fetch, branch surgery, PR tracking
- `../t3code-alpha`: day-to-day local running and manual QA

That keeps your alpha branch runnable even while another agent is rebasing or comparing branches in the main clone.

## Daily Upstream Sync

Update your upstream mirror first:

```bash
git checkout main
git fetch upstream
git merge --ff-only upstream/main
```

Then refresh the alpha branch:

```bash
git checkout codex/alpha
git rebase main
```

If you prefer fewer rewrite operations on a shared local branch, use:

```bash
git checkout codex/alpha
git merge --no-ff main
```

Default recommendation:

- use `rebase` if the branch is mostly local and private
- use `merge` if several agents or machines are already sharing the branch tip

## PR Tracking Method

Never merge an old open PR branch directly into `codex/alpha` without comparing it to current `main`.

Instead:

### 1. Fetch the PR into a dedicated tracking branch

Example for PR `178`:

```bash
git fetch upstream pull/178/head:refs/heads/codex/pr-178-track
```

### 2. Compare current `main` against the PR branch

Use cherry-pick-aware history comparison:

```bash
git log --left-right --cherry-pick --oneline main...codex/pr-178-track
```

If the PR was stacked on older work, most of its commits may already exist on `main` in equivalent form.

### 3. Review the still-unique commits

```bash
git show --stat <commit>
```

### 4. Replay only the unique tail onto `codex/alpha`

```bash
git checkout codex/alpha
git cherry-pick <commit-a> <commit-b> <commit-c>
```

### 5. Add a local compatibility fix commit if current `main` moved

Keep that fix separate from the transplanted PR commits so future rebases are easier to reason about.

### 6. Run the validation matrix

At minimum:

```bash
bun lint
bun typecheck
```

Then run the area-specific tests/build steps from this document.

## Feature Addition Method For Agents

For any new feature added on top of `codex/alpha`, agents should use this order:

1. Start from `codex/alpha`, not `main`.
2. Make the change in a focused branch if the work is non-trivial.
3. Run `bun lint` and `bun typecheck`.
4. Run targeted tests for the touched surface.
5. If the change touches packaging or runtime wiring, run `bun run build:desktop`.
6. Merge or rebase the feature branch back into `codex/alpha`.

## Integration Notes Convention

For each tracked PR, keep a short note in your branch history or commit message that says:

- which PR it came from
- whether it was cherry-picked whole or partially transplanted
- what local compatibility fix was required

This matters because many upstream PRs in this repo are stacked and will drift as upstream moves.

## Current Reality Check

As of this workflow being written:

- upstream PR integration should be treated as transplant work, not naive merge work
- build confidence should come from `lint`, `typecheck`, targeted tests, and `build:desktop`
- the local alpha branch is the branch to optimize for usability, not strict branch purity

## Default Commands

Bootstrap:

```bash
bun install
```

Run app locally:

```bash
bun run dev
```

Run desktop locally:

```bash
bun run dev:desktop
```

## Non-Negotiables

- Keep `main` clean.
- Keep `codex/alpha` runnable.
- Track PRs in separate branches.
- Cherry-pick unique commits instead of blindly merging stale stacks.
- Run `bun lint` and `bun typecheck` for every completed unit of work.
- Use `bun run test`, never `bun test`.
