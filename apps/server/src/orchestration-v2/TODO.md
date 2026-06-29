# Orchestration V2 TODO

This file tracks remaining backend-oriented V2 work. Architecture-level intent lives in
[`docs/orchestration-v2`](../../../../docs/orchestration-v2); this file is the local
implementation checklist for `apps/server/src/orchestration-v2`.

## Current Baseline

- V2 commands/events/projections are server-owned and replayable.
- Message dispatch supports start, steer, queue, queue reorder, promote queued message to steer,
  interrupt, and provider switch command shapes.
- Checkpoint rollback is currently a full revert: filesystem checkpoint restore, provider thread
  rollback, stale checkpoint marking, and later run/node `rolled_back` projection state.
- Codex same-provider fork is lazy: `thread.fork` records lineage and pending transfer, and first
  dispatch resolves native Codex fork. Earlier source-point forks use native `thread/fork` followed
  by fork-local `thread/rollback`.
- Native Codex fork-from-earlier-run has a real replay-backed test fixture:
  `testkit/fixtures/thread_fork_native_prior_turn`.
- Merge-back from a fork into its source thread records a `merge_back` context transfer, materializes
  a `fork_delta_summary` context handoff, and injects that handoff into the next source-thread run.

## Projection Hardening

Target docs:

- [`core-graph-and-data-model.md`](../../../../docs/orchestration-v2/core-graph-and-data-model.md)
- [`thread-lineage-and-context-transfer.md`](../../../../docs/orchestration-v2/thread-lineage-and-context-transfer.md)
- [`testing-strategy.md`](../../../../docs/orchestration-v2/testing-strategy.md)

TODO:

- [x] Add end-to-end projection assertions for forked threads, not only provider-context behavior.
      The fork projection should show inherited user-visible items through the source point plus an
      explicit fork marker.
- [x] Decide and implement the projection representation for inherited fork history:
      referenced lineage overlay vs physically duplicated projection items. Prefer referenced overlay
      unless product requirements need independent editable history.
- [x] Add local visible projection assertions to non-fork replay fixtures:
      `visibleTurnItems` mirrors canonical local `turnItems` for simple, multi-turn, queue,
      steering, interrupt, rollback, planning, tool, and web-search fixtures.
- [ ] Ensure projections render rollback state consistently:
      rolled-back runs/nodes/items, stale checkpoints, and active provider thread cursor.
- [ ] Add projection tests for interrupt edge cases:
      provider emits chunks after interrupt requested, provider ignores/delays interrupt, interrupt is
      immediately followed by queue/steer/start.
- [ ] Add projection tests for queue/steer flows:
      queued message visibility, queue reorder, promote queued message to steer, and post-interrupt
      dispatch visibility.

## Context Transfer And Merge-Back

Target docs:

- [`thread-lineage-and-context-transfer.md`](../../../../docs/orchestration-v2/thread-lineage-and-context-transfer.md)
- [`provider-switching-and-context.md`](../../../../docs/orchestration-v2/provider-switching-and-context.md)

TODO:

- [x] Implement merge-back from a fork into its source thread:
      source fork point as `basePoint`, fork latest stable point as `sourcePoint`, and source-thread
      next user message as the consuming run.
- [x] Materialize delta context artifacts for merge-back and persist them as auditable
      `ContextHandoff` records.
- [x] Add replay-backed integration coverage for merge-back:
      fork, explore in fork, merge back, then assert source provider receives only the fork delta plus
      the new user message.
- [ ] Implement portable context handoff for cross-provider forks and same-thread provider switches.
- [ ] Define explicit failure states for unresolved context transfers:
      missing source point, unsupported provider capability, context too large, source projection not
      stable, and adapter resolution failure.

## Capability And Policy Model

Target docs:

- [`provider-capability-system.md`](../../../../docs/orchestration-v2/provider-capability-system.md)
- [`feature-lifecycles.md`](../../../../docs/orchestration-v2/feature-lifecycles.md)

TODO:

- [ ] Audit capability use against the documented nested `OrchestrationV2ProviderCapabilities`
      shape and fill any behavior gaps.
