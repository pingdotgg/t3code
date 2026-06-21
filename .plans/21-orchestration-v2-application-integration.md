# Plan: Orchestration V2 Application Integration

## Summary

Make Orchestration V2 the only orchestration system used by the server, web app, and mobile app. Preserve reusable platform infrastructure, remove V1 orchestration as each replacement becomes authoritative, and leave legacy persistence untouched until a separate state-migration plan is chosen.

In this plan, "Orchestration V2" means the agent orchestrator: provider sessions, runs, attempts, runtime requests, and external agent effects. It does not replace the application event-sourcing data plane. Projects and threads remain first-class application aggregates in one durable, globally ordered event source, and the shell remains a projection of that source.

The work is split into four sequential architectural shapes. Finish and validate one shape before beginning the next. These shapes are implementation checkpoints only: they exist to keep the work reviewable and easier to reason about, not to define rollout stages or supported compatibility windows.

There will be no users until after Shape 4 is complete. No intermediate shape is released, deployed for users, or expected to provide a usable mixed-version application. The first user-facing build uses the completed V2-only server and V2-native clients.

Execution rules:

- Do not dual-write V1 and V2 state.
- Do not mirror production commands into both runtimes.
- Do not write core entity projection tables directly. Project and thread mutations commit application events first; projections are derived transactionally and remain replayable.
- Preserve one application event cursor across project and thread shell changes.
- Shapes 1 and 2 may keep V1 runnable as a development reference while V2 is completed through direct and replay-backed tests; this is not a supported user path or rollout strategy.
- Shape 3 performs the backend hard cut and intentionally breaks the old client protocol.
- Shape 4 updates web and mobile to the final protocol. No intermediate backend/client compatibility adapter is required because no users consume the intermediate shapes.
- Only the completed Shape 4 system is eligible for the first user-facing release.
- Do not drop V1 tables, migrations, provider runtime rows, or attachment files during this plan.
- V1 removal happens inside the shape that replaces it; there is no deferred general cleanup phase.

## Alignment With The Current Production Path

The current application path is V1 at the orchestration boundary, but several provider and selection concepts beneath it are already provider-neutral and should be retained. Shapes 1 and 2 must not recreate functionality that already exists.

The current production flow is:

```text
Web/mobile model and mode selection
  -> V1 thread command and projection
  -> ProviderCommandReactor
  -> ProviderService.getByInstance(instanceId)
  -> ProviderInstanceRegistry
  -> driver-specific legacy adapter
```

Current ownership and intended treatment:

| Concept | Current ownership | Decision |
| --- | --- | --- |
| `ProviderDriverKind` | Neutral `packages/contracts/src/providerInstance.ts` | Keep unchanged. It identifies the protocol implementation. |
| `ProviderInstanceId` | Neutral `packages/contracts/src/providerInstance.ts` | Keep unchanged. It remains the routing key for configured instances. |
| `ProviderInstanceRegistry` | Server provider platform | Keep its configuration, lifecycle, hot reload, unavailable-instance handling, continuation identity, and instance lookup behavior. Replace its legacy adapter surface with V2 during the backend transition. |
| `ModelSelection` | Physically defined in V1 `packages/contracts/src/orchestration.ts`, but used by V1, V2, providers, web, and mobile | Move essentially unchanged to a neutral provider/model contract. Do not redesign the client-facing shape. |
| `RuntimeMode` | Physically defined in V1 `packages/contracts/src/orchestration.ts` | Move unchanged to a neutral runtime contract. |
| `ProviderInteractionMode` | Physically defined in V1 `packages/contracts/src/orchestration.ts` | Move unchanged to a neutral runtime contract. |
| Model and mode UI | Existing web/mobile production code | Preserve the concepts and controls. Shape 4 rewires their commands and state source to V2. |
| Instance-aware provider routing | `ProviderService`, `ProviderCommandReactor`, and `ProviderInstanceRegistry` | Preserve the behavior as policy, but replace the V1 service/reactor implementations. |

`ModelSelection` is already instance-based:

```ts
{
  instanceId: ProviderInstanceId;
  model: string;
  options?: ProviderOptionSelections;
}
```

Moving this type in Shape 1 is dependency and ownership cleanup required to delete the V1 contract. It is not a new model-selection feature.

The production provider path already performs useful behavior that V2 must preserve:

