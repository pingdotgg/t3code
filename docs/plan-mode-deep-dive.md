# Plan Mode Deep Dive

## Goal

Implement plan mode without fighting the architecture that already exists in this repo.

The current app is:

- provider-adapter driven on the server
- orchestration snapshot driven on the client
- already equipped with some plan-adjacent runtime events
- not yet equipped with first-class plan-mode state in the orchestration read model

This document updates the implementation plan to match that reality.

---

## Current Repo Baseline

### 1. Shared contracts already have some plan primitives

`packages/contracts/src/providerRuntime.ts` already includes:

- `turn.plan.updated`
- `content.delta` with `streamKind: "plan_text"`
- `user-input.requested`
- `user-input.resolved`

Important constraint:

- these are runtime-event primitives only
- there is no first-class provider capability schema
- there is no first-class plan operating mode field
- there is no dedicated final-plan artifact schema

### 2. Existing `runtimeMode` is not plan mode

`RuntimeMode` in `packages/contracts/src/orchestration.ts` and `packages/contracts/src/provider.ts` means execution policy:

- `approval-required`
- `full-access`

Plan mode must not overload that field.

If we need provider operating mode, it needs a separate concept and separate naming, for example:

- `interactionMode`
- `planningMode`
- `providerOperatingMode`

Anything is acceptable as long as it is not reused from the existing access-policy `runtimeMode`.

### 3. Server flow is already canonical-event-first

The current server pipeline is:

1. Provider adapters emit `ProviderRuntimeEvent`s.
2. `ProviderService` multiplexes adapter streams and maintains provider session bindings.
3. `ProviderRuntimeIngestion` translates runtime events into orchestration commands and thread activities.
4. `ProjectionPipeline` persists read-model tables.
5. `ProjectionSnapshotQuery` rebuilds the orchestration snapshot returned by `orchestration.getSnapshot`.
6. `wsServer` exposes generic orchestration snapshot, command dispatch, diff, and replay methods.

This matters because plan mode should fit into the same pipeline, not bypass it with a parallel websocket protocol.

Important detail:

- `wsServer` broadcasts orchestration domain events, not raw provider runtime events
- if the web should see plan state live, that state must first become orchestration events and/or projections

### 4. The current read model has nowhere to put plan mode

`OrchestrationThread` currently contains:

- `messages`
- `activities`
- `checkpoints`
- `session`
- `latestTurn`
- thread metadata like title, model, branch, worktree

It does not contain:

- current structured plan snapshot
- accumulated plan-text stream
- pending structured user-input prompt
- resolved structured answers
- provider interactive capabilities
- provider plan/default operating mode
- final approved plan artifact

Today the only flexible place plan data can survive into the web snapshot is `activities[].payload`.

### 5. The web app is snapshot-driven, not event-reduced

The client flow today is:

1. `EventRouter` listens to `orchestration.domainEvent`.
2. On domain events, it re-fetches `orchestration.getSnapshot`.
3. Zustand stores the latest normalized snapshot.
4. `session-logic.ts` derives UI state like pending approvals and work log from thread activities.
5. `ChatView` renders the thread from snapshot state plus those derived selectors.

Important implication:

- plan mode should be added to the orchestration snapshot and/or activity derivation path
- it should not depend on a separate client-side event reducer

### 6. Current implementation status by provider

#### Codex

Currently implemented:

- `turn/plan/updated` maps to `turn.plan.updated`
- `item/plan/delta` maps to `content.delta` with `streamKind: "plan_text"`

Current gap:

- `item/tool/requestUserInput` is currently classified as `request.opened` with request type `tool_user_input`
- it is not yet upgraded into `user-input.requested`
- there is no structured answer submission path yet

#### Claude Code

Currently implemented:

- session/config metadata surfaces through `session.configured`
- assistant/reasoning text flows through normal runtime content events
- approval requests already bridge into `request.opened` / `request.resolved`

Current gap:

- no current canonical plan-mode mapping
- no current `AskUserQuestion` mapping
- no current `ExitPlanMode` mapping

#### Cursor

Currently implemented:

- `available_commands_update` maps to `session.configured`
- thought/message chunks map to `content.delta`
- permission requests bridge into approval request events

Current gap:

- no current plan-mode mapping
- no current structured prompt mapping
- no current todo/plan projection

---

## Design Constraints

### Keep the current transport model

Plan mode should continue to flow through:

- `ProviderRuntimeEvent`
- orchestration commands/events
- projection tables
- `orchestration.getSnapshot`
- `orchestration.domainEvent`

Do not introduce provider-specific websocket channels unless the current architecture proves insufficient.

### Keep the client snapshot-driven

The client already assumes that server state is re-synced from snapshots. Plan mode should respect that.

That means:

- server-side persistence matters more than clever client buffering
- reconnect behavior should come from projection state, not ad hoc React state
- `session-logic.ts` and `ChatView` are the main frontend extension seams

### Keep approvals separate from structured user input

The current system has a full approval pipeline:

- runtime `request.opened` / `request.resolved`
- orchestration `thread.approval.respond`
- provider `respondToRequest(...)`

