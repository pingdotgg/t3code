# Plan: Convex Orchestrator Linear Refactor

> Source PRD: conversational architecture spec for the new fork branch using `apps/orchestrator`, Chat SDK Linear adapter, Convex Agent orchestration, and T3 Code as the execution kernel

## Summary

Build a clean-break fork where Convex becomes the control plane and T3 Code becomes the worker runtime.

This plan intentionally does **not** include legacy Linear cutover or in-place migration work. The target deployment is a new machine with fresh setup, separate from the current production environment. T3's existing web UI remains untouched and continues to serve as a worker/debug console rather than the primary operator surface.

## Architectural decisions

Durable decisions that apply across all phases:

- **Package layout**:
  - `apps/orchestrator/` is the new control-plane app
  - `apps/orchestrator/convex/` contains Convex entrypoints and generated API
  - `apps/orchestrator/src/` contains bridge clients, orchestration helpers, and vendored Chat SDK state glue
- **Primary control plane**: Convex is the canonical store for orchestration threads, execution-run metadata, parent/child relationships, and Linear thread mappings.
- **Worker runtime**: `apps/server` owns worktrees, provider sessions, terminals, git state, diffs, checkpoints, and raw execution artifacts.
- **UI scope**: `apps/web` is unchanged in v1. No Convex-aware rendering, no new orchestration UX in T3.
- **Linear integration boundary**: Chat SDK's Linear adapter handles webhook ingress and reply/reaction egress. It is not the durable workflow brain.
- **Workflow brain**: Convex Agent owns durable orchestration logic, child-run planning, and final decision-making.
- **State adapter strategy**: Do not install `convex-chat-sdk`. Vendor the minimal state-adapter behavior needed for Chat SDK lock, subscription, and KV semantics directly into `apps/orchestrator`.
- **Chat SDK compatibility note**: The Linear adapter currently exposes `botUserId` as `string | undefined`, which is slightly looser than Chat SDK's optional-property typing under `exactOptionalPropertyTypes`. Keep that mismatch documented so we can remove the narrow compatibility cast later if it starts affecting maintenance.
- **Bridge protocol**: Convex controls T3 through a small authenticated HTTP worker API. T3 emits signed, idempotent callbacks back to Convex.
- **Run topology**: One Convex control thread can spawn many T3 execution runs. Each child run is independently addressable and rolls up to a parent thread.
- **Artifact ownership**: T3 stores raw logs, terminal output, file manifests, and diffs. Convex stores summaries, foreign keys, lifecycle state, and artifact pointers.
- **Linear UX scope**: v1 Linear behavior is threaded replies, edits, and reactions only. Do not design around streaming, modals, buttons, ephemeral messages, or file uploads in Linear.
- **Deployment mode**: Clean break on a new machine. No backward-compatibility or live migration work is required in this plan.

---

## Phase 1: Control Plane Skeleton

**User stories**:
- As an operator, I can boot a new `apps/orchestrator` service beside T3.
- As the system, I have one canonical place for orchestration state.

### What to build

Create the new `apps/orchestrator` app, wire Convex into the monorepo, and stand up the minimum Chat SDK Linear entrypoint with a no-op orchestration path. Define the core control-plane models so every later slice builds on stable identifiers and lifecycle records instead of ad hoc event handling.

This phase proves that the repo can host the orchestrator app and that Linear ingress can create durable control-thread records without involving T3 yet.

### Acceptance criteria

- [x] `apps/orchestrator` is a first-class workspace in the monorepo and participates in build/typecheck tasks.
- [x] Convex app entrypoints exist under `apps/orchestrator/convex/` and can boot locally.
- [x] A Linear webhook can create or update a canonical control-thread record in Convex.
- [x] The vendored Chat SDK state adapter is present and supports the minimum lock, subscription, and KV behavior needed by the bot runtime.
- [x] No T3 worker interaction is required for the happy path in this phase.

### Implementation notes

