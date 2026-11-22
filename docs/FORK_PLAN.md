# Briefing: Trail v2 as an additive fork of T3 Code

Status: decided, plan tuned against the desktop design canvas, workspace = one repo = one T3 project · 22 November 2026
Repo: https://github.com/Joeydekruis/trail-v2 (fork of pingdotgg/t3code, MIT, created 22 Nov 2026)
Design: Claude Design canvas "Trail Desktop — Workspace switcher & Kanban" (T3 today, Trail v1 with workspace rail, Trail v2 with rail + Dashboard/Chat/Board/Files). Text version: `design-desktop-workspace-switcher-board.md`.
First feature: Kanban board

## Decision

Trail continues as a **fork of T3 Code** instead of a from-scratch build. We take the additive-fork route: our code lives in new workspaces, edits to T3's own files are kept to a minimum and are marked, and we merge upstream regularly so we keep receiving their updates.

Why: running agents in worktrees, the desktop/web/mobile clients, provider drivers (Cursor, Claude, Codex, OpenCode, Grok) and an issue-tracker layer are the commodity part and T3 already has them. Trail's own value is the PM layer on top (board, dashboard, project switching, autopilot, later decisions/ADRs and MCP knowledge). Some planned features need changes inside the server, so a pure sidecar was rejected.

The old Trail codebase (docs-folder sync with GitHub) is superseded by this. The cleanup briefing `briefing-opschonen-docs-sync.md` only applies if the old codebase is kept alive; decide whether it is still needed.

## Workspace = project = one repo

To keep things simple, a Trail workspace contains exactly one repository. That is the same thing as a T3 project, so we add **no new grouping concept and no workspace table**. The "workspace rail" in the design is a project switcher over the projects T3 already has. The board, dashboard and files view all work per project, and an issue is identified by its number alone. T3's multi-repo "task folders" are not used. If grouping several repos is ever wanted, it can be added later as a small table without redoing the views.

## What the design adds to the plan

| Design element                                                      | What it is                                                                                                                                   | Cost in the fork                                                                                                                                                  |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Board** (5 columns, issue drawer, New issue modal)                | GitHub issues as cards; move = status change; drawer with description, acceptance criteria, activity, comments, status, assignee, thread, PR | Low. Almost all of it exists in `IssueService` and the thread links. Our code is the UI, the column logic and a small table for card order.                       |
| **Dashboard** (latest chats, Kanban activity, board snapshot, docs) | Landing view per project, built from data other views already load                                                                           | Low once the board exists. A new route, no new backend beyond aggregation.                                                                                        |
| **Project rail** (the "workspace" switcher)                         | Switch between projects, accent colour per project                                                                                           | Medium. No new data model, but it wraps the app shell and replaces or sits next to T3's own project list, so it is a core patch. Optional for the first versions. |
| **Files view** ("docs/ in sync with GitHub")                        | Docs from the repo's `docs/` folder, with an "updated / linked to" line                                                                      | Low if docs stay on disk in the repo (T3's Files panel already previews them). A separate knowledge store would be new work.                                      |

Other T3 UI in the design stays as is: the thread list, subagents, lineage panel, terminal, the "Setup Worktree" and "Commit" controls. The design is mostly T3 with a new frame around it.

### Decisions the design settles or reopens

1. **Docs live in the repo's `docs/` folder for phase 1.** The Files view shows `docs/` "in sync with GitHub", which is just Git. T3's Files panel (Markdown, PDF, Mermaid, edit, comments) can render it, so no own knowledge store yet. This differs from the earlier idea of Trail as the global store that replaces `/docs`; the project description names both (replaces `/docs` and keeps the folder in sync). Recommendation: start with repo `docs/`, and add ADR/decision metadata (links from a doc to issues and threads, the "linked to N" in the design) in our own table later. **Needs your confirmation.**
2. **Status = label, with derived automation later.** Source of truth is a `status:*` label on the issue (portable across GitHub and the other trackers). The design already shows derived badges (running/idle, "PR #52 open", "PR #49 merged"). Phase 2 can move cards automatically: thread started → In progress, PR opened → Review, PR merged → Done. Manual drag always wins.
3. **Acceptance criteria come from the issue body** (a task list under a heading), not from a new field. The drawer note says agents read the issue text when you start a thread, so the body is the right place.
4. **"New issue" = create on GitHub, optionally start a thread right away.** That is `IssueService.create` plus `ThreadLaunchService.launch` with the worktree strategy and the issue as first message. Both exist; our code is the modal and the glue. This is also the first, manual version of autopilot.
5. **One board per project.** No cross-repo aggregation, so no key collisions.

