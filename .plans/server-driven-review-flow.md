# Implementation Plan: Server-Driven PR Review Flow

## Executive Summary

Replace the current frontend-orchestrated PR review flow (8+ sequential WS round-trips with user-visible spinners) with a single server-side operation. The frontend sends one request (`reviewRequest.startReview`) and receives back a `threadId` immediately. The server handles all setup (project resolution, cloning, worktree creation, thread creation, review linking, agent kickoff) and pushes progress via existing orchestration events. The chat view naturally renders agent progress as it arrives.

**Key deliverables:**
- New `reviewRequest.startReview` WS method (server)
- New server-side `ReviewFlowOrchestrator` module that composes existing services
- Simplified frontend: dialog becomes a thin "starting review..." indicator
- Agent auto-kickoff: the review agent starts automatically, no manual trigger needed

**Success criteria:**
- Review start is a single WS call from the frontend
- User sees the chat view within ~200ms of clicking "Start Review"
- Agent begins working while worktree setup completes in the background
- All error states are surfaced via existing orchestration events
- `bun fmt`, `bun lint`, and `bun typecheck` pass

---

## Repository Context

### Technology Stack
- **Server:** Node.js + Effect-TS, WebSocket-based RPC
- **Web:** React + Vite, TanStack Router/Query, Zustand stores
- **Contracts:** Effect/Schema shared type definitions
- **Persistence:** SQLite via effect/sql

### Current Flow (Frontend-Orchestrated)

The `StandaloneReviewPrDialog.tsx` component runs this sequential pipeline:

1. Validate PR URL, extract repo URL
2. Match repo URL to existing project via `githubUrlByProjectId` map
3. If no match: clone repo via `git.cloneRepo`, create project via `orchestration.dispatchCommand(project.create)`
4. Fetch PR details via `git.fetchPrDetails` + prepare branch via `git.preparePullRequestThread` (parallel)
5. Create worktree via `git.createWorktree`
6. Set branch upstream via `git.setBranchUpstream`
7. Create draft thread in `composerDraftStore` (client-only, pre-server)
8. Set review prompt in composer draft
9. Call `onThreadCreated` callback (triggers `reviewRequest.linkThread` from Sidebar)
10. Navigate to `/$threadId`
11. User manually triggers the agent by pressing send

**Problems:**
- 6-8 sequential WS round-trips before the user sees the chat
- Race condition between `linkThread` and navigation
- Thread starts as a "draft" in client state, not yet on server
- Agent doesn't start automatically -- user must manually press send
- All error handling is in the frontend, duplicated from server capabilities
- `buildReviewPrompt` logic lives in `apps/web/src/lib/prReviewUtils.ts` (frontend-only)

### Relevant Files

**Server:**
- `apps/server/src/wsServer.ts` -- WS request routing (lines ~790-1400 handle all methods)
- `apps/server/src/git/Layers/GitManager.ts` -- `preparePullRequestThread`, worktree creation
- `apps/server/src/git/Services/GitManager.ts` -- Service interface
- `apps/server/src/git/Services/GitCore.ts` -- Low-level git operations
- `apps/server/src/git/Services/GitHubCli.ts` -- `gh` CLI wrapper (fetchPrDetails, etc.)
- `apps/server/src/orchestration/Services/OrchestrationEngine.ts` -- Command dispatch
- `apps/server/src/orchestration/Layers/OrchestrationEngine.ts` -- Engine implementation
- `apps/server/src/persistence/Services/ReviewRequestRepository.ts` -- Review request DB
- `apps/server/src/persistence/Layers/ReviewRequestRepository.ts` -- Repository implementation
- `apps/server/src/config.ts` -- `ServerConfig` (has `cwd`, `stateDir`)

**Contracts:**
- `packages/contracts/src/ws.ts` -- `WS_METHODS`, `WebSocketRequestBody` union, push channels
- `packages/contracts/src/reviewRequest.ts` -- Review request schemas
- `packages/contracts/src/orchestration.ts` -- Commands, events, thread/project schemas
- `packages/contracts/src/git.ts` -- Git operation input/result schemas
- `packages/contracts/src/ipc.ts` -- `NativeApi` interface