Plan-mode structured prompts are different and should not be forced into the approval model unless a provider genuinely models them as approval requests.

### Preserve raw provider payloads

When adding plan-mode mappings:

- keep `raw` on internal canonical runtime events
- keep `providerRefs` on internal canonical runtime events
- avoid throwing away native payload shape too early inside adapter/server processing

This does not mean provider-specific payloads should leak into the orchestration read model, websocket API, or web UI.

The boundary should stay:

- adapter/server internals may retain native payloads for correlation, debugging, and future parser improvements
- shared orchestration state and client-visible contracts should expose only canonical plan-mode data

That matters most for Claude and Cursor, where some mappings will be adapter-derived and may need native context during implementation and debugging.

---

## Updated Shared Work Plan

## 1. Tighten shared contract naming before wiring features

The first step is not to invent a new architecture. It is to formalize the concepts that are currently missing from contracts.

### Add a plan operating mode concept

Add a new shared contract for provider plan/default mode.

Requirements:

- do not reuse `RuntimeMode`
- keep it orthogonal to access policy
- make it available in the server->web read model, not only in raw runtime payloads

Preferred shape:

```ts
type ProviderInteractionMode = "default" | "plan";
```

### Add typed provider interactive capabilities

Current `session.configured.payload.config` is just `Record<string, unknown>`. That is too weak for capability-driven UI.

Add a typed capability surface in `packages/contracts` that both server and web can import directly.

Preferred shape:

- exported constant/object keyed by `ProviderKind`
- exported type derived from that object
- usable by adapters, orchestration code, and frontend rendering logic without duplicating provider capability tables

Minimum fields:

```ts
interface ProviderInteractiveCapabilities {
  supportsPlanMode: boolean;
  supportsStructuredPlanUpdates: boolean;
  supportsPlanTextStreaming: boolean;
  supportsStructuredUserInput: boolean;
  supportsFreeformUserInput: boolean;
  supportsPlanAcceptance: boolean;
}
```

Preferred usage:

- static provider capabilities live in shared contracts
- adapters may still emit dynamic runtime metadata when a capability is session-specific or probe-dependent
- the orchestration snapshot should expose the active provider and any dynamic overrides, not duplicate the full static capability catalog per thread

### Add a dedicated structured-answer command path

Current shared commands only support approvals:

- `thread.approval.respond`
- provider `respondToRequest(...)`

Plan mode needs a distinct path for structured prompt answers.

Preferred additions:

- orchestration command such as `thread.user-input.respond`
- provider service method such as `respondToUserInput(...)`
- adapter hook per provider for native answer serialization

Do not overload approval decisions like `accept` / `decline` for structured question answers.

## 2. Extend the orchestration read model

The current read model is the main missing piece.

Plan mode needs first-class projection state so reconnect and refresh behave like the rest of the app.

### Add first-class thread plan state

Preferred thread-level additions:

- `interactionMode`
- `currentPlan`
- `pendingUserInput`
- `resolvedUserInputs`
- optional `finalPlanArtifact`

The exact nesting can vary, but it should be snapshot-friendly and not require replaying arbitrary activity payloads in the client.

`interactiveCapabilities` should not be modeled as thread-owned state if they are static per provider.

Preferred split:

- static capabilities: shared contract export keyed by provider
- dynamic per-thread/per-session state: only fields that can actually vary at runtime, such as current interaction mode or active pending prompt

### Keep activities as secondary audit trail

`thread.activities` should still receive plan/user-input activity summaries for timeline/debugging, but it should not be the only source of truth for active plan state.

### Projection changes

This likely means:

- new projection repository/table(s) for plan state and prompt state
- `ProjectionPipeline` updates
- `ProjectionSnapshotQuery` returning the new fields
- projection tests for persistence and replay

## 3. Update runtime ingestion to populate that state

`ProviderRuntimeIngestion` already knows how to:

- turn assistant text into messages
- turn approval events into activities
- turn `turn.plan.updated` into an activity

It should be extended to also translate plan/user-input runtime events into read-model state.

Implementation direction:

- `turn.plan.updated` updates projected plan snapshot
- `content.delta(plan_text)` appends to projected plan-text buffer when relevant
- `user-input.requested` opens a projected pending prompt
- `user-input.resolved` closes/resolves that prompt
- providers that only expose raw/native blobs can still emit synthesized canonical runtime events first, then rely on the shared ingestion path

## 4. Integrate plan mode into the existing web seams

The web architecture already has the right places.

### Store and types

Update:

- `apps/web/src/types.ts`
- `apps/web/src/store.ts`

The store should stay thin and snapshot-oriented. It should sync whatever new read-model fields the server exposes.

### Derived UI state

Update:

- `apps/web/src/session-logic.ts`

This is the natural place for:

- `derivePlanState(...)`
- `derivePendingUserInput(...)`
- any fallback derivation from activities during an incremental migration

### Rendering

Primary UI seam:

- `apps/web/src/components/ChatView.tsx`

Current UI already has:

- top-of-thread alert stacks for pending approvals
- work-log rendering derived from activities
- timeline rows for messages and work state

