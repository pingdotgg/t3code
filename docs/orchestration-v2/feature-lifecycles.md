# Feature Lifecycles

This document describes how core user-facing features should work in V2. These flows describe target behavior, not current implementation constraints.

## Creating Threads

Creating an app thread is separate from starting provider work.

```text
thread.create
  -> AppThread created
  -> no provider session required yet
  -> no provider thread required yet unless eager provider creation is enabled
```

Provider thread creation may be lazy:

```text
first run starts
  -> ensure ProviderSession
  -> ensure ProviderThread
  -> send provider turn
```

If the provider supports empty thread creation, V2 may create a provider thread early. If not, the provider thread is created at first run start.

## Starting A Run

When the user sends a message:

```text
thread.message.send
  -> ConversationMessage(role=user)
  -> Run(status=queued, ordinal=N)
  -> root ExecutionNode(kind=root_turn, countsForRun=true)
  -> enqueue provider command
```

When provider execution begins:

```text
provider turn accepted/started
  -> ProviderTurn allocated or correlated
  -> root node status=running
  -> run status=running
```

When the root provider turn completes:

```text
root provider turn/completed
  -> finalize assistant streams
  -> finalize plans/todos/questions
  -> root node terminal
  -> capture checkpoint if applicable
  -> run terminal
```

Only the root node can complete the run.

## Steering And Queueing Messages

V2 should support three classes of follow-up input:

```text
steer active run in place
steer active run by restart
queue next run
```

Steering is an app-level intent to change the active run's instructions. Provider-native steering is only one implementation strategy.

If the provider supports active-run steering, the app sends a steer command to the provider and keeps the same run active.

If the provider does not support active-run steering, the app interrupts the active provider turn, finalizes the interrupted attempt, and starts a replacement provider turn for the same app-level steering intent. This may be represented as either:

- the same `RunId` with a new root attempt node, if the UI should treat steering as revising the active run, or
- a new `RunId` linked by `supersedesRunId`, if preserving the interrupted attempt as a counted turn is important.

The preferred default is the same `RunId` with a new root attempt node until the first attempt has produced a user-meaningful terminal assistant response or checkpoint.

Queueing creates a new run after the active run.

Recommended command shape:

```ts
type MessageDispatchMode =
  | { type: "steer_active"; targetRunId: RunId }
  | { type: "restart_active"; targetRunId: RunId }
  | { type: "queue_after_active" }
  | { type: "start_immediately" };
```

Policy:

- If the provider supports active-run steering, send steer to the provider and attach the message to the active run.
- If not, interrupt the active provider turn and restart the active run with the steering message included.
- If the user explicitly requests a new turn, queue even if steering is available.
- If no run is active, start immediately.

The model supports this because `Run` and `ProviderTurn` are separate. A single app run may have multiple provider-turn attempts when the first attempt was interrupted for steering.

```ts
type RunAttempt = {
  id: RunAttemptId;
  runId: RunId;
  attemptOrdinal: number;
  rootNodeId: NodeId;
  providerThreadId: ProviderThreadId;
  providerTurnId: ProviderTurnId | null;
  reason: "initial" | "steering_restart" | "retry" | "provider_recovery";
  status: "running" | "completed" | "interrupted" | "failed" | "cancelled";
};
```

Only the selected/final attempt completes the run and creates the run checkpoint. Earlier interrupted steering attempts remain in the execution graph for audit/debugging.

## Follow-Up Turns

A normal follow-up after a completed run creates a new run.

```text
previous Run completed
user sends follow-up
  -> new Run ordinal=N+1
  -> new root node
  -> same AppThread
  -> same ProviderThread if resumable
```

If the previous provider thread cannot be resumed due to runtime error, missing native state, or incompatible provider settings, the provider thread is marked unavailable and the app creates a replacement provider thread from reconstructed context.

The replacement path is an error recovery flow, not a provider capability branch.

## Changing Providers Between Runs

Changing providers is a first-class context handoff. It does not fork the app thread and it does not rewrite prior provider history.

```text
user selects a different provider for next run
  -> create Run with target provider
  -> resolve or create target ProviderThread
  -> create ContextHandoff if target provider thread lacks current app context
  -> inject handoff summary into provider context
  -> send user message as the new root turn
```

Example:

```text
runs 1-5: Codex provider thread C1
switch to Claude
  -> summarize runs 1-5 for Claude
  -> create Claude provider thread L1
runs 6-8: Claude provider thread L1
switch back to Codex
  -> resume Codex provider thread C1 if possible
  -> summarize runs 6-8 for Codex
  -> send run 9 to C1 with the delta handoff
```

The default policy when returning to a provider is to resume the previous provider thread and bridge only the off-provider delta. This preserves native continuity for that provider's own earlier work while informing it about what happened elsewhere.

Fallback policy: create a fresh provider thread with a full app-thread summary when:

- the previous provider thread cannot be resumed,
- the provider's context is likely too stale or polluted by repeated handoffs,
- model/runtime settings changed incompatibly,
- the user explicitly requests a clean provider context.