**Web:**
- `apps/web/src/components/StandaloneReviewPrDialog.tsx` -- Current frontend orchestration (375 lines)
- `apps/web/src/components/NotificationBell.tsx` -- `onStartReview` callback
- `apps/web/src/components/Sidebar.tsx` -- Mounts dialog, handles `onStartReview`
- `apps/web/src/lib/prReviewUtils.ts` -- `buildReviewPrompt`, `normalizePrReference`
- `apps/web/src/composerDraftStore.ts` -- Draft thread state management
- `apps/web/src/wsNativeApi.ts` -- WS transport wrapper for NativeApi
- `apps/web/src/nativeApi.ts` -- NativeApi singleton
- `apps/web/src/hooks/useHandleNewThread.ts` -- Thread creation helper

---

## Architectural Decisions

### AD-1: Single Server Method, Return Early

The new `reviewRequest.startReview` method returns `{ threadId, projectId }` as soon as the thread is created on the server (after project resolution and thread.create dispatch). The heavier work (worktree setup, agent kickoff) continues asynchronously. The frontend navigates to the thread immediately and sees activity arrive via orchestration event push.

**Rationale:** Performance first. The user should see the chat view within 200ms. Worktree creation can take seconds; the agent can start while the UI is already showing.

### AD-2: Project Resolution on Server

The server resolves which project matches the PR's repo URL by querying the orchestration read model. If no project matches, the server clones the repo (using `ServerConfig.cwd` or a configured `projectsWorkingDirectory` passed in the request) and creates the project via `orchestrationEngine.dispatch`.

**Rationale:** The server already has all the services needed. Moving this to the server eliminates the `githubUrlByProjectId` map construction on the frontend and the multiple round-trips for clone + project.create.

### AD-3: Move `buildReviewPrompt` to `packages/shared`

The review prompt builder currently lives in `apps/web/src/lib/prReviewUtils.ts`. It takes `GitFetchPrDetailsResult` and produces a string. This is pure logic with no DOM dependencies. Move it to `packages/shared` so both server and web can use it.

**Rationale:** The server needs to build the prompt for auto-kickoff. Shared utilities belong in `packages/shared` per CLAUDE.md package roles. This avoids duplicating the prompt logic.

### AD-4: Auto-Kickoff via `thread.turn.start`

After creating the thread, the server dispatches a `thread.turn.start` command with the review prompt as the user message. This starts the agent immediately. The frontend doesn't need to put anything in the composer.

**Rationale:** Eliminates the manual "press send" step. The user clicks "Start Review" and the agent begins working. The chat view shows the agent's progress naturally via orchestration events.

### AD-5: No Clone from Server Without `projectsWorkingDirectory`

If no matching project exists and no `projectsWorkingDirectory` is provided in the request, the server returns an error. The frontend should surface this and offer a "Configure in Settings" link (same as current behavior).

**Rationale:** The server should not guess where to clone repos. This is a user configuration choice.

### AD-6: Keep StandaloneReviewPrDialog as Thin Shell

The dialog is not fully removed. It becomes a thin component that:
1. Validates the PR URL format (instant, no server call)
2. Calls `reviewRequest.startReview`
3. Shows a single loading state
4. Navigates to the thread on success
5. Shows errors on failure

**Rationale:** The dialog still provides a place for URL input when the user clicks the "Review PR" button without a notification context. But it no longer orchestrates multi-step flows.

---

## Implementation Strategy

### Phase 1: Shared Utilities (Low Risk)

**Goal:** Move `buildReviewPrompt` and `normalizePrReference` to `packages/shared` so both server and web can import them.

#### Step 1.1: Create `packages/shared/src/prReview.ts`

- **Files changed:**
  - NEW: `packages/shared/src/prReview.ts`
  - EDIT: `packages/shared/package.json` (add `./prReview` subpath export)

- **Content:** Move `buildReviewPrompt` and `normalizePrReference` from `apps/web/src/lib/prReviewUtils.ts`. The `GitFetchPrDetailsResult` type is imported from `@t3tools/contracts`. The `GITHUB_PR_URL_REGEX` and `isLikelyPrReference` can stay in the web package as they're only used for UI input validation.

- **Validation:** `bun typecheck` passes.

#### Step 1.2: Update Web Imports

- **Files changed:**
  - EDIT: `apps/web/src/lib/prReviewUtils.ts` -- re-export from shared, or update imports
  - EDIT: `apps/web/src/components/StandaloneReviewPrDialog.tsx` -- update import path

- **Validation:** `bun fmt && bun lint && bun typecheck` pass. Existing behavior unchanged.

---

### Phase 2: Contract Layer (Low Risk)

