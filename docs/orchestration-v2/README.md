# Orchestration V2

This document set describes the target architecture for the next orchestration model. It is not a patch plan for the current implementation and it intentionally ignores migration/backward compatibility. Those concerns should be handled after the target model is coherent.

V2 is an orchestrator rewrite, not a rewrite of the whole app domain platform. Existing non-orchestration domains, persistence/migration infrastructure, websocket/RPC infrastructure, and projection streaming semantics should be retained unless V2 exposes a concrete orchestration-specific gap.

V2 is designed around the real provider behavior observed in the Codex app-server probes, but it is not Codex-specific. Codex is treated as the richest protocol we currently have; weaker providers are adapted into the same model with app-owned ids and explicit capability flags.

## Documents

- [Core Graph And Data Model](./core-graph-and-data-model.md)
- [Entity IDs And Correlation](./entity-ids-and-correlation.md)
- [Feature Lifecycles](./feature-lifecycles.md)
- [Provider Switching And Context Handoff](./provider-switching-and-context.md)
- [Provider Capability System](./provider-capability-system.md)
- [Testing Strategy](./testing-strategy.md)

## Primary Goals

- Preserve provider-native lifecycle fidelity without leaking provider ids into app identity.
- Model root turns, subagents, tools, approvals, plans, and checkpoints as one execution graph.
- Make root-run completion the only event that completes a user-visible turn.
- Support forking from normal threads and completed subagent/provider threads.
- Support changing providers between runs as a first-class context handoff.
- Support providers with weak or missing ids through deterministic app-owned id allocation.
- Make feature behavior capability-driven, not provider-name-driven.

## Key Invariants

1. App ids are primary. Provider ids are refs.
2. Provider events are never rewritten to look like another provider event.
3. Child execution completion never closes the parent run.
4. Checkpoints attach to checkpointable execution scopes. Root-run checkpoints advance app run history; child/subagent checkpoints are nested and do not advance the parent run count.
5. Rollback is expressed in app run count and reconciled with provider conversation state.
6. Every command targets app ids; adapters translate to provider refs at the edge.
7. Missing provider capability is represented explicitly and handled by policy.
8. Provider switches create explicit context handoff artifacts; they are not hidden prompt hacks.
9. Tests should prefer replay-backed integration coverage over mocked unit tests. The only normal substitute in orchestration tests is the provider runtime transport.

## Conceptual Layers

```text
Native provider protocol
  -> Rotating raw provider diagnostics
  -> Provider adapter / normalizer
  -> V2 orchestration event store using existing persistence patterns
  -> Runtime execution graph
  -> Conversation projection
  -> UI / API views
```

Raw provider diagnostics store what the provider actually sent or received for debugging and replay capture. The durable app state is the normalized orchestration state: events/entities, correlation refs, projections, and command receipts. The runtime graph stores what provider behavior means. The conversation projection stores what users see.

V2 should integrate with the existing orchestration command/event/projection infrastructure patterns rather than creating an unrelated event system. The V2-specific work is the graph model, provider lifecycle semantics, adapter contracts, normalizers, policies, and projections.

While V1 is still present, V2 should own a V2 event schema and V2 event table. It should not force V2 semantics through the old `OrchestrationEvent` TypeScript union. The old union is a V1 semantic model, not the target V2 event vocabulary. A later migration can replace V1 with V2, but the target model should stay V2-native.

## Minimal Mental Model

```text
AppThread
  Run 1
    root ExecutionNode
      tool ExecutionNode
      approval ExecutionNode
      subagent ExecutionNode
        ProviderThread
          child root ExecutionNode
  Run 2
    root ExecutionNode
```

An app thread is the user-visible conversation. A run is the counted user-visible turn. Execution nodes are the tree of work inside the run. Provider threads are provider-native conversation handles that can be attached to app threads or nested execution nodes.

Provider switches do not create new app threads. They create or reactivate provider threads and attach context handoff summaries to the next run.

## Probe-Derived Requirements

The Codex app-server probes showed several protocol realities that the V2 model must preserve:

- `thread/status/changed` can become idle before or around completion, but `turn/completed` is the authoritative turn terminal event.
- `turn/interrupt` completes as a request first; the interrupted terminal state arrives later through `turn/completed`.
- Approval requests are provider-initiated JSON-RPC requests scoped to provider thread, turn, and item.
- `thread/rollback` returns an authoritative provider thread snapshot after rollback.
- Subagent child `turn/completed` events can occur before the parent/root turn completes.
- Child provider turns are real provider turns and must not be remapped onto the parent provider turn id.

These observations are why V2 separates app runs, provider turns, and execution nodes.

## Existing Platform Boundaries

V2 should reuse existing app infrastructure where that infrastructure is not the source of the orchestration bug class:

- Command dispatch should keep the existing serialized/idempotent command handling and command receipt pattern.
- Projection streams should keep the existing snapshot-plus-cursor semantics used by the current API.
- Persistence should keep the existing SQLite/migration/repository infrastructure and projection-stream semantics.
- Raw provider frames should continue to be diagnostic log data, with bounded retention through rotating logs.
- Replay tests should replace only the provider transport/process boundary.

V2 may add V2-native orchestration events, projection tables, command policies, and provider execution services. It should not add a durable raw-provider-event database or a separate generic event bus unless the existing infrastructure cannot satisfy a documented V2 requirement.

V2 command dispatch returns the last committed stored-event sequence for accepted commands. Duplicate command ids must return the same receipt-backed result without re-running provider side effects. This is the API-level boundary the frontend uses for reconnect/recovery cursors.

## Tracked Follow-Up: Durable Effect Outbox

The current app pipeline uses domain events plus reactors to trigger provider side effects:

```text
command
  -> domain event(s)
  -> projection
  -> reactor observes event
  -> provider side effect
  -> provider output ingestion
  -> domain event(s)
```

This is valid, but it can become hard to trace because the provider side effect is implicit in a live subscription. If V2 needs stronger restart/recovery/debuggability, introduce a durable effect outbox for orchestration side effects:

```text
command
  -> transaction:
       append domain event(s)
       append provider effect request(s)
  -> projection
  -> stream to UI

effect worker
  -> claim effect request
  -> call provider
  -> ingest provider output
  -> append domain event(s)
  -> mark effect request completed/failed
```

Example effect request:

```ts
type ProviderEffectRequest = {
  id: ProviderEffectRequestId;
  kind:
    | "provider.turn.start"
    | "provider.turn.interrupt"
    | "provider.runtime-request.respond"
    | "provider.thread.rollback"
    | "provider.thread.fork";
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  threadId: ThreadId;
  runId: RunId | null;
  nodeId: NodeId | null;
  provider: ProviderKind;
  payload: unknown;
  causationEventId: EventId;
  commandId: CommandId | null;
  attempts: number;
  lastError: string | null;
};
```

This should be treated as an infrastructure improvement, not a prerequisite for the first V2 slice. The first V2 implementation can use the existing reactor pattern, but it should keep the provider side-effect boundary clear enough that moving to an outbox later does not require redesigning the graph or provider adapters.
