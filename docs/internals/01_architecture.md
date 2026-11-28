# Architecture

T3 Code keeps execution in the environment that owns the workspace. Web, desktop, and mobile
clients control it over authenticated RPC. A remote client must never substitute its own filesystem,
provider credentials, or machine state for the environment's. The desktop app bundles a server,
but its renderer follows the same boundary.

## Ownership boundaries

- **Server (`apps/server`).** Owns provider processes, terminals, Git, checkpoints, durable state,
  and project files.
- **Client runtime (`packages/client-runtime`).** Owns shared connection management and domain
  state across web, desktop, and mobile so reconnect and multi-environment behavior do not diverge.
  Clients supply platform services and UI. See [connection runtime](./09_connection-runtime.md) and
  [remote environments](./05_remote.md).
- **Contracts (`packages/contracts`).** The typed wire boundary between independently versioned
  clients and servers. Subscriptions send only the state a client needs. Authentication of a socket
  does not authorize every method on it; see [environment auth](./04_environment-auth.md).
- **Providers (`packages/provider-*`).** Provider-specific protocols and quirks stay behind an
  adapter. Orchestration and clients read capabilities, never provider names. See
  [providers](./03_providers.md).

## Settings ownership

Client preferences live in the current client; environment defaults and project overrides live on
their owning server. An unavailable settings target must never fall back to another environment.
**All environments** is an explicit bulk edit of currently connected servers, not a durable global
default or sync promise.

## Durable intent and side effects

Orchestration state is decided as events, and persisted projections are the source of truth once
applied. The [orchestrator](../../apps/server/src/orchestration-v2/Orchestrator.ts) serializes
commands and decides events without doing I/O.
[EventSink](../../apps/server/src/orchestration-v2/EventSink.ts) commits events, persisted
projections, command receipts, and outbox effects in one database transaction, then notifies
subscribers.

The [effect worker](../../apps/server/src/orchestration-v2/EffectWorker.ts) runs side effects after
commit and feeds results back as commands. A command acknowledgement therefore means intent
committed, not that provider, checkpoint, or follow-up work finished. Never put external I/O in
command decisions or the database transaction. Effects tied to a lost provider process are retired
on recovery rather than replayed.

The event log retains only a bounded replay window, so projections cannot be rebuilt from scratch
from the log. Retained events must remain decodable across upgrades: schema changes affect stored
history at startup, not just live RPC traffic.

## Turn completion and checkpoints

A provider turn ending and follow-up work settling (checkpoints, diffs, PR sync) are separate
milestones. Late finalization must not keep the client showing provider work as active or extend
recorded provider duration.

A run is `completed` when its provider turn ends; the turn-end checkpoint is captured afterwards as
an outbox effect on the thread's effect lane. Until that capture commits, readers treat the missing
checkpoint as pending, and command decisions still see the run as `waiting`, so steers, queued
turns, rollback and restore line up behind the capture.

Checkpoints use hidden Git refs so workspace snapshots never add commits to the user's branch.
Reverting a checkpoint must coordinate workspace state with the provider conversation: if the
provider cannot roll back its conversation, reject the revert before touching the filesystem.

Thread settlement is server-owned. Clients render persisted settlement state rather than deriving it
from local clocks or PR caches.

## Desktop process isolation

Native modules never load on the Electron main process startup path. Native capabilities that can
crash or stall (such as accessibility or window-capture helpers) run in isolated child processes or
workers with deadlines, never as top-level imports in main.

See the [glossary](./00_glossary.md) for shared terms and the
[development runbook](../operations/00_development.md) for setup and checks.
