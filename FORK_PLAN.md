# T3 Code fork plan

**Purpose:** turn this checkout into a maintainable personal fork of T3 Code, with an isolated development setup and four focused product changes: project-first navigation, prompt-level thread navigation, inspectable subagents, and Bitbucket operations through `bkt`.

**Current checkout:** `main` tracks `origin/main`, and `origin` currently points to `pingdotgg/t3code`. No personal fork remote is configured yet. The repo is a TypeScript monorepo using Vite+, pnpm, Node 26, and some Rust/native tooling. It has a Dev Container. The Python files found are utility/build scripts; there is no `pyproject.toml`, `uv.lock`, or Python application dependency set.

## Goals and acceptance criteria

1. Keep a clean, repeatable path for bringing upstream T3 changes into the personal fork without losing custom work.
2. Develop and run the fork in a container with its own dependencies, credentials boundary, and T3 runtime state. Avoid using the normal T3 installation or its live data.
3. In the sidebar, make projects the primary navigation level and let each project expand to its threads. Keep projects discoverable even when they have no active threads, subject to clear archive/settled behavior.
4. In a thread, provide an at-a-glance index of the user's prompts. Selecting an entry jumps to that prompt and its response, making long advice conversations easy to revisit.
5. In the Agents view, show a collapsible execution tree: parent agents, child subagents, and each node's status. Selecting a child opens a complete inspection view, including its own messages/activity and code changes/diff when T3 and that provider can supply them.
6. For Bitbucket Cloud and/or Data Center as applicable, let T3 use the existing `bkt` CLI login for API operations instead of requiring a separate T3-managed Bitbucket credential. Preserve Git's own clone/fetch/push authentication behavior.

## Phase 0 — establish the fork and upstream workflow

1. Create a GitHub fork of `pingdotgg/t3code` under the user's account/organization.
2. Configure `origin` to the personal fork and `upstream` to `https://github.com/pingdotgg/t3code.git`. Confirm fetch/push URLs and branch tracking before pushing.
3. Keep a local `main` aligned with `upstream/main`; do custom work on named feature branches. Prefer small, independently reviewable commits/branches for the UI, subagent, and Bitbucket changes.
4. Define an update routine: fetch upstream; inspect the change range; merge or rebase upstream `main` into the fork's integration branch; resolve and record conflicts; run only affected checks. Do not force-push shared branches. Tag or otherwise record known-good integration points.
5. Before feature work, record the upstream commit SHA and verify the fork can build/start in the isolated environment. Do not publish changes or open an upstream PR unless separately requested.

**Done when:** local remotes clearly distinguish personal `origin` from upstream; the fork has a documented sync routine; custom work is not made directly on upstream-tracking `main`.

## Phase 1 — isolate the development environment

1. Use the repository's `.devcontainer` as the default. It provisions Ubuntu, Node 26, Rust and the repo's Vite+ (`vp`) tool, and installs the pnpm workspace dependencies inside the container. `node_modules` and package caches are container volumes; the host does not need the T3 toolchain installed globally.
2. Keep T3 development state in the checkout's ignored `.t3` directory (`T3CODE_HOME` is already configured that way in the Dev Container). Explicitly disable database seeding for the first run (`T3CODE_DEV_SEED=0` or the dev runner's `--no-seed` option) so no real user data is copied. Start with an empty/synthetic development account and the free `Replay (dev)` provider.
3. Keep `.env`, auth tokens, pairing URLs, and provider credentials out of Git. Do not connect the dev instance to production T3 Connect or use production credentials by default. If a feature later needs credentials, add a separate test account/token scoped to the minimum permissions and keep it inside the container's ignored configuration.
4. Treat host-only Electron GUI and mobile native builds as optional later work; web/server development is the first target. The Dev Container guide documents those platform limits.
5. Do not add `uv` just to make the JavaScript environment feel virtualized. The repository has no Python project or dependency lockfile. First inventory each Python helper's actual runtime; if a future maintained Python tool gains third-party dependencies, isolate that tool with its own `pyproject.toml`, `uv.lock`, and project-local `.venv` (or run it in the container). Keep Blender-specific asset scripts tied to their documented Blender runtime rather than pretending they are a general Python package.

**Done when:** a fresh container can install and run web/server T3 with state under `.t3`, no global Node/pnpm/vp install is required on the host, and the first run cannot read or mutate the normal T3 database or credentials.

## Phase 2 — project-first sidebar

1. Inspect the current sidebar implementation and its project/thread query contracts; reuse existing project grouping and ordering where possible.
2. Make projects the stable top-level rows. Expand/collapse each project to show its threads; define where pinned, archived, settled, snoozed, and no-project threads live so they remain findable.
3. Include projects with no active threads, and provide a visible count/status where useful. Preserve keyboard navigation, search, responsive layouts, and existing thread actions.
4. Keep the change presentational unless inspection proves the server does not return the metadata needed.

**Acceptance:** all configured projects are discoverable from the sidebar; expanding one shows its threads; selecting a thread opens the same conversation; empty/archived projects and no-project threads have intentional, documented access paths; web behavior works at narrow and wide widths.

## Phase 3 — prompt index inside a thread

