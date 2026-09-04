# Architecture

T3 Code keeps execution in the environment that owns the workspace. Web, desktop, and mobile
clients control it over authenticated RPC. A remote client must never substitute its own filesystem,
provider credentials, or machine state for the environment's. The desktop app bundles a server,
but its renderer follows the same boundary.

## Ownership boundaries

```
┌────────────────────────────────────────────────┐
│ Clients: apps/web, apps/desktop, apps/mobile   │
│ shared runtime: packages/client-runtime        │
│  connection supervisor, RPC session, Atom state│
└──────────────────┬─────────────────────────────┘
                   │ Effect RPC over WebSocket (/ws)
                   │ contract: packages/contracts
┌──────────────────▼─────────────────────────────┐
│ apps/server                                    │
│  orchestration engine (event-sourced)          │
│  provider driver registry (6 built-in drivers) │
│  checkpointing, VCS, terminals, filesystem     │
└──────────────────┬─────────────────────────────┘
                   │ per-driver transport
┌──────────────────▼─────────────────────────────┐
│ Agent CLIs: Codex, Claude, Cursor, Grok,       │
│ OpenCode, Antigravity                          │
└────────────────────────────────────────────────┘
```

The [RPC contract](../../packages/contracts/src/rpc.ts) is the boundary between independently
versioned clients and servers. Subscriptions send the state a client needs, so a client viewing one
thread does not pay for every thread's history. Authentication of a socket does not authorize every
method on it. See [environment auth](./environment-auth.md).

Provider-specific behavior belongs behind an adapter. Orchestration works with normalized commands
and events, so adding a provider should not require branches throughout the domain or clients.
See [provider constraints](./providers.md).

## Durable intent and side effects

The event log is the source of truth for orchestration state. The
[engine](../../apps/server/src/orchestration/Layers/OrchestrationEngine.ts) serializes commands;
the [decider](../../apps/server/src/orchestration/decider.ts) produces events without performing
provider or filesystem work. Events, persisted projections, and the accepted command receipt commit
in one database transaction. The in-memory state changes and subscribers receive events after that
commit. This keeps command retries idempotent and prevents a persisted projection from getting
ahead of the event log.

Reactors perform side effects after intent has been recorded, then feed results back through
commands. A command acknowledgement therefore means the intent committed, not that the provider,
checkpoint, or other follow-up work finished. Keep external I/O out of the decider and the database
transaction.

Persisted events must remain decodable on replay. Changing a schema affects old environments at
startup as well as live RPC traffic. Compatibility work must account for stored history, not just
what the newest client sends.

## Turn completion and checkpoints

A turn ending and its follow-up work settling are separate milestones. The
[projector](../../apps/server/src/orchestration/projector.ts) settles the turn from its session
status. A late checkpoint or diff must not extend the recorded turn duration or keep the client
showing provider work as active.

[Checkpoints](../../apps/server/src/checkpointing/CheckpointStore.ts) use hidden Git refs to
capture workspace state without adding commits to the user's branch. A revert must coordinate
workspace state with the provider conversation. A provider that cannot roll back its conversation
must reject that operation before changing the filesystem.

## Waiting for asynchronous work

Tests use [drainable workers](../../packages/shared/src/DrainableWorker.ts) to wait until both the
queue and its current item have finished. An empty queue alone does not prove the worker is idle.

Runtime receipts mark specific test milestones. Their
[production layer](../../apps/server/src/orchestration/Layers/RuntimeReceiptBus.ts) is a no-op;
production behavior must use persisted state and events. These test signals are separate from the
durable command receipts that make dispatch idempotent.

A turn is complete when its session leaves `running` status, projected by
`settledTurnStateForSessionStatus` in [`projector.ts`][projector]. Checkpoint work settling later
does not define turn end.

Thread settlement is server-owned. Each server's settings control PR and inactivity settlement.
Clients synchronize those preferences through `SHARED_SERVER_SETTING_KEYS` for connected servers
that advertise `threadAutoSettlement`. [`ThreadSettlementService`][settlement] sweeps at startup,
on settings changes, and once per minute, including when no client is connected. Merge notifications
trigger an immediate check and invalidate cached PR state. Existing worktrees share the same PR
lookup cache as the sidebar; missing worktrees fall back to the project root.

The guarded `thread.auto-settle` command rejects newer activity, explicit settled overrides, and
live or blocked work. It records the last activity timestamp for stable sorting. PR settlement
requires a comparable merge or close timestamp; inactivity can settle a quiet thread with an open
PR. Clients render the persisted settlement state. Settling detaches idle provider sessions.

