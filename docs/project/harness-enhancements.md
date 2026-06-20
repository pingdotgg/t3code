# Harness Enhancements Tracker

> Last updated: 2026-06-20

This tracks planned improvements to make T3 Code a stronger harness around coding agents, inspired by the useful parts of Conductor's workspace model: persistent context, injected guidance, action-specific prompts, isolated workspaces, review flow, and merge readiness.

## Priority Summary

| Priority | Enhancement                                       | Status          | Why It Matters                                                                                                                    |
| -------- | ------------------------------------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| P0       | Workspace identity and sidebar hierarchy          | Compat complete | Creates the Project -> Workspace -> Chat model that every other harness feature can attach to.                                    |
| P0       | Workspace migration and compatibility layer       | Compat complete | Lets existing projects, threads, routes, and APIs keep working while workspace ownership rolls out.                               |
| P0       | Dev/prod data isolation and feature flag rollout  | Complete        | Lets the new workspace layout run in dev without risking the user's deployed/current T3 Code data.                                |
| P0       | Workspace context folder                          | Not started     | Gives each workspace durable memory across turns, restarts, and provider handoffs.                                                |
| P0       | Durable task list                                 | Not started     | Gives every workspace a trustworthy task state instead of relying on the agent to update a checklist.                             |
| P1       | Workspace setup scripts and local file copy rules | Not started     | Makes workspace creation reliable by handling setup, run scripts, and `.env*` copying before agents start work.                   |
| P1       | T3 Code harness prompt injection                  | Not started     | Teaches Codex, Claude, Cursor, and OpenCode how to behave inside T3 Code workspaces instead of acting like raw CLIs.              |
| P1       | Context and task update reactor                   | Not started     | Keeps `.context` and task state useful after meaningful turns without asking users to manually summarize state.                   |
| P1       | Action-specific prompts                           | Not started     | Makes UI actions such as review, PR creation, fix checks, and handoff more consistent.                                            |
| P1       | Workspace lifecycle dashboard                     | Not started     | Makes the workspace/worktree/branch/terminal/diff/PR lifecycle visible as one unit of work.                                       |
| P1       | Integrated file editor and review surface         | Not started     | Gives users a Conductor-style file editor for inspecting, editing, and reviewing agent changes next to chat, diffs, and comments. |
| P1       | File diff review improvements                     | Not started     | Makes large diffs easier to navigate, filter, comment on, and hand back to agents.                                                |
| P2       | Merge readiness checks panel                      | Not started     | Gives users a clear "ready to merge" gate for git status, tests, PR state, comments, and todos.                                   |
| P2       | Structured review loop                            | Not started     | Lets users send diff comments and unresolved review feedback back to agents with precise context.                                 |
| P3       | Issue and PR fanout                               | Not started     | Enables one workspace per GitHub/Linear issue or PR for parallel agent work.                                                      |
| P3       | Spotlight-style root runner                       | Not started     | Supports projects that need one fixed root checkout, fixed port, shared database, or expensive dev stack.                         |

## P0: Workspace Identity and Sidebar Hierarchy

Add `Workspace` as the durable unit of work above `Thread`/chat, then update the left sidebar to show project -> workspace -> chat.

Target hierarchy:

```txt
Project A
  Workspace 1
    Chat 1
    Chat 2
    Chat 3
  Workspace 2
Project B
  Workspace 1
Project C
```

Ownership model:

- Workspace owns task-level lifecycle state: branch, worktree path, `.context`, task list,
  terminal sessions, right-panel surfaces, setup scripts, checks, review state, and PR state.
- Chat/thread owns conversation-level state: messages, provider session, turns, turn diffs, and approvals.
- Existing work should migrate into generated default workspaces grouped by stable execution
  identity: worktree path when present, otherwise branch-only or the local checkout.

Expected behavior:

