# Epic 21: Context Tool Catalog

## Direction

Context-bound chat should expose tools that match what the visible `t3work` UI can do.
The agent may also get one level lower than the UI when the result still reflects cleanly
in the UI.

Good tool:

```text
Agent sets backlog to a JQL-backed saved filter.
Backlog visibly switches to that filter.
```

Bad tool:

```text
Agent mutates hidden Jira state that no visible surface can explain or review.
```

Tool outputs and mutations must stay reflectable in the current view.

## One Shared Surface

This catalog is the **Tools** primitive — one of the four shared primitives (Context,
Tools, Workflows, Views) the rest of `t3work` is built on. There is a single tool surface,
brokered by `T3workToolBroker`, consumed identically by:

- **agent turns** (the original consumer),
- **workflow `tool`/`script` steps** in action recipes ([Epic 16](./16-action-recipes.md)),
- **miniapp/View tool bridges** ([Epic 19](./19-workspace-miniapps.md)).

Tools began as agent-scoped capabilities, but scripts, workflows, and Views all bind to the
_same_ registry rather than getting parallel APIs. A recipe's `allowedToolGroups` scopes
this surface for everything that recipe runs, and is the single enforcement point for
stage-2 sandboxing. Pre-launch code (recipe visibility, View pre-render) binds in a
no-thread, read-only mode — read tools and resource reads only, no view-state or mutation
tools.

## Context Files First

`t3work` already has a context attachment model. Attached context is written into the
managed project workspace under `.t3work/context/...`, then the agent can read those
files through normal workspace file access.

That should be the primary read substrate for broad context.

Example:

```text
Ticket detail context is attached.
Files are written under .t3work/context/jira/<project>/items/<key>/...
Agent reads those files directly.
```

This means many "read" tools should not duplicate cached context files. Prefer context
attachments when the agent needs the current project, work item, GitHub activity, or
artifact bundle.

Current project workspace sync behavior:

- project metadata and linked repository URLs are written for work projects with a managed
  workspace root
- loaded Jira/backlog resources are written as per-item files plus `work-items/index.json`
  only after the relevant view reports loaded data; pre-load empty arrays are not published
- visible project thread lists are written when project, dashboard, ticket, or standalone
  thread routes are opened
- visible backlog and my-work state is written from the mounted dashboard views; my-work also
  writes loaded GitHub activity when available
- `.t3work/context/entrypoint.json`, `.t3work/context/manifest.json`, and
  `.t3work/context/.sync-commit.json` record paths and sync/commit timestamps for readers

Sync is best-effort but durable while the relevant UI state is mounted. Requests are
debounced per workspace root, repeated payloads are coalesced, and a newer payload replaces
any older queued payload before it writes. Writes are serialized per workspace root, so an
older in-flight write is followed by the latest queued payload instead of racing it. Failed
writes move the internal sync state to `failed`, reject the first attempt for logging, and
retry with bounded backoff while the route/view remains mounted; remounting or changing the
input enqueues again and resumes the attempt. The server writes each file through a temp file
and rename, then writes the commit marker last.

Known limits: the client does not read the existing on-disk files before each render, failed
sync status is currently internal/log-only, and the commit marker is a batch completion hint
rather than a transactional directory swap. If the app is closed before a retry succeeds, the
next mount/input change is what resumes the write.

Read tools are still useful when they do one of these:

- refresh or resync the context cache
- answer a narrow query without attaching a large bundle
- expose live view state that is not in files yet
- run lower-level integration queries such as JQL preview
- return small enumerations for UI choices, such as boards, sprints, saved filters, or
  assignable users
- resolve a target before writing a draft mutation

Rule:

```text
If the information is stable enough to attach, write/update context files.
If the information is query-like, live, tiny, or UI-state-specific, use a read tool.
```

Required freshness behavior:

- context-bound thread kickoff attaches a fresh view snapshot
- every side-panel send should check whether attached context is stale
- views that poll or refresh integrations should update the corresponding context bundle
- read tools that return data already cached should include freshness metadata
- agents should see file paths and `syncedAt` timestamps for attached context

## Tool Classes

Read tools:

- safe by default
- scoped to current view or registered element
- no approval
- may refresh visible data or context files
- should prefer returning file references when a context bundle already exists

View-state tools:

- change local route/view state
- safe by default
- reflected immediately in controls, URL, or persisted view state
- examples: filter, sort, group, open ticket, switch view mode

Draft mutation tools:

- create visible local drafts
- never commit external writes directly
- user accepts inline or with `Save all`

External convenience tools:

- may create durable user-owned app objects when low risk
- must open or select the result immediately
- examples: create Jira saved filter and select it

## Project-Level Tools

Current UI basis:

- project dashboard mode switch
- linked repository manager
- project-level GitHub activity
- project context bundle
- project sidebar and thread creation

Useful tools:

```text
t3work.project.attach_context_bundle
t3work.project.refresh_context_bundle
t3work.project.list_linked_repositories
t3work.project.open_dashboard_mode
t3work.project.open_linked_repository_manager
t3work.project.refresh_integrations
t3work.project.create_context_bound_thread
```

Notes:

- `open_dashboard_mode` is a view-state tool. It switches between backlog and my-work.
- `open_linked_repository_manager` opens existing UI, not a hidden mutation.
- `create_context_bound_thread` creates a thread under the current project or view.

## Backlog View Tools

Current UI basis:

- query search
- assignee filter
- Jira saved filter selection
- sprint board selection
- sprint selection
- refresh data
- view modes: hierarchy, planning, table, ownership
- focus filters
- table grouping
- table sorting and direction
- visible table columns
- collapse or expand groups
- visible ticket list
- inline assignee update
- inline estimate update
- create subtask

Read tools:

```text
t3work.backlog.attach_view_context
t3work.backlog.refresh_view_context
t3work.backlog.read_view_state
t3work.backlog.list_visible_items
t3work.backlog.read_hierarchy
t3work.backlog.read_planning_lanes
t3work.backlog.read_ownership_groups
t3work.backlog.read_table_state
t3work.backlog.list_boards
t3work.backlog.list_sprints
t3work.backlog.list_saved_filters
t3work.backlog.search_assignable_users
```

Use context files for larger loaded item data. Use the list/read tools for current view
state, derived UI presentations, and small query results.

View-state tools:

```text
t3work.backlog.set_query
t3work.backlog.set_assignee_filter
t3work.backlog.set_saved_filter
t3work.backlog.set_board
t3work.backlog.set_sprint
t3work.backlog.set_view_mode
t3work.backlog.set_focus_filter
t3work.backlog.set_table_grouping
t3work.backlog.set_table_sort
t3work.backlog.set_visible_columns
t3work.backlog.collapse_groups
t3work.backlog.expand_groups
t3work.backlog.refresh
t3work.backlog.open_item
```

Draft mutation tools:

```text
t3work.backlog.item.assignee.draft_update
t3work.backlog.item.estimate.draft_update
t3work.backlog.item.subtask.draft_create
```

Near-term lower-level Jira tools:

```text
t3work.backlog.jql.preview
t3work.backlog.jql.open
t3work.backlog.saved_filter.draft_create
t3work.backlog.saved_filter.create_and_open
```

`jql.preview` returns a count and sample issue keys before opening the result. `jql.open`
loads the backlog from a JQL selection and reflects it in the backlog controls as a custom
query-backed view.

`saved_filter.create_and_open` may be automatic when it only creates a new Jira saved
filter for the current user and then selects it in the backlog. It should still create a
visible activity event because it writes an external user-owned object.

Examples:

```text
User: "Show only unassigned bugs in review or QA."
Agent:
  t3work.backlog.jql.preview
  t3work.backlog.saved_filter.create_and_open
Result:
  Backlog selects "Unassigned review bugs" and shows matching issues.
```

```text
User: "Put these three subtasks at 2h each."
Agent:
  t3work.backlog.item.estimate.draft_update x3
Result:
  Three rows show dirty estimate values with check and X controls.
```

## My Work View Tools

Current UI basis:

- text query
- view modes: grid, list, kanban
- grouping: hierarchy or flat
- status category
- show/hide Jira items
- show/hide GitHub activity
- advanced filters: type, priority, exact status
- reset filters
- open work item
- visible work items
- unmatched GitHub activity

Read tools:

```text
t3work.my_work.attach_view_context
t3work.my_work.refresh_view_context
t3work.my_work.read_view_state
t3work.my_work.list_visible_items
t3work.my_work.list_metrics
t3work.my_work.list_kanban_columns
t3work.my_work.read_parent_child_groups
t3work.my_work.list_github_activity
t3work.my_work.list_unmatched_github_activity
```

View-state tools:

```text
t3work.my_work.set_query
t3work.my_work.set_view_mode
t3work.my_work.set_group_mode
t3work.my_work.set_status_category
t3work.my_work.set_show_jira_items
t3work.my_work.set_show_github_activity
t3work.my_work.set_type_filter
t3work.my_work.set_priority_filter
t3work.my_work.set_exact_status_filter
t3work.my_work.reset_advanced_filters
t3work.my_work.open_item
```

Draft mutation tools should reuse item-level tools when the target is a Jira work item:

```text
t3work.work_item.assignee.draft_update
t3work.work_item.estimate.draft_update
t3work.work_item.status.draft_update
```

Examples:

```text
User: "Show my review work as a kanban."
Agent:
  t3work.project.open_dashboard_mode({ mode: "my-work" })
  t3work.my_work.set_status_category({ value: "review" })
  t3work.my_work.set_view_mode({ value: "kanban" })
```

## Work Item Detail Tools

Current UI basis:

- ticket metadata
- parent and related links
- description
- attachments
- comments
- GitHub activity section
- activity/context bundles
- reload ticket detail
- open related ticket

Read tools:

```text
t3work.work_item.attach_context_bundle
t3work.work_item.refresh_context_bundle
t3work.work_item.read_view_state
t3work.work_item.read_attachment
t3work.work_item.reload
```

Metadata, description, comments, relationships, and GitHub activity should normally come
from the attached work-item context bundle. Dedicated read tools are for refreshing,
view state, or individual assets that are not already present in text form.

View-state tools:

```text
t3work.work_item.open_related_item
t3work.work_item.focus_section
t3work.work_item.expand_section
t3work.work_item.create_context_bound_thread
```

Draft mutation tools:

```text
t3work.work_item.description.draft_update
t3work.work_item.comment.draft_create
t3work.work_item.status.draft_update
t3work.work_item.assignee.draft_update
t3work.work_item.estimate.draft_update
t3work.work_item.priority.draft_update
t3work.work_item.labels.draft_update
t3work.work_item.link.draft_create
t3work.work_item.attachment.draft_add
```

MVP should start with tools already close to implemented backend behavior:

- comment draft create
- assignee draft update
- estimate draft update
- subtask draft create

Description, status, priority, labels, links, and attachments need edit metadata and
field capability checks before being exposed.

Example:

```text
User: "Rewrite this description as acceptance criteria."
Agent:
  t3work.work_item.read_description
  t3work.work_item.description.draft_update
Result:
  Description section shows proposed replacement inline with accept and discard controls.
```

## GitHub Activity Tools

Current UI basis:

- linked repositories
- project GitHub activity
- matched activity per work item
- unmatched activity section
- pull request context bundles and assets

Read tools:

```text
t3work.github.attach_activity_context
t3work.github.refresh_activity_context
t3work.github.list_linked_repositories
t3work.github.list_project_activity
t3work.github.list_work_item_activity
t3work.github.read_pull_request_context
t3work.github.read_pull_request_files
t3work.github.read_pull_request_assets
t3work.github.list_unmatched_activity
```

View-state tools:

```text
t3work.github.open_activity_item
t3work.github.attach_activity_to_chat
t3work.github.link_activity_to_work_item.draft_update
```

Commit behavior:

- reading PR context is safe
- linking GitHub activity to a work item should be a visible draft first unless it only
  updates local matching metadata
- GitHub comments, reviews, labels, or PR changes are external mutations and need draft
  UI first

## GitHub Pull Request Workspace Tools

These tools extend GitHub activity from a context attachment surface into a first-class
PR workspace.

Current UI basis:

- PR detail page with pinned gates and actions
- diff workspace with file tree, search, and unresolved-thread navigation
- selection-aware chat and handoff entry points
- recipe launchers on PR detail, diff selection, and review comment threads

Read tools:

```text
t3work.github.read_pull_request_overview
t3work.github.read_pull_request_activity
t3work.github.read_pull_request_checks
t3work.github.read_pull_request_file_tree
t3work.github.read_pull_request_diff_manifest
t3work.github.read_pull_request_diff_chunk
t3work.github.read_pull_request_selection_context
t3work.github.read_review_thread
t3work.github.read_check_run_details
```

