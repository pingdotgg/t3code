# Plan: Thread Lineage And Lazy Context Transfer

## Summary

Implement the shared backend foundation for forking, provider handoff, merge-back, and future subagents without forcing provider selection at fork time. The first slice should create cheap app-level fork lineage and defer expensive context materialization until a run starts and the target provider is known.

Architecture reference: `docs/orchestration-v2/thread-lineage-and-context-transfer.md`.

## Goals

- Support user-created fork threads for exploration.
- Keep fork creation provider-neutral and cheap.
- Reuse the same source-point/context-transfer model for provider switching, merge-back, and future subagents.
- Prefer native same-provider fork at first dispatch when available.
- Fall back to portable context only when native transfer is unavailable or target provider differs.
- Keep all behavior replayable through V2 events/projections.

## Non-Goals For First Slice

- Full portable context generation quality.
- Cross-provider adapter implementation beyond the data/runtime hook.
- Merge-back UI.
- Native or custom subagent orchestration.
- Forking from actively streaming provider state.
- Backward compatibility with old dev databases.

## Core Data Model

Add schema/contracts for:

```ts
type ContextTransferType =
  | "fork"
  | "provider_handoff"
  | "merge_back"
  | "subagent_spawn"
  | "subagent_result";

type ContextSourcePoint = {
  threadId: ThreadId;
  runId?: RunId;
  checkpointId?: CheckpointId;
  turnItemId?: TurnItemId;
  providerThreadRef?: NativeThreadRef;
  providerTurnRef?: NativeTurnRef;
};

type ContextTransferStatus =
  | "pending"
  | "resolved_native"
  | "resolved_portable"
  | "failed"
  | "consumed"
  | "superseded";
```

Persist:

- `orchestration_v2_projection_context_transfers`
- optional later portable handoff payload columns/table if the existing context handoff projection is not enough

For the first slice, `ContextTransfer` is required. Materialized `ContextHandoff` payloads can be deferred until portable context is implemented.

## Events

Add V2 events:

- `context-transfer.created`
- `context-transfer.updated`
- possibly `context-handoff.created` later

Do not emit provider-native fork details as app identity. Native fork refs belong in the transfer resolution payload and provider thread refs.

## Commands

Add:

```ts
type ThreadForkCommand = {
  type: "thread.fork";
  commandId: CommandId;
  sourceThreadId: ThreadId;
  targetThreadId: ThreadId;
  sourcePoint:
    | { type: "latest_stable" }
    | { type: "run"; runId: RunId }
    | { type: "checkpoint"; checkpointId: CheckpointId };
  title?: string;
  createdAt: string;
};
```

First-slice policy:

- `latest_stable` resolves to latest completed run checkpoint.
- explicit completed run/checkpoint is accepted.
- active run source is rejected or resolved to latest stable checkpoint; choose one policy and test it.
- target thread starts idle.
- no provider session/thread is created by `thread.fork`.

## Runtime Hook

Add a provider-neutral start-context resolver used by run startup:

```ts
resolveStartContext({
  threadId,
  runId,
  provider,
  modelSelection,
  userMessage,
}): Effect<StartContextResolution, StartContextResolutionError>
```

Resolution order:

1. No pending transfer targeting the thread/run: normal run start.
2. Pending fork transfer and same provider with native fork support: resolve native fork.
3. Pending transfer requiring portable context: return explicit unsupported/stub result in first slice, or build minimal portable context if cheap.
4. Failed resolution: fail command before provider side effects.

The resolver should be called before provider thread creation/startTurn so the adapter can decide whether to create, resume, or native-fork provider state.

## Codex Native Fork Path

Investigate the app-server native fork API in `effect-codex-app-server` and Codex docs/probes.

Implementation target:

- use native fork only when source provider is Codex and source native refs are strong;
- create or bind a new `ProviderThread` for the forked native thread;
- when the source point is an earlier completed Codex provider turn, fork the latest native thread first and then rollback the forked native thread by later terminal provider turns;
- mark `ContextTransfer.status = resolved_native` and then `consumed` when the first run starts;
- preserve source app thread lineage separately from native thread refs.

If native API details are not clean, land the data model and resolver first with native fork marked unsupported, then add Codex native fork in a follow-up.

## Portable Context Fallback

The first slice should define the fallback boundary even if it does not fully implement high-quality summarization.

Minimum viable fallback:

- detect cross-provider fork/handoff need;
- create failed/unsupported transfer resolution with a clear command error, or
- generate a deterministic minimal context handoff from app projection if we want a usable MVP.

Do not silently concatenate hidden summaries into the user message without a `ContextTransfer`/`ContextHandoff` record.

## Merge-Back Preparation

Do not implement merge-back in the first slice, but keep model support:

- `ContextTransfer.type = "merge_back"`
- `basePoint` on transfer
- source thread may differ from target thread

The later merge-back command should create a transfer from fork latest stable point back to source thread and consume it with the next user message.

## Subagent Preparation

Do not implement subagents in this slice, but keep model support:

- `createdBy: "agent"`
- `type: "subagent_spawn"` and `"subagent_result"`
- source/target thread relationship fields

Native subagent ingestion can later map provider-native child refs into the same graph. Cross-provider app-owned subagents can later create child app threads using the same transfer primitive.

## Projection And Debugger

Backend projection first:

- expose thread lineage in thread projection;
- expose context transfers in debug projection;
- expose transfer status and resolution strategy.

Debugger after backend:

- fork button/control from stable source point;
- show thread lineage/source point;
- show pending/resolved/failed transfers;
- show native vs portable resolution.

Do not build debugger controls before the backend projection is authoritative.

## Tests

Use `bun run test`, not `bun test`.

Required backend tests:

- `thread.fork` from latest completed checkpoint creates target thread and pending transfer.
- fork command is idempotent through command receipts.
- fork does not create provider session/thread eagerly.
- first run on same-provider fork invokes native resolution path when capability exists.
- unsupported native fork falls back or fails according to explicit policy.
- active-run fork policy is deterministic.
- replay/recovery preserves target thread lineage and pending transfer.

Add test provider layers only at external service boundaries. Do not mock core orchestration policy.

## Implementation Order

1. Add contract schemas and ids for context transfers/source points.
2. Add migration/projection table for context transfers.
3. Add event store/projection handling for transfer events.
4. Add `thread.fork` command policy and orchestrator path.
5. Add tests for cheap idle fork creation and recovery.
6. Add start-context resolver interface.
7. Wire resolver into run startup with no-op behavior.
8. Add Codex native fork capability investigation and adapter path.
9. Add tests for same-provider native fork resolution.
10. Add debug projection surface after backend behavior is stable.

## Validation

Before considering the slice complete:

- `bun fmt`
- `bun lint`
- `bun typecheck`
- targeted backend tests with `bun run test`

If backend code changes are included, tests must cover the new orchestration behavior before the task is considered done.

## Implementation Status

Implemented in this slice:

- context transfer ids, schemas, JSON codecs, events, and projection storage
- app-thread lineage on thread creation and fork creation
- `thread.fork` command using `latest_stable`, explicit run, or explicit checkpoint source points
- cheap idle fork creation with no eager provider session/thread/run
- Codex same-provider native `thread/fork` resolution on first target dispatch
- Codex native fork-from-earlier-run resolution with `thread/fork` plus fork-local `thread/rollback`
- transfer status progression through `pending`, `resolved_native`, and `consumed`
- command receipt idempotency for duplicate fork commands
- replay-backed integration coverage for lazy fork creation and native Codex fork consumption

Explicitly deferred:

- portable `ContextHandoff` materialization for cross-provider forks/provider handoff
- merge-back command/runtime
- subagent spawn/result runtime
- debugger controls for creating/inspecting transfers