- Projects remain top-level groups.
- Workspaces appear under projects.
- Chats appear under workspaces only when the workspace is expanded.
- Clicking a chat opens that one chat in the center, matching current T3 behavior.
- The workspace row has separate controls: caret toggles expand/collapse, title opens the last active chat, and `+` creates a new chat in that workspace.
- Collapsed workspaces show only workspace-level status such as name, branch/status, and changed-file count.
- Expanded workspaces show their chats, with the active chat highlighted.
- The center layout does not change in the first implementation; no Conductor-style center chat tabs.
- Terminal drawer state and right-panel surfaces should follow the active workspace rather than
  resetting per chat, while chat-specific plan/diff content can still render the selected chat's data.

Initial implementation notes:

- Start with a compatibility layer so existing thread URLs still resolve.
- Preserve existing turn/diff behavior during migration.
- Persist project/workspace expansion state in local UI state.
- Add workspace-level new-chat creation from the sidebar before adding a larger workspace dashboard.
- Prevent more than one active agent run per workspace until concurrent same-workspace runs are designed.

Completed compatibility scope:

- The workspace layout groups existing threads into generated default workspaces by worktree path, branch, or local checkout.
- Workspace rows expand/collapse independently from the selected center chat.
- Terminal drawer state and right-panel visibility follow the active workspace-scoped thread reference, while chat-specific diff and plan data remains attached to the selected chat.
- Settings and keybinding documentation describe the branch/worktree behavior for new chat creation.

Still pending:

- Add a durable workspace model instead of synthesizing workspace groups from thread metadata.
- Move branch/worktree ownership fully from thread fields to workspace fields after compatibility is proven.
- Add workspace-level lifecycle surfaces for changed files, checks, review state, and PR state.

## P0: Workspace Migration and Compatibility Layer

Make the workspace rollout additive first so existing T3 Code users do not lose projects, chats, diffs, routes, or provider sessions.

Migration goals:

- Existing projects should open without manual intervention.
- Existing threads should appear under generated default workspaces.
- Existing thread URLs should keep resolving.
- Existing turn/diff/checkpoint history should remain attached to the visible chat.
- Existing commands that accept `threadId` should keep working while workspace-aware commands are introduced.
- Workspace ownership should be introduced without immediately deleting thread-owned fields.

Backfill model:

```txt
Before:
Project A
  Thread 1
  Thread 2

After migration:
Project A
  Workspace generated from shared branch/worktree context
    Chat/Thread 1
    Chat/Thread 2
```

Compatibility rules:

- Add workspace tables/fields before removing or repurposing thread fields.
- Backfill one workspace per stable execution identity for the first migration, so multiple
  legacy threads on the same worktree or local branch appear as sibling chats.
- Treat branch name as mutable workspace metadata, not workspace identity, so branch renames
  update the label without creating a new sidebar workspace.
- Keep `thread.branch` and `thread.worktreePath` readable during the transition.
- Add `workspace.branch` and `workspace.worktreePath`, initially copied or derived from the thread.
- If a thread is missing workspace linkage, synthesize a default workspace in the projection rather than failing the UI.
- Old thread routes should resolve to the containing workspace and selected chat.
- New workspace-aware routes can be added while old routes remain aliases.
- Server commands that only know `threadId` should resolve the containing workspace internally.
- Only after the workspace model is proven should branch/worktree ownership move fully off thread.

Rollback and safety:

- First migration should be additive and reversible at the application level.
- Avoid destructive data movement in the initial rollout.
- Keep a clear invariant: every visible chat belongs to exactly one workspace.
- Add tests for old snapshots, new snapshots, and mixed snapshots where some threads have workspace linkage and some do not.

Completed compatibility scope:

- There is not yet a durable workspace table. The UI synthesizes compatible workspace groups from existing thread project, branch, worktree, and local-checkout metadata.
- Projection and client reducer paths preserve an existing worktree identity when stale restored local metadata arrives without a worktree path.
- Project-scoped new chat creation clears active branch/worktree context when the selected project differs from the current chat, so the draft appears under the selected project instead of the previously active workspace.

Still pending:

- Add persistent workspace IDs and workspace-aware routes/API commands.
- Backfill durable workspace records once the schema exists.
- Keep old thread routes as aliases during the durable migration.

