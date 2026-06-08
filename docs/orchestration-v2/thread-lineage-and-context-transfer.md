# Thread Lineage And Context Transfer

Forking, provider handoff, merge-back, and subagents are separate product features, but they should share one orchestration model. The common primitive is not "fork" and not "summary". It is:

```text
thread relationship
  + source point
  + optional context transfer resolution
```

The app should preserve lineage cheaply and resolve expensive provider/context work lazily when a run actually needs it.

## Product Use Cases

### Fork To Explore

A user forks an existing app thread to explore a tangent without polluting the source thread's context.

```text
source AppThread
  -> user forks from stable source point
  -> new idle AppThread
  -> no provider chosen yet
  -> first message chooses provider/model
```

If the first run on the fork uses the same provider as the source and the provider supports native fork, use the provider-native fork path. If it uses a different provider, materialize portable context at first dispatch.

### Continue Same Thread With A Different Agent

A user continues the same app thread with another provider. This is not a new app thread, but it is still a context transfer.

```text
AppThread runs 1-5 with Codex
user sends run 6 with Claude
  -> resolve context transfer from Codex-backed source state to Claude
  -> start Claude provider thread with handoff context + user message
```

The app thread remains the canonical conversation. Provider-native threads are backing handles with explicit coverage.

### Merge A Fork Back Into Its Source

A user explores deeply in a fork, then brings the result back to the source thread.

```text
source thread at source point S
fork explores runs F1-Fn
user sends next message in source thread with "bring this back"
  -> build delta from S to fork latest stable point
  -> inject delta context with the source-thread user message
```

This is not a full source-thread provider switch. It is a targeted context transfer from the fork back to the original thread.

### Subagents

Subagents are the same family of operation with a different creator and lifecycle contract.

Native subagents:

- the provider spawns the child through its native capability;
- the app observes native child refs/events;
- the child is modeled as a child execution node and, when useful, as a related app subthread.

Cross-provider T3 subagents:

- the parent agent calls an app-owned tool;
- the app creates a child app thread/run with a relationship to the parent;
- the child result is transferred back to the parent as a subagent result context transfer.

The shared model should make user forks and agent-created subthreads feel like the same graph shape with different `createdBy` and lifecycle policy.

## Core Concepts

### Thread Relationship

Thread relationship describes why a target thread or run exists relative to another thread.

```ts
type ThreadRelationshipKind =
  | "fork"
  | "provider_handoff"
  | "merge_back"
  | "subagent_spawn"
  | "subagent_result";
```

Relationships are product-level and provider-neutral. A fork is not the same thing as a provider-native fork. A provider-native fork is one possible resolution strategy for a fork relationship.

### Source Point

Source point describes the exact state being transferred.

```ts
type ContextSourcePoint = {
  threadId: ThreadId;
  runId?: RunId;
  checkpointId?: CheckpointId;
  turnItemId?: TurnItemId;
  providerThreadRef?: NativeThreadRef;
  providerTurnRef?: NativeTurnRef;
};
```

Stable source points should prefer completed runs/checkpoints. Active runs are harder because provider chunks may still arrive and checkpoints may not be final.

### Context Transfer

Context transfer is the durable operational record that connects source and target. It is cheap to create and may stay unresolved until first use.

```ts
type ContextTransfer = {
  id: ContextTransferId;
  type: ThreadRelationshipKind;
  sourceThreadId: ThreadId;
  targetThreadId: ThreadId;
  sourcePoint: ContextSourcePoint;
  basePoint?: ContextSourcePoint;
  sourceProvider?: ProviderKind;
  targetProvider?: ProviderKind;
  status:
    | "pending"
    | "resolved_native"
    | "resolved_portable"
    | "failed"
    | "consumed"
    | "superseded";
  resolution?: ContextTransferResolution;
  createdBy: "user" | "agent" | "system";
  createdAt: string;
  consumedAt?: string;
};
```

`basePoint` is used for delta transfers, especially merge-back. For a fork merge-back, `basePoint` is the original fork source point and `sourcePoint` is the fork's latest stable point.

### Context Handoff

Context handoff is the expensive materialized context artifact. It is created lazily only when native transfer is unavailable or insufficient.

```ts
type ContextHandoff = {
  id: ContextHandoffId;
  transferId: ContextTransferId;
  kind: "portable_context" | "delta_context" | "checkpoint_context";
  payload: PortableContextPayload;
  createdAt: string;
};
```

