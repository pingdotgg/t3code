# Orchestration V2

This document set describes the target architecture for the next orchestration model. It is not a patch plan for the current implementation and it intentionally ignores migration/backward compatibility. Those concerns should be handled after the target model is coherent.

V2 is an orchestrator rewrite, not a rewrite of the whole app domain platform. Existing non-orchestration domains, persistence/migration infrastructure, websocket/RPC infrastructure, and projection streaming semantics should be retained unless V2 exposes a concrete orchestration-specific gap.

V2 is designed around the real provider behavior observed in the Codex app-server probes, but it is not Codex-specific. Codex is treated as the richest protocol we currently have; weaker providers are adapted into the same model with app-owned ids and explicit capability flags.

## Documents

- [Core Graph And Data Model](./core-graph-and-data-model.md)
- [Entity IDs And Correlation](./entity-ids-and-correlation.md)
- [Feature Lifecycles](./feature-lifecycles.md)
- [Thread Lineage And Context Transfer](./thread-lineage-and-context-transfer.md)
- [Provider Switching And Context Handoff](./provider-switching-and-context.md)
- [Orchestrator MCP Server](./orchestrator-mcp-server.md)
- [Provider Capability System](./provider-capability-system.md)
- [Testing Strategy](./testing-strategy.md)

## Primary Goals

- Preserve provider-native lifecycle fidelity without leaking provider ids into app identity.
- Model root turns, subagents, tools, approvals, plans, and checkpoints as one execution graph.
- Make root-run completion the only event that completes a user-visible turn.
- Support forking from normal threads and completed subagent/provider threads.
- Support changing providers between runs as a first-class context handoff.
- Model forks, provider handoffs, merge-back, and subagents through shared thread lineage and context transfer primitives.
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
9. Forks record app-level lineage first. Provider-native forks and portable context handoffs are lazy resolution strategies chosen when a run starts.
10. Tests should prefer replay-backed integration coverage over mocked unit tests. The only normal substitute in orchestration tests is the provider runtime transport.

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

V2 owns its event schema. The V1 command and event unions are gone; V1 rows survive only as input to the legacy importer (`apps/server/src/orchestration-v2/legacy/`), and project events keep their own application event shape.

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

Forks do create new app threads, but they should not force provider selection at fork time. Forking records thread lineage and a pending source point. The first run on the fork resolves that source point through native provider fork when possible or portable context transfer when needed.

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

## Durable Effect Outbox

Commands record side effects, such as starting a provider turn or capturing a checkpoint, as requests in a durable outbox, committed in the same transaction as their events. The effect worker runs them after the commit, so side-effect intent is persisted rather than implicit in a live event subscription. A thread's effects run one at a time in enqueue order; title generation is ordered separately. [`OrchestrationEffectRequestV2`](../../apps/server/src/orchestration-v2/EffectOutbox.ts) lists the requests, and [Durable intent and side effects](../internals/overview.md#durable-intent-and-side-effects) covers recovery and the constraints on new code.
