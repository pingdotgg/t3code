# Server-Authoritative Event-Sourcing Cleanup Plan

Goal:
- Move to a cleaner service architecture with:
  - durable, server-authoritative event sourcing
  - strict command routing/validation
  - pluggable provider adapters
  - explicit separation between transport, domain orchestration, provider runtime, and persistence

## Target Service Graph (ASCII)

```text
                              +---------------------------+
                              |        wsServer           |
                              |        transport          |
                              +---------------------------+
                                  | orchestration.dispatchCommand
                                  v
                    +-------------------------------------------+
                    |      OrchestrationCommandRouter          |
                    +-------------------------------------------+
                                  |
                                  v
                    +-------------------------------------------+
                    |     OrchestrationCommandHandlers         |
                    +-------------------------------------------+
                                  |
                                  v
                    +-------------------------------------------+
                    |        OrchestrationEventStore           |
                    +-------------------------------------------+
                                  |
                                  v
                    +-------------------------------------------+
                    |      OrchestrationProjectionService      |
                    +-------------------------------------------+
                                  | snapshot/replay
                                  +---------------------------> wsServer


wsServer -- providers.* RPC --> +---------------------------+
                                |      ProviderService      |
                                +---------------------------+
                                    |                 |
                                    v                 v
                        +-------------------+   +-------------------------+
                        | ProviderSession   |   | ProviderAdapterRegistry |
                        | Registry (durable)|   +-------------------------+
                        +-------------------+               |
                                     ^                      v
                                     |            +-------------------------+
                                     |            |   ProviderAdapter(s)    |
                                     |            +-------------------------+
                                     |                     |
                                     | runtime events      v
                                     |          +---------------------------+
                                     +----------| ProviderRuntimeIngestion  |
                                                +---------------------------+
                                                     |        |         |
                                                     v        v         v
                                                  Router   Session   Checkpoint
                                                            Registry  Service

                             +-------------------------------------------+
                             |            CheckpointService              |
                             +-------------------------------------------+
                                 |                |                 |
                                 v                v                 v
                     +--------------------+  +-------------+  +-------------------+
                     | CheckpointCatalog  |  | Checkpoint  |  | ProviderAdapter(s)|
                     | (durable)          |  | Store (git) |  | (read/rollback)   |
                     +--------------------+  +-------------+  +-------------------+
                                 |
                                 v
                              +------+
                              |SQLite|
                              +------+

OrchestrationEventStore  ------> SQLite
OrchestrationProjectionService -> SQLite
ProviderSessionRegistry  ------> SQLite
CheckpointCatalog        ------> SQLite
```

## Commit Series

### Commit 1: Split public vs system orchestration command contracts
- Create separate schemas/types:
  - `ClientOrchestrationCommandSchema`
  - `SystemOrchestrationCommandSchema`
  - `OrchestrationCommandSchema = union(client, system)`
- Ensure client transport can only submit client commands.
- Keep system commands for server-internal workflows only.
- Expected files:
  - `packages/contracts/src/orchestration.ts`
  - `apps/server/src/wsServer.ts`
  - orchestration/service tests
- Tests:
  - reject system-only command via WS dispatch path
  - preserve internal dispatch functionality for system commands

### Commit 2: Introduce `OrchestrationCommandRouter` + handler boundary
- Add dedicated router service to validate, authorize, and route commands.
- Move command-to-event mapping out of `orchestration/Layer.ts` into handlers.
- Add aggregate-level invariant checks before append (thread exists, project exists, etc.).
- Expected files:
  - `apps/server/src/orchestration/Services/CommandRouter.ts` (new)
  - `apps/server/src/orchestration/Layers/CommandRouter.ts` (new)
  - `apps/server/src/orchestration/Layer.ts`
  - `apps/server/src/orchestration/reducer.ts` (only if needed for event payload changes)
- Tests:
  - router validation and invariant failures
  - handler happy-path tests per command type

### Commit 3: Harden event store for idempotency + optimistic append metadata
- Add DB-level idempotency guard for `command_id` (`UNIQUE` where non-null).
- Extend append API to support idempotent replays and deterministic return of prior event on duplicate `commandId`.
- Add optional aggregate version metadata for future optimistic concurrency.
- Expected files:
  - `apps/server/src/persistence/Migrations/00x_*.ts` (new migration)
  - `apps/server/src/persistence/Services/OrchestrationEvents.ts`
  - `apps/server/src/persistence/Layers/OrchestrationEvents.ts`