**Goal:** Define the new `reviewRequest.startReview` WS method schema.

#### Step 2.1: Add `ReviewRequestStartReviewInput` and `ReviewRequestStartReviewResult` Schemas

- **File:** `packages/contracts/src/reviewRequest.ts`

```typescript
export const ReviewRequestStartReviewInput = Schema.Struct({
  prUrl: Schema.String,
  /** Optional review request ID to link (from notification bell). */
  requestId: Schema.optional(TrimmedNonEmptyString),
  /** Directory to clone into if no matching project exists. */
  projectsWorkingDirectory: Schema.optional(Schema.String),
});

export const ReviewRequestStartReviewResult = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
});
```

#### Step 2.2: Register in WS Method Catalog

- **File:** `packages/contracts/src/ws.ts`

Add to `WS_METHODS`:
```typescript
reviewRequestStartReview: "reviewRequest.startReview",
```

Add to `WebSocketRequestBody` union:
```typescript
tagRequestBody(WS_METHODS.reviewRequestStartReview, ReviewRequestStartReviewInput),
```

Add import of `ReviewRequestStartReviewInput` from `./reviewRequest`.

#### Step 2.3: Update NativeApi Interface

- **File:** `packages/contracts/src/ipc.ts`

Add to `reviewRequest` section:
```typescript
startReview: (input: ReviewRequestStartReviewInput) => Promise<ReviewRequestStartReviewResult>;
```

Import the new types.