- Added `apps/orchestrator` as a standalone workspace with Convex config, schema, HTTP ingress, and source/tests for the control-plane skeleton.
- Generated Convex `_generated/*` files via `npx convex dev` so the new app is using the real Convex codegen instead of a hand-written shim.
- Implemented a local `StateAdapter` for Chat SDK instead of `convex-chat-sdk`, which keeps the phase-1 runtime self-contained while still matching Chat SDK's actual interface.
- Wired Linear ingress to normalize payloads into durable Convex `controlThreads`, `controlThreadEvents`, and `controlThreadMessages` records.
- Kept T3 worker execution and the richer Linear lifecycle bridge out of scope for this phase, exactly as planned.

### Implementation footprint

Files added in phase 1:

- `.plans/convex-orchestrator-linear-refactor.md`
- `apps/orchestrator/package.json`
- `apps/orchestrator/tsconfig.json`
- `apps/orchestrator/src/index.ts`
- `apps/orchestrator/src/chat/bot.ts`
- `apps/orchestrator/src/chat/state.ts`
- `apps/orchestrator/src/chat/state.test.ts`
- `apps/orchestrator/src/linear/ingress.ts`
- `apps/orchestrator/src/linear/ingress.test.ts`
- `apps/orchestrator/convex/convex.config.ts`
- `apps/orchestrator/convex/schema.ts`
- `apps/orchestrator/convex/http.ts`
- `apps/orchestrator/convex/chatState.ts`
- `apps/orchestrator/convex/controlThreads.ts`
- `apps/orchestrator/convex/_generated/*`
- `bun.lock`

What those files established:

- `apps/orchestrator/convex/schema.ts` defines the first durable control-plane tables:
  - `controlThreads`
  - `controlThreadEvents`
  - `controlThreadMessages`
  - `chatStateLocks`
  - `chatStateSubscriptions`
  - `chatStateKv`
- `apps/orchestrator/convex/http.ts` exposes the first Convex HTTP ingress:
  - `GET /health`
  - `POST /linear/webhook`
- `apps/orchestrator/src/linear/ingress.ts` normalizes loose Linear webhook payloads into a stable `LinearIngressEnvelope`.
- `apps/orchestrator/convex/controlThreads.ts` upserts canonical thread state from normalized ingress instead of allowing ad hoc writes from the HTTP layer.
- `apps/orchestrator/src/chat/state.ts` and `apps/orchestrator/convex/chatState.ts` vendor the minimum Chat SDK state-adapter semantics locally.

---

## Phase 2: Single Worker Handshake

**User stories**:
- As an orchestrator, I can start one execution run in T3 from a Convex control thread.
- As the system, I can correlate one control thread to one worker run deterministically.

### What to build

Introduce the first version of the worker bridge between Convex and T3. Convex should be able to request a worker run, T3 should allocate its internal thread/worktree/session state, and T3 should callback into Convex with stable identifiers and a small lifecycle envelope.

This is the first thin end-to-end slice through control plane, worker API, callback protocol, and durable run metadata.

### Acceptance criteria

- [ ] Convex can create one execution run through an authenticated HTTP request to T3.
- [ ] T3 returns or publishes a stable `t3ThreadId` and `executionRunId` that Convex can persist.
- [ ] T3 can callback into Convex with `started`, `completed`, and `failed` lifecycle events for a single run.
- [ ] Callback application is idempotent for repeated deliveries of the same event id.
- [ ] No Linear reply behavior is required yet beyond internal control-thread/run correlation.

### Status

Implemented on `feature/orchestrator-agent`.

This slice now has a real end-to-end single-worker handshake:
- Convex can persist a requested execution run for an existing `controlThreads` record.
- `apps/orchestrator` can call a dedicated authenticated T3 HTTP bridge.
- T3 can create the minimal project/thread state it needs, dispatch `thread.turn.start`, and return a stable `t3ThreadId`.
- T3 watches real `thread.session-set` lifecycle events and calls back into Convex with `started`, `completed`, and `failed`.
- Convex applies callback events idempotently by `eventId`.

Phase 2 still intentionally stops short of any Linear reply or status-post behavior.

### Files to edit

Existing files changed in phase 2:

- `apps/orchestrator/convex/schema.ts`
- `apps/orchestrator/convex/http.ts`
- `apps/orchestrator/convex/_generated/api.d.ts`
- `apps/orchestrator/package.json`
- `apps/server/src/server.ts`
- `packages/contracts/src/index.ts`

### Files to create