## What T3 already gives us (checked in the fork at commit 7ddc81d)

Layout: pnpm workspace. `apps/server` (Effect-based runtime, WebSocket RPC, event-sourced orchestration in `orchestration-v2/`), `apps/web` (React, TanStack Router, file-based routes), `apps/desktop` (Electron), `apps/mobile` (Expo). Many packages: `contracts` (RPC and schema contract), `client-runtime`, `provider-*` (cursor, opencode, grok, ...), `source-control-*` (github, gitlab, ...), `issue-tracker-linear`, `secret-provider-*`, `ssh`, `tailscale`.

**Issue trackers already exist.** `packages/source-control-core/src/server/IssueTracker.ts` is a port every tracker implements. GitHub, GitLab, Linear, Forgejo and Azure DevOps implementations exist. The port has `listIssues` (state, labels, assignee, cursor), `getIssue`, `create`, `comment`, `update` (title, body, labels, assignees) and `setState`. `apps/server/src/issue/IssueService.ts` wraps it, there is an MCP issues toolkit, and threads can be linked to issues (`thread.issue.link`, `ThreadIssueService`).

**No Kanban/board exists** in the repo.

**Files and documents.** `apps/web/src/components/files` previews Markdown, PDF, Office files, CSV, images, audio, fonts, notebooks and Mermaid, with editing, comments and drag-to-prompt. RPC: `projects.listEntries/readFile/searchContents/searchEntries/writeFile`. It only sees files on disk in a project folder. The right panel has surface kinds (diff, files, file, terminal, pull-request, issue, device, thread, preview), and `RightPanelTabs.tsx` has exhaustive switches over them, so a new surface kind touches core. Prefer full-page routes for our views.

### How worktrees work

- A thread has an optional `branch` and `worktreePath`. A thread launches with a workspace strategy: `root` (project folder), `existing_worktree`, or `worktree` (new, with `baseRef`, optional `branch`, `startFromOrigin`, optional `repositories`).
- Creation is server-side in `orchestration-v2/ThreadLaunchService.ts` (`prepareInBackground`). It runs as tracked stages (`WorktreeSetupTracker`): fetch, checkout, submodules, setup-script, agent. The user can cancel until the agent starts. On cancel or failure the worktree and branch are removed again.
- Git work goes through `GitWorkflowService` and `GitVcsDriver` (`git worktree add`). It is exposed as RPC `vcs.createWorktree` / `vcs.removeWorktree`, behind the source-control write scope. The server picks the folder.
- Branch naming: a temporary `t3code/<8hex>` branch first. After the first message, a text-generation model proposes a real name (20 s timeout), and the branch is renamed. Settings control the naming mode and prefix.
- The base ref can be refreshed from origin. If a recorded base branch no longer exists, it falls back to the remote default branch, then the current branch.
- An agent can move itself into a worktree through MCP (`mcp/WorktreeMcpService.ts`, `handoff`). Deleting a thread does not remove its worktree automatically. `restoreMissingWorktree.ts` can recreate one from its branch.
- Not fully confirmed: the exact default worktree folder (docs say `.t3-worktrees/<thread>/`, an issue mentions `~/.t3/worktrees`) and which database is used.

Mapping to Trail: "task = branch + chat as worktree" is a thread started with `workspaceStrategy: worktree`. The "Worktrees" sidebar is a view over threads that have a `worktreePath`. Autopilot is a call to `ThreadLaunchService.launch` with the issue as the initial message.

## Fork rules (keep upstream merges possible)