- resolve `modelSelection.instanceId` through the instance registry
- discover the corresponding driver and capabilities
- reject missing or unavailable instances
- decide whether a model can switch within the current session
- restart a session when runtime mode, workspace, instance, or an unsupported model change requires it
- verify continuation compatibility when changing configured instances
- apply interaction mode to each provider turn

V2 currently diverges from this model:

- V2's generic `ProviderKind` stores an instance ID on app threads, runs, and attempts, but stores a driver kind on provider sessions, provider threads, events, and native references.
- V2 compares some of these incompatible values directly, which only appears correct for default instances where the driver and instance slugs are identical.
- V2 constructs a separate settings-backed adapter registry instead of consuming one canonical provider-instance lifecycle.
- Some V2 adapter paths still return hardcoded default instance IDs even when created for a custom instance.
- V2 stores model and mode values on thread creation but lacks production thread mutation commands for changing them.
- `message.dispatch` can use a run-specific model selection without updating the thread's default selection.
- `provider.switch` exists in the contract but is not handled by the orchestrator dispatcher.

Therefore:

- Shape 1 relocates existing shared contracts, aligns V2 with the existing driver/instance identity model, ports thread mutation semantics, and converges on one provider-instance registry.
- Shape 2 replaces the operational behavior currently hidden in `ProviderCommandReactor` and other V1 reactors with explicit V2 policies, services, and durable effects.
- Neither shape rebuilds the existing model picker, runtime-mode picker, interaction-mode picker, or provider-instance configuration UX.

## Shape 1: Production-Ready V2 Foundation

### Goal

Make V2 contracts, persistence, command handling, projections, and streams stable enough that application services can depend on them without inheriting temporary semantics.

### 1. Separate shared contracts from V1

Move non-orchestration concepts out of `packages/contracts/src/orchestration.ts`:

- `ModelSelection`
- runtime and interaction modes
- message attachments
- approval and input-request payloads
- project identifiers and metadata
- common timestamps and provenance types

`ProviderDriverKind` and `ProviderInstanceId` already live in the neutral `providerInstance.ts` contract. Reuse them directly; do not redefine or relocate them as part of this work.

Use neutral contract modules such as:

- `provider.ts`
- `projects.ts`
- `messages.ts`
- `runtime.ts`

V1 may temporarily import these neutral contracts until its removal. New V2 code must not import anything from the V1 orchestration contract. Preserve the current `ModelSelection`, runtime-mode, and interaction-mode wire semantics unless a deliberate final-contract simplification is made while updating all callers together.

### 2. Align V2 with the existing provider identity model

The current production provider-instance model is the target. This step fixes V2's inconsistent use of it rather than inventing another identity system.

Replace ambiguous `provider` fields with explicit routing identity:

```ts
{
  driver: ProviderDriverKind;
  providerInstanceId: ProviderInstanceId;
}
```

Keep provider-native identity separate:

```ts
{
  nativeThreadId: string | null;
  nativeTurnId: string | null;
}
```

Apply the split consistently to:

- app threads
- runs and attempts
- provider sessions
- provider threads and turns
- context transfers and handoffs
- adapter resolution
- provider switching

Verify that multiple instances of the same driver route and resume independently. Remove hardcoded default-instance assumptions from adapters.

Converge on one provider-instance lifecycle:

- retain the existing registry's configuration map, scoped instance lifecycle, hot reload, unavailable-instance representation, and continuation identity
- make the final materialized provider instance expose the V2 orchestration adapter
- make `ProviderAdapterRegistryV2` a thin facade over the canonical instance registry or remove it
- remove the duplicate settings watcher and independently materialized V2 instance map
- remove the legacy adapter field when V1 provider execution is disconnected

Use these field rules:

- app threads and runs route by `providerInstanceId`
- provider sessions and provider threads carry `providerInstanceId` and `driver`
- provider-native refs carry `driver` plus the native ID and strength
- adapter lookup always uses `providerInstanceId`
- capability and protocol-specific behavior uses `driver` only at adapter and presentation boundaries

### Provider process residency and thread multiplexing

Make process sharing a provider capability, not an orchestrator special case:

- when `supportsMultipleProviderThreadsPerSession` is true, derive one stable provider-session ID per configured provider instance
- when it is false, allocate an isolated provider session per app thread
- Codex enables sharing now; ACP, Claude, Cursor, and OpenCode remain isolated until their adapters are independently proven multiplex-safe
- model selection, cwd, runtime policy, and MCP authorization are applied on thread start/resume/fork rather than process launch
- MCP bearer credentials have no idle or maximum lifetime; reissue, thread detachment, provider-session release, and server shutdown revoke them explicitly
- the manager tracks the loaded native thread configuration per app thread, so reattachment or a model/cwd/policy change reapplies thread-scoped settings without redundantly resuming unchanged threads
- provider-session projections use explicit many-to-many thread bindings
- archiving, deleting, or switching one thread detaches that binding; it does not release a shared runtime used by sibling threads
- the manager owns one consumer of each provider process event stream and broadcasts events to run subscribers
- each run filters broadcast events by app thread, run attempt, provider thread, provider turn, and subagent lineage before ingestion
- reaping uses aggregate activity: a shared process stays resident while any attached thread is active, then closes after the normal idle timeout
- full release remains an internal runtime lifecycle operation for process failure, server shutdown, or idle reap

This is an orchestration capability even when only one adapter enables it. Adding ACP or Claude sharing later must require only adapter capability and multiplex-safety work, not a new orchestrator path.

### 3. Complete the V2 command and event vocabulary

Add V2-native domain commands and events for:

- archive and unarchive
- delete/tombstone
- thread title and metadata changes
- branch and worktree metadata
- runtime mode
- interaction mode
- model-selection changes
- explicit thread detachment from a provider session
- provider switching

Extend thread and shell projections with:

- archive and delete state
- branch and worktree information
- current model and provider instance
- active run status
- pending runtime-request summary
- latest visible message and update timestamp

These commands commit domain state only. Filesystem, terminal, checkpoint, and provider side effects are implemented as durable effects in Shape 2.

### 4. Make command commits atomic

Replace per-event writes with one command transaction containing:

- all domain events
- all affected projection updates
- the accepted or rejected command receipt
- required durable effect requests
- the final committed event sequence

Duplicate command IDs must return the stored receipt without reapplying projections or repeating external effects.

Introduce a durable orchestration-effect outbox for operations such as:

- provider turn start
- provider interrupt
- runtime-request response
- provider rollback and fork
- provider-session detach
- checkpoint capture
- terminal cleanup
- attachment cleanup

External effects execute only after their originating domain transaction commits.

### 5. Fix projection and stream semantics

Implement:

- atomic `{ snapshot, sequence }` reads
- paginated event catch-up
- a race-free transition from stored events to live subscription
- shell snapshot cursors
- active, archive, update, and removal shell deltas
- projection schema versions
- projection replay and rebuild verification
- consistent thread `updatedAt` updates

Replace adapter-generated turn-item positions with a durable per-thread allocator. The first event for an item allocates its position; later updates retain it.

### 6. Decompose the orchestrator

Use the existing intended service boundaries instead of continuing to grow `Orchestrator.ts`:

- implement `ProviderSwitchService`
- implement `ThreadForkService` around existing fork and merge behavior
- implement `RuntimeRequestService`
- extract command transaction planning from effect execution
- delete `CorrelationStore` if no concrete consumer emerges

The orchestrator coordinates command handlers and transaction commits. Provider processes, filesystem work, and other external effects remain outside the domain transaction.

### Shape 1 tests

Add coverage for:

- two custom instances of the same provider driver
- accepted and rejected command idempotency
- crash or failure during multi-event command commits
- crash after commit but before provider-effect execution
- duplicate effect-worker claims
- snapshot/subscription races
- catch-up exceeding the current event-read limit
- shell archive and deletion deltas
- more than 100 turn items in one run
- projection replay equivalence
- lifecycle command projection behavior
- capability-driven shared versus isolated provider-session identity
- two concurrent app threads sharing one Codex runtime without cross-run event ingestion
- detaching one thread without closing the sibling runtime, followed by idle reap after the last detach

### Shape 1 exit gate

- Custom provider instances route correctly.
- Command retries cannot duplicate provider effects.
- Fault injection cannot produce partial projections.
- Snapshot reconnect tests prove no missing or duplicated events.
- Turn-item ordering is collision-free.
- Projection rebuild produces the same state as incremental projection.
- Lifecycle commands work through direct V2 tests.
- No new V2 code imports V1 orchestration contracts.
- V1 remains the only production application writer; no dual-write path exists.
- `vp check`, `vp run typecheck`, and `vp test` pass.

## Shape 2: Application Services Around V2

