# Custom Alpha Workflow

This document is the maintainer playbook for keeping a fast local alpha build of T3 Code while still tracking:

- your fork: `aaditagrawal/t3code`
- upstream OSS repo: `pingdotgg/t3code`
- selected open PRs that have not merged yet

It is written so future agents can follow one consistent workflow.

## Configured Local Layout

This clone is intended to use:

- `origin` = `https://github.com/aaditagrawal/t3code.git`
- `upstream` = `https://github.com/pingdotgg/t3code`
- `main` as the downstream base branch kept close to `upstream/main`
- `codex/alpha` as the persistent custom integration branch
- `../t3code-alpha` as the dedicated alpha worktree

Agents should preserve this layout unless explicitly asked to change it.

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

### When macOS app icon behavior changes

Keep the fast loop the same by default:

```bash
bun lint
bun typecheck
bun run build:desktop
```

Only use the macOS 26 appearance-aware path when you intentionally add a real
`assets/prod/icon.icon` asset created in Apple Icon Composer. The repo is wired
so:

- if `assets/prod/icon.icon` exists, desktop packaging and local desktop launch
  compile it with `actool`
- if it does not exist, the repo stays on the current legacy `icon.icns` path

That keeps the normal build pipeline short and avoids adding extra work for
every feature branch.

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

- `main`: downstream base branch for your fork, rebased or merged forward from `upstream/main`
- `codex/alpha`: long-lived integration branch for your custom local app
- `codex/feat-<short-name>`: focused feature branches created from `codex/alpha`
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

## Repo-Local Git Defaults

These local git settings are recommended for this clone:

```bash
git config --local fetch.prune true
git config --local rerere.enabled true
git config --local remote.pushDefault origin
```

Why:

- `fetch.prune` keeps remote branch state tidy.
- `rerere.enabled` helps with repeated conflict resolution on long-lived PR transplants.
- `remote.pushDefault origin` avoids accidentally pushing to upstream.

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

## macOS 26 Icon Method

Use this only when you want the app icon to participate in Apple’s newer
appearance-aware rendering on macOS 26 and later.

### Source of truth

- Cross-platform source art stays in `assets/prod/logo.svg`
- Legacy macOS raster output stays in `assets/prod/black-macos-1024.png`
- Appearance-aware macOS source should live at `assets/prod/icon.icon`

### Authoring rules

- Create `assets/prod/icon.icon` in Apple Icon Composer, not by hand
- Put the `Default`, `Dark`, and `Mono` variants there
- Keep the center symbol and silhouette recognizable across all three variants
- Do not delete the legacy PNG/ICNS outputs; older tooling still uses them

### Validation rules

After changing icon assets:

```bash
bun lint
bun typecheck
bun run build:desktop
bun run start:desktop
```

Check the rebuilt app bundle in Finder and the Dock. If the Dock still shows a
stale icon, quit the running copy and relaunch the rebuilt app.

## Standard Feature Workflow

Use this for normal custom feature development:

### 1. Refresh the base

```bash
git checkout main
git fetch upstream
git merge --ff-only upstream/main
git checkout codex/alpha
git rebase main
```

### 2. Create a feature branch from alpha

```bash
git checkout -b codex/feat-<short-name> codex/alpha
```

### 3. Implement the feature

Keep changes focused. Prefer multiple small commits over one mixed commit.

### 4. Run validation

Always:

```bash
bun lint
bun typecheck
```

Then run the area-specific commands from the validation matrix.

### 5. Land the feature back into alpha

Preferred:

```bash
git checkout codex/alpha
git cherry-pick <feature-commit>...
```

If the feature branch is already clean and linear:

```bash
git checkout codex/alpha
git merge --ff-only codex/feat-<short-name>
```

### 6. Keep alpha runnable

After landing, verify the alpha worktree still starts:

```bash
cd ../t3code-alpha
bun run dev
```

Use `bun run dev:desktop` instead when the work touched desktop behavior.

## PR Tracking Method

Never merge an old open PR branch directly into `codex/alpha` without comparing it to current `main`.

Instead:

### Config file and refresh command

The tracked PR list lives in:

- `config/upstream-pr-tracks.json`

Refresh all tracked PR branches with:

```bash
bun run sync:upstream-prs
```

That command:

- fetches each tracked PR head from `upstream`
- updates the matching local `codex/pr-<number>-track` branch
- reports unique commits and diff stats versus `main`
- reports pending commits and diff stats versus `codex/alpha`

Current tracked PRs in this repo:

- `#179` Claude Code adapter
- `#295` GitHub Copilot adapter
- `#364` OpenCode adapter

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

Also useful:

```bash
git diff --stat main...codex/pr-178-track
git range-diff main...codex/pr-178-track
```

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

Commit message recommendation:

- `fix: adapt PR #178 integration to current upstream provider API`
- `fix: reconcile PR #XYZ web model picker with current alpha settings flow`

### 6. Run the validation matrix

At minimum:

```bash
bun lint
bun typecheck
```

Then run the area-specific tests/build steps from this document.

### 7. Record the outcome

For each imported PR, record in commit messages or handoff notes:

- PR number
- source branch or commit SHAs
- whether the import was full or partial
- what had to be reconciled against current upstream
- which validation commands were run

## Standard Upstream Merge Workflow

When upstream `main` moves and you want alpha caught up:

1. Update `main` with `git merge --ff-only upstream/main`.
2. Rebase `codex/alpha` onto `main` if the branch is private and linear.
3. Otherwise merge `main` into `codex/alpha`.
4. Run `bun lint` and `bun typecheck`.
5. Run targeted tests for any conflict-heavy areas that were touched during the rebase or merge.
6. If desktop/runtime wiring changed, run `bun run build:desktop`.

## Conflict Resolution Rules

When a PR or upstream sync conflicts:

- Prefer current `main` behavior where the same area has evolved significantly.
- Keep transplanted PR functionality only where it is still unique and intentional.
- Preserve existing repo conventions and current contract shapes instead of reviving stale APIs.
- Add local compatibility fixes as separate commits after the transplanted commits.
- Re-run the minimum gates immediately after conflict resolution.

Do not flatten multiple unrelated fixes into one resolution commit.

## Feature Addition Method For Agents

For any new feature added on top of `codex/alpha`, agents should use this order:

1. Start from `codex/alpha`, not `main`.
2. Make the change in a focused branch if the work is non-trivial.
3. Run `bun lint` and `bun typecheck`.
4. Run targeted tests for the touched surface.
5. If the change touches packaging or runtime wiring, run `bun run build:desktop`.
6. Merge or rebase the feature branch back into `codex/alpha`.

## Handoff Format For Future Agent Runs

When handing off work, include:

- active branch name
- whether work was done in the main clone or `../t3code-alpha`
- upstream sync status
- PRs currently being tracked
- exact validation commands already run
- remaining risks, if any

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
