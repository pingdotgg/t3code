<h1 align="center">Trail</h1>

<p align="center">Project management on top of your coding agents — Kanban, dashboard, and one repo per workspace.</p>

<p align="center">
  <a href="./docs/FORK_PLAN.md"><strong>Fork plan</strong></a> ·
  <a href="./docs/operations/development.md">Development</a> ·
  <a href="https://github.com/pingdotgg/t3code">Upstream (T3 Code)</a>
</p>

**Trail** is an additive fork of [T3 Code](https://github.com/pingdotgg/t3code). T3 already runs agents in worktrees, ships desktop/web/mobile clients, and talks to Cursor, Claude, Codex, OpenCode, and more. Trail adds the PM layer: a GitHub-issues Kanban board, a project dashboard, docs tied to the repo, and (later) autopilot and decisions — without replacing the agent runtime underneath.

One **workspace** is one git repository, mapped to a single T3 **project**. The board, dashboard, and files views are per project; issues are tracked by number on the connected issue tracker (GitHub first).

The product UI is still largely T3-branded while Trail features land. Design reference: `docs/designs/Trail Desktop — Workspace switcher & Kanban.html` and [FORK_PLAN.md](./docs/FORK_PLAN.md).

## What Trail adds (planned)

| Area             | Direction                                                                        |
| ---------------- | -------------------------------------------------------------------------------- |
| **Board**        | Five columns from `status:*` labels; issue drawer; drag to change status         |
| **Dashboard**    | Latest threads, board activity, snapshot — mostly aggregation over existing data |
| **Files**        | `docs/` in the repo, with T3’s file preview where possible                       |
| **Project rail** | Switch projects with per-project accent color (optional after board v1)          |

Everything else in the stack — threads, worktrees, diffs, PRs, subagents, terminal — stays T3’s.

## Prerequisites

Install [Vite+](https://viteplus.dev/) (`vp`) so you get the Node version pinned in this repo:

```sh
curl -fsSL https://vite.plus | bash
```

From the repository root:

```sh
vp i
```

Use the [development runbook](./docs/operations/development.md#first-checkout) for Windows long-path checkout, dev containers, and isolated state under a worktree’s `.t3` (never develop against `~/.t3/userdata`).

## Run locally

| Goal                      | Command                                |
| ------------------------- | -------------------------------------- |
| Server + web (browser UI) | `vp run dev`                           |
| **Desktop (Electron)**    | `vp run dev:desktop`                   |
| Server or web only        | `vp run dev:server` / `vp run dev:web` |

Read **ports and the pairing URL** from the `[dev-runner]` line in the terminal. Open the pairing URL in a browser before the UI can talk to the server.

For agent turns without spending on a model, `vp run dev` registers **Replay (dev)**; see [development.md](./docs/operations/development.md#replay-provider).

## Desktop: how we test

### Day-to-day development

`vp run dev:desktop` builds and launches the Electron shell with the same backend as web dev. Renderer hot reload follows the same rules as upstream; macOS passkeys need a signed build — see [Connect setup](./docs/operations/connect-setup.md#desktop-passkeys).

### Unit and integration tests

Desktop tests live under `apps/desktop` (Vitest). From the repo root:

```sh
vp test run apps/desktop
```

Before you push, run fast checks on what you changed:

```sh
vp run check:changed
```

### Launch smoke (packaged or unpackaged)

`scripts/smoke-desktop-app.ts` boots the app against a **seeded older database** in `scripts/fixtures/desktop-launch/`. The packaged server must migrate that DB forward, same as a real upgrade. It opens a known thread and asserts the message renders (Playwright driving Electron).

**CI (Linux):** after `vp run build:desktop`, the workflow runs the smoke unpackaged:

```sh
electron=$(node -p "require('./apps/desktop/node_modules/electron')")
xvfb-run -a node scripts/smoke-desktop-app.ts \
  --executable "$electron" \
  --app apps/desktop \
  --artifacts-dir /tmp/desktop-launch-check
```

**After a local artifact build**, point `--executable` at the packaged binary (AppImage, `.app` inside a DMG, or Windows installer output). Use `--artifacts-dir` to capture a screenshot on failure.

**Release pipeline:** when upstream’s full release runs, macOS arm64 and Linux x64 jobs also run this check before upload. Trail’s fork does not run that pipeline yet (see below).

### Manual UI check

Use server + web or desktop against an isolated `.t3` home. The maintainer skill [test-t3-app](.agents/skills/test-t3-app/SKILL.md) describes pairing, the Browser panel, and the free Replay provider — the same flows apply when exercising Trail UI once routes exist.

## Desktop: how we build and deploy

### Local unsigned artifacts

Default output directory: `release/`. Commands from [development.md](./docs/operations/development.md#desktop-artifacts):

```sh
vp run dist:desktop:dmg          # macOS (host arch by default)
vp run dist:desktop:win          # Windows NSIS
vp run dist:desktop:linux        # Linux AppImage x64
```

More targets and flags: `vp run dist:desktop:artifact --help`. Builds are **unsigned** unless you pass `--signed` and configure certificates per the [release runbook](./docs/operations/release.md).

Platform prerequisites (Rust, libsecret on Linux, Xcode CLT on macOS, MSVC on Windows) are documented in the same development page.

### What runs on GitHub today (this fork)

| Workflow                                                       | On `Joeydekruis/trail-v2`                                                                         |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| [ci.yml](./.github/workflows/ci.yml)                           | Runs on push/PR — includes `build:desktop` and the launch smoke when desktop-related files change |
| [release.yml](./.github/workflows/release.yml)                 | **Does not run** — jobs are gated to `github.repository == 'pingdotgg/t3code'`                    |
| [release-desktop.yml](./.github/workflows/release-desktop.yml) | Reusable workflow only; called from `release.yml` upstream                                        |

So **Trail does not publish installable desktop releases from this repo yet**. Installers are built locally, or you use [T3 Code releases](https://github.com/pingdotgg/t3code/releases) for a stock agent shell while Trail features are in development.

### Planned Trail releases (phase 0)

From [FORK_PLAN.md](./docs/FORK_PLAN.md#deployment):

1. Add a **`trail-release.yml`** that calls `release-desktop.yml` on GitHub-hosted runners (upstream uses Blacksmith and the same gate).
2. Start with **macOS arm64** and **Windows x64** only; expand the matrix later.
3. Ship **unsigned** builds first; add Apple notarization and Azure Trusted Signing when certs are ready.
4. Repoint **electron-updater** from `pingdotgg/t3code` to Trail’s public release feed.
5. Rename collision-prone identifiers before side-by-side install with stock T3: app ID, `t3code://` protocol, `~/.t3` data path (Trail-specific home).
6. Audit baked-in T3-only services (Clerk, T3 Connect, marketing telemetry) for what Trail keeps.

Until that ships, treat **local `dist:desktop:*` + launch smoke** as the bar for “good enough to install on a machine.”

### Branching and upstream

- **`upstream`** — `pingdotgg/t3code`, fast-forward only.
- **`trail/main`** (or `main` carrying Trail work) — our patches; see fork rules in [FORK_PLAN.md](./docs/FORK_PLAN.md#fork-rules-keep-upstream-merges-possible).
- Mark seams in upstream files with `TRAIL-PATCH`; list them in `PATCHES.md` when that file exists.

## Documentation map

| Doc                                                | Use                                                                    |
| -------------------------------------------------- | ---------------------------------------------------------------------- |
| [FORK_PLAN.md](./docs/FORK_PLAN.md)                | Roadmap, design choices, deployment checklist                          |
| [development.md](./docs/operations/development.md) | Full dev setup, desktop artifacts, signing                             |
| [release.md](./docs/operations/release.md)         | Upstream’s six-target release train (reference)                        |
| [AGENTS.md](./AGENTS.md)                           | Contributor agent rules (T3 monorepo conventions)                      |
| T3 user docs under [docs/user/](./docs/user/)      | Agents, git, remote access — still accurate for the underlying product |

## License

[MIT](./LICENSE) — same as T3 Code. Keep upstream copyright notices in forked files.

Trail is maintained by [Joeydekruis](https://github.com/Joeydekruis); agent and UI foundations are from the T3 Code project.