At run completion, `RunFinalizationService` refreshes PR discovery when the checkout matches the
thread's non-default branch and a newer run is not active. `VcsStatusBroadcaster` requires loaded
remote status and permission from background policy. `GitManager` retries only a successful
"no PR" cache entry for the current branch, preserving known PRs and failure backoff without
fetching remotes. Remote status cache writes share a lock per cwd, including the initial load.

## Drainable workers

Follow-up work runs asynchronously in queue-backed workers built on [`DrainableWorker`][worker]:
[`ProviderRuntimeIngestion`][ingest] normalizes provider runtime streams into orchestration commands,
[`ProviderCommandReactor`][cmd] dispatches provider calls in response to intent events,
[`CheckpointReactor`][checkpoint] captures and reverts workspace checkpoints, and
[`ThreadSettlementService`][settlement] evaluates server-owned automatic settlement rules.

`DrainableWorker` pairs a transactional queue with a transactional count of outstanding items.
`enqueue` atomically offers and increments; processing always decrements. `drain` retries until the
count reaches zero, so a test can await "queue empty and current item finished" instead of sleeping.
Each of these four services exposes `drain` for exactly this.

Runtime receipts are a test-only mechanism. `RuntimeReceiptBusLive` in
[`RuntimeReceiptBus.ts`][receipts] publishes nothing; only the test layer is PubSub-backed. Do not
build production behavior on receipts.

## Provider drivers

Six drivers ship built in, registered in [`builtInDrivers.ts`][drivers] as `BUILT_IN_DRIVERS`:
Codex, Claude, Cursor, Grok, OpenCode, and Antigravity. A driver declares its kind and config schema and creates a
scoped adapter; `ProviderInstanceRegistry` owns live instances and `ProviderAdapterRegistry` resolves
an instance to its adapter, so `ProviderService` routes session and turn operations without knowing
which agent is behind them. See [providers.md](./providers.md).

## Checkpointing

Each turn is bracketed by workspace checkpoints so diffs and reverts are exact. `CheckpointStore`
captures state as hidden Git refs through the VCS driver's checkpoint operations;
`CheckpointDiffQuery` answers turn and full-thread diff requests; `CheckpointReactor` coordinates
baseline capture, completed-turn capture, diff projection, and reverting both the workspace and the
provider conversation. The storage contract is `VcsCheckpointOps` in
[`VcsDriver.ts`](../../apps/server/src/vcs/VcsDriver.ts), implemented for Git in the same directory.

## Startup

[`serverRuntimeStartup.ts`][startup] runs a fixed lifecycle: start keybindings, settings, and
reactors; publish welcome; signal command readiness (logged as `Accepting commands`); wait for the
HTTP listener via `markHttpListening`; publish ready; fork the heartbeat; then either print headless
output or open the browser. Command readiness precedes the listener, so a socket that opens can
already dispatch.

## Related

- [Workspace layout](./workspace-layout.md), [Glossary](./glossary.md)
- [Mobile navigation headers](./mobile-navigation.md)
- [Remote environments](./remote.md), [Server updates](./server-updates.md)
- [Resource telemetry](./resource-telemetry.md)
- [Product analytics](./product-analytics.md)
- [Scripts](./scripts.md), [CI gates](./ci.md)

[rpc]: ../../packages/contracts/src/rpc.ts
[contracts]: ../../packages/contracts/src/orchestration.ts
[ws]: ../../apps/server/src/ws.ts
[session]: ../../packages/client-runtime/src/rpc/session.ts
[startup]: ../../apps/server/src/serverRuntimeStartup.ts
[engine]: ../../apps/server/src/orchestration/Layers/OrchestrationEngine.ts
[decider]: ../../apps/server/src/orchestration/decider.ts
[projector]: ../../apps/server/src/orchestration/projector.ts
[worker]: ../../packages/shared/src/DrainableWorker.ts
[ingest]: ../../apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts
[cmd]: ../../apps/server/src/orchestration/Layers/ProviderCommandReactor.ts
[checkpoint]: ../../apps/server/src/orchestration/Layers/CheckpointReactor.ts
[settlement]: ../../apps/server/src/orchestration-v2/ThreadSettlementService.ts
[receipts]: ../../apps/server/src/orchestration/Layers/RuntimeReceiptBus.ts
[drivers]: ../../apps/server/src/provider/builtInDrivers.ts