Implementation status: complete. The production WebSocket/client cutover remains intentionally deferred to Shape 3.

### Goal

Recreate the application behavior currently hidden in V1 reactors and WebSocket handlers using explicit V2 services and durable workflows.

### 1. Project domain service

Create a `ProjectService` outside the agent orchestrator that owns project validation and application commands for:

- create, update, and delete
- lookup by ID and workspace root
- project lookup and snapshot queries over the event-derived projection
- repository identity
- setup-script configuration
- favicon metadata
- startup auto-bootstrap
- project event planning

Reuse `projection_projects` initially instead of migrating project data. Project commands are application-domain commands, not agent-orchestrator commands, but they still commit to the shared application event source. `ProjectService` must not mutate `projection_projects` directly or own a standalone in-memory change stream.

Reuse existing project infrastructure:

- `ProjectSetupScriptRunner`
- `RepositoryIdentityResolver`
- `ProjectFaviconResolver`
- workspace and VCS services

Update project CLI operations to target this service in tests, but do not switch the production route until Shape 3.

### 2. Thread launch workflow

Create `ThreadLaunchService` with an input equivalent to:

```ts
{
  commandId: CommandId;
  projectId: ProjectId;
  title: string;
  modelSelection: ModelSelection;
  runtimeMode: RuntimeMode;
  interactionMode: InteractionMode;
  workspaceStrategy: WorkspaceStrategy;
  initialMessage?: InitialMessage;
}
```

The service owns:

1. Project resolution and validation.
2. Worktree and branch provisioning.
3. Setup-script execution.
4. V2 `thread.create` dispatch.
5. Optional initial-message dispatch.
6. First-turn title and branch generation.
7. Compensation for partially completed launches.

Launches involving filesystem work need a durable workflow record so a restart can resume or compensate instead of leaving orphaned worktrees.

Reuse:

- Git and worktree services
- `ProjectSetupScriptRunner`
- text generation
- repository identity
- VCS status broadcasting

Do not reuse the V1 WebSocket bootstrap as an orchestration layer.

### 3. Thread lifecycle service

Create `ThreadLifecycleService` around the Shape 1 lifecycle commands.

Archive behavior:

- commit archive state
- enqueue detachment from live provider sessions
- enqueue terminal closure
- remove the thread from the active shell projection

Unarchive behavior:

- commit active state
- restore it to the active shell projection
- do not open a provider session eagerly

Delete behavior:

- commit a tombstone first
- cancel queued or running work
- detach the deleted thread from provider sessions
- close terminal history according to current product semantics
- clean unreferenced attachments
- revoke MCP credentials
- remove the thread from active and archived shell projections

Metadata and mode changes should be pure V2 commands without hidden V1 events.

### 4. Run finalization service

Create `RunFinalizationService` to replace the V1 checkpoint reactor.

On root-run start:

- establish the checkpoint scope
- capture or verify the pre-run baseline

On root-run completion:

- capture the filesystem checkpoint
- calculate the file summary
- commit checkpoint projection events
- refresh workspace entries
- refresh VCS status
- trigger relevant diff and index updates

Effect IDs must be deterministic per run and scope so replay or restart cannot create duplicate checkpoints. Child or subagent completion must not finalize the root run.

Keep and reuse:

- `CheckpointStore`
- checkpoint diff parsing
- VCS and Git infrastructure
- workspace indexing infrastructure

### 5. Provider session transition policy

Extract the useful decision logic currently embedded in `ProviderCommandReactor` into a pure V2 `ProviderSessionTransitionPolicy`.

Inputs should include:

- current thread and active provider-thread state
- current provider session, if any
- requested `ModelSelection`
- requested runtime and interaction modes
- target workspace
- current and target provider instance metadata
- provider capabilities and continuation identity

The policy should return an explicit decision:

```ts
type ProviderSessionTransition =
  | { type: "reuse" }
  | { type: "switch_model_in_session" }
  | { type: "restart_and_resume" }
  | { type: "create_with_handoff" }
  | { type: "reject"; reason: string };
```

Required semantics:

- reuse a compatible live session when nothing relevant changed
- switch models in-session only when the adapter advertises support
- restart and resume when runtime mode, workspace, or unsupported model changes require it
- treat a different configured instance as an instance transition even when the driver is unchanged
- use continuation identity to determine whether native resume state is compatible
- use explicit context handoff for cross-driver or incompatible-instance transitions
- apply interaction mode to the next run without treating it as provider identity
- never compare a driver kind directly with a provider instance ID

