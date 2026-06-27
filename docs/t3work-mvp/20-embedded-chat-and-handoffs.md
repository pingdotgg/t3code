# Epic 20: Embedded Chat And Agent Handoffs

## Direction

The right-side `t3work` chat panel should become a full contextual chat surface, not
only a kickoff form.

Project, ticket, backlog, my-work, and future work views should keep their main content
visible while the user chats in the side panel. Starting a contextual thread should not
throw the user into a standalone thread page. The page stays on the same data view, the
right panel swaps from kickoff composer to real chat, and the URL changes to the new
context-bound thread route.

The full thread page still remains necessary for focused reading, deep navigation, and
opening standalone child or handoff threads directly.

Example:

```text
User views backlog filtered to Sprint 12 bugs.
Side panel chat asks: "summarize release risk."
Thread receives current project, route, filters, visible work items, and selected items.
User stays on the backlog page.
```

## Two Chat Modes

There are two composer/chat modes.

Standalone chat:

- general project work
- coding work in local repositories or worktrees
- agent handoff child threads
- focused full-thread reading and navigation

Context-bound chat:

- project dashboard work
- backlog work
- my-work work
- ticket/work-item work
- any future data view where the chat should stay bound to the visible view

Context-bound chat inherits the current data view. It is not just a smaller version of
the standalone thread page.

Example:

```text
/t3work/projects/acme/backlog
Right panel: kickoff composer

User sends: "Find sprint risks."

/t3work/projects/acme/backlog/threads/thread-123
Main view: same backlog, same filters
Right panel: real chat for thread-123
Left nav: thread-123 appears under the backlog/project attachment point
```

## Embedded Chat Panel

Keep the current kickoff panel concept, but make kickoff become the first step of a
context-bound thread.