- Tests:
  - duplicate command ID append returns same event/sequence (or explicit idempotent behavior)
  - concurrent append behavior stays ordered and deterministic

### Commit 4: Extract provider-runtime -> orchestration bridge from `wsServer`
- Create `ProviderRuntimeIngestionService` that:
  - subscribes to `ProviderService.streamEvents`
  - translates runtime events into orchestration commands
  - dispatches through router/engine
- Remove provider-to-orchestration state mutation logic from `wsServer`.
- Expected files:
  - `apps/server/src/orchestration/Services/ProviderRuntimeIngestion.ts` (new)
  - `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts` (new)
  - `apps/server/src/wsServer.ts`
- Tests:
  - ingestion service mapping tests (turn started/completed, message delta/completed, runtime error)
  - ws integration confirms same external push behavior

### Commit 5: Make session directory durable (`ProviderSessionRegistry`)
- Replace in-memory-only `ProviderSessionDirectoryLive` with persistence-backed registry.
- Keep in-memory cache optional, but source of truth must be persistent.
- Add startup reconciliation to prune dead sessions / keep known thread mapping.
- Expected files:
  - `apps/server/src/provider/Services/ProviderSessionDirectory.ts` (or new SessionRegistry service)
  - `apps/server/src/provider/Layers/ProviderSessionDirectory.ts`
  - `apps/server/src/persistence/Migrations/00x_*.ts` (new table/indexes)
  - provider persistence tests
- Tests:
  - survives server restart with correct mapping
  - stale session cleanup semantics

### Commit 6: Re-key checkpoint metadata from session to thread identity
- Change checkpoint catalog primary identity from `provider_session_id` to durable `thread_id`.
- Keep `session_id` as nullable metadata only.
- Update checkpoint flows (`initialize`, `capture`, `list`, `diff`, `revert`) to use thread identity.
- Expected files:
  - `apps/server/src/persistence/Migrations/00x_*.ts` (checkpoint schema migration)
  - `apps/server/src/persistence/Services/Checkpoints.ts`
  - `apps/server/src/persistence/Layers/Checkpoints.ts`
  - `apps/server/src/checkpointing/Layers/CheckpointService.ts`
- Tests:
  - resume/new session over same thread sees same checkpoint history
  - revert/diff still work after session churn

### Commit 7: Add durable projection persistence for orchestration read models
- Introduce projection tables/snapshots persisted in DB to avoid full replay dependency.
- Keep event stream as source of truth; projection rebuild stays deterministic.
- `getSnapshot` reads from projection store (memory cache optional).
- Expected files:
  - `apps/server/src/persistence/Migrations/00x_*.ts` (projection tables)
  - `apps/server/src/orchestration/*` projection service/layer
  - `apps/server/src/wsServer.ts` (snapshot/replay path wiring)
- Tests:
  - cold boot snapshot load without replaying full history in process
  - projection rebuild from events yields same result as previous reducer semantics

### Commit 8: Narrow `ProviderService` responsibilities
- Keep `ProviderService` focused on provider RPC/session lifecycle + unified runtime stream.
- Move checkpoint-capture side effects out of provider event worker into dedicated ingestion/checkpoint pipeline service.
- Preserve adapter pluggability and provider-neutral contracts.
- Expected files:
  - `apps/server/src/provider/Layers/ProviderService.ts`
  - new orchestration/checkpoint runtime coordinator service(s)
- Tests:
  - provider service routing stays intact
  - checkpoint capture still triggered by turn completion through new coordinator

### Commit 9: Remove dead legacy path and finalize docs
- Remove unused legacy manager/store path from active architecture:
  - `providerManager.ts`
  - `filesystemCheckpointStore.ts` (if no longer needed by tests/tools)
- Update architecture docs with final service boundaries and boot/runtime graph.
- Expected files:
  - legacy files + references
  - `AGENTS.md`/docs as needed
  - `.plans` docs linkage
- Tests:
  - full server integration suite passes on Effect-only path
  - no regressions in WS protocol behavior

## Risk Controls
- Keep WS method names and payload contracts stable throughout.
- Gate each commit with targeted integration tests before moving forward.
- Avoid broad event-type churn in one step; migrate schemas incrementally with clear compatibility windows.