- [ ] Keep orchestration decisions capability/policy driven. Shared runtime code should not branch on
      provider name except at adapter registration/resolution boundaries.
- [ ] Make optional adapter methods impossible to call without going through a policy wrapper or a
      capability-checked branch.
- [ ] Add typed capability/policy errors for:
      native fork unavailable, rollback unavailable, steering unavailable, interrupt unavailable,
      context handoff unavailable, and weak terminal status.
- [ ] Add capability-aware tests using real adapter/test layers at provider boundaries only. Do not mock
      core orchestration policy.

## Checkpoint And Rollback

Target docs:

- [`feature-lifecycles.md`](../../../../docs/orchestration-v2/feature-lifecycles.md)
- [`core-graph-and-data-model.md`](../../../../docs/orchestration-v2/core-graph-and-data-model.md)

TODO:

- [ ] Document current `checkpoint.rollback` command semantics in contracts/docs as full revert:
      filesystem restore plus provider conversation rollback.
- [ ] Decide whether we need separate commands for conversation-only rollback and filesystem-only
      restore. Do not add them until a real product flow needs them.
- [ ] Add tests for rollback after fork and rollback inside fork:
      source rollback should not corrupt child lineage, and fork rollback should not mutate source
      provider state.
- [ ] Validate rollback behavior when no active provider thread exists. Current behavior fails; decide
      whether a filesystem-only rollback fallback is useful or too surprising.

## Provider Switching And Second Adapter

Target docs:

- [`provider-switching-and-context.md`](../../../../docs/orchestration-v2/provider-switching-and-context.md)
- [`provider-capability-system.md`](../../../../docs/orchestration-v2/provider-capability-system.md)
- [`testing-strategy.md`](../../../../docs/orchestration-v2/testing-strategy.md)

TODO:

- [x] Add Claude replay fixture definitions for recorded fixtures, with TODO fixture slots that
      reference the corresponding Codex transcripts and V2 docs.
- [ ] Promote Claude `simple` from the replay adapter to a real `ClaudeAdapterV2` replay test:
      live and replay both consume an injected Agent SDK `query()` async iterable.
- [ ] Record Claude `multi_turn` from real usage and prove native session/thread continuation.
- [ ] Record Claude `tool_call_read_only` from real usage and prove read-only tool projection without
      approvals.
- [ ] Keep unrecorded Claude fixtures out of `testkit/fixtures/index.ts` until each has a real
      transcript and real adapter assertions.
- [ ] Add the second adapter once these vv0 Claude slices are stable enough to validate
      cross-provider behavior.
- [ ] Use the second adapter to test:
      cross-provider fork, same-thread provider switch, returning to a previous provider thread with
      delta handoff, and unsupported capability fallback paths.

## Subagents

Target docs:

- [`thread-lineage-and-context-transfer.md`](../../../../docs/orchestration-v2/thread-lineage-and-context-transfer.md)
- [`provider-capability-system.md`](../../../../docs/orchestration-v2/provider-capability-system.md)

TODO:

- [x] Add provider-native subagent observation for Codex and Claude replay-backed fixtures.
- [ ] Model native subagents and app-owned cross-provider subagents as related thread/subthread graph
      entries with different creator/lifecycle policy.
- [ ] Preserve native provider subagent refs where available, but do not make the app graph depend on
      provider-native ids as primary ids.
- [ ] Add deeper tests for subagent wait, close, result transfer, pending approvals, failed/stopped
      tasks, and fork-from-subagent behavior.

FOOD FOR THOUGHT:

- Custom t3code tools/mcp_server that lets agents spawn subagents of other providers powered by the T3 Orchestrator

## Debugger-Only Work

- Keep debugger UI useful but temporary. Backend semantics and projections should be the source of
  truth.
- [x] Wire the debugger thread tree to persisted V2 shell state through websocket RPC instead of
      debugger-local thread discovery state.
- Continue exposing lightweight controls for new backend surfaces:
  fork from response, new thread, full revert from user message checkpoint, merge-back, and provider
  switch.
- Avoid adding mock backend behavior for debugger convenience. In-memory debugger state is fine for
  layout affordances, but backend behavior must route through V2 commands/projections.