For recipe-driven launches, creating the thread does not necessarily mean the first agent turn
starts immediately. Kickoff is the first phase of the recipe's workflow: the workflow may create
the thread, render guided kickoff state in the embedded chat panel via a `collect-input` step, and
wait for user input before advancing to the first `agent` step. See
[Epic 16](./16-action-recipes.md#workflows) for the unified step model.

A conversation has three message authors — `user`, `agent`, and `system` (workflow- or
host-emitted) — with independent `visibleToUser`/`visibleToAgent` flags and an optional
embedded `view` (a miniapp at `conversation.inlineCard`) that carries interactive UI for
forms, approvals, and structured pickers. The embedded chat panel renders all three. See
[Epic 16 — Conversation Participants](./16-action-recipes.md#conversation-participants)
for the model and the `t3workExt` additive seam.

Panel states:

- kickoff draft for the default parent view
- active context-bound thread
- thread running
- thread blocked on user input or approval (a `collect-input` waiting on a system message)
- thread error

Core controls:

- compact full chat timeline
- compact composer
- open full thread page action

The panel should reuse existing T3 chat behavior where possible. It should not invent a
separate chat runtime.

## No Sidebar Thread Selector By Default

The side panel should not need a thread selector as its primary navigation model.

Threads are selected through normal left navigation and route state. When the user starts
a contextual thread from a project, backlog, my-work, or work-item page, that thread is
created under the current navigation item. The user remains in the same data view.

Clicking the parent item returns to the default view with an empty kickoff composer.

Example:

```text
Project
  Backlog
    Thread: Sprint risk review
    Thread: Estimate cleanup
  PROJ-123
    Thread: Test plan
    Thread: Root-cause analysis
```

Behavior:

- click `Backlog`: show default backlog view plus kickoff chat
- click `Backlog > Sprint risk review`: show same backlog view plus that chat
- click `PROJ-123`: show default ticket view plus kickoff chat
- click `PROJ-123 > Test plan`: show same ticket view plus that chat

This creates multiple persisted views of the same parent work item or project. Each
thread can carry its own view state.

Optional later: add local search or "recent chats" inside the panel if navigation alone
becomes too slow. It should not be required for the base model.

## Context-Bound View State

A context-bound thread should persist the data-view state it was created with.

Examples:

- backlog filters
- backlog grouping
- backlog sort
- my-work filters
- selected work items
- ticket tab or expanded sections
- relevant linked repository selection

This means the same work item can have several useful thread-specific views.

Example:

```text
PROJ-123
  default view: normal ticket detail, empty kickoff chat
  Thread A: acceptance criteria review, comments tab open
  Thread B: implementation handoff, linked repo selected
  Thread C: QA plan, attachments expanded
```

When clicking back to the parent, the app should restore the default parent route state,
not the last child thread state.

## Current View Context

Every side-panel send should attach a fresh snapshot of what the user is currently
viewing.

The snapshot should be created at send time, not when the panel mounted.

Context examples:

- project id
- route/view type
- parent attachment point
- context-bound thread id when present
- ticket id
- backlog mode
- backlog filters
- sorting/grouping
- visible work item refs
- selected work item refs
- linked repository refs relevant to the view
- short human-readable context summary

Example:

```text
View: ticket detail
Context: PROJ-123, comments, GitHub activity, linked PRs, selected attachments
User: "write test ideas"
```

The agent should receive enough context to act without asking the user to repeat what is
already visible.

## Agent-Started Handoffs

Handoffs are always agent-started.

There is no separate manual handoff UI for the MVP. A user can still ask the active
agent to start a handoff in natural language.

Example:

```text
User: "start a handoff to inspect the payment repo."
Agent uses tool: t3work.thread.start_child
Child thread appears under the selected work item or parent thread.
User stays on current page.
```

## Handoff Tool

The provider tool should create a child thread and optionally start its first turn.

Effective live tool shape:

```ts
type StartChildThreadInput = {
  name: string;
  execution_scope: "metarepo" | "repository";
  kickoff_prompt?: string;
  kickoff_mode?: "plan" | "interactive" | "autopilot";
  model?: string;
  reasoning_effort?: "low" | "medium" | "high";
  repo_full_name?: string;
  repo_ref?: string;
};

type StartChildThreadResult = {
  ok: true;
  project_id: string;
  project_session_id: string;
  name: string;
  execution_scope: "metarepo" | "repository";
  started: boolean;
  interaction_mode: "plan" | "default";
  runtime_mode: "approval-required" | "auto-accept-edits" | "full-access";
  model: string;
  requested_kickoff_mode?: "plan" | "interactive" | "autopilot";
  reasoning_effort?: string;
  repo_full_name?: string;
  branch?: string;
  worktree_path?: string;
  setup_script_status: "not-requested" | "no-script" | "started" | "failed";
  navigate_to: {
    target: "project_session";
    project_session_id: string;
  };
  startup_error?: string;
};
```

Rules:

- no user approval required for MVP
- child thread is created in background
- current page does not navigate
- `execution_scope` is required on every call
- `execution_scope: "repository"` requires `repo_full_name`, selects a linked repository, and creates a fresh worktree/branch
- `execution_scope: "metarepo"` forbids `repo_full_name` and `repo_ref`, and keeps the child in the project metarepo workspace
- `kickoff_prompt` is optional; when present, the first turn starts immediately
- a recipe-owned kickoff flow may still pause after thread creation and wait for a structured kickoff submission before the first agent turn starts
- durable handoff activity cards are recorded on both the parent and child threads
- server validates project, repository, and workspace access

First live-slice limitation:

- visual parent-thread and work-item attachment metadata is not persisted yet
- child sessions are currently linked through project membership plus durable activity/result metadata
- true nested parent-thread or ticket attachment remains a follow-up schema/UI change

## Workspace And Worktree Policy

Default depends on the task.

If the handoff is repository work, call `t3work.thread.start_child` with
`execution_scope: "repository"`, a linked `repo_full_name`, and a new worktree.

Example:

```text
Goal: "Fix flaky checkout tests in repo payments-api."
Workspace: linked repository payments-api, new worktree required.
```

If the handoff is meta-level project work, call `t3work.thread.start_child` with
`execution_scope: "metarepo"` and no repository fields. The project metarepo is the
workspace that holds project context, references, recipes, skills, and synthesis outputs;
it is not a linked implementation repository.

Example:

```text
Goal: "Summarize cross-ticket sprint risk."
Workspace: project metarepo workspace, no repository worktree.
```

Because a `t3work` project may link multiple repositories, the handoff tool must make
the workspace choice explicit.

## Attachment Point And Navigation

Child threads can attach to different visual parents.

Target parents for the full design:

- parent chat thread
- project
- work item
- backlog or my-work view
- later: artifact, pull request, saved filter

Example:

```text
Agent: create new thread under work item PROJ-123.
Result: child appears below PROJ-123 in navigation and receives PROJ-123 context.
```

The first live slice creates project-level child sessions and links them back to the
parent through durable activity cards. Persisted work-item or parent-thread placement
still needs an explicit metadata extension before the UI can render those children under
their visual parent.

## Cross-Thread Messaging

Handoff threads need durable bidirectional communication.

The first version should model this as explicit cross-thread events, not hidden prompt
state.

Message kinds:

- brief
- status
- question
- result
- blocked

Example:

```text
Parent -> child: "Inspect checkout tests and report root cause."
Child -> parent: "Blocked: linked repo auth missing."
Child -> parent: "Done: failure is stale fixture data."
```

Messages should appear in both timelines as typed activity cards.

## MVP Order

1. Embed full chat in the side panel.
2. Make kickoff create a context-bound thread without leaving the current data view.
3. Update routes so context-bound thread URLs preserve the parent view.
4. Render context-bound threads under the current project, backlog, my-work, or work item.
5. Persist per-thread data-view state.
6. Attach fresh current-view context on every send.
7. Add agent tool for child thread creation.
8. Add linked-repository worktree selection to the tool contract.
9. Add durable cross-thread messages.
10. Add view-control tools later, such as backlog filter changes and saved filters.

Tool and mutation behavior is defined in
[Epic 07: Skill Tools And Mutations](./07-skill-tools-and-mutations.md). Context-bound
chat should use that model: read tools are scoped to the current view, agent mutations
become live UI drafts, and only user UI actions commit external writes.

## Non-Goals

- no manual handoff button or wizard in MVP
- no hidden child thread creation without durable events
- no required thread selector inside the side panel
- no repository work without explicit repository/worktree choice
- no replacement for the full thread page
- no view mutation tools until the embedded chat and handoff model is stable

## Risks

- The side panel can become cramped.
  Use a compact chat variant and keep the full thread page available.

- Context can be stale.
  Build context at send time.

- Agent-created threads can become noisy.
  Require durable creation events, visible navigation placement, and clear parent links.

- Multi-repository workspace choice can be wrong.
  Make the tool input explicit and validate it server-side.
