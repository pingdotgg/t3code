# GitHub Panel Context And Promotion Phases

Date: 2026-03-09
Status: active
Owner: web

## Intent

Track the phased overhaul for GitHub panel correctness, workspace awareness, repo switching, responsiveness, and promotion state integration.

## Progress

| Phase | Goal | Status | Checks | Commit | Notes |
| --- | --- | --- | --- | --- | --- |
| 1 | Define canonical panel context and scope ownership | DONE | PASS | `refactor(web): define canonical github panel context` | Repo scope and workspace scope are explicit |
| 2 | Reset stale panel state and query results on context change | DONE | PASS | `fix(web): reset github panel state on context changes` | Context switches now clear local panel state and force a fresh fetch |
| 3 | Make project and thread switching rules explicit | DONE | PASS | `refactor(web): align project clicks with panel scope` | Project header clicks now activate that project thread context |
| 4 | Split panel into repo and workspace sections and improve responsiveness | TODO | TODO | TODO | Improve overflow handling, stacking, and density |
| 5 | Integrate promotion state and next action guidance | TODO | TODO | TODO | Apply the workflow spec to the active workspace card |

## Phase 1

### Goal

Create one canonical context model for the GitHub panel and make ownership of repo scoped data and workspace scoped data explicit.

### Detailed implementation plan

| Step | Change | Files | Done criteria |
| --- | --- | --- | --- |
| 1.1 | Add a pure `GitPanelContext` resolver with explicit repo root, workspace cwd, project id, workspace kind, and context key | `apps/web/src/lib/gitPanelContext.ts` | DONE |
| 1.2 | Update `ChatView` to derive and pass the canonical panel context | `apps/web/src/components/ChatView.tsx` | DONE |
| 1.3 | Refactor `GitHubPanel` props to use explicit `repoRoot` and `workspaceCwd` naming | `apps/web/src/components/GitHubPanel.tsx` | DONE |
| 1.4 | Key the panel by context identity at the mount site | `apps/web/src/components/ChatView.tsx` | DONE |
| 1.5 | Add focused tests for the resolver if adjacent test patterns exist | `apps/web/src/lib` | DONE |

### Implementation notes

- Repo scoped GitHub queries must use repo root only
- Workspace scoped Git queries and mutations must use workspace cwd only
- The context key should include project id, repo root, workspace cwd, and active thread id
- Phase 1 should not reshape the panel layout yet

### Validation

- `bun lint`
- `bun typecheck`
- `bun run test -- --run src/lib/gitPanelContext.test.ts` from `apps/web`

## Phase 2

### Goal

Eliminate stale panel state after thread changes, project changes, worktree creation, worktree removal, and merge actions.

### Detailed implementation plan

| Step | Change | Files | Done criteria |
| --- | --- | --- | --- |
| 2.1 | Reset merge and issue filter state when panel context changes | `apps/web/src/components/GitHubPanel.tsx` | DONE |
| 2.2 | Audit Git and GitHub query invalidation after branch and worktree mutations | `apps/web/src/lib/gitReactQuery.ts`, `apps/web/src/lib/githubReactQuery.ts` | DONE |
| 2.3 | Review `keepMounted` behavior and tighten remount rules | `apps/web/src/components/ChatView.tsx` | DONE |
| 2.4 | Fix live branch display to prefer current Git facts over stale thread metadata | `apps/web/src/components/GitHubPanel.tsx`, `apps/web/src/components/BranchToolbar.tsx`, `apps/web/src/components/ChatView.tsx` | DONE |

### Validation

- Switch between threads in the same project without stale merge state
- Switch between projects without stale repo slug or branch labels
- `bun lint`
- `bun typecheck`

## Phase 3

### Goal

Make the active entity rules explicit so the panel consistently follows the intended thread or project.

### Detailed implementation plan

| Step | Change | Files | Done criteria |
| --- | --- | --- | --- |
| 3.1 | Define active panel scope rules for thread scoped and project scoped views | `apps/web/src/lib/gitPanelContext.ts`, `docs/workspace_promotion_spec.md` | DONE |
| 3.2 | Audit sidebar project clicks and thread selection behavior | `apps/web/src/components/Sidebar.tsx` | DONE |
| 3.3 | Add explicit UI copy that names the current panel scope | `apps/web/src/components/GitHubPanel.tsx` | DONE |
| 3.4 | Ensure empty project states and draft thread states resolve correctly | `apps/web/src/components/ChatView.tsx`, `apps/web/src/components/GitHubPanel.tsx` | DONE |

### Validation

- Click between projects and verify the panel scope rule holds
- Create a new draft thread in another project and verify scope changes cleanly
- `bun lint`
- `bun typecheck`

## Phase 4

### Goal

Separate repo and workspace concerns in the layout and make the panel responsive under narrow and wide widths.

### Detailed implementation plan

| Step | Change | Files | Done criteria |
| --- | --- | --- | --- |
| 4.1 | Split the panel into repo, workspace, actions, auth, and issues sections | `apps/web/src/components/GitHubPanel.tsx` and child components | Each section has one clear scope |
| 4.2 | Rework long branch and path presentation | `apps/web/src/components/GitHubPanel.tsx` | Long values no longer collide with buttons or badges |
| 4.3 | Stack merge controls and action groups for narrow widths | `apps/web/src/components/GitHubPanel.tsx` | Narrow sheet and rail layouts stay readable |
| 4.4 | Collapse low priority metadata behind a disclosure area | `apps/web/src/components/GitHubPanel.tsx` | High value actions remain visible without overload |
| 4.5 | Polish loading and refresh affordances on context switch | `apps/web/src/components/GitHubPanel.tsx` | State changes feel intentional rather than stale |

### Validation

- Verify narrow sheet layout
- Verify standard rail layout
- Verify long branch and path values remain readable
- `bun lint`
- `bun typecheck`

## Phase 5

### Goal

Integrate promotion state into the active workspace card and make next action guidance explicit.

### Detailed implementation plan

| Step | Change | Files | Done criteria |
| --- | --- | --- | --- |
| 5.1 | Add a pure promotion state calculator from Git facts | `apps/web/src/lib/workspacePromotionState.ts` | State derives from facts rather than local UI state |
| 5.2 | Add overlays for publish and review status | `apps/web/src/components/GitHubPanel.tsx` | Delivery overlays appear without replacing core promotion state |
| 5.3 | Show next suggested action by state | `apps/web/src/components/GitHubPanel.tsx` | Each state has one obvious next step |
| 5.4 | Surface conflict resolution as a first class state | `apps/web/src/components/GitHubPanel.tsx` | Conflict actions outrank normal merge actions |
| 5.5 | Draft short thread guidance on state changes | `apps/web/src/components/GitHubPanel.tsx` or adjacent helper | Conversation guidance aligns with workspace state |

### Validation

- Verify seeded, draft, committed, needs sync, conflicted, ready, merged, and retired cases
- Verify loop closure rules after merge
- `bun lint`
- `bun typecheck`

## Commit strategy

Use one focused commit per phase.

Recommended subjects:

- `design(web): phase github panel context and promotion overhaul`
- `refactor(web): define canonical github panel context`
- `fix(web): reset stale github panel state on context changes`
- `refactor(web): align project switching with panel scope rules`
- `design(web): reorganize github panel layout for responsive workspace flows`
- `feat(web): derive workspace promotion state in github panel`