The fallback should be explicit in the graph:

```text
new ProviderThread
  forked/reconstructed from AppThread summary
  ContextHandoff(strategy=full_thread_summary)
```

Provider switching should never concatenate hidden summaries into arbitrary prompts without recording the handoff. The handoff text is part of the run input contract and must be auditable.

## Forking Threads

Forking creates a new app thread from a source point. It should not require provider selection and it should not eagerly create provider runtime state.

```text
thread.fork
  -> create target AppThread
  -> record AppThread lineage
  -> create ContextTransfer(type=fork, status=pending)
  -> no ProviderSession required
  -> no ProviderThread required
  -> no portable context handoff required
```

The first run on the fork resolves the pending transfer:

```text
first message on fork selects provider P
  -> if source provider is P and native fork is available:
       resolve by provider-native fork
     else:
       materialize portable context
  -> create/resume target ProviderThread
  -> send resolved context + user message
```

The preferred first implementation should fork only from stable source points: completed runs, checkpoints, or idle provider threads with known coverage. Forking from an active run should use the latest completed checkpoint or be rejected until active-run semantics are deliberately designed.

## Merge-Back From Forks

Merge-back brings fork exploration into a source thread without copying the entire fork transcript into the main provider context.

```text
source thread forked at point S
fork thread explores through point F
user sends next source-thread message with merge-back intent
  -> create ContextTransfer(type=merge_back, basePoint=S, sourcePoint=F)
  -> build delta context lazily
  -> inject delta with the next source-thread user message
```

The delta should describe what changed since the fork point: decisions, files changed, commands/tests run, conclusions, and unresolved issues. It should not include provider protocol noise or full transcript content unless needed.

## Interruption

Interruption targets a run or a node.

```text
interrupt.run(RunId)
  -> resolve root node
  -> resolve provider turn/thread refs
  -> provider interrupt command if supported
  -> mark interrupt requested
```

Terminal state arrives from provider lifecycle:

```text
provider interrupt request returns
  -> command acknowledged only
provider emits root turn/completed status=interrupted
  -> root node interrupted
  -> run interrupted
  -> checkpoint policy runs
```

The app should not mark the run terminal solely because the interrupt request returned.

If the provider does not support interruption:

- best case: stop provider session and mark run interrupted or cancelled by policy.
- worst case: mark interrupt unsupported and leave run active until provider exits.

## Resumption

Resumption has three related meanings:

1. Resume an app thread in the UI from persisted projection.
2. Resume a provider-native conversation/session.
3. Recover or recreate a live provider runtime process while preserving app and provider-thread continuity.

V2 always supports app-thread resumption from stored events/projections. Provider-thread resumption is a required provider adapter primitive. Every provider harness must expose a cursor/session/thread handle that can be used to resume prior provider state.

Provider runtime recovery is also a core primitive, not a test-only hook. The same recovery path is used when:

- the user restarts the app/server and all provider processes are gone,
- an idle-session reaper intentionally releases provider processes,
- a provider process crashes or loses network and policy allows retry.

```text
open app thread
  -> load AppThread, Runs, Messages, ExecutionGraph summary
  -> if provider work must continue, resume the relevant ProviderThread
```

Provider resume flow:

```text
resolve activeProviderThreadId
resolve nativeThreadRef / nativeConversationHeadRef resume cursor
start ProviderSession
provider resume
bind new ProviderSessionId to ProviderThread
```

Provider runtime recovery flow:

```text
provider runtime unavailable
  -> mark ProviderSession stopped/error with reason
  -> remove live runtime handle from ProviderSessionManager
  -> keep ProviderThread and nativeThreadRef durable
  -> on next work, open a new provider runtime
  -> resume the active ProviderThread before starting/retrying work
```

Idle cleanup and crash recovery must use production lifecycle APIs. Tests may recreate the outermost layer/runtime or drive the same reaper/recovery service with deterministic clock and replayed provider transport, but they must not use test-only session restart methods.

If provider resume fails:

- preserve historical graph.
- mark provider thread not loaded or error.
- create replacement provider thread from reconstructed app context when the user continues.
- mark pending live requests as not resumable.

Provider resume failure is a runtime/recovery condition. It should not be modeled as "provider does not support resume."

## Forking

Forking creates a new first-class `AppThread` from a stable source.

Supported fork sources:

```ts
type ForkSource =
  | { type: "run"; threadId: ThreadId; runId: RunId }
  | { type: "node"; nodeId: NodeId }
  | {
      type: "provider_thread";
      providerThreadId: ProviderThreadId;
      providerTurnId?: ProviderTurnId;
    };
```

Stable fork boundaries:

- completed run
- interrupted or failed run with a provider snapshot/checkpoint
- completed subagent node with a provider thread
- provider thread snapshot returned by the provider
- checkpoint boundary

Unstable boundaries:

- streaming message delta
- active tool call
- pending approval
- active subagent turn, unless live fork support is explicitly implemented