- **Validation:** `bun typecheck` passes (web will fail until Step 4 adds the client implementation -- that's expected and handled in Phase 4).

---

### Phase 3: Server Implementation (Medium Risk)

**Goal:** Implement the server-side review flow orchestrator and wire it into the WS router.

#### Step 3.1: Create `apps/server/src/reviewFlow.ts`

This is a new module that composes existing services to orchestrate the entire review start flow. It is an Effect function, not a Service, because it is a one-shot operation rather than a long-lived service.

**Dependencies (all existing services):**
- `OrchestrationEngineService` -- dispatch commands
- `ProjectionSnapshotQuery` -- read current projects
- `GitManager` -- `preparePullRequestThread`
- `GitCore` -- `cloneRepo`, `createWorktree`, `setBranchUpstream`
- `GitHubCli` -- `fetchPrDetails`
- `ReviewRequestRepository` -- `updateStatus`
- `ServerConfig` -- `cwd`
- `FileSystem`, `Path` -- path resolution

**Algorithm:**

```
startReview(input: { prUrl, requestId?, projectsWorkingDirectory? }):
  1. Normalize prUrl (strip fragments/query)
  2. Extract repoUrl from prUrl
  3. Query orchestration read model for existing projects
  4. Match repoUrl to project.workspaceRoot via gitRemoteOriginToGitHubUrl
     (need to check each project's git remote origin URL -- use GitCore.readConfigValue)
     OR simpler: check if any project's workspaceRoot has a matching origin URL.

     OPTIMIZATION: The server can build the same githubUrlByProjectId map
     by reading remote.origin.url for each project's workspaceRoot.
     Cache this with a short TTL.

  5a. If project found: use its projectId and cwd
  5b. If no project found:
      - If no projectsWorkingDirectory: fail with descriptive error
      - Clone repo via GitCore.cloneRepo
      - Dispatch project.create command

  6. Generate threadId (server-side UUID)
  7. Fetch PR details via GitHubCli.fetchPrDetails (needed for prompt + worktree)
  8. Prepare PR thread via GitManager.preparePullRequestThread (mode: "worktree")
     This handles: fetch branch, create worktree, configure upstream

  9. Dispatch thread.create command:
     - threadId, projectId, title: "Review PR #{number}: {title}"
     - model: project's defaultModel
     - runtimeMode: "full-access"
     - branch: worktree branch
     - worktreePath: worktree path

  10. Link review request (if requestId provided):
      reviewRequestRepo.updateStatus({ id: requestId, status: "in_review", threadId })

  11. Build review prompt via buildReviewPrompt(prDetails)

  12. Dispatch thread.turn.start command:
      - threadId
      - message: { role: "user", text: reviewPrompt }
      - runtimeMode: "full-access"

  13. Return { threadId, projectId }
```

**Steps 1-9 are synchronous (must complete before return).**
**Steps 10-12 can be fire-and-forget after returning threadId (use Effect.fork).**

Actually, reconsidering: Steps 6-9 must complete synchronously because:
- The frontend needs `threadId` to navigate
- The thread must exist on the server for the chat view to load
- The turn start must happen for the agent to begin

Steps 7-8 (PR details + worktree) are the slow parts. We can parallelize them with step 9 (thread creation) using a two-phase approach:

**Revised algorithm (optimized):**

```
Phase A (fast, return to client):
  1-5. Resolve project (use cache for origin URL lookup)
  6.   Generate threadId
  7.   Fetch PR details (fast: single gh api call, ~200ms)
  8.   Dispatch thread.create command
  9.   Return { threadId, projectId } to client

Phase B (background, after return):
  10.  preparePullRequestThread (slow: fetch + worktree create)
  11.  Dispatch thread.meta.update to set branch + worktreePath
  12.  Link review request
  13.  Build review prompt
  14.  Dispatch thread.turn.start (kicks off agent)
```

This way the client gets `threadId` after ~300ms (project lookup + PR details + thread.create) and navigates immediately. The chat view shows a thread with no messages yet. Within 1-3 seconds, the worktree is ready and the agent starts, with activity events streaming in.

**However**, there's a subtlety: `thread.turn.start` needs the thread to have a `worktreePath` so the provider session starts in the correct directory. The worktree must be ready before the turn starts. So we can't fully decouple Phase B.

**Final revised approach:** Return `threadId` to the client as early as possible, but do all the setup synchronously in the server method. The WS request handler has no timeout issues (Effect handles long-running operations). The client navigates immediately and sees the thread appear when `thread.created` event arrives.

Actually -- the WS request/response model means the client awaits the response. If the server takes 3 seconds, the client waits 3 seconds. This is still better than 8 round-trips but not ideal.

**Best approach: Two-phase with early response.**

```
1. Validate input, resolve project, generate threadId
2. Dispatch thread.create (synchronous, fast)
3. Return { threadId, projectId } to client
4. Fork background fiber:
   a. Fetch PR details
   b. Prepare worktree (fetch branch + create worktree)
   c. Dispatch thread.meta.update (set branch, worktreePath)
   d. Link review request
   e. Build review prompt
   f. Dispatch thread.turn.start
   g. If any step fails, dispatch thread.activity.append with error
```

The client navigates to `/$threadId` immediately. The thread exists (from step 2) but has no messages/worktree yet. When step 4f completes, the agent starts and events flow to the chat view.

If step 4b fails (e.g., clone/worktree error), we dispatch an error activity that shows in the chat timeline, and the thread stays in an error state that the user can see.

**Error activity for failures:**
```typescript
orchestrationEngine.dispatch({
  type: "thread.activity.append",
  commandId: newCommandId(),
  threadId,
  activity: {
    id: newEventId(),
    tone: "error",
    kind: "review-setup-failed",
    summary: "Failed to set up review workspace: ${error.message}",
    payload: {},
    turnId: null,
    createdAt: new Date().toISOString(),
  },
  createdAt: new Date().toISOString(),
});
```

#### Step 3.2: Wire into `wsServer.ts` Route Handler

- **File:** `apps/server/src/wsServer.ts`

Add a new case in the `routeRequest` switch:

```typescript
case WS_METHODS.reviewRequestStartReview: {
  const body = stripRequestTag(request.body);
  return yield* startReview(body);
}
```

Import the `startReview` function from `./reviewFlow.ts`.

The `startReview` function needs access to all the services already available in `createServer`'s closure. Two options:

**Option A:** Pass services explicitly to `startReview`.
**Option B:** Make `startReview` an Effect that reads services from the environment.

Option B is cleaner and follows existing patterns. The `routeRequest` function already runs in a context with all `ServerRuntimeServices`. We just need to ensure `startReview` declares its dependencies correctly.

```typescript
// reviewFlow.ts
export const startReview = Effect.fnUntraced(function* (input: {
  prUrl: string;
  requestId?: string;
  projectsWorkingDirectory?: string;
}) {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionQuery = yield* ProjectionSnapshotQuery;
  const gitManager = yield* GitManager;
  const gitCore = yield* GitCore;
  const gitHubCli = yield* GitHubCli;
  const reviewRequestRepo = yield* ReviewRequestRepository;
  const serverConfig = yield* ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // ... implementation
});
```

Wait -- `routeRequest` in wsServer.ts is an `Effect.fnUntraced` that doesn't appear to provide services via the environment. It accesses services through closure variables (`orchestrationEngine`, `gitManager`, etc.) that were resolved at server startup. So Option A is more consistent with the existing pattern.

Looking at the code more carefully: `routeRequest` is defined inside `createServer` which already has all services in scope. The `startReview` function can similarly be created inside `createServer` using those closure variables, or it can be a standalone Effect that takes the services as parameters.

**Decision:** Create `startReview` as a standalone Effect function in `reviewFlow.ts` that takes services as dependencies via Effect context. In `wsServer.ts`, provide the services when calling it. This keeps the review flow logic in its own module (clean separation) while still working within the existing architecture.

Actually, the simplest approach consistent with the codebase: define `startReview` as a regular function that takes the needed services as parameters (like `makeGitManager` does). The wsServer.ts handler calls it with the services already in scope.

**Final decision:** Create a factory function in `reviewFlow.ts`:

```typescript
export function makeStartReview(deps: {
  orchestrationEngine: OrchestrationEngineShape;
  projectionQuery: ProjectionSnapshotQueryShape;
  gitManager: GitManagerShape;
  gitCore: GitCoreShape;
  gitHubCli: GitHubCliShape;
  reviewRequestRepo: ReviewRequestRepositoryShape;
  serverConfig: ServerConfigShape;
  fileSystem: FileSystem.FileSystem;
  path: Path.Path;
}) {
  return Effect.fnUntraced(function* (input: ReviewRequestStartReviewInput) {
    // ... implementation using deps.*
  });
}
```

In `wsServer.ts`:
```typescript
const startReview = makeStartReview({
  orchestrationEngine, projectionQuery, gitManager, gitCore, gitHubCli,
  reviewRequestRepo, serverConfig: { cwd, ... }, fileSystem, path,
});
```

This is consistent with how `makeGitManager` works in the codebase.

#### Step 3.3: Project Resolution Logic

The server needs to map a GitHub repo URL to an existing project. The current frontend builds `githubUrlByProjectId` by calling `git.status` for each project and extracting `originUrl`, then using `gitRemoteOriginToGitHubUrl`.

For the server, we can:
1. Query the read model for all projects
2. For each non-deleted project, read `remote.origin.url` via `gitCore.readConfigValue`
3. Normalize via `gitRemoteOriginToGitHubUrl` from `@t3tools/shared/git`
4. Match against the repo URL extracted from the PR URL

**Optimization:** Cache this mapping with a short TTL (30s). Multiple review starts within 30s reuse the cached mapping.

#### Step 3.4: Background Fiber for Post-Return Work

After returning `{ threadId, projectId }`, the server forks a fiber for:
1. Fetch PR details
2. Prepare worktree
3. Update thread meta (branch, worktreePath)
4. Link review request
5. Build and dispatch review prompt as turn.start

Use `Effect.forkDaemon` or `Effect.forkIn(subscriptionsScope)` to ensure the fiber outlives the request handler.

Error handling: wrap the entire background fiber in a catch-all that dispatches an error activity to the thread.

- **Validation:** `bun typecheck` passes. Manual testing with mock server.

---

### Phase 4: Frontend Simplification (Medium Risk)

**Goal:** Replace the multi-step dialog with a single server call.

#### Step 4.1: Add `startReview` to `wsNativeApi.ts`

- **File:** `apps/web/src/wsNativeApi.ts`

Add to `reviewRequest` section:
```typescript
startReview: (input) => transport.request(WS_METHODS.reviewRequestStartReview, input),
```

#### Step 4.2: Rewrite `StandaloneReviewPrDialog.tsx`

The dialog becomes much simpler:

```typescript
// Simplified phases
type Phase = "input" | "starting";

function StandaloneReviewPrDialog({ initialPrUrl, onClose, projectsWorkingDirectory }) {
  const [prUrl, setPrUrl] = useState(initialPrUrl ?? "");
  const [phase, setPhase] = useState<Phase>("input");
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  const handleStart = async () => {
    setPhase("starting");
    setError(null);
    try {
      const api = ensureNativeApi();
      const result = await api.reviewRequest.startReview({
        prUrl: prUrl.trim(),
        ...(pendingReviewRequest?.requestId ? { requestId: pendingReviewRequest.requestId } : {}),
        ...(projectsWorkingDirectory ? { projectsWorkingDirectory } : {}),
      });
      await navigate({ to: "/$threadId", params: { threadId: result.threadId } });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start review");
      setPhase("input");
    }
  };

  // Auto-trigger when opened with initialPrUrl
  // ... (same pattern as current)
}
```

**Removed concerns:**
- `githubUrlByProjectId` prop -- server handles project resolution
- `projects` prop -- server handles project matching
- `cloneRepoMutation` -- server handles cloning
- `fetchPrMutation` -- server handles PR details
- `setProjectDraftThreadId` -- thread is created server-side, no draft
- `useComposerDraftStore` -- no draft prompt needed, agent starts automatically
- Phase tracking for "cloning", "fetching-pr", "creating-worktree" -- single "starting" phase
- `onThreadCreated` callback with `linkThread` -- server handles linking

**Kept:**
- PR URL validation (instant, no server call)
- Error display
- "needs working directory" warning with Settings link

#### Step 4.3: Update Sidebar Props

- **File:** `apps/web/src/components/Sidebar.tsx`

The `StandaloneReviewPrDialog` no longer needs:
- `githubUrlByProjectId`
- `projects`
- `onThreadCreated` callback

Remove these props from the dialog instantiation. The `projectsWorkingDirectory` prop stays (from appSettings).

#### Step 4.4: Update NotificationBell Flow

No changes needed to `NotificationBell.tsx`. It still calls `onStartReview(prUrl, requestId)` which opens the dialog. The dialog now just makes a single server call.

However, consider an optimization: for notification-triggered reviews (where we have `requestId`), skip the dialog entirely and call `startReview` directly from the Sidebar's `onStartReview` handler:

```typescript
onStartReview={async (prUrl, requestId) => {
  try {
    const api = ensureNativeApi();
    const result = await api.reviewRequest.startReview({
      prUrl,
      requestId,
      projectsWorkingDirectory: appSettings.projectsWorkingDirectory,
    });
    await navigate({ to: "/$threadId", params: { threadId: result.threadId } });
  } catch {
    // Fall back to dialog on error
    setPendingReviewRequest({ prUrl, requestId });
    setStandaloneReviewOpen(true);
  }
}}
```

This makes the notification bell -> review flow instant (no dialog at all on success).

- **Validation:** `bun fmt && bun lint && bun typecheck` pass. Manual testing.

---

### Phase 5: Testing (Low Risk)

#### Step 5.1: Unit Test for `startReview` Server Logic

- **File:** NEW `apps/server/src/reviewFlow.test.ts`

Test cases:
1. Happy path: existing project, PR details fetched, thread + turn created
2. No matching project, clone succeeds, project + thread created
3. No matching project, no projectsWorkingDirectory -- returns error
4. PR URL validation failure
5. Worktree creation failure -- thread exists but error activity dispatched
6. PR fetch failure -- thread exists but error activity dispatched

Use the existing test patterns from `apps/server/src/orchestration/Layers/OrchestrationEngine.test.ts` for mocking services.

#### Step 5.2: Move `buildReviewPrompt` Tests

If `buildReviewPrompt` had tests in the web package, move them alongside the shared module. Currently there don't appear to be dedicated tests, so add basic tests in `packages/shared/src/prReview.test.ts`.

#### Step 5.3: Integration Smoke Test

Manual testing checklist:
- [ ] Click "Start Review" from notification bell with existing project
- [ ] Click "Start Review" from notification bell with new repo (clone needed)
- [ ] Click "Review PR" button in sidebar (manual URL entry)
- [ ] Verify agent starts automatically
- [ ] Verify error when no projectsWorkingDirectory configured
- [ ] Verify error surfaces in chat when worktree fails
- [ ] Verify review request status updates to "in_review"
- [ ] Verify thread shows correct branch and worktree path

---

## Detailed File Change Matrix

| File | Action | Description |
|------|--------|-------------|
| `packages/shared/src/prReview.ts` | NEW | `buildReviewPrompt`, `normalizePrReference` |
| `packages/shared/package.json` | EDIT | Add `./prReview` subpath export |
| `packages/contracts/src/reviewRequest.ts` | EDIT | Add `ReviewRequestStartReviewInput`, `ReviewRequestStartReviewResult` |
| `packages/contracts/src/ws.ts` | EDIT | Add `reviewRequestStartReview` to `WS_METHODS` + body union |
| `packages/contracts/src/ipc.ts` | EDIT | Add `startReview` to `NativeApi.reviewRequest` |
| `apps/server/src/reviewFlow.ts` | NEW | `makeStartReview` factory + review flow orchestration |
| `apps/server/src/reviewFlow.test.ts` | NEW | Unit tests |
| `apps/server/src/wsServer.ts` | EDIT | Add route case, instantiate `startReview` |
| `apps/web/src/wsNativeApi.ts` | EDIT | Add `startReview` transport binding |
| `apps/web/src/components/StandaloneReviewPrDialog.tsx` | REWRITE | Simplify to single-call flow |
| `apps/web/src/components/Sidebar.tsx` | EDIT | Remove dialog props, add direct startReview for notifications |
| `apps/web/src/lib/prReviewUtils.ts` | EDIT | Re-export from shared or keep UI-only utils |
| `packages/shared/src/prReview.test.ts` | NEW | Tests for shared review utils |

---

## Risk Assessment

### Technical Risks

1. **Background fiber error propagation**
   - Risk: If the background fiber (worktree + turn start) fails silently, the user sees an empty thread
   - Mitigation: Wrap entire background fiber in catch-all, dispatch `thread.activity.append` with error tone
   - The chat view already renders error activities

2. **Thread exists but agent never starts**
   - Risk: The thread is created and returned, but the background fiber crashes before `thread.turn.start`
   - Mitigation: The chat view shows an empty thread. User can type a message and manually trigger the agent.
   - Enhancement: Add a "review setup in progress" system message during background setup

3. **Project resolution race condition**
   - Risk: Two concurrent `startReview` calls for the same repo could create duplicate projects
   - Mitigation: Use `ON CONFLICT` on project workspaceRoot or add a mutex. The orchestration engine already serializes command dispatch, so duplicate `project.create` commands are rejected by invariants.

4. **Stale project-to-repo mapping**
   - Risk: A project's remote origin URL changes but the cache still has the old mapping
   - Mitigation: Short TTL (30s) on the mapping cache. This is not a frequent scenario.

5. **Large repo clone timeout**
   - Risk: Cloning a large repo takes > 60s, WS request times out
   - Mitigation: With the two-phase approach, the clone happens in Phase A (before return). If clone is needed, the response will be slow. Consider: if clone is needed, create a "pending" thread immediately, fork the clone, and return. The clone completion triggers thread.meta.update.
   - For v1: accept that clone-needed reviews are slower. The dialog shows "starting..." during the clone. This is still better than the current flow (which also blocks on clone).

### Dependency Risks

- **Effect-TS version:** No new Effect features needed; uses existing patterns
- **`@t3tools/shared` subpath export:** Well-established pattern in the codebase
- **`gh` CLI:** Already used extensively; no new gh commands needed

---

## Acceptance Criteria

### Functional

1. Single `reviewRequest.startReview` WS method handles the entire flow
2. Thread is created on the server (not as a client-side draft)
3. Agent starts automatically with the review prompt
4. Review request is linked to the thread
5. Existing project is reused when repo URL matches
6. New project is created + repo cloned when no match exists
7. Error states are surfaced in the chat timeline
8. Manual URL entry (dialog) still works

### Quality

1. `bun fmt` passes
2. `bun lint` passes
3. `bun typecheck` passes
4. Unit tests for server-side review flow
5. Unit tests for shared `buildReviewPrompt`

### Performance

1. Client-side latency for notification-triggered review (existing project): < 500ms to navigate
2. Client-side latency for manual URL review (existing project): < 500ms after submitting URL
3. Agent begins producing output within 3s of review start (existing project, no clone)

### Reliability

1. If worktree creation fails, thread exists with error activity visible
2. If agent kickoff fails, thread exists and user can manually send a message
3. Concurrent review starts for different PRs don't interfere
4. WebSocket reconnect doesn't lose the thread (it's persisted server-side)

---

## Implementation Order

The phases can be executed in strict order (1 -> 2 -> 3 -> 4 -> 5). Each phase is independently verifiable:

1. **Phase 1 (Shared Utilities)** -- Pure refactor, zero behavior change. Safe to merge independently.
2. **Phase 2 (Contracts)** -- Additive schema changes. Does not break existing code (new method, not changing existing ones).
3. **Phase 3 (Server)** -- New server endpoint. Can be deployed without frontend changes (endpoint exists but isn't called yet).
4. **Phase 4 (Frontend)** -- Switches to the new endpoint. Can be feature-flagged if needed.
5. **Phase 5 (Testing)** -- Validates the complete flow.

Estimated total effort: 2-3 days for a developer familiar with the codebase.