`ProviderSessionManagerV2` and the durable effect worker execute the selected transition. Do not retain `ProviderCommandReactor` as an intermediary.

### 6. Provider runtime recovery

Create `ProviderRuntimeRecoveryService` and run it before command readiness.

It must:

- reconcile provider sessions left active by a crash
- expire or cancel orphaned runtime requests
- reclaim pending or running outbox effects
- resume provider threads where supported
- retry recoverable attempts within policy
- terminalize unrecoverable runs
- release idle sessions
- prevent one logical effect from executing concurrently twice

Recovery decisions must be driven by capabilities and runtime policy, not provider-name checks.

### 7. Portable provider fallback

Complete portable context handoff before V2 becomes the application runtime:

- use native resume when a strong provider reference exists
- create a replacement provider thread when resume fails
- inject portable history exactly once
- record the handoff explicitly
- keep rollback and fork capability-gated when correlations are weak

This is also the continuation mechanism a future legacy importer can reuse.

### Shape 2 tests

Direct service-level integration tests must cover:

- project create, update, lookup, and delete
- root-workspace and worktree thread launch
- setup-script success and failure compensation
- first-run title and branch generation
- model changes supported in-session
- model changes requiring session restart
- runtime-mode changes requiring session restart
- interaction-mode changes applied to the next run
- same-driver compatible instance transitions
- incompatible and cross-driver instance transitions using handoff
- send, queue, steer, restart, reorder, and interrupt
- approval and user-input response
- archive, unarchive, and delete cleanup
- checkpoint capture, diff, and rollback
- process restart during each durable external effect
- provider-native resume
- failed native resume followed by portable fallback

### Shape 2 exit gate

- Application services reproduce all required V1 product behavior without V1 orchestration dependencies.
- Provider session transition decisions preserve current production model, mode, workspace, and instance-routing semantics.
- External side effects are durable and idempotent.
- Restart recovery leaves no permanently active run or request.
- Portable fallback can continue a thread after native resume failure.
- No WebSocket or production client cutover has occurred yet.
- `vp check`, `vp run typecheck`, and `vp test` pass.

## Shape 3: V2-Only Backend Ownership

Implementation status: complete. The revision removes the V1 agent runtime, restores the existing application event-sourcing data plane, and installs V2 behind it instead of replacing it.

### Goal

Make V2 the only live agent orchestration runtime while preserving the event-sourced application backend.

This shape intentionally breaks the old client protocol. That is acceptable because the shapes are implementation chunks and there are no users or releases between them.

### 1. Production orchestration gateway

Replace V1 and debug V2 endpoints with one production API containing:

- one shell snapshot and subscription containing projects, active threads, and archived threads
- archived-thread query and subscription
- full thread projection snapshot and subscription
- thread launch
- message dispatch
- queue, reorder, and promote
- interrupt, restart, and steer
- runtime-request response
- metadata and mode updates
- archive, unarchive, and delete
- rollback
- fork and merge-back
- provider switch
- provider-session detach

Use final unversioned method names. Do not retain compatibility aliases.

The shell stream uses one durable application-event cursor. Project and thread deltas cannot be split into independently ordered streams.

The project HTTP API may remain as a CLI command/query transport, but it must call the same event-sourced `ProjectService`. It is not a second project state source, and the WebSocket protocol must not expose a separate project snapshot or subscription.

Move the debug route's projection reducer into a shared pure client-runtime module. Backend behavior must not depend on debugger state.

### 2. Replace server runtime composition

In `apps/server/src/server.ts`:

- remove the V1 agent reactors and provider runtime from the composition, but retain the existing `OrchestrationLayerLive` application event/projection infrastructure
- retain `orchestration_events` and `orchestration_command_receipts` as the generic application event log and receipt store; their historical names do not make them V1-only tables
- migrate the isolated `orchestration_v2_events` and `orchestration_v2_command_receipts` rows into that shared log, then treat the V2-specific tables as read-only legacy storage
- preserve or rename the generic projection, replay, and shell-query infrastructure
- remove only V1 agent/provider reactor composition
- remove the V1 provider runtime layer
- install V2 application services
- install the durable effect worker
- install runtime recovery
- retain shared SQLite, provider-instance, VCS, terminal, workspace, project, and diagnostic infrastructure

