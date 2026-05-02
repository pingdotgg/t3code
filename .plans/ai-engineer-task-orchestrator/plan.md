# AI Engineer Task Intake MVP Implementation Plan

> [!IMPORTANT]
> **Instructions for Agents**
>
> This plan is executed phase-by-phase. After completing each phase:
>
> 1. Update **Implementation Notes** with deviations, decisions, and surprises.
> 2. Update **Implementation Footprint** with files created and modified.
> 3. Check off **Acceptance Criteria** only after verification.
>
> Required completion checks: `bun fmt`, `bun lint`, and `bun typecheck`.
> Use `bun run test`, never `bun test`.

## Source Documents

- [PRD](./prd.md)
- [Domain Context](../../CONTEXT.md)
- [ADR 0001: Limit v1 Orchestrator autonomy to Task coordination](../../docs/adr/0001-limit-v1-orchestrator-autonomy.md)
- [ADR 0002: Convex owns Task state, T3 owns runtime state](../../docs/adr/0002-convex-owns-task-state-t3-owns-runtime-state.md)
- [ADR 0003: Refactor Orchestrator schema around Tasks](../../docs/adr/0003-refactor-orchestrator-schema-around-tasks.md)

## MVP Boundary

This plan intentionally replaces the broader Task Orchestrator plan with a backend-only Task Intake MVP.

In scope:

- Task-domain Convex state needed for routing and auditability.
- T3 runtime materialization for one Primary Thread per Task.
- Simple Slack and Linear Intake Source integrations through one Chat SDK-centered deep module.
- Simple Intake Source replies: accepted, needs input, start failed, completed, failed.
- Contract-first integration boundaries in `packages/contracts`.

Out of scope:

- Workspace UI changes.
- GitHub PR lifecycle.
- Streaming Coding Agent output to Slack or Linear.
- Linear status sync and assignment-first workflow.
- Slack promotion workflows, mute/unmute, and aside semantics.
- Autonomous supporting Threads.
- Cloud sandboxes.

## Architecture

### Deep Module

Create one integration module:

- `apps/orchestrator/src/taskIntake`

This module owns:

- Chat SDK adapter setup boundaries for Slack and Linear.
- Normalizing inbound platform messages into shared contract payloads.
- Dedupe/idempotency decisions for webhook delivery.
- Resolving an Intake Source conversation to an existing Task or a new Task request.
- Building the initial T3 prompt from the Intake Source conversation.
- Selecting simple outbound replies.
- Posting replies back through Chat SDK/platform adapters.

Code outside this module should not know Slack/Linear behavioral details. Convex HTTP routes authenticate and delegate. Convex mutations persist Task state. T3 bridge materializes runtime. The integration module coordinates policy.

### Contracts

Add schema-only contracts in `packages/contracts`, likely `packages/contracts/src/taskIntake.ts`.

Proposed schemas:

- `TaskIntakeSource`: `slack | linear | support_email | webhook`
- `TaskIntakeConversationRef`: source, external conversation id, optional channel/team/issue/comment/email ids, optional URL
- `TaskIntakeMessage`: event id, source, conversation ref, actor display/id, text, received time
- `TaskIntakeResolution`: `ignore | needs_input | create_task | route_existing_task`
- `TaskIntakeReply`: source, conversation ref, markdown/text body, idempotency key
- `TaskIntakeDeliveryResult`: `posted | skipped | failed`

Contracts are the only public shape between HTTP/source entrypoints, Convex orchestration, and tests. Keep them schema-only.

### Convex State

Keep the existing Task-centered state, but narrow its purpose:

- `projects`: configured repo/workspace routing.
- `tasks`: current Task identity/status for backend routing.
- `taskExternalLinks`: stable Intake Source conversation references and idempotency anchor.
- `taskThreads`: Primary T3 Thread reference.
- `workSessions`: T3 runtime lifecycle history.
- `taskEvents`: short audit trail for accepted, needs input, started, completed, failed.

Do not build a Workspace Task tree for this MVP.

## Phase 1: Contract And Task-State Foundation

**Blocked by**: None

**What to build**:
Preserve the useful Task-domain schema work, but add the Task Intake contract boundary that the Slack/Linear MVP will use. The goal is a small, durable backend model and typed integration payloads.

**Implementation steps**:

1. Keep or finish the Task-centered Convex schema: `projects`, `tasks`, `taskExternalLinks`, `taskThreads`, `workSessions`, and `taskEvents`.
2. Add `packages/contracts/src/taskIntake.ts` and export it from the contracts package.
3. Define contract schemas for normalized inbound messages, thread refs, task resolution, outbound replies, and delivery results.
4. Keep Task status helpers minimal: `ready`, `working`, `needs_input`, `done`, `failed`, `canceled`.
5. Ensure Task External Links can look up by `(source kind, external id)` and by Task.
6. Add focused tests for pure contract/domain helpers.

