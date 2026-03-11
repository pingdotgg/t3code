# Plan: Refactor Git Panel Boundaries

## Summary

Refactor the Git panel into a thin container with clear section, dialog, hook, and logic boundaries. Keep behavior stable while reducing file size, lowering review cost, and making workflow ownership easier to reason about.

## Boundary Definitions

- **Container**
  - `GitPanel` owns feature composition, query wiring, mutation wiring, and cross section coordination.
  - It passes derived state and command callbacks to children.
  - It does not own large section JSX blocks.
- **Primitives**
  - Small view only pieces such as status indicators, section chrome, copyable paths, and workspace cards.
  - No data fetch, store writes, routing, or workflow orchestration.
- **Sections**
  - One component per major area such as primary actions, workspace, sync, GitHub auth, and issues.
  - Sections render derived state and emit user intent.
  - Sections do not own navigation, query invalidation, or store mutation.
- **Dialogs**
  - One component per dialog for commit, default branch confirmation, and promote confirmation.
  - Dialogs own only local form state and submit or cancel events.
  - Dialogs do not access query hooks or stores directly.
- **Hooks**
  - Hooks own imperative workflows that span navigation, native API access, toasts, stores, and mutations.
  - Hooks return narrow commands and derived status.
  - Hooks do not render JSX.
- **Pure logic**
  - Stateless derivation helpers remain in pure modules.
  - They produce labels, guard reasons, prompts, and summaries from typed inputs.
- **Chat view**
  - `ChatView` owns mount location, open state, and repo or thread context selection.
  - It does not know section internals.
- **Query layer**
  - Query option factories stay in `gitReactQuery` and `githubReactQuery`.
  - Section components consume prepared data or callbacks rather than constructing query options.

## Boundary Rules

- A section may render data and emit intent.
- A section may not own store writes or navigation.
- A dialog may own local draft state.
- A dialog may not own query invalidation or toast policy.
- A hook may coordinate platform services and workflows.
- A hook may not render JSX.
- A pure logic module may derive data.
- A pure logic module may not call hooks or access browser APIs.
- The container may compose hooks, sections, and dialogs.
- The container should stay shallow and orchestration focused.

## Boundary Violation Map

| Area | Current state | Violation | Target |
| --- | --- | --- | --- |
| Container and section rendering | `apps/web/src/components/GitHubPanel.tsx` renders all major sections directly | Composition and section ownership are fused | Move each major area into a dedicated section component |
| Imperative workflows | One file owns worktree routing, merge orchestration, PR opening, native editor open, external links, and toast policy | Too many reasons to change in one component | Extract workflow hooks by domain |
| Dialog ownership | Main panel renders all dialog internals | Dialog contracts are coupled to broad panel state | Extract standalone dialog components with narrow props |
| Primitive view pieces | Small view components live inside the main panel file | Reusable leaf UI is trapped in the largest feature file | Move primitives into local component files |
| Reset ownership | Parent remount uses `contextKey` and panel also runs a broad reset effect | Lifecycle reset semantics are duplicated | Assign one reset owner per state slice |
| Naming | `GitHubPanel` now covers far more than GitHub specific behavior | Feature name no longer matches scope | Rename to `GitPanel` |
| Public contract drift | `scopeKind` is passed and ignored | Prop surface is not truthful | Remove it or make it drive behavior |
| Type naming | Props still use `GitActionsControlProps` | Stale name obscures ownership | Rename to a panel specific prop type |
| Section guard placement | Many disabled reason rules live in the container | Section rules sit in the composition layer | Move rules near section view models |
| Thread routing mix | Thread and draft routing is mixed with Git workflows | Reliability sensitive routing is not isolated | Extract thread workspace routing hook |

## Target Shape

- **Container**
  - `GitPanel`
- **Hooks**
  - `useGitPanelData`
  - `useGitPanelThreadRouting`
  - `useGitPanelWorkspaceActions`
  - `useGitPanelMergeActions`
  - `useGitPanelGitHubActions`
- **Sections**
  - `GitPanelHeader`
  - `GitPrimaryActionsSection`
  - `GitWorkspaceSection`
  - `GitSyncSection`
  - `GitHubAuthSection`
  - `GitHubIssuesSection`