New files created in phase 2:

- `apps/orchestrator/convex/executionRuns.ts`
- `apps/orchestrator/src/t3/client.ts`
- `apps/server/src/executionBridge/http.ts`
- `apps/server/src/executionBridge/routeAuth.ts`
- `apps/server/src/executionBridge/runStart.ts`
- `packages/contracts/src/executionBridge.ts`

Files intentionally left untouched in phase 2:

- `apps/orchestrator/convex/controlThreads.ts`
- `apps/server/src/orchestration/http.ts`
- `packages/contracts/src/orchestration.ts`

Those modules did not need edits because phase 2 extracted a dedicated bridge contract file and kept the new worker bridge separate from owner-session orchestration HTTP.

### Acceptance criteria

- [x] Convex can create one execution run through an authenticated HTTP request to T3.
- [x] T3 returns or publishes a stable `t3ThreadId` and `executionRunId` that Convex can persist.
- [x] T3 can callback into Convex with `started`, `completed`, and `failed` lifecycle events for a single run.
- [x] Callback application is idempotent for repeated deliveries of the same event id.
- [x] No Linear reply behavior is required yet beyond internal control-thread/run correlation.

### Concrete implementation details

Convex-side additions:

- `apps/orchestrator/convex/schema.ts` now defines:
  - `executionRuns`
  - `executionRunEvents`
- `executionRuns` stores the durable correlation record:
  - `executionRunId`
  - `controlThreadId`
  - request payload basics like `initialPrompt` and `workspaceRoot`
  - lifecycle fields like `status`, `requestedAt`, `acceptedAt`, `startedAt`, `completedAt`
  - worker correlation fields like `t3ThreadId`, `t3TurnId`, `lastEventId`, `failureSummary`
- `executionRunEvents` stores callback application history keyed by `eventId`, which is the idempotency key for repeated server callbacks.
- `apps/orchestrator/convex/executionRuns.ts` now implements:
  - `createRequestedRun`
  - `attachT3Acceptance`
  - `applyLifecycleEvent`
  - `startSingleWorkerRun`
  - `getExecutionRun`
- `apps/orchestrator/src/t3/client.ts` is the first machine-to-machine client for T3:
  - reads `T3_EXECUTION_BRIDGE_BASE_URL`
  - reads `T3_EXECUTION_BRIDGE_SHARED_SECRET`
  - POSTs `ExecutionRunCreateRequest`
  - validates `ExecutionRunCreateResponse`
- `apps/orchestrator/convex/http.ts` now exposes `POST /t3/execution-events` for T3 callbacks and protects it with the shared bearer secret.

T3-side additions:

- `apps/server/src/executionBridge/routeAuth.ts` validates the shared bearer secret and keeps bridge auth separate from owner sessions.
- `apps/server/src/executionBridge/runStart.ts` translates one bridge request into existing orchestration commands:
  - create a project if the requested `workspaceRoot` is not already known
  - create a new T3 thread
  - dispatch `thread.turn.start`
  - track `executionRunId -> t3ThreadId` in a small in-memory registry for this thin phase
- `apps/server/src/executionBridge/http.ts` adds:
  - `POST /api/execution/runs`
  - a scoped background subscriber on `OrchestrationEngineService.streamDomainEvents`
  - lifecycle forwarding based on real `thread.session-set` events
- `apps/server/src/server.ts` now wires both the new route and the lifecycle forwarder into the running server.
- The lifecycle forwarder intentionally only emits the first `started`, `completed`, and `failed` event it successfully posts per tracked run, so duplicate session transitions do not spam Convex.

Bridge contract:

- `packages/contracts/src/executionBridge.ts` now owns:
  - `ExecutionRunCreateRequest`
  - `ExecutionRunCreateResponse`
  - `ExecutionRunLifecycleEvent`
- The bridge contract was intentionally extracted instead of bloating `packages/contracts/src/orchestration.ts`, because this is a control-plane-to-worker boundary rather than a browser-facing orchestration contract.

Authentication approach for this phase:

- The shared secret is `T3_EXECUTION_BRIDGE_SHARED_SECRET`.
- `apps/orchestrator` also needs `T3_EXECUTION_BRIDGE_BASE_URL` to reach T3.
- `apps/server` also needs `ORCHESTRATOR_BASE_URL` to post callbacks back to Convex.
- Owner-session auth, cookies, and pairing tokens are still intentionally out of scope for this bridge.

### Implementation decisions made

- The phase 2 server-side run registry is intentionally in-memory, not persisted.
  - Reason: phase 2 only needs a thin handshake and lifecycle callback proof.
  - Consequence: server restarts can lose the temporary `executionRunId -> t3ThreadId` callback mapping.
- T3 always creates a fresh thread for this phase instead of trying to reuse an existing worker thread.
  - Reason: it keeps correlation deterministic and avoids continuation semantics before phase 5.
- Lifecycle forwarding uses `thread.session-set` rather than inventing a second callback source.
  - Reason: it is already driven by the existing provider runtime ingestion path, so the bridge remains anchored to real orchestration state.
- Convex applies callback events idempotently by inserting an `executionRunEvents` row before patching the run state.
  - Reason: repeated callback delivery is expected and should no-op cleanly.

### Deferred to Phase 3+

- Any Linear reply or threaded status-post behavior
- Retry queues or durable outbox behavior for failed T3 -> Convex callback delivery
- Persisted server-side run correlation across server restarts
- Run continuation, interrupt, or thread reuse semantics
- Richer worker metadata like diff summaries or artifact pointers

### Pseudocode sketch

Convex run request:

```ts
// apps/orchestrator/convex/executionRuns.ts
export const startSingleWorkerRun = action({
  args: { controlThreadId: v.id("controlThreads"), prompt: v.string() },
  handler: async (ctx, args) => {
    const executionRunId = crypto.randomUUID();
    await ctx.runMutation(internal.executionRuns.createRequestedRun, {
      controlThreadId: args.controlThreadId,
      executionRunId,
    });

    const response = await t3Client.createExecutionRun({
      controlThreadId: args.controlThreadId,
      executionRunId,
      initialPrompt: args.prompt,
    });

    await ctx.runMutation(internal.executionRuns.attachT3Thread, response);
    return response;
  },
});
```

T3 bridge route:

```ts
// apps/server/src/executionBridge/http.ts
POST /api/execution/runs
  -> authenticate shared secret
  -> validate ExecutionRunCreateRequest
  -> create project/thread if needed
  -> dispatch thread.turn.start through OrchestrationEngineService
  -> return { executionRunId, t3ThreadId, acceptedAt }
```

T3 callback application:

```ts
// apps/orchestrator/convex/http.ts
POST /t3/execution-events
  -> authenticate shared secret
  -> validate ExecutionRunLifecycleEvent
  -> if eventId already applied: return applied=false
  -> persist executionRunEvents record
  -> patch executionRuns lifecycle state
```

### Definition of done for phase 2

Phase 2 is done when this exact thin path works without any Linear reply logic:

1. A Convex action creates one requested execution run for an existing control thread.
2. `apps/orchestrator` sends one authenticated HTTP request to T3.
3. T3 dispatches one `thread.turn.start` using existing orchestration internals.
4. T3 calls Convex back with `started` and then terminal state (`completed` or `failed`).
5. Convex stores the full run correlation and ignores duplicate callback deliveries safely.

---

## Phase 3: Linear Thread Reply Loop

**User stories**:
- As a Linear user, I can comment on an issue and receive a threaded reply tied to the correct issue or comment thread.
- As the system, I can tolerate duplicate webhook delivery without double-replying.

### What to build

Complete the first user-visible vertical slice: Linear webhook arrives through Chat SDK, Convex resolves or creates the control thread, Convex launches a single T3 worker run, T3 emits completion data, and Convex posts a threaded reply back into Linear.

The reply can be intentionally simple in v1, but it must be deterministic, correctly threaded, and sourced from Convex-owned run state rather than direct T3-to-Linear calls.

### Acceptance criteria

- [x] Top-level Linear issue comments and nested comment-thread replies both map to stable Convex control threads using adapter-compatible root-comment thread ids.
- [x] One completed worker run produces exactly one threaded Linear reply.
- [x] Duplicate Linear webhook delivery does not create duplicate control threads or duplicate replies.
- [x] The Linear reply is generated from Convex-owned run state rather than from direct T3 webhook logic.
- [x] The happy path is demoable without any manual data repair between systems.