**Acceptance Criteria**:

- [x] Convex has Task-centered records for Projects, Tasks, External Links, Primary Thread references, Work Sessions, and Task Events.
- [x] Existing `controlThreads`, `executionRuns`, and `linearOrchestration` tables/modules are no longer the conceptual center.
- [x] Task Intake schemas exist in `packages/contracts` and are exported.
- [x] Slack and Linear can be represented by one `TaskIntakeMessage` shape.
- [x] External Link lookup supports idempotent Intake Source conversation-to-Task routing.
- [x] Focused tests cover contract decoding, Task status helpers, and External Link identity helpers.
- [x] `bun fmt`, `bun lint`, and `bun typecheck` pass.

**Implementation Notes**:

- Current dirty work already covers most Task-state schema/module creation.
- Existing Task statuses are broader than the MVP needs. They can remain if removing them would churn code, but new MVP behavior should use only the minimal states.
- Added schema-only Task Intake contracts for Slack, Linear, support email, and generic webhook sources. The contract names use `TaskIntake*` while the domain language remains Intake Source.
- Widened Convex Task origin and External Link validators to support future support email and generic webhook intake without changing the MVP behavior.
- Added a small pure External Link identity helper outside `packages/contracts` so Task Intake code has one validated way to derive `(kind, externalId)` lookup keys.
- Verification completed with `bun fmt`, `bun lint`, `bun typecheck`, `bun --filter @t3tools/contracts test -- taskIntake.test.ts`, and `bun --filter @t3tools/orchestrator test -- taskIntakeExternalLink.test.ts taskStatus.test.ts`. Lint/typecheck emitted existing warnings/suggestions only, with no errors.

**Implementation Footprint**:

- Existing dirty work: `apps/orchestrator/convex/schema.ts`
- Existing dirty work: `apps/orchestrator/convex/projects.ts`
- Existing dirty work: `apps/orchestrator/convex/tasks.ts`
- Existing dirty work: `apps/orchestrator/convex/taskExternalLinks.ts`
- Existing dirty work: `apps/orchestrator/convex/taskThreads.ts`
- Existing dirty work: `apps/orchestrator/convex/workSessions.ts`
- Existing dirty work: `apps/orchestrator/convex/taskEvents.ts`
- Added `packages/contracts/src/taskIntake.ts`
- Added `packages/contracts/src/taskIntake.test.ts`
- Updated `packages/contracts/src/index.ts`
- Added `apps/orchestrator/src/domain/taskIntakeExternalLink.ts`
- Added `apps/orchestrator/src/domain/taskIntakeExternalLink.test.ts`
- Updated `apps/orchestrator/convex/_generated/api.d.ts`

## Phase 2: T3 Runtime Materialization

**Blocked by**: Phase 1

**What to build**:
Keep the narrow T3 bridge that turns a Task into one Worktree and one Primary Thread. Do not expand into restart orchestration, PRs, or Workspace UI.

**Implementation steps**:

1. Keep `TaskRuntimeMaterializeRequest` and `TaskRuntimeMaterializeResponse` contracts.
2. Keep the T3 route that creates or resolves the local Project, creates a Worktree/branch, creates the Primary Thread, and optionally starts the first turn.
3. Keep Convex `t3Runtime.materializeTaskRuntime` as the only Orchestrator action that asks T3 to materialize runtime.
4. Record returned `t3ProjectId`, `t3ThreadId`, branch, and worktree path on Task Thread/Work Session state.
5. Report lifecycle callbacks back to Convex as Task runtime events.
6. Post only coarse lifecycle updates to Intake Sources later through Phase 3/4 selection logic.

**Acceptance Criteria**:

- [x] Orchestrator can request T3 runtime materialization for a Task.
- [x] T3 creates/resolves the local Project for the configured workspace root.
- [x] T3 creates the Worktree/branch through existing git services.
- [x] T3 creates the Primary Thread and reports its reference back.
- [x] Lifecycle callbacks update Work Session state.
- [ ] Lifecycle callback handling has idempotency tests.
- [x] Failed materialization records a Task Event and leaves the Task in `failed` or `needs_input`.
- [ ] `bun fmt`, `bun lint`, and `bun typecheck` pass.

**Implementation Notes**:

- Current dirty work has most of this bridge in place.
- Restart/replacement behavior is intentionally deferred.
- Live Linear smoke tests confirmed T3 materialization records `t3ThreadId`, branch, and worktree path in Convex on `basic-porcupine-321`.
- Failed Task Intake starts now mark the Task `failed` and record a `task-intake.start-failed` event.

**Implementation Footprint**:

- Existing dirty work: `packages/contracts/src/executionBridge.ts`
- Existing dirty work: `apps/orchestrator/src/t3/client.ts`
- Existing dirty work: `apps/orchestrator/convex/t3Runtime.ts`
- Existing dirty work: `apps/server/src/executionBridge/runStart.ts`
- Existing dirty work: `apps/server/src/executionBridge/http.ts`
- Existing dirty work: `apps/server/src/server.ts`

## Phase 3: Chat SDK Task Intake Deep Module

**Blocked by**: Phase 1, Phase 2

**What to build**:
Create the shared Slack/Linear Task Intake module around Chat SDK. This phase should remove source-specific behavior from Convex HTTP routes and Linear-specific orchestration code. Linear and Slack should both flow through the same contract-shaped path.

**Implementation steps**:

1. Add `apps/orchestrator/src/taskIntake/contracts.ts` or equivalent local type helpers that consume `@t3tools/contracts` schemas.
2. Add `apps/orchestrator/src/taskIntake/ingress.ts` for normalized inbound handling:
   - decode `TaskIntakeMessage`
   - dedupe by event id/idempotency key
   - resolve existing Task by External Link
   - decide create vs needs-input vs ignore
3. Add `apps/orchestrator/src/taskIntake/prompts.ts` to build the first T3 prompt from source, actor, URL, and message text.
4. Add `apps/orchestrator/src/taskIntake/replies.ts` to build simple outbound reply text.
5. Add `apps/orchestrator/src/taskIntake/chatSdk.ts` as the narrow Chat SDK adapter boundary.
6. Add Slack and Linear thin entrypoints that normalize source events and call the shared module.
7. Keep Convex HTTP routes limited to auth/signature verification, request parsing, and delegation.
8. Verify current Chat SDK docs/API before writing adapter-specific code.

**Acceptance Criteria**:

- [ ] Slack and Linear inbound messages enter the same `taskIntake` handler after source verification.
- [x] The shared handler creates a Task for a clear new request.
- [x] The shared handler routes follow-up messages to an existing Task by External Link.
- [x] Ambiguous messages produce a simple clarification reply and do not start coding.
- [x] Acknowledgement replies are simple comments/messages, not streams.
- [x] Chat SDK usage is isolated to the adapter boundary.
- [x] Unit tests cover create, route existing, ambiguous, duplicate event, and reply selection.
- [x] `bun fmt`, `bun lint`, and `bun typecheck` pass.

**Implementation Notes**:

- Current dirty `apps/orchestrator/convex/linear.ts` is a useful tracer bullet but should be collapsed behind the shared Task Intake module rather than growing as a Linear-only path.
- Installed the real Chat SDK transport packages: `chat`, `@chat-adapter/linear`, and `@chat-adapter/slack`. The package named `chat-sdk` is unpublished; the current SDK package is `chat`.
- Added a minimal Task Intake port layer (`TaskIntakeStore`, `TaskIntakeRuntime`, `TaskIntakeReplyTransport`) so the shared handler stays pure and testable without a source-adapter abstraction.
- Added shared prompt and reply builders. Linear now delegates into `handleTaskIntakeMessage` instead of creating/materializing/posting inline.
- Added Slack and Linear normalizers into the shared `TaskIntakeMessage` contract. Linear now enters through Chat SDK. Slack remains intentionally not configured because this environment does not have Slack bot/signing env vars, and the Slack adapter has an `exactOptionalPropertyTypes` incompatibility with `chat` that should be fixed upstream or wrapped deliberately later.
- The Linear Chat SDK webhook action passes `waitUntil` tasks through Convex and awaits them, so intake mutations/runtime materialization complete before the webhook action returns.
- Linear client credentials are passed explicitly to the Chat SDK adapter instead of relying on zero-config `LINEAR_CLIENT_ID`/`LINEAR_CLIENT_SECRET`, which the adapter treats as multi-tenant OAuth.

**Implementation Footprint**:

- Added `apps/orchestrator/src/taskIntake/contracts.ts`
- Added `apps/orchestrator/src/taskIntake/ports.ts`
- Added `apps/orchestrator/src/taskIntake/ingress.ts`
- Added `apps/orchestrator/src/taskIntake/prompts.ts`
- Added `apps/orchestrator/src/taskIntake/replies.ts`
- Added `apps/orchestrator/src/taskIntake/chatSdk.ts`
- Added `apps/orchestrator/src/taskIntake/linear.ts`
- Added `apps/orchestrator/src/taskIntake/slack.ts`
- Added `apps/orchestrator/src/taskIntake/ingress.test.ts`
- Added `apps/orchestrator/src/taskIntake/normalization.test.ts`
- Updated `apps/orchestrator/convex/tasks.ts`
- Updated `apps/orchestrator/convex/linear.ts`
- Updated `apps/orchestrator/convex/http.ts`
- Added `apps/orchestrator/convex/taskIntake.ts`
- Updated `apps/orchestrator/package.json`
- Updated `bun.lock`

## Phase 4: Simple Slack And Linear End To End

**Blocked by**: Phase 3

**What to build**:
Wire the shared Task Intake module into real Slack and Linear webhook paths and finish the MVP behavior end to end.

**Implementation steps**:

1. Linear:
   - accept comments or issue-thread messages addressed to the AI Engineer
   - create or route Task by stable Linear issue/thread External Link
   - post simple acknowledgement/clarification/completion/failure comments
2. Slack:
   - accept app mentions or subscribed thread messages
   - create or route Task by stable Slack channel/thread External Link
   - post simple acknowledgement/clarification/completion/failure messages
3. For clear new work:
   - create Task
   - attach External Link
   - materialize T3 runtime
   - post acknowledgement with Task id and T3 Thread id
4. For follow-up messages:
   - append a Task Event
   - optionally continue the existing T3 Thread if the message is actionable
   - post a simple received/queued reply when useful
5. For runtime terminal events:
   - post one completed or failed reply to linked Slack/Linear threads
   - do not post raw activity/chatter

**Acceptance Criteria**:

- [x] Linear comments can create a Task and receive a simple acknowledgement.
- [x] Linear follow-up comments route to the same Task.
- [ ] Slack mentions can create a Task and receive a simple acknowledgement.
- [ ] Slack thread replies route to the same Task.
- [ ] Duplicate webhooks do not duplicate Tasks or acknowledgements.
- [ ] T3 runtime completion posts one simple completion comment/message.
- [ ] T3 runtime failure posts one simple failure comment/message.
- [x] No Coding Agent stream/activity is posted to Slack or Linear.
- [ ] Focused integration tests cover Slack create/follow-up and Linear create/follow-up with fake Chat SDK adapters.
- [ ] `bun fmt`, `bun lint`, and `bun typecheck` pass.

**Implementation Notes**:

- Live E2E: `AFF-1717` created Task `kn78dx567ws7amf3hjfbytema185yjh7`, T3 Thread `a58ac3c3-7b62-4c84-9e6f-5360b7f8be6e`, branch `task/aff-1717-ytema185yjh7`, and worktree `/var/lib/t3code/worktrees/t3code/task-aff-1717-ytema185yjh7`. Work Session completed.
- Follow-up/routing E2E: `AFF-1718` routed later comments to Task `kn7bn2v37at62ejhh6x7v7pdpd85zynz` and completed the Work Session.
- Completion/failure source replies are wired in code, but live Linear completion reply posting still needs one more auth pass against the Chat SDK Linear adapter. Chat SDK receives client-credentials tokens, but `thread.post` returned Linear auth errors in the live deployment for follow-up/lifecycle posts.
- Reply posting is best-effort after runtime materialization. A source reply failure no longer marks an already materialized Task as start-failed, and lifecycle callback HTTP responses no longer fail solely because Linear reply posting failed.
- Slack was not live-tested; no Slack bot/signing env vars were present in the repository env.

**Implementation Footprint**:

- Updated `apps/orchestrator/convex/http.ts`
- Added `apps/orchestrator/convex/taskIntake.ts`
- Updated `apps/orchestrator/convex/tasks.ts`
- Updated `apps/orchestrator/src/taskIntake/chatSdk.ts`
- Updated `apps/orchestrator/src/taskIntake/ports.ts`
- Deleted `apps/orchestrator/src/taskIntake/sourceAdapters.ts`

## Verification

Run before considering the MVP complete:

- `bun fmt`
- `bun lint`
- `bun typecheck`
- `bun run test` for focused contract, task intake, orchestrator, and execution bridge tests

## Done Criteria

- The PRD and plan describe only the backend Task Intake MVP.
- No Workspace UI work is required.
- Slack and Linear use one shared integration module.
- Platform behavior is hidden behind contracts and Chat SDK adapter boundaries.
- Clear Intake Source requests can create Tasks and start T3 runtime.
- Follow-up Intake Source messages route to existing Tasks.
- Intake Source replies are simple comments/messages, not streams.