In `apps/server/src/serverRuntimeStartup.ts`, establish this startup order:

1. Start settings and platform services.
2. Verify or rebuild V2 projections when required.
3. Run provider and durable-effect recovery.
4. Start effect workers.
5. Auto-bootstrap the standalone project domain.
6. Signal command readiness.
7. Publish welcome and readiness events.

No V1 reactor or provider-session reaper starts.

The resulting ownership boundary is:

```text
application commands
  -> application event transaction
  -> project/shell/thread projections
  -> Agent Orchestrator V2 durable effects
  -> provider execution
  -> additional application events
```

The event transaction remains responsible for ordered append, command idempotency, projection updates, effect-outbox enqueue, and the committed sequence.

This is an integration, not a replacement data plane. Restore and adapt the existing components:

- `OrchestrationEventStore` remains the one durable event source and gains V2 thread-event codecs; V2 `EventStore` is an adapter over it, not a second SQL implementation.
- `OrchestrationCommandReceiptRepository` remains the command-idempotency store; the V2 receipt service adapts to it.
- `OrchestrationEngine` retains its serialized project-command transaction, decider, and projector path. Its production command surface is narrowed to project commands instead of restoring V1 agent execution.
- `OrchestrationProjectionPipeline` remains responsible for project projection replay and cursor advancement.
- `ProjectionSnapshotQuery` remains the source of project shell rows and is composed with V2 thread projections for the unified shell.

Do not introduce parallel `ApplicationEventStore`, `ProjectProjection`, or `ApplicationShellService` replacements for these components.

### 3. Update backend consumers

Rewrite or redirect:

- `CheckpointDiffQuery` to V2 checkpoint scopes and runs
- `AgentAwarenessRelay` to V2 shell, run, and runtime-request state
- project CLI to `ProjectService`
- startup heartbeat to `ProjectService` and V2 projection counts
- welcome auto-bootstrap to `ProjectService` and `ThreadLaunchService`
- orchestration HTTP API to the new gateway, or remove it when redundant
- MCP orchestration to the production `ThreadManagementService`

### 4. Remove V1 server code

Delete:

- V1-only files under `apps/server/src/orchestration/**`, while keeping the existing event transaction, project decider/projector, projection pipeline, and snapshot query
- V1 orchestration HTTP routes
- V1 WebSocket handlers
- V1 reactor and startup wiring
- V1 projection queries
- V1 provider command and runtime ingestion
- V1 provider session directory and reaper
- V1 high-level provider adapters and services after import analysis confirms no remaining consumers
- corresponding tests and duplicate service interfaces

Do not delete infrastructure merely because it lived under the old `orchestration` namespace. Retain or relocate code whose responsibility is generic application event append/replay, command receipts, project/shell projection, cursor catch-up, or projection rebuild.

Retain low-level provider infrastructure imported by V2, including provider instance configuration, SDK and ACP transports, environment setup, logging, and runtime utilities.

Add an import-boundary test preventing production code from importing the deleted V1 agent reactors and provider services. Imports of the retained application event/projection services are expected.

### 5. Preserve legacy storage

Do not drop:

- V1 event or projection tables
- old migrations
- provider-session runtime rows
- existing attachment files

Move only the minimal V1 projection decoders potentially needed by migration into an isolated `legacy/orchestration-v1` module. That module must not be installed in the server runtime layer and must have no write API.

### Shape 3 tests

Add backend integration coverage for:

- startup ordering and command readiness
- V2-only provider session creation
- shell and thread snapshot reconnects
- project and thread changes sharing one ordered shell cursor
- project command idempotency and projection replay
- proof that project commands cannot bypass the application event store
- CLI project operations
- MCP send, wait, interrupt, fork, and merge flows
- agent-awareness output
- checkpoint diff queries
- terminal and attachment cleanup
- server shutdown and restart
- static import-boundary enforcement

### Shape 3 exit gate

- Server startup does not construct any V1 orchestration or provider runtime.
- Every production orchestration endpoint targets V2.
- Projects and threads are committed through one application event source and exposed through one shell stream.
- `projection_projects` and core thread projections are only changed by event projection/rebuild code.
- CLI, MCP, checkpoints, awareness, startup, and telemetry use V2.
- No production import references the deleted V1 agent reactors, provider runtime ingestion, provider command handling, or session-reaper services.
- New writes go only to the retained application event/receipt tables and event-derived projections; the retired V1-only projection/runtime tables and isolated `orchestration_v2_*` event/receipt tables remain untouched.
- Backend integration and restart tests pass.
- Old clients are expected to be incompatible at this boundary.
- `vp check`, `vp run typecheck`, and `vp test` pass.

