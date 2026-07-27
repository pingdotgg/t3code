# AGENTS.md

## CRITICAL: This Repo Is SergeCode — a Permanent, Separate Fork

SergeCode (github.com/SergeSerb2/SergeCode) is a **permanent hard fork** of `pingdotgg/t3code`. It will **never** be re-merged upstream.

- **NEVER EVER open a PR against, merge into, push to, comment on, or otherwise touch `pingdotgg/t3code`.** Not for any reason.
- All PRs, issues, and pushes go to `SergeSerb2/SergeCode` only. Always pass `--repo SergeSerb2/SergeCode` explicitly to `gh` commands.
- Do not add a git remote pointing at `pingdotgg/t3code`. If one exists, treat it as an error and remove it. `scripts/setup-worktree.sh` refuses to run when it finds one, so a worktree that bootstrapped cleanly has already passed this check.
- Before creating any PR, verify the base repository is `SergeSerb2/SergeCode`.

## Working in a Fresh Worktree

Each thread gets its own git worktree, which starts with no `node_modules`.
`scripts/setup-worktree.sh` installs dependencies, links `.env.local` from the
main checkout, and fails fast if a remote points at the upstream repo.
`.vite-hooks/post-checkout` runs it automatically when git creates the
worktree, so normally there is nothing to do. The install is bounded by
`SERGECODE_SETUP_TIMEOUT_SECONDS` (300s), so a wedged pnpm reports itself
instead of stalling worktree creation.

If a command fails with `vp: command not found`,
`Could not resolve 'vite-plus/test/config'`, or `Cannot find module`, that is
the missing install and not your change. Run `pnpm run setup` and retry —
do not start debugging the error itself.

### Never run `git stash`

Every worktree shares one stash stack with every other worktree and with the
main checkout. A stash you push here can be popped by a different agent
working somewhere else, and the work is then gone from both. 24 threads in the
archive used it and at least one lost work to it.

If you need a clean tree, commit to your branch instead — a commit is
recoverable and private to your branch. If you have already stashed and lost
something, `git fsck --unreachable` plus `git stash store <sha>` can recover
it.

### `--no-verify` is not the escape hatch for a failing hook

120 commits across 45 threads used `git commit --no-verify`, after which
nothing in this repo is formatted or linted locally.

An unbootstrapped worktree is no longer a reason to skip it: the pre-commit
hook bootstraps the worktree itself and then runs the real check. If it does
fail, the bootstrap failed for a reason worth reading — fix that and commit
again. If a hook genuinely must be skipped, `VITE_GIT_HOOKS=0 git commit …` is
the supported way (`.vite-hooks/_/h` honours it), and run `vp fmt` before
opening the PR.

### A push that fails on credentials is not a missing login

`could not read Username for 'https://github.com'`, `Permission denied
(publickey)`, and `You are not logged into any GitHub hosts` show up when the
provider CLI runs with a redirected `HOME` that has no git or gh credentials —
not because nobody is logged in. Do not run `gh auth login`; it will not fix
it and it can disturb the real login. Report the failure and hand the push
back to the user. 22 threads reached the end of their work and stranded there,
most of them never shipping a PR.

### Start from current `main`

Worktrees are created from whatever `main` pointed at when the thread started,
and long threads drift. Before you begin substantial work, and again before
opening the PR, run `git fetch origin && git merge origin/main` (or rebase).
34 threads in the archive needed a user-prompted "fix the merge conflicts"
turn, and one bad resolution clobbered `main`.

### Finish the job

A task is not done at the commit. Unless the user said otherwise, push the
branch and open the PR against `SergeSerb2/SergeCode` in the same turn —
17 threads stopped after committing and had to be told "push + pr please".

## Task Completion Requirements

### Verify the change, not the monorepo

`pnpm run verify` runs only the checks your diff can possibly have broken: it
resolves changed files to workspace packages, then runs `vp check` on those
files, `vp run --filter ...<pkg> typecheck` on those packages and their
dependents, `vp test related` on the tests that import the changed sources,
and the Swift suite only when `apps/mac` changed. Use it as the loop you run
while working.