## P0: Dev/Prod Data Isolation and Feature Flag Rollout

Keep the deployed/current T3 Code experience on the existing layout and data store while the dev build can run the new workspace layout safely.

Why this matters:

- Users may already run a deployed or installed T3 Code with real projects and chat history.
- Workspace migrations should not be tested first against the user's production app data.
- The dev build should be able to break, reset, and migrate independently.
- The old layout needs to stay available until the workspace model is proven.

Required behavior:

- Dev and prod must use separate ports and separate T3 home/data directories.
- The workspace-first sidebar should be gated behind a feature flag until migration is stable.
- Running dev should not automatically migrate the production `T3CODE_HOME`.
- Migrations should be tested against copied fixtures or a dev-only data directory first.
- The app should make the active mode obvious in diagnostics or settings: current layout vs workspace layout.

Recommended local commands:

```bash
# Existing/current app keeps its normal data directory.
npx t3@latest

# Dev app uses shifted ports and a separate data directory.
vp run dev:sandbox
```

Recommended long-term package script:

```json
{
  "scripts": {
    "dev:sandbox": "node scripts/dev-sandbox.ts"
  }
}
```

The sandbox wrapper sets these defaults:

- `T3CODE_DEV_INSTANCE=dev` so dev ports are shifted away from the normal app.
- `T3CODE_HOME=$HOME/.t3-dev` so dev data does not touch the user's current T3 Code data.
- `T3CODE_WORKSPACE_LAYOUT=1` so workspace-first UI work can be developed behind a flag.
- Refuses `T3CODE_HOME=$HOME/.t3` unless `T3CODE_ALLOW_PROD_HOME=1` is set.

Completed scope:

- `vp run dev:sandbox` is available as the repeatable development entrypoint for the workspace layout.
- The sandbox uses dev-only state, shifted ports, and the workspace layout flag by default.

Implementation notes:

- `T3CODE_DEV_INSTANCE` shifts dev ports, but data isolation requires `T3CODE_HOME` or `--base-dir`.
- Add a feature flag such as `T3CODE_WORKSPACE_LAYOUT=1` for the workspace-first sidebar.
- Keep old sidebar code path available while the flag is off.
- Add a startup warning if workspace-layout dev mode points at a non-dev-looking `T3CODE_HOME`.
- Document how to copy production data into a throwaway dev directory for migration testing, but never do it automatically.
- Prefer a committed `dev:sandbox` script over relying on a local `.env` file, because the script is explicit, repeatable, and harder to accidentally point at production data.
- `.env.local` can still be used for machine-specific secrets or overrides, but it should not be the only guardrail for data isolation.

## P0: Workspace Context Folder

Create a gitignored context directory for each workspace.

Decision:

- `.context/` lives only inside the active workspace root or worktree.
- `.context/` should be gitignored by default.
- T3 Code should not persist a second copy of context files in app data.
- T3 Code may read `.context/` on demand and may keep short-lived in-memory UI cache, but the files remain the only durable source.
- If a user edits or deletes `.context/`, T3 should reflect that state rather than resurrecting stale app-data copies.
- `.context/` is T3/agent-managed workspace memory, not a normal user-authored project folder.
- Users can inspect or reset `.context/` when needed, but the normal workflow should not require users to edit it manually.
- Agents can write any `.context/*.md` file by default.
- Context quality should come from structured updates tied to workspace events, not from asking users to curate files by hand.

Proposed structure:

```txt
.context/
  brief.md
  plan.md
  decisions.md
  handoff.md
  review.md
  checks.md
  artifacts/
```

Expected behavior:

- Context is stored in the active workspace root or worktree.
- T3 Code creates `.context/` when a workspace is created.
- T3 Code only stores durable workspace state, not full transcripts.
- Agents are instructed to read relevant files before starting substantial work.
- Agents are instructed to update any relevant `.context/*.md` file that changed meaningfully.

Initial implementation notes:

- Add server-side context file helpers under `apps/server/src/workspace/` or a focused `apps/server/src/context/` module.
- Add contracts for reading and writing context summaries if the UI needs direct access.
- Ensure `.context/` is ignored or recommend adding it to `.gitignore`.
- Avoid persisted app-data mirrors of `.context/`; prefer file reads, file watchers, or invalidatable in-memory cache.
- Keep writes atomic and scoped to the active workspace path.
- Keep `.context/` out of the normal changed-files/diff review flow by default.
- Add a later context inspector/reset surface for debugging bad or stale memory.

## P0: Durable Task List

Make workspace task state a first-class T3 Code object instead of relying on the agent to keep a markdown checklist current.

Decision:

- Structured T3 task state becomes canonical at the workspace level.
- Current provider plan/todo events and proposed plans remain inputs for seeding and updating workspace tasks.
- `.context/tasks.md` is a generated readable mirror for agents and handoffs, not the source of truth.
- T3 should avoid parsing arbitrary markdown as canonical task state.
- Task state must support `todo`, `in progress`, `done`, `blocked`, and `stale/needs review`.

Problem to solve:

- Agents sometimes complete or discover work without updating the visible task list.
- Users cannot tell whether the task list is current, stale, or just forgotten.
- A task list that lies is worse than no task list because it breaks trust in the harness.

Expected behavior:

- Each workspace has a durable task list in T3 Code state.
- The task list is mirrored into `.context/tasks.md` so agents and handoffs can read it.
- After each meaningful turn, T3 Code reconciles task state from assistant output, checkpoint diff summaries, command activity, check results, and any explicit plan updates.
- The UI clearly distinguishes `todo`, `in progress`, `done`, `blocked`, and `stale/needs review`.
- If task reconciliation is uncertain, T3 Code marks the list as needing review instead of silently pretending it is up to date.

Initial implementation notes:

- Reuse current `turn.plan.updated`, provider TodoWrite/task events, and proposed plan projections as migration inputs.
- Add task schemas to orchestration contracts rather than parsing arbitrary markdown as the source of truth.
- Keep `.context/tasks.md` as a readable mirror, not the canonical database.
- Start with user/agent-visible task state before adding automatic reconciliation.

## P1: Workspace Setup Scripts and Local File Copy Rules

Create a checked-in repo configuration for workspace setup behavior.

Decision:

- First workspace setup for a project asks whether to copy local env files into new worktrees.
- The setup UI pre-fills recommended patterns: `.env` and `.env.*`.
- Users can edit the pattern list one entry per line.
- The default copy mode is `missing-only`; never overwrite existing files unless the user explicitly changes that mode.
- Remember the choice per project.
- Warn if a matched file is not gitignored.
- Show setup results: copied, skipped because present, missing in source, or blocked.

Candidate file:

```txt
.t3code/settings.toml
```

Candidate settings:

```toml
[scripts]
setup = "vp i"
run = "vp dev --port $T3CODE_PORT"
archive = ""
run_mode = "concurrent"

[workspace]
file_include_globs = ".env.local\n.env.development.local"
port_count = 10
context_dir = ".context"

[workspace.copy]
files = [".env", ".env.*"]
mode = "missing-only"
source = "project-root"
```

Prebuilt local file copy behavior:

- Offer a default "Copy local environment files into new worktrees" option.
- Default patterns should include `.env` and `.env*`.
- Users can add more files or globs in a simple one-entry-per-line UI.
- One-entry-per-line is preferred over comma-separated input because paths and globs are easier to scan, edit, reorder, and validate.
- Copy from `T3CODE_PROJECT_ROOT` into `T3CODE_WORKTREE_PATH` during workspace/worktree setup.
- Default copy mode should be `missing-only` so T3 Code does not overwrite existing worktree files.
- Show copy results in the setup/checks UI: copied, skipped because present, missing in source, blocked because unsafe.
- Warn when a file pattern appears to copy sensitive files that are not gitignored.

Initial implementation notes:

- T3 Code already has project scripts; this should standardize repository-shared defaults.
- T3 Code already exposes `T3CODE_PROJECT_ROOT` and `T3CODE_WORKTREE_PATH` to project scripts; the first-class copy feature should use the same root/worktree distinction.
- Support local overrides separately from checked-in settings.
- Avoid copying unignored secret files.
- Store shared copy defaults in repo config, and user-specific additions in local app settings or an ignored local config file.

## P1: T3 Code Harness Prompt Injection

Inject a concise system/developer prompt into provider sessions explaining T3 Code's environment.

Decision:

- Users inspect and edit injected prompts through a Settings UI.
- Projects can override or extend defaults with checked-in files such as `.t3code/prompts/base.md`, `.t3code/prompts/review.md`, and `.t3code/prompts/pr.md`.
- T3 should show the final assembled prompt before a run, including built-in defaults, project overrides, and action-specific additions.
- Repo prompt files are for shared/team defaults; user-specific prompt preferences stay in local app settings or ignored local config.
- Prompt injection uses a shared core harness prompt plus provider-specific adapters.
- The shared core owns workspace rules, `.context`, task/check expectations, diff/review behavior, and safety expectations.
- Provider adapters translate the shared core into the right instruction shape for Codex, Claude, Cursor, OpenCode, or other providers.

Prompt should cover:

- The agent is running inside T3 Code.
- A thread may be backed by a git worktree and branch.
- The workspace has terminals, scripts, preview surfaces, diffs, checkpoints, and PR actions.
- `.context/` contains durable workspace state.
- The agent should update context only when goal, plan, decisions, blockers, touched areas, checks, or next steps change.
- Verification should prefer project scripts and repo instructions.
- The agent should avoid hidden destructive operations and respect runtime mode.

Initial implementation notes:

- Start with Codex prompt injection because `apps/server/src/provider/CodexDeveloperInstructions.ts` already exists.
- Generalize provider harness instructions through provider adapter capabilities after the Codex path is proven.
- Make injected prompts visible and editable in settings before adding more aggressive behavior.
- Keep prompt assembly deterministic and inspectable so users can understand what the agent actually received.
- Avoid maintaining fully separate provider prompts that can drift in behavior.

## P1: Context and Task Update Reactor

Add a server-side reactor that updates `.context` after meaningful turn completion.

Decision:

- Use a hybrid update model.
- T3 writes deterministic facts it already knows: task state, branch/worktree, changed files, commands, checks, review state, PR state, timestamps, and turn IDs.
- The agent/model writes narrative context: summaries, decisions, rationale, handoff notes, risks, and open questions.
- Prefer deterministic facts whenever T3 can know them.
- Do not update `.context/` after every message; update after meaningful turns and workspace lifecycle events.

Update triggers:

- A turn completes and produced file changes.
- A plan was proposed or implemented.
- A checkpoint diff was finalized.
- A command/check failed or became green.
- Review comments or PR/check state changed.

Update rules:

- Do not append every assistant message.
- Write short structured summaries.
- Preserve user-authored context where possible.
- Prefer updating `plan.md`, `decisions.md`, `checks.md`, `review.md`, and `handoff.md` over creating many files.

Initial implementation notes:

- Hook after `turn.processing.quiesced` or checkpoint diff finalization.
- Use existing turn diff summaries and thread activity rather than rereading the full transcript.
- Start with deterministic reconciliation for explicit plan/task events.
- Add model-assisted reconciliation only after the deterministic path is reliable.
- Consider a small text-generation summarizer, but keep a deterministic fallback that writes basic changed-file/check metadata.

## P1: Action-Specific Prompts

Create reusable prompts for UI actions that currently depend on generic chat behavior.

Initial actions:

- Review current diff.
- Address selected diff comments.
- Fix failing checks.
- Create PR title/body.
- Continue from proposed plan.
- Write handoff for another agent.
- Summarize workspace before archive.

Initial implementation notes:

- Keep prompts short and action-scoped.
- Store prompt templates in a server module or checked-in prompt directory.
- Expose repository/user overrides in settings after default prompts are stable.