That suggests two viable rendering patterns:

1. active plan/prompt panel above the timeline
2. resolved plan/prompt entries rendered in timeline/history

The route structure does not need to change. Plan mode should remain thread-local state inside the existing chat route.

---

## Provider Implementation Plan

## Provider 1: Codex

Codex is closest to the target shape and should be the first end-to-end implementation.

### Current status

Already present:

- native structured plan update mapping
- native plan-text stream mapping

Missing:

- native structured prompt mapping for `item/tool/requestUserInput`
- structured answer submission path
- removal of the current empty-answer auto-ack path in `codexAppServerManager`
- projection and UI support for the already-emitted plan events

### Required work

1. Upgrade `item/tool/requestUserInput` from request-only handling to canonical `user-input.requested`.
2. Preserve `request.opened` as transport/debug metadata when useful.
3. Add adapter-side answer submission for the corresponding pending request/tool context.
4. Emit `user-input.resolved` when the answer is submitted or confirmed resolved.
5. Project the result into the orchestration snapshot.

### Codex-specific note

The runtime event schemas already match Codex reasonably well, so this provider should define the canonical end-to-end behavior first.

## Provider 2: Claude Code

Claude likely needs tool-aware adaptation rather than pure transport mapping.

### Current status

Already present:

- generic session/runtime stream integration
- approval bridging

Missing:

- plan/default operating mode mapping
- `AskUserQuestion` -> `user-input.requested`
- `ExitPlanMode` -> final-plan or plan-state handoff

### Required work

1. Detect plan/default operating mode from Claude-native metadata without touching access-policy `runtimeMode`.
2. Map `AskUserQuestion` tool payloads into canonical `user-input.requested`.
3. Add provider-specific answer serialization for the return path.
4. Detect `ExitPlanMode` and decide whether it becomes:
   - a final-plan artifact
   - a synthetic structured plan snapshot
   - or both
5. Avoid over-synthesizing incremental structured plan steps unless Claude gives us enough structure to do it safely.

## Provider 3: Cursor

Cursor should start from the same canonical server pipeline, but with a more conservative adapter.

### Current status

Already present:

- session/update stream handling
- reasoning/assistant text mapping
- approval bridging

Missing:

- plan/default operating mode mapping
- structured prompt mapping
- structured plan/todo mapping

### Required work

1. Detect and publish Cursor operating mode separately from access-policy runtime mode.
2. Map documented extension methods such as `cursor/ask_question` and `cursor/update_todos` only when payloads are confirmed.
3. Fall back to plan-mode indicator plus normal assistant/reasoning text if structured Cursor plan events are absent.
4. Preserve raw ACP payloads so the adapter can improve without changing higher layers.

---

## Frontend Rendering Plan

The frontend should remain capability-driven, but using real repo seams.

### Active state

Render from projected snapshot fields:

- current plan/default operating mode
- provider capabilities
- current structured plan
- current plan-text stream
- pending structured prompt

### History state

Render from:

- normal messages
- resolved prompt answers
- plan-related activity/history rows
- optional final-plan artifact

### Placement

Recommended initial placement:

1. Active pending prompt and active plan panel above the timeline, near the current approvals stack.
2. Resolved prompt/plan history in the timeline.

This fits the existing `ChatView` layout with the least architectural churn.

---

## Test Plan

### Contracts

Add coverage for:

- new interaction-mode schema
- new capability schema
- new structured-answer command schema
- any read-model additions for active plan/prompt state

Retain existing coverage for:

- `turn.plan.updated`
- `content.delta(plan_text)`
- `user-input.requested`
- `user-input.resolved`

### Server

Add or extend tests for:

- provider adapter plan/prompt mapping
- `ProviderRuntimeIngestion` plan/prompt projection behavior
- `ProjectionPipeline` persistence and replay
- `ProjectionSnapshotQuery` returning active plan state
- provider answer submission path

### Web

Add or extend tests for:

- `syncServerReadModel` with new plan fields
- `session-logic.ts` derivation of active plan/prompt state
- `ChatView` rendering of:
  - active plan panel
  - pending structured prompt
  - resolved prompt history
  - plan-text fallback

---

## Recommended Execution Order

1. Add shared contract types for interaction mode, capabilities, and structured-answer submission.
2. Extend orchestration read-model contracts and projection storage for active plan/prompt state.
3. Wire `ProviderRuntimeIngestion` into those projections.
4. Finish Codex end-to-end first, since it already emits most of the canonical runtime pieces.
5. Add frontend snapshot sync, derivation, and rendering in `types.ts`, `store.ts`, `session-logic.ts`, and `ChatView.tsx`.
6. Add Claude adapter mapping.
7. Add Cursor adapter mapping and fallback behavior.

## Short version

The repo is already close in one specific sense: the runtime event vocabulary for plans and structured prompts exists.

The real missing architecture is:

- a separate plan/default operating mode concept
- typed provider capabilities
- a first-class structured-answer command path
- read-model projection for active plan/prompt state
- web rendering sourced from that snapshot state

That is the shape the implementation should follow.