1. Reuse the existing message history, search, and timeline/minimap data. Build a compact outline from user-authored prompts, with a readable one-line preview and optional time/sequence context.
2. Selecting a prompt scrolls to that user message and places its corresponding assistant answer in view. Handle prompts with long text, attachments, queued/steered messages, and multiple assistant/tool messages without treating every tool message as a prompt.
3. Make the outline easy to open and dismiss without permanently consuming chat space; preserve keyboard and mobile usability. Decide whether the index is a side panel, popover, or extension of the current minimap after reviewing the actual UI.
4. Search remains useful when the user knows a keyword; the index serves the different case where they want to scan prior questions, especially advice-only discussions.

**Acceptance:** a long thread exposes a scannable list of its user prompts; choosing an entry reliably lands at the prompt/answer pair; current scroll position and navigation state behave predictably; no server/schema change is made unless required by demonstrated data gaps.

## Phase 4 — Agents tree and full subagent inspection

1. Trace how the Agents view receives parent/child lineage, execution status, and provider activity. Identify capability differences by provider before changing the UI.
2. Add expandable parent rows with nested subagents and clear live/terminal statuses. Avoid duplicating every child as a peer-level item when the tree is expanded; retain a route for locating a child directly.
3. Selecting a child opens a dedicated inspection view with its prompt/task, messages, tool/activity timeline, status, and files/diff. Show only information T3 can attribute to that child; state clearly when a provider cannot report child-level diffs.
4. Keep controls semantically correct: stop/cancel applies to the selected execution; subagents that cannot accept user messages must direct the user back to the parent rather than showing a misleading composer.
5. Check whether diffs can be derived from existing checkpoints/worktree data. If children share a checkout or provider does not report changes separately, do not label the parent's aggregate diff as the child's own work. Decide whether a server-side attribution/checkpoint change is needed.

**Acceptance:** the Agents view communicates hierarchy and status at a glance; a child is one click away; child view shows attributable code changes when supported; unsupported attribution is explicit and safe; parent and child lifecycle actions remain correct.

## Phase 5 — Bitbucket through `bkt`

1. Audit `packages/source-control-bitbucket` and the source-control provider contract: list repos/PRs, create/update PRs, review/comment/status operations, identity probes, pagination, Cloud vs Data Center, and error handling. Map each operation to a supported `bkt` command or structured output.
2. Add a Bitbucket CLI-backed adapter that invokes `bkt` on the T3 server's environment and uses its existing auth/keyring/context. Never read, copy, log, or persist the raw `bkt` credential in T3's secret store. Detect the executable, version, active host/context, and auth status; explain missing CLI/auth in Settings.
3. Keep Git transport separate. `bkt` API auth does not automatically configure `git` over SSH/HTTPS; preserve the repository's normal Git credential helper/SSH setup for clone, fetch, and push.
4. Match existing user-visible Bitbucket capabilities where `bkt` supports them; report unsupported actions rather than silently falling back to the old credential flow. Support the user's actual Cloud/DC context and test both only if both are in scope.
5. Provide a setting to select the `bkt` executable path only if environment discovery needs it. Do not require new Premium-only token setup in the T3 UI for the CLI-backed path.

**Acceptance:** a developer with `bkt` installed and logged in can use the supported T3 Bitbucket workflows without entering a Bitbucket token into T3; credentials stay under `bkt`'s storage; missing/expired auth returns actionable errors; Git clone/push continues to use Git credentials; no accidental fallback leaks or duplicate credential stores.

## Phase 6 — integration, verification, and upstream maintenance

1. Keep the changes in focused branches/commits and integrate them into the fork after each feature is reviewable. Resolve upstream drift regularly rather than accumulating a large divergence.
2. Follow this checkout's instructions: focused tests/checks for changed areas, no repo-wide checks unless requested, and integrated UI review for web changes. Use synthetic thread/project/agent fixtures and the Replay provider. Use a dedicated Bitbucket test repository/context for any API verification; never perform writes against a real project without explicit direction.
3. Capture before/after UI evidence for the sidebar, prompt outline, and Agents view. Document provider limitations and the `bkt` version/commands relied on.
4. Update user docs only after behavior and settings are settled. Keep the fork-specific plan separate from upstream product docs.

**Release gate:** fresh-container setup works; all four product goals meet their acceptance criteria; scoped checks pass; no live T3 userdata, credentials, repositories, or Bitbucket projects were changed during development; the fork has a tested upstream sync procedure.

## Dependencies and sequencing

- Phase 0 precedes all code changes.
- Phase 1 precedes running or testing the fork.
- Phases 2 and 3 are primarily web/client navigation work and can be implemented independently after Phase 1.
- Phase 4 depends on confirming current orchestration lineage and child-diff attribution before choosing UI versus server scope.
- Phase 5 can proceed independently, but starts with an API/CLI capability map; the Git transport boundary must remain explicit.
- Phase 6 is continuous integration and the final release gate.

## Current assumptions to verify during implementation

- The desired Bitbucket target is Bitbucket Cloud because the user reports `bkt` already authenticates successfully on a free plan; confirm whether Data Center is also needed.
- “Prompt index” means user messages only, with each entry navigating to the response associated with that prompt.
- The subagent work view should resemble top-level inspection while preserving correct child-level attribution; provider limitations may prevent a true per-child diff in some cases.
- This is a personal fork first. Upstream PRs, publishing binaries, connecting production environments, and using real Bitbucket repositories are out of scope unless later requested.