Forking from a subagent:

```text
subagent node selected
  -> resolve ProviderThread owned by node
  -> provider fork/resume if supported
  -> create new AppThread
  -> attach forked ProviderThread
  -> copy/link checkpoint baseline
```

If the provider cannot fork native threads, V2 may synthesize a fork by creating a new app thread with projected messages/context, but that should be marked as lower fidelity by capability.

## Checkpointing

Checkpoints attach to checkpoint scopes. Root runs and child execution nodes can both be checkpointed.

Pre-run baseline:

```text
before root execution starts
  -> ensure root checkpoint for current app run ordinal - 1
```

Post-root-run checkpoint:

```text
root node terminal
  -> drain/finalize streams
  -> capture root checkpoint for app run ordinal
  -> compute diff from prior root checkpoint
  -> mark run terminal with checkpoint
```

Child/subagent checkpoint:

```text
child checkpointable node starts
  -> create child CheckpointScope under parent scope
child node terminal
  -> drain/finalize child streams/items
  -> capture child checkpoint for that scope
  -> compute diff from parent/previous child checkpoint
  -> mark child node checkpointed
```

Interrupted/failed runs:

- If filesystem state is meaningful and safe to capture, capture with status reflecting terminal state.
- If not, store a missing/error checkpoint summary.
- Child/subagent checkpoints are allowed, but they do not advance the parent app run count.
- Root run checkpointing should include or reference child checkpoint summaries so the run has a complete audit trail.

Rollback:

```text
rollback.toRun(threadId, targetRunOrdinal)
  -> restore filesystem checkpoint targetRunOrdinal
  -> compute provider turns to roll back if provider supports rollback
  -> call provider rollback
  -> reconcile returned provider snapshot if available
  -> mark later runs rolled_back
  -> delete or mark stale later checkpoint refs
```

Codex `thread/rollback` returns an authoritative provider thread snapshot. Other providers may require a synthetic provider thread restart from context.

Nested rollback:

```text
rollback.node(nodeId, checkpointId)
  -> restore child checkpoint if scope cwd/ref is available
  -> roll back provider thread for that child scope if supported
  -> mark descendant child checkpoints stale/rolled_back
  -> preserve parent run checkpoint history unless parent filesystem state changed
```

If a child checkpoint mutates the same workspace as the parent, restoring it may dirty the parent run's workspace state. The UI/API should make that explicit.

## Approvals

Approvals are runtime requests scoped to execution nodes.

```text
provider requestApproval
  -> RuntimeRequest(kind=...)
  -> approval ExecutionNode
  -> thread pending request projection
  -> optional thread status waiting
```

User response:

```text
approval.respond(RuntimeRequestId)
  -> resolve live provider callback
  -> send provider response
  -> RuntimeRequest resolved
  -> approval node completed/cancelled
```

Rules:

- Approval ids are app-owned.
- Provider request ids are refs.
- Pending approvals from subagents are still actionable if the provider exposes live response capability.
- Approval response should fail with `not_resumable` if provider callback state is gone.

## Ask Questions / User Input

Ask-questions is a user-input request, not a plan by itself.

```text
provider requests user input
  -> RuntimeRequest(kind=user_input)
  -> ExecutionNode(kind=user_input_request)
  -> Question artifact
  -> run status=waiting
```

On answer:

```text
user-input.respond(RuntimeRequestId, answers)
  -> provider callback
  -> request resolved
  -> node completed
  -> run resumes/runs
```

If the provider does not support structured questions, the adapter may project a plain assistant message and no respondable request.

## Plans And Todo Lists

V2 separates three concepts:

- Proposed plan: a durable plan artifact the user can accept/implement.
- Todo list: live execution progress for the current run.
- Ask questions: structured user-input request.

Codex examples:

```text
turn/plan/updated
  -> PlanArtifact(kind=todo_list)
  -> activity/projection update

item/plan/delta or plan item completed
  -> PlanArtifact(kind=proposed_plan)

item/tool/requestUserInput
  -> PlanArtifact(kind=questions)
  -> RuntimeRequest(kind=user_input)
```

Rules:

- Root run todo lists update the main plan/progress UI.
- Child/subagent todo lists are nested under their execution node.
- Child plans do not replace root plans unless promoted/forked.
- Proposed plan implementation creates a new run or a new thread depending on user action.

## Activities

Activities are a projection of execution graph events.

Examples:

```text
tool.started
approval.requested
approval.resolved
plan.updated
checkpoint.captured
subagent.started
subagent.completed
runtime.warning
```

Activities should keep `nodeId` and `runId` so the UI can group them correctly.

## Completion Barriers

Before a run is marked terminal, V2 should pass a finalization barrier:

```text
root provider turn terminal
  -> flush assistant text buffers
  -> close active assistant messages
  -> finalize plan/todo artifacts
  -> close open non-live child nodes if provider marked them done
  -> capture checkpoint
  -> publish run terminal
```

This prevents early checkpoint capture and incomplete plan state.
