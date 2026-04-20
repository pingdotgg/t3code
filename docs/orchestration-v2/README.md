# Orchestration V2

This document set describes the target architecture for the next orchestration model. It is not a patch plan for the current implementation and it intentionally ignores migration/backward compatibility. Those concerns should be handled after the target model is coherent.

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
  -> Raw event log
  -> Provider adapter / normalizer
  -> Runtime execution graph
  -> Conversation projection
  -> UI / API views
```

The raw event log stores what happened. The runtime graph stores what it means. The conversation projection stores what users see.

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
