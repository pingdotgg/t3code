# AGENTS.md

## CRITICAL: This Repo Is SergeCode — a Permanent, Separate Fork

SergeCode (github.com/SergeSerb2/SergeCode) is a **permanent hard fork** of `pingdotgg/t3code`. It will **never** be re-merged upstream.

- **NEVER EVER open a PR against, merge into, push to, comment on, or otherwise touch `pingdotgg/t3code`.** Not for any reason.
- All PRs, issues, and pushes go to `SergeSerb2/SergeCode` only. Always pass `--repo SergeSerb2/SergeCode` explicitly to `gh` commands.
- Do not add a git remote pointing at `pingdotgg/t3code`. If one exists, treat it as an error and remove it.
- Before creating any PR, verify the base repository is `SergeSerb2/SergeCode`.

## Task Completion Requirements

- `vp check` and `vp run typecheck` must pass before considering tasks completed.
  - If changing native mobile code, `vp run lint:mobile` must also pass.
- Use `vp test` for the built-in Vite+ test command and `vp run test` when you specifically need the `test` package script.

## macOS App Versioning and Release Policy

Releases are automated but opt-in: **merging a PR into `main` only triggers
the `Release macOS App` workflow when that PR carries the `release` label**.
Plain merges never ship an update. When triggered, the workflow bumps the
version and `buildNumber` in `apps/mac/version.json`, builds and signs the
app, publishes a GitHub Release, and commits the updated Sparkle appcast back
to `main`. The bump size comes from an optional qualifier label on the same
PR — `release:patch` for bug fixes (the default when only `release` is
present), `release:minor` for features or larger PRs, and `release:major`
for big releases. Installed apps then see the update via Sparkle. Bot
commits pushed by the workflow carry `[skip release]` in their message —
never remove that marker from automation commits, and never cherry-pick a
bot commit without keeping the marker.

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
  version on merge (patch by default; add `release:minor` or
  `release:major` to the PR for a bigger bump).
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