- **Dialogs**
  - `GitCommitDialog`
  - `GitDefaultBranchDialog`
  - `GitPromoteDialog`
- **Primitives**
  - `GitPanelSection`
  - `GitStatusDot`
  - `GitCopyablePath`
  - `GitWorkspaceCard`

## Validation Gate

Run these checks after each phase:

- `bun fmt`
- `bun lint`
- `bun typecheck`

## Phase 1

| Progress | Workstream | Scope | Exit criteria |
| --- | --- | --- | --- |
| Done | Rename and reframe | Rename `GitHubPanel` to `GitPanel` and rename stale panel types | Naming and imports reflect actual feature scope |
| Done | Create feature folder | Add a `git-panel` folder for sections, dialogs, hooks, and primitives | Local feature structure exists with no behavior change |
| Done | Extract primitives | Move `StatusDot`, `CopyablePath`, `Section`, and `WorkspaceCard` into local files | Main container loses leaf view code |
| Done | Verify checks | Run formatting, lint, and typecheck | Validation gate passes |

## Phase 2

| Progress | Workstream | Scope | Exit criteria |
| --- | --- | --- | --- |
| Done | Extract dialogs | Move commit, default branch, and promote dialogs into standalone components | Main container no longer renders dialog internals |
| Done | Narrow contracts | Pass only dialog specific props, open state, and submit callbacks | Dialogs have no query or store access |
| Done | Clarify state ownership | Keep only the needed open state and dialog draft state at the right layer | Dialog lifecycle is easy to reason about |
| Done | Verify checks | Run formatting, lint, and typecheck | Validation gate passes |

## Phase 3

| Progress | Workstream | Scope | Exit criteria |
| --- | --- | --- | --- |
| Done | Extract workspace section | Move workspace card, dedicated workspace actions, and primary checkout attention flow | Workspace behavior lives in one section component |
| Done | Extract sync section | Move merge source picker, conflict banner, abort flow, and last merge result | Sync behavior lives in one section component |
| Done | Move section guards | Relocate section specific disabled reason logic near section view models | Container no longer owns most section guard logic |
| Done | Verify checks | Run formatting, lint, and typecheck | Validation gate passes |

## Phase 4

| Progress | Workstream | Scope | Exit criteria |
| --- | --- | --- | --- |
| Not started | Extract GitHub sections | Move auth and issues into separate section components | GitHub specific behavior is isolated from workspace flows |
| Not started | Isolate GitHub actions | Create a GitHub focused hook or controller for auth verify, login, issue fetch, and repo links | GitHub sections are mostly declarative |
| Not started | Reduce container breadth | Keep the main file as a composition shell | Main file is materially smaller and easier to scan |
| Not started | Verify checks | Run formatting, lint, and typecheck | Validation gate passes |

## Phase 5

| Progress | Workstream | Scope | Exit criteria |
| --- | --- | --- | --- |
| Not started | Extract workflow hooks | Move thread routing, worktree lifecycle, merge flows, and stacked action orchestration into hooks | Container owns composition and hooks own workflows |
| Not started | Resolve reset boundary | Remove redundant reset logic where remount already defines lifecycle | Each state slice has one reset owner |
| Not started | Decide `scopeKind` fate | Remove unused prop or make it drive visible behavior | Public prop surface is truthful |
| Not started | Verify checks | Run formatting, lint, and typecheck | Validation gate passes |

## Phase 6

| Progress | Workstream | Scope | Exit criteria |
| --- | --- | --- | --- |
| Not started | Add focused tests | Add or update tests around extracted hooks and section logic where useful | Critical workflows are covered at the new boundaries |
| Not started | Review dependency direction | Confirm section, hook, and logic dependency flow is correct | Expected boundary rules are reflected in code structure |
| Not started | Document final structure | Update the plan with final progress and any follow up notes | The refactor story is easy to follow |
| Not started | Verify checks | Run formatting, lint, and typecheck | Validation gate passes |

## Done Criteria

- `GitPanel` is a thin composition shell.
- Major sections live in their own files.
- Dialogs live in their own files.
- Workflow heavy logic lives in hooks.
- Pure derivation logic stays in pure modules.
- `bun fmt` passes.
- `bun lint` passes.
- `bun typecheck` passes.
