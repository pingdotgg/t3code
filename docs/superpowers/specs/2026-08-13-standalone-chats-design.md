# Standalone Chats — Design

**Date:** 2026-08-13
**Status:** Approved (awaiting implementation plan)

## Problem

Every conversation in T3 Code lives inside a project rooted at a directory. Users who want to "just talk to a model" — like ChatGPT or Claude.ai — currently must pick or create a project even while the work has nothing to do with source code. This adds the ability to start a chat with any configured provider/model *without* attaching a workspace, while still supporting attachments (images, file contents) on each message.

## Decisions (from brainstorming)

1. **Pure-conversation feel, attachments allowed.** Attachments embed content in the message; the model never gets a live filesystem view of the user's code.
2. **Existing provider CLIs**, not a new direct-API provider class. Codex, Claude, Cursor, Grok, and OpenCode adapters all run unchanged.
3. **Model switchable mid-chat**, matching current thread behavior.
4. **Web + mobile ship together.** Desktop inherits via the web wrapper.
5. **Promote-to-project is a documented future hook**, not built here.
6. **Per-chat scratch directories** (Approach C), built on a hidden synthetic chat project (Approach A's foundation).

## Prior art

Branch `experiment/hermes-provider-ui` (commit `0fde14a8c`, "feat: directoryless Hermes threads and a generic Agent page") solved this problem class with synthetic projects + converge-on-read creation. This design reuses its patterns; nothing from that branch is on `main`. Its recorded follow-up warning — "`activeProject !== null` is no longer a safe proxy for has-a-workspace" — is addressed head-on below.

## Architecture

A chat is a **completely ordinary thread**. What makes it a chat:

- It lives under a **hidden synthetic project** (one per environment):
  - `title: "Chats"`, `kind: "chat"`, `workspaceRoot: <t3home>/scratch/chats/`
  - The workspace root is a real directory on disk, so every adapter's cwd validation (including Grok/Cursor's hard-fail on missing cwd) passes trivially.
- Its `worktreePath` points at a **per-chat scratch dir** `<t3home>/scratch/chats/<threadId>/`, created at bootstrap.
- It is not a git repo, so checkpoint capture auto-skips (existing `resolveCheckpointCwd` behavior). Chats can never be "reverted", and that is correct.

Nothing goes nullable. Contracts, decider, and the `NOT NULL` SQLite columns stay as they are — `projection_threads.project_id NOT NULL` is untouched.

### Promotion hook (future, not built)

Because a chat is a normal thread, "promote to project" later = create/select a real project, set `thread.projectId` to it, and clear `worktreePath`. This design deliberately keeps that possible.

### Trade-off accepted

Chat threads carry dead fields (diff, checkpoint, branch). They never populate and cost nothing at runtime.

## Contracts (all defaulted, non-breaking)

- `OrchestrationProject`, `OrchestrationProjectShell`, `ProjectCreateCommand`, `ProjectCreatedPayload` gain `kind: "workspace" | "chat"`, decoding default `"workspace"`. A migration adds a `kind` column to `projection_projects` defaulting to `"workspace"`; existing rows need no rewrite.
- `ThreadTurnStartBootstrapCreateThread` gains `createInChatScratch?: boolean` (default `false`). When true, the server resolves the synthetic chat project itself and ignores `projectId` semantics.

## Server flow