1. Branches: `upstream` mirrors `pingdotgg/t3code` untouched (fast-forward only). `trail/main` carries our work.
2. Our code goes in new workspaces: `packages/trail-contracts`, `packages/trail-server`, and in `apps/web` only the routes and navigation hooks. Do not edit T3 schemas; add our own tables, commands and events, linked by thread id and issue number.
3. Edits to T3 files only at seams (registering RPC methods, mounting routes, the app shell). Mark each with `TRAIL-PATCH` and list it in `PATCHES.md`. Goal: one wrapper component for the shell (`TrailShell`) instead of edits spread over many files.
4. `routeTree.gen.ts`, `pnpm-lock.yaml` and `package.json` conflicts: take upstream's version and regenerate, never hand-merge.
5. Keep the MIT license and T3 copyright notice. Rebrand (name, logo, mint #4AF7A3, the Trail design tokens, Electron signing as Derisory Ventures B.V.) in isolated files.

### Syncing with upstream

- **Merge, don't rebase**, weekly: `upstream` into `trail/main`. Turn on `git rerere` so a conflict resolved once stays resolved.
- **Nightly canary** (GitHub Action): merge `upstream` into a throwaway branch, run typecheck and tests, report how many commits we are behind and which files conflict. Do the first merge in week one.
- Urgent upstream fixes can be cherry-picked before the weekly merge.
- Expected pain, in order: changes to the contracts our packages import (compile errors, not text conflicts), refactors of the seams in `PATCHES.md`, and database migration numbering (check how T3 numbers migrations and keep ours in a separate namespace).
- Budget: a few hours a week, more when upstream does a big refactor. If we need a seam often, open a small PR upstream to get a real extension point.

## Phases

**Phase 0: foundation (week 1)**

- Run the fork locally, make one trivial `TRAIL-PATCH`, learn the build and test flow.
- Create `upstream` / `trail/main`, the nightly merge-check, and `PATCHES.md`. Do the first upstream merge.
- Check how DB migrations can be extended with our own tables.
- Load the Trail design tokens (`project/ds/trail/tokens.json` in the canvas) into an isolated theme file.

**Phase 1: read-only board**

- Route `/board` plus one nav entry (the only core edits). Issues of the current project from `IssueService`, grouped by `status:*` label, five columns, label filter.
- Issue drawer: description, acceptance criteria (parsed from the body), activity, linked thread and PR state. Link out to GitHub.

**Phase 2: a working board**

- Drag and drop: set the status label, Done also closes the issue. Card order in our own table.
- Comments in the drawer sync to GitHub (`comment`).
- New issue modal: create on GitHub, optional "start a thread in a new worktree right away".
- "Start thread from issue" in the drawer. Then the derived moves (thread started, PR opened, PR merged).

**Phase 3: dashboard and project rail**

- Dashboard route: latest chats, Kanban activity, board snapshot. Reuses data the board already loads.
- Project rail (optional): a switcher over T3's projects with an accent colour per project, in `TrailShell`. No grouping table. Do it after phases 1 and 2, when we know the seams.

**Phase 4: Files view and docs**

- Files view over the repo's `docs/` using T3's preview components; the "updated / linked to N" line from our own links table.

Later, not in scope now: autopilot beyond the manual launch, roadmap/epics, decisions/ADRs with conflict view, knowledge MCP, Chrome extension, mobile, grouping several repos.

## Deployment

Findings from the fork's release workflows. This only has to be settled before the first installable build, so it sits in phase 0 as a small task, not a blocker.

- `release.yml` is gated to `github.repository == 'pingdotgg/t3code'` and uses Blacksmith runners, so it will not run in our repo. `release-desktop.yml` takes `runner` as an input and is reusable, so the plan is our own `trail-release.yml` that calls it on GitHub-hosted runners.
- Signing needs an Apple Developer ID certificate, a notarization key, a team ID and a provisioning profile (macOS), and Azure Trusted Signing (Windows). Unsigned builds work, so the first build is unsigned.
- The updater points at GitHub releases of `pingdotgg/t3code`; repoint it to our (public) releases repo.
- Rename identifiers that would collide with an installed T3 Code: the `t3code://` protocol, the `~/.t3` data folder, the app ID.
- Remove or replace baked-in services: Clerk, the T3 Connect relay, the Vercel web app and relay tracing; `.env.example` holds T3's IDs. Audit telemetry (`FeatureUsage.ts`).
- Build complexity: a Rust resource-monitor, node-pty, a Windows cross-build with WSL runtime, and a six-target matrix. Start with macOS arm64 and Windows x64 only.

## Open questions

- **Docs source:** repo `docs/` for phase 1 (recommended), or a separate Trail store from the start? See decision 1.
- **Project rail:** replace T3's existing project list, or sit next to it? Is the rail needed at all in the first versions, or is T3's project list enough until phase 3?
- **Columns as labels or GitHub Projects v2?** Labels are the default in this plan; Projects v2 needs new API code and only works on GitHub.
- Is T3's database migration system easy to extend with our own tables? (phase 0)
- Which T3 features do we hide (mobile, relay, other providers, non-GitHub trackers)? Hiding is preferred over removing, because removal makes merges harder.
- Keep the old Trail repo alive, or archive it?

## Next steps

1. Confirm the docs source (repo `docs/` or a separate store).
2. Phase 0 in `trail-v2`: branches, nightly merge-check, `PATCHES.md`, first upstream merge, one trivial patch.
3. Read the web route and shell code to pick the exact seam for `/board` (and later `TrailShell`).
4. Build phase 1 (read-only board).