Context handoffs should be auditable app artifacts, not hidden prompt concatenation.

### Resolution Strategy

Resolution decides how the target provider/thread receives the source context.

```ts
type ContextTransferResolution =
  | {
      strategy: "native_fork";
      providerThreadRef: NativeThreadRef;
    }
  | {
      strategy: "portable_context";
      contextHandoffId: ContextHandoffId;
    }
  | {
      strategy: "delta_context";
      contextHandoffId: ContextHandoffId;
    }
  | {
      strategy: "checkpoint_context";
      contextHandoffId: ContextHandoffId;
    };
```

Same-provider forks should prefer `native_fork` when the source native refs are strong and the adapter supports it. Cross-provider handoff and merge-back usually require a context handoff.

## Lazy Resolution

Fork creation should be cheap:

```text
thread.fork
  -> create target AppThread
  -> record thread relationship / ContextTransfer(status=pending)
  -> do not create provider session
  -> do not create provider thread
  -> do not build portable context
```

First dispatch on a pending fork resolves the transfer:

```text
first run on fork chooses provider P
  -> find pending fork ContextTransfer
  -> if source provider == P and native fork is supported:
       resolve native fork
     else:
       materialize portable context
  -> create/resume provider thread
  -> send handoff/native context + user message
```

This avoids forcing users to choose an agent at fork time and avoids generating summaries that may never be used.

## Runtime Entry Point

Run startup should have one provider-neutral hook:

```ts
resolveStartContext({
  threadId,
  provider,
  message,
}): StartContextResolution
```

This hook checks pending context transfers targeting the thread/run and chooses a strategy:

1. No transfer needed: target provider already has current coverage.
2. Native transfer: same provider and adapter supports native fork/resume.
3. Portable transfer: build a context handoff and inject it into the run.
4. Delta transfer: build the changes between `basePoint` and `sourcePoint`.
5. Unsupported: fail explicitly before provider work starts.

Provider adapters own native details. The orchestrator owns the relationship, source point, durable transfer record, and command receipts.

For Codex, native `thread/fork` forks the latest native thread state. When the app source point is an earlier completed provider turn, the Codex adapter resolves that provider-specific detail by forking first, then rolling back the forked native thread by the number of later terminal provider turns. The orchestrator still passes a provider-neutral source point and source provider-turn history; it does not encode Codex rollback policy.

## Data Ownership

`AppThread` should store lightweight browsing lineage:

```ts
type AppThreadLineage = {
  parentThreadId: ThreadId | null;
  relationshipToParent: "fork" | "subagent" | null;
  rootThreadId: ThreadId;
};
```

Operational transfer details should live in `ContextTransfer`, not directly on `AppThread`, because a thread can participate in many transfers:

- created by fork;
- later switched to another provider;
- later merged back to its source;
- later spawned subagents.

## Checkpoint And Active-Run Policy

The first implementation should prefer stable source points:

- completed run checkpoint;
- explicit checkpoint;
- idle provider thread with known coverage.

Forking or handoff from an active run should either:

- use the latest completed checkpoint, or
- be rejected until active-run semantics are designed.

Do not silently fork from partially streamed provider state. That weakens correlation and makes replay/recovery difficult.

## Current Implementation Boundary

The first backend slice implements lazy same-provider fork resolution:

- `thread.fork` creates a target app thread with fork lineage and a pending `ContextTransfer`.
- `thread.fork` does not create a provider session, provider thread, provider turn, or portable context artifact.
- The first dispatch on the fork resolves the pending transfer. For Codex-to-Codex forks with strong native refs and `thread/fork` support, the orchestrator uses the provider-native fork path and records `resolved_native` then `consumed`.
- Cross-provider or otherwise non-native fork transfers materialize a portable `ContextHandoff`
  lazily on the target thread's first dispatch.
- Active source runs are rejected for explicit run/checkpoint forks; `latest_stable` resolves to the latest completed checkpointed run.

This keeps the runtime aligned with the architecture while making portable context explicit and
auditable through `ContextTransfer` and `ContextHandoff` records.

## Relationship To Provider Switching

Provider switching is a context transfer where `sourceThreadId === targetThreadId` and the target provider differs from the current active provider.

Returning to a prior provider is also a context transfer, usually a delta from the provider's last covered run range to the current app-thread point.

The [Provider Switching And Context Handoff](./provider-switching-and-context.md) document describes strategy selection for that specific feature. This document defines the broader model shared by provider switching, forks, merge-back, and subagents.