### Status

Implemented on the current branch.

This phase is now install/test-ready for the MVP path:

- `GET /linear/oauth/install` starts the `actor=app` install flow
- `GET /linear/oauth/callback` exchanges the returned authorization code and renders an operator completion page
- `POST /linear/webhook` now verifies `Linear-Signature`, parses raw `Comment create` payloads, upserts control threads, and starts one worker run when the bot is mentioned
- `POST /t3/execution-events` now attempts exactly-once Linear reply posting for final lifecycle states while keeping callback application idempotent

### Implementation notes

- We intentionally landed the MVP webhook/reply path as a minimal Convex-native Linear slice instead of mounting the full Chat SDK runtime into the webhook request path.
- The current ingress logic mirrors the adapter's root-comment thread model: both top-level comments and nested replies resolve to `linear:{issueId}:c:{rootCommentId}`.
- The install path uses OAuth `actor=app`, but runtime posting still uses client credentials because the bot only needs app-scoped server-to-server auth after installation.
- Reply posting is lifecycle-based and intentionally simple for now; it confirms completion or failure without trying to surface rich artifact summaries before the later metadata phases land.

### Implementation footprint

Files added in phase 3:

- `apps/orchestrator/convex/linearMvp.ts`
- `apps/orchestrator/src/linear/client.ts`
- `apps/orchestrator/src/linear/oauth.ts`
- `apps/orchestrator/src/linear/replies.ts`
- `apps/orchestrator/src/linear/replies.test.ts`

Files changed in phase 3:

- `apps/orchestrator/convex/controlThreads.ts`
- `apps/orchestrator/convex/executionRuns.ts`
- `apps/orchestrator/convex/http.ts`
- `apps/orchestrator/convex/schema.ts`
- `apps/orchestrator/src/chat/bot.ts`
- `apps/orchestrator/src/index.ts`
- `apps/orchestrator/src/linear/ingress.ts`
- `apps/orchestrator/src/linear/ingress.test.ts`
- `docs/orchestrator-deployment.md`
- `docs/linear-agent-mvp-setup.md`

---

## Phase 4: Linear Surface Validation

**User stories**:
- As an operator, I know exactly which Linear entities and fields reach the orchestrator through the Chat SDK adapter.
- As the system, I do not accidentally design around unsupported Linear surfaces such as first-class file ingestion when the adapter only supports comment/message primitives.

### What to build

Add a focused validation slice for the real Linear integration surface area. This phase is about proving, with tests and controlled fixtures, what the adapter actually delivers for:

- issue-level comments
- comment-thread replies
- mentions
- reactions
- issue metadata
- attachment-adjacent content such as markdown links or attachment references in comment bodies

The goal is to turn current assumptions into documented, repeatable evidence before later phases depend on those assumptions.

This phase should explicitly answer whether issue attachments are available as structured adapter data or only indirectly via normal comment/markdown content. If attachments are not first-class in the adapter, that limitation should become a durable architectural constraint for the rest of the plan.

### Acceptance criteria

- [x] We have a deterministic test matrix for the Linear adapter inputs the MVP depends on.
- [x] The team has a documented answer for whether issue attachments are exposed as structured data, only as links in comment bodies, or not at all.
- [x] Unsupported adapter surfaces are recorded as explicit constraints in the orchestrator docs and plan, not as tribal knowledge.
- [ ] Mention, comment-thread, and issue-thread behavior is validated against real or captured payloads, not only inferred from docs.
- [x] Later phases are not allowed to assume first-class attachment ingestion unless this phase proves it.

### Status

Partially implemented on the current branch.

What landed:

- the ingress tests now lock down top-level comment routing, nested reply routing, mention detection, and the current attachment boundary
- the docs now explicitly call out that attachments are only available indirectly via markdown links in comment bodies for this MVP
- the plan now treats root-comment threading and attachment limits as durable constraints instead of assumptions

What still remains:

- validate the same thread behavior against a real installed Linear app or captured production payloads after the first live install

---

## Phase 5: Execution State and Recovery