## Shape 4: V2-Native Web And Mobile Clients

### Goal

Move all production clients to V2 projections and remove the remaining V1 contract and presentation model.

### 1. New client-runtime state

Replace the V1 stores with:

- project snapshot state
- thread shell state
- archived-thread state
- full V2 thread projection state
- snapshot and cursor persistence
- connection and reconnect state
- optimistic command-receipt state where necessary

Use the server's committed sequence as the reconnect boundary.

Bump web and mobile cache versions. Discard cached V1 orchestration state while preserving drafts, credentials, preferences, and environment configuration.

### 2. Shared V2 presentation model

Create one shared timeline derivation module using:

- `visibleTurnItems`
- runs and attempts
- execution nodes
- runtime requests
- plans
- checkpoints
- context handoffs
- fork and subagent markers

Expose UI-oriented entries for:

- user and assistant messages
- reasoning
- tool and command execution
- file changes
- file and web search
- approval and input requests
- proposed plans
- todo lists
- checkpoints
- interrupts
- handoffs, forks, and subagents
- errors and diagnostic status

Both web and mobile consume this module. Delete the separate V1 transformations in web `session-logic.ts` and mobile `threadActivity.ts`.

### 3. Replace client commands

Update client-runtime operations for:

- project mutations
- thread launch
- send and start
- queue, steer, restart, promote, and reorder
- interrupt
- approval and input response
- archive, unarchive, and delete
- metadata and mode changes
- rollback
- fork and merge-back
- provider switching
- provider-session detach

Commands use final V2 identifiers and receipt semantics directly.

### 4. Web integration

Update:

- sidebar and project grouping
- new-thread flow
- chat timeline
- composer behavior
- active-run controls
- approval and input controls
- plan implementation
- diff and rollback views
- archive management
- thread deletion
- provider and model switching
- context-window and token indicators

Reuse UI widgets, but remove dependencies on `OrchestrationThreadActivity`, V1 `latestTurn`, and V1 pending-request shapes.

Delete the V2 debug route after its useful inspection and reducer code has moved into production modules.

### 5. Mobile integration

Update:

- home and thread lists
- new-task flow
- thread detail
- composer
- archive screens
- approval and input interactions
- run status
- diff and Git actions
- provider and model selectors

Mobile must consume the same shared timeline derivation as web.

### 6. Remove remaining V1 contracts

After all client imports are gone:

- delete V1 orchestration commands, events, and projections
- rename V2 contracts to final unversioned orchestration names
- delete V1 reducers, state models, persistence schemas, and client operations
- delete compatibility exports
- retain only the isolated legacy SQL decoder reserved for a future importer

### Shape 4 tests

Add shared client-runtime tests for:

- every V2 timeline item type
- incremental projection updates
- reconnect from persisted cursors
- shell archive and removal deltas
- queued, steering, restarted, and interrupted runs
- runtime requests opening, responding, expiring, and reconnecting
- plan and checkpoint presentation
- fork and handoff presentation

Add web and mobile integration coverage for:

- project and thread creation
- opening and continuing a thread
- active-run interaction
- archive, unarchive, and delete
- provider and model selection
- approvals and input requests
- checkpoint diff and rollback
- reconnect during a run

### Shape 4 exit gate

- Web and mobile open, create, run, reconnect, archive, and delete V2 threads.
- Queue, steer, restart, and interrupt work during live runs.
- Approvals and input requests survive reconnects.
- Checkpoint diff and rollback work.
- Provider resume and portable fallback work.
- No production TypeScript import references a V1 orchestration type.
- No V2-to-V1 compatibility projection exists.
- `vp check`, `vp run typecheck`, and `vp test` pass.
- `vp run lint:mobile` passes for mobile changes.

## Final Outcome

At the end of Shape 4:

- V2 is the only orchestration system.
- V1 runtime, server API, client state, and contracts are removed.
- Reusable platform infrastructure remains.
- Legacy database rows remain untouched and read-only.
- State migration remains a separate, narrow future project and is not a release blocker for this plan because no users exist before Shape 4.
- The first user-facing release happens only after the complete V2-only backend and V2-native clients pass the Shape 4 exit gate.