- `pnpm run verify` — the changed slice. Seconds, not minutes.
- `pnpm run verify --all` — the full gate. Run it once, before opening the PR.
- `pnpm run verify --dry-run` — show the plan without running it.
- A single file is always cheapest to check directly:
  `vp test run path/to/file.test.ts`.

`vp check` and `vp run typecheck` must pass before a task is complete, and
`vp run lint:mobile` must also pass when native mobile code changed —
`pnpm run verify --all` covers all three. Use `vp test` for the built-in
Vite+ test command and `vp run test` when you specifically need the `test`
package script.

"Pass" means exit code 0. `vp check` reports a standing baseline of ~22 lint
warnings that predate your change; they are not errors and not yours. Compare
the error count, not the warning count.

### Do not re-run a check that cannot have changed

Across the archived threads, 63% of all build/test/check runs happened with no
file edit since the previous run. Re-running is not free: the full TypeScript
suite is 411 files, and the Swift suite relinks before it runs.

- Never re-run a suite to "confirm" a result you already have. If nothing was
  edited, the answer is the same.
- `swift test` builds first. Do not run `swift build` before it.
- Re-read the output you already captured instead of re-running the command to
  see it again.

### macOS app

Use `pnpm run test:mac` (`apps/mac/scripts/swift-test.sh`). A bare
`swift test --package-path apps/mac` fails on a Command Line Tools toolchain —
missing `TestingMacros` plugin, then missing `lib_TestingInterop.dylib`, then
missing `Sparkle.framework` — and the flags that fix it differ between
Command Line Tools and Xcode. The wrapper resolves them from the active
toolchain and applies `--no-parallel`.

It forwards arguments, so `pnpm run test:mac --filter SidebarPresentationTests`
narrows the run — but do not expect much from that. Roughly 90% of a Swift
test run is compilation and ~10% is execution (509 tests run in 9.8s inside a
44s invocation), so `--filter` mostly buys you shorter output, not a shorter
wait. The way to make Swift work cheaper is to run it less often, not to
narrow it.

## macOS App Versioning and Release Policy

Releases are automated but opt-in: **merging a PR into `main` only triggers
the `Release macOS App` workflow when that PR carries a release label** —
either `release` (ships a default patch bump) or any `release:patch` /
`release:minor` / `release:major` qualifier, which is sufficient on its own
and picks the bump size (`release:patch` for bug fixes, `release:minor` for
features or larger PRs, `release:major` for big releases; `release:major`
wins if several are present). Plain merges never ship an update. When
triggered, the workflow bumps the version and `buildNumber` in
`apps/mac/version.json`, builds and signs the app, publishes a GitHub
Release, and commits the updated Sparkle appcast back to `main`. Installed
apps then see the update via Sparkle. Bot commits pushed by the workflow
carry `[skip release]` in their message — never remove that marker from
automation commits, and never cherry-pick a bot commit without keeping the
marker.

Before _manually_ changing `apps/mac/version.json`, tagging a release,
generating an appcast entry, or running the macOS release workflow by hand,
every agent MUST ask the user this question and wait for the answer:

> Should this work create a new app version/release, or should it be added to
> the current rolling/pending version number?

Do not infer the answer from the size of the change, the PR title, or the
current branch. Note that merging a PR labeled `release` to `main` produces
an automatic version bump — this question is about _manual_ version-line
changes (major/minor/patch) and manual release actions.

- **Rolling/pending version:** keep both `version` and `buildNumber` in
  `apps/mac/version.json` unchanged in the PR. The automation bumps the
  version on merge when the PR carries a release label (patch by default;
  `release:minor` or `release:major` selects a bigger bump).
- **New version/release (manual semver bump):** get the user's desired semver
  bump (major, minor, patch, or prerelease), increment `buildNumber`
  monotonically, and update `apps/mac/version.json` in a PR targeting `main`.