View-state tools:

```text
t3work.github.open_pull_request
t3work.github.select_pull_request_item
t3work.github.set_pull_request_activity_filters
t3work.github.set_pull_request_diff_filters
t3work.github.attach_pull_request_selection_to_chat
t3work.github.start_child_from_pull_request_selection
```

Draft mutation tools:

```text
t3work.github.issue_comment.draft_create
t3work.github.review_comment.draft_create
t3work.github.review_reply.draft_create
t3work.github.review_summary.draft_create
t3work.github.reviewers.draft_update
```

Commit behavior:

- reading PR detail, diff, checks, and selection context is safe
- comment, reply, review-summary, reviewer, and label changes stay draft-first
- repository file changes stay in session/worktree flows, not direct PR UI mutation
- multi-comment review submissions should be previewed as a review package before commit

## Thread And Handoff Tools

Context-bound chat and standalone chat share thread tools.

Useful tools:

```text
t3work.view.read
t3work.thread.rename
t3work.thread.read_current
t3work.thread.rename.draft_update
t3work.thread.create_context_bound
t3work.thread.start_child
t3work.thread.send_cross_thread_message
t3work.thread.attach_context
t3work.thread.open_full_page
```

`t3work.view.read`, `t3work.thread.rename`, and `t3work.thread.start_child` are the
current live runtime slice used by the broker implementation. The rest of this section
remains planned catalog scope.

`t3work.thread.start_child` keeps the `t3work` tool id, but uses session-style input and
result vocabulary aligned with Copilot session tooling:

- `name` for the child session title
- required `execution_scope` (`metarepo` or `repository`)
- optional `kickoff_prompt`
- optional `kickoff_mode` (`plan`, `interactive`, `autopilot`)
- optional `model` and `reasoning_effort`
- `repo_full_name` required for `repository` scope and forbidden for `metarepo` scope
- result metadata including `project_session_id`, navigation hint, and repo/worktree details

`metarepo` means the project workspace that holds project context, references, recipes,
skills, and cross-repository synthesis. `repository` means a linked implementation
repository and always runs in a dedicated worktree.

The first live slice creates project-level child sessions with durable parent/child
activity cards. Visual parent-thread or work-item attachment metadata remains planned.

`start_child` is agent-started and does not require user approval in the MVP. The created
child thread must be visible in navigation and receive the chosen context immediately.

## Tool Safety Matrix

```text
Read current view data             auto-run
Change local view state            auto-run
Refresh visible data               auto-run
Create Jira saved filter + open    auto-run, visible activity event
Create local thread/context        auto-run, visible navigation/event
Draft Jira field edit              auto-draft, user commits
Commit Jira field edit             UI action only
Post Jira/GitHub comment           UI action only
Change Jira status/priority        draft first, UI action only
Change repository files            standalone agent/worktree flow
```

## Implementation Notes

Start from existing code paths:

- `t3work-agentContext.ts` already defines add-to-chat style capabilities.
- `t3work-contextAttachmentSync.ts` writes context attachments into the managed workspace.
- `t3work-contextAttachmentSyncPlan.ts` already models sync plans and freshness progress.
- `t3work-threadToolContext.ts` already defines a small thread tool context.
- `ProjectDashboardBacklogView` owns backlog view state and handlers.
- `useProjectBacklog` exposes board, sprint, saved filter, refresh, assignee, estimate,
  and subtask actions.
- `ProjectDashboardMyWorkView` owns my-work filters and mode state.
- `TicketDetailMainColumn` already registers section context menus for metadata,
  parent, description, attachments, comments, references, and GitHub activity.

The next implementation should grow the common registry behind `T3workToolBroker` so these
surfaces expose tools without each tool calling component state directly. The broker already
binds a per-thread tool surface for agents; scripts, workflow steps, and Views bind to the
same registry (with a no-thread, read-only binding for pre-launch code).

Recommended flow:

```text
view/element registers tools
-> context-bound thread receives tool manifest + view snapshot
-> agent calls tool
-> tool dispatcher validates scope
-> read/view-state/draft mutation store updates
-> UI re-renders from normal state
```