**User stories**:
- As an operator, I can recover run state after retries, duplicate callbacks, or worker restarts.
- As the system, I can reach a correct final state without double-applying completion behavior.

### What to build

Strengthen the worker-control protocol so Convex can reconcile eventual worker state even when callbacks are delayed, duplicated, or partially missing. Add explicit execution-run lifecycle states and a recovery path based on callback replay and status inspection.

This phase makes the architecture operationally credible before we add richer orchestration behaviors.

### Acceptance criteria

- [ ] Execution runs have explicit durable states for queued, running, completed, failed, interrupted, and unknown/reconciling.
- [ ] Duplicate callbacks do not re-open closed runs or double-trigger Linear replies.
- [ ] Convex can reconcile final worker state via polling or replay if callbacks are lost.
- [ ] Worker restarts do not orphan the control thread permanently.
- [ ] Recovery behavior is covered by deterministic tests, not only by manual verification.

---

## Phase 6: Run Continuation and Stop Control

**User stories**:
- As a Linear user, I can send follow-up comments that continue an existing worker run context.
- As a Linear user, I can stop or interrupt in-flight work.

### What to build

Add continuation and interruption semantics to the control plane. Follow-up Linear comments should route to the right control thread and either continue an active worker context or create a new run on the same control thread according to explicit policy. Stop requests should flow through Convex to T3 and produce a final, durable result state.

This phase turns the system from one-shot request/reply automation into an actual conversational execution loop.

### Acceptance criteria

- [ ] Follow-up Linear comments attach to the correct control thread.
- [ ] Convex can create a continuation run or message against the appropriate worker context.
- [ ] Stop requests result in T3 interruption and a durable interrupted state in Convex.
- [ ] The system avoids ambiguous "two active runs for one control thread" behavior unless that thread is explicitly orchestrator-managed.
- [ ] Final Linear replies after stop/interrupt are deterministic and non-duplicated.

---

## Phase 7: Parent/Child Orchestration

**User stories**:
- As an orchestrator, I can decompose work into multiple child execution runs.
- As the system, I can track child runs under one parent control thread and roll their outcomes back up.

### What to build

Introduce explicit parent/child orchestration semantics in Convex Agent. A parent control thread can plan, spawn, monitor, and summarize multiple child worker runs. Child runs remain T3-owned at the execution layer, but their relationships and aggregate status belong to Convex.

This phase should preserve the architecture decision that Convex is the orchestrator and T3 is just the execution kernel.

### Acceptance criteria

- [ ] A parent control thread can spawn multiple child execution runs with stable parent-child relationships.
- [ ] Each child run has its own lifecycle state and worker mapping.
- [ ] Parent state can summarize child status without reading from T3 UI state.
- [ ] Child completion can roll up into a parent summary or next-step orchestration decision in Convex.
- [ ] The system prevents duplicate child-run registration for the same orchestrator action.

---

## Phase 8: Artifact Metadata and Worker Observability

**User stories**:
- As an operator, I can inspect what each worker produced without moving raw artifacts into Convex.
- As the system, I can link orchestrator state to T3-owned execution artifacts cleanly.

### What to build

Add the metadata model that lets Convex reason about T3 outputs without owning heavyweight payloads. Convex should store structured summaries of diffs, outputs, terminal state, and attachments, plus stable pointers back to T3-owned artifact locations or retrieval APIs.

This phase makes the control plane useful for operational debugging and higher-level orchestration decisions while preserving the "T3 owns raw artifacts" boundary.

### Acceptance criteria

- [ ] Convex stores normalized metadata summaries for worker outputs and references raw artifacts by pointer rather than by full payload.
- [ ] Parent threads can reference child-run artifact summaries during orchestration.
- [ ] Operators can inspect run outcome metadata in Convex without needing to scrape T3 logs manually.
- [ ] The worker bridge exposes enough retrieval metadata to support future runbooks and debugging tools.
- [ ] Raw artifact storage remains entirely outside Convex.

---

## Future follow-on work

These items are intentionally out of scope for this plan:

- Machine setup guides and deployment runbooks for the new environment
- Operational dashboards and day-2 observability tooling
- Any migration or cutover plan from the current production machine
- Any future decision to make the T3 UI Convex-aware