- `apps/mac/version.json` is the source of truth. Run
  `apps/mac/scripts/sync-version.sh` when the bundle metadata needs syncing:
  `version` maps to `CFBundleShortVersionString` and `buildNumber` maps to
  `CFBundleVersion`.
- Sparkle uses the numeric build number for update ordering
  (`CFBundleVersion`/`sparkle:version`) and the semver string for display
  (`CFBundleShortVersionString`/`sparkle:shortVersionString`).
- Never create or push a release tag, publish a GitHub Release, or run
  `Release macOS App` manually until the version decision is explicit and the
  version change is merged into `main`. Manual `workflow_dispatch` runs
  require the version input to match `version.json` exactly.
- `apps/mac/scripts/version-bump.sh` currently commits and tags immediately.
  Do not run it in normal PR work unless the user explicitly requests that
  local commit/tag behavior; edit `version.json` on the release branch
  instead. `apps/mac/scripts/compute-version.sh` is the shared compute-only
  bump logic used by both `version-bump.sh` and the release workflow.
- Every version/release PR must target `SergeSerb2/SergeCode` with base
  `main`, and must satisfy the repository validation requirements above.

## Project Snapshot

SergeCode is a native Apple client for coding agents such as Codex and Claude. It is an independent hard fork of T3 Code that evolves on its own.

This repository is a VERY EARLY WIP. Proposing sweeping changes that improve long-term maintainability is encouraged.

## Core Priorities

1. Performance first.
2. Reliability first.
3. Keep behavior predictable under load and during failures (session restarts, reconnects, partial streams).

If a tradeoff is required, choose correctness and robustness over short-term convenience.

## Maintainability

Long term maintainability is a core priority. If you add new functionality, first check if there is shared logic that can be extracted to a separate module. Duplicate logic across multiple files is a code smell and should be avoided. Don't be afraid to change existing code. Don't take shortcuts by just adding local logic to solve a problem.

## Package Roles

- `apps/mac`: Native SwiftUI macOS app. Supervises the local server sidecar and owns the desktop UI.
- `apps/mobile`: Expo/React Native iPhone companion. Connects to a SergeCode backend over LAN or relay.
- `apps/server`: Node.js HTTP/WebSocket backend. Wraps provider runtimes and manages sessions, persistence, git, and orchestration.
- `packages/contracts`: Shared effect/Schema schemas and TypeScript contracts for provider events, WebSocket protocol, and model/session types. Keep this package schema-only — no runtime logic.
- `packages/shared`: Shared runtime utilities consumed by both server and client applications. Uses explicit subpath exports (e.g. `@t3tools/shared/git`) — no barrel index.
- `packages/client-runtime`: Shared TypeScript client runtime used by the mobile app and relay-facing code.

## Reference Repos

- Open-source Codex repo: https://github.com/openai/codex
- Codex-Monitor (Tauri, feature-complete, strong reference implementation): https://github.com/Dimillian/CodexMonitor

Use these as implementation references when designing protocol handling, UX flows, and operational safeguards.

## Vendored Repositories

This project vendors external repositories under `.repos/` as read-only reference material for coding
agents.

- Prefer examples and patterns from the vendored source code over generated guesses or web search results.
- Do not edit files under `.repos/` unless explicitly asked.
- Do not import from `.repos/`; application code must continue importing from normal package dependencies.
- Manage vendored subtrees with `bun run sync:repos`; use `bun run sync:repos --repo <id>` to sync one
  configured repository.
- When updating a dependency with a configured vendored subtree, sync that subtree in the same change so
  `.repos/` matches the installed dependency version.
- When writing Effect code, read `.repos/effect-smol/LLMS.md` first and inspect `.repos/effect-smol/` for
  examples of idiomatic usage, tests, module structure, and API design.
- When writing relay infrastructure code with Alchemy, inspect `.repos/alchemy-effect/` for examples of
  idiomatic usage, tests, module structure, and API design.