## P1: Workspace Lifecycle Dashboard

Create a workspace-level overview that makes each active thread feel like one shippable unit.

Show per workspace:

- Title and provider/model.
- Branch and worktree path.
- Runtime mode and interaction mode.
- Latest turn state.
- Changed files and diff size.
- Running terminals/scripts.
- Preview URL/status.
- PR/MR state when available.
- Next recommended action.

Initial implementation notes:

- Reuse existing thread shell projections, VCS status, source-control state, terminal sessions, and preview sessions while migrating terminal/right-panel ownership from thread keys to workspace keys.
- Start read-only before adding lifecycle actions.
- This should become the user's home base for parallel agent work.

## P1: Integrated File Editor and Review Surface

Build a Conductor-style file editor inside the workspace view for reviewing and editing project files, with external editor opening as an explicit secondary action.

Decision:

- Preserve the current right-side changed-files/diff review surface as the base.
- Improve the current surface incrementally rather than replacing it with a full IDE-like editor.
- File clicks from review contexts should stay in T3 Code by default: changed files, diffs, chat file links, review comments, and checkpoint files.
- VS Code/external editor remains an obvious secondary action for larger edits and deeper refactors.
- The goal is a stronger agent review surface, not a general-purpose IDE.
- T3 supports review-sized edits only; larger coding work stays in the external editor.

Why this is useful:

- Review stays in the same workspace as chat, diff, terminal, preview, and PR actions.
- Users can inspect the full file around a diff without losing agent context.
- T3 Code can attach file selections, lines, and comments directly back to the agent.
- Remote and desktop workflows become more consistent because opening an external editor may not always work.

Expected behavior:

- Clicking a changed file opens an integrated editor tab by default.
- The file surface supports syntax highlighting, line numbers, search, copy path, copy selection, and "ask agent about selection."
- The editor supports safe direct edits with debounced saves and clear pending/error state.
- In-app edit scope is limited to small line/block edits, hunk actions, and review comments.
- Diff hunks can jump to the corresponding file and line.
- The file tab shows whether it is viewing the workspace file, a checkpoint version, or a diff side.
- External editor remains available as `Open in editor`.

Initial implementation notes:

- Build on the existing Files right-panel surface, editable file preview, `@pierre/diffs/editor`, and save coordinator.
- Update changed-file, diff, chat-link, and git-action file clicks to prefer the integrated editor surface.
- Keep the editor focused on agent review workflows; do not try to become a full IDE.
- Add a clear fallback when file content is binary, too large, missing, or outside the workspace.
- Keep external editor integrations for advanced refactors and user preference.
- Prioritize targeted improvements first: collapse all, filters, review state, clearer turn labels, and better file navigation.

## P1: File Diff Review Improvements

Improve diff navigation and review so large agent changes are easier to understand and act on.

Expected behavior:

- File tree grouped by directory with additions/deletions, file type, generated/lockfile badges, and test/docs labels.
- Filters for current turn, all turns, unreviewed files, files with comments, tests only, docs only, and generated files hidden.
- Per-file review status: unreviewed, reviewed, commented, resolved, approved.
- Collapse all / expand all controls with state that survives switching files, turns, and panel visibility.
- Compare any two checkpoints or turns, not only the latest summarized range.
- Clear turn labels that explain whether the user is viewing one assistant turn or the aggregate diff across all turns.
- Summary panel with touched areas, risky files, tests/docs changed, large generated changes, and missing-test hints.
- Hunk-level actions: copy hunk, ask agent about hunk, comment on hunk, revert hunk or file when safe.
- Sticky file navigation for large diffs.

Initial implementation notes:

- Build on `DiffPanel`, `ChangedFilesTree`, checkpoint diff queries, and `reviewCommentContext`.
- Start with navigation, grouping, and filters before adding mutation actions like hunk/file revert.
- Persist collapsed file/hunk state by thread, selected turn/checkpoint range, and file path.
- Feed unresolved diff comments into the structured review loop and merge readiness panel.
- Keep diff parsing and rendering in shared/tested helpers; avoid one-off UI parsing.