**`getOrCreateChatProject()`** — idempotent, converge-on-read precondition (same shape as the Hermes branch's `getOrCreateAgentProject`):

1. Read for an existing active project with `kind: "chat"`.
2. If missing, dispatch `project.create` with `workspaceRoot = <t3home>/scratch/chats/`, `createWorkspaceRootIfMissing: true`, `kind: "chat"`.
3. Handle create-races (two environments bootstrapping simultaneously) by re-reading after a failed unique-workspace-root create.

**Bootstrap expansion** (`ws.ts` `dispatchBootstrapTurnStart`): when `createInChatScratch` is set —

1. Ensure the synthetic chat project exists via `getOrCreateChatProject()`.
2. Mint the `threadId` before dispatch (the create command already supports caller-supplied ids).
3. Compute `worktreePath = <workspaceRoot>/<threadId>/`, create the directory, dispatch `thread.create` with the synthetic project id and that `worktreePath`.
4. Start the turn as normal.

**Hiding the synthetic project:** done at the source, not the client. `subscribeShell` excludes `kind: "chat"` projects from the projects list it ships (their threads still stream). No client can render a "Chats" entry in a project picker, killing the 17-picker-surface class of bug wholesale. Search, shell thread lists, and thread subscription behave normally.

**Adapters:** zero changes. All five providers receive a real cwd pointing into T3 home. Tool-enabled harnesses can read/write within the per-chat scratch dir but cannot reach user code unless the user attaches content explicitly.

## Web UI

- **Sidebar:** new top-level **"Chats"** section below the projects list, per environment. Lists chat threads using the existing pinned/inbox/settled/archived grouping components, not nested under a project header. Rename, archive, snooze, pin work unchanged.
- **Entry points (all of them):**
  - Sidebar "+" on the Chats section
  - Command palette: "New chat" (alongside `chat.new` / `chat.newLocal`)
  - Keybinding for new chat
  - Landing "No projects" hero gains "Start a chat" — chats work with zero real projects
- **ChatView degradation:** the single guard `projectHasWorkspace(project) = project.kind !== "chat"` lives in `packages/client-runtime`. Workspace chrome consults it instead of null-checks:
  - Workspace breadcrumb, branch toolbar, git worktree toggle, diff/checkpoint panel, terminal toggle → hidden
  - "Open PR" / "Create PR", project scripts menu → hidden
  - @-mention file index → disabled (nothing to index in a scratch dir)
  - Right panel: chat threads show transcript only
- **Routes:** reuse `_chat.$environmentId.$threadId` (threads are already keyed by environment, not project). No new thread route needed.
- **Desktop:** inherits the web app unchanged.

## Mobile

- **Navigation sidebar** (`threads/ThreadNavigationSidebar.tsx`): "Chats" group alongside project groups, listing chat threads per environment.
- **New chat flow:** "New chat" action in the Chats group header, skipping project selection. `NewTaskDraftScreen` requires a `projectId` today; add a sibling lightweight chat-draft screen (or an optional-param variant — final call made in the implementation plan) whose first send dispatches the `createInChatScratch` bootstrap.
- **Home feed** (`home/homeThreadList.ts`): chat threads appear under a "Chats" scope, no project header.
- **Thread screen:** consults the shared `projectHasWorkspace` helper for workspace chrome.
- Mobile thread-list builders already tolerate unknown groupings, so threads render fine; the project pickers need zero changes because the server never ships them the synthetic project.

## Testing

Focused tests for new seams only (no repo-wide suites):

- `getOrCreateChatProject` — creates once, idempotent under concurrency, heals after manual deletion.
- Bootstrap with `createInChatScratch` — thread lands under the synthetic project with per-thread `worktreePath`; scratch directory exists on disk.
- Shell filtering — `subscribeShell` omits `kind: "chat"` projects but still ships their threads.
- One end-to-end adapter test: a chat turn runs against a provider with the scratch-dir cwd.

UI verification happens via `test-t3-app` (web) and `test-t3-mobile` (mobile) as one integrated pass after implementation, not via subagent-run dev servers.

## Docs

- `docs/user/`: a "Chats" page in shipped-product voice (what chats are, attachments, model switching, no workspace context). No repo tooling or source paths.
- `docs/internals/glossary.md`: "chat project / synthetic project" vocabulary.
- `docs/internals/`: one paragraph on the synthetic-project pattern pointing at the Hermes prior art.
- Nothing operations-facing.

## Surface checklist

| Surface | Verdict |
|---|---|
| Entry points | Sidebar, palette, keybinding, landing hero — all in scope |
| Clients | Web + mobile; desktop inherits web |
| Providers | Zero adapter changes; all five work (real cwd) |
| Contracts | Defaulted `kind` + defaulted `createInChatScratch` — non-breaking |
| Reverse states | Archive/unarchive, rename, snooze ride existing machinery; promote-to-project is a documented future hook |
| Connection modes | Synthetic project lives in the environment's own T3 home; remote/relay/tunnel identical to local |
| Docs | user + glossary + internals paragraph |

## Out of scope (explicit)

- Promoting a chat into a project (hook documented, not built)
- Disabling tools inside provider CLIs (harness-dependent, harness-owned)
- Any direct-API model provider class