## P2: Merge Readiness Checks Panel

Add a single readiness panel for work that may be merged.

Decision:

- The v1 Checks panel starts with local checks and workspace health.
- Do not wait for GitHub/provider CI integration before building the first version.
- Include git status, uncommitted file count, branch/worktree info, last command/check run, configured check results, blocked/stale task state, context freshness, and PR-created state when available.
- Treat provider CI and review data as later signals layered onto the same local readiness model.

Checks to aggregate:

- Git working tree status.
- Uncommitted file count.
- Ahead/behind/default branch delta.
- Branch and worktree identity.
- Project scripts and latest command results.
- Task blocked/stale state.
- Context freshness.
- PR/MR state.
- CI/status checks when provider data is available.
- Unresolved review comments.
- Context todos or open checklist items.
- Last checkpoint/diff availability.

Initial implementation notes:

- Start with local signals already available in T3 Code.
- Add provider-backed CI/review signals incrementally.
- Use blockers as guidance, not hard locks, until the data is reliable.

## P2: Structured Review Loop

Make review feedback first-class instead of plain prompt text.

Expected behavior:

- User selects changed lines in diff.
- T3 Code creates structured review comments.
- Comments can be unresolved or resolved.
- A user can send selected unresolved comments to the active agent.
- The Checks panel reflects unresolved comments.

Initial implementation notes:

- Build on `apps/web/src/reviewCommentContext.ts`.
- Persist review comments in orchestration state or a focused review projection.
- Later, sync GitHub/GitLab review comments into the same model.

## P3: Issue and PR Fanout

Let users create multiple workspaces from a list of issues or PRs.

Expected behavior:

- Pick GitHub/Linear issues or PRs.
- Create one workspace per selected item, with an initial chat seeded from that issue or PR.
- Seed each workspace with issue/PR context in `.context/brief.md`.
- Run setup script per workspace if configured.
- Show all spawned workspaces in the lifecycle dashboard.

Initial implementation notes:

- Start with GitHub because source-control support already exists.
- Add Linear later behind a separate integration.
- Keep fanout explicit; do not auto-spawn agents without user confirmation.

## P3: Spotlight-Style Root Runner

Support testing one worktree through the repository root.

Use cases:

- Fixed local port.
- One shared local database.
- Heavy Docker or microservice stack.
- Expensive build cache that only exists in the root checkout.
- Apps that assume the repository root path.

Initial implementation notes:

- Treat this as a later feature because it can mutate the root checkout.
- Require clear UI state showing which workspace is currently active in root.
- Preserve and restore root state carefully.
- Start with a design doc and safety tests before implementation.

## Suggested Build Order

1. Keep dev/prod data isolated and run workspace layout behind a feature flag.
2. Add workspace identity above thread/chat with additive migration/backfill for old threads.
3. Preserve old thread routes and thread-id commands while resolving the containing workspace internally.
4. Change the sidebar to Project -> Workspace -> Chat while keeping the center one-chat layout behind the feature flag.
5. Move branch/worktree ownership toward workspace while preserving existing turn/diff behavior.
6. Add `.context/` creation and basic read/write helpers scoped to workspace.
7. Add durable workspace task-list schemas and a basic task UI.
8. Mirror task state into `.context/tasks.md`.
9. Add repo setup profiles and prebuilt `.env*` worktree copy rules.
10. Inject a small T3 Code harness prompt for Codex sessions using workspace context.
11. Add manual "Update handoff" and "Read workspace context" actions.
12. Add deterministic context and task updates after turn completion.
13. Add action-specific prompts for review and PR creation.
14. Make changed-file clicks use the current integrated review surface by default.
15. Add diff grouping, filters, collapse state, clearer turn labels, and per-file review state.
16. Build the workspace lifecycle dashboard.
17. Add the merge readiness checks panel.
18. Persist structured review comments.
19. Add issue/PR fanout.
20. Design and build Spotlight-style root runner.
