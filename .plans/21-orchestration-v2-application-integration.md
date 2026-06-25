# Plan: Orchestration V2 Application Integration

## Summary

Make Orchestration V2 the only orchestration system used by the server, web app, and mobile app. Preserve reusable platform infrastructure, remove V1 orchestration as each replacement becomes authoritative, and leave legacy persistence untouched until a separate state-migration plan is chosen.

In this plan, "Orchestration V2" means the agent orchestrator: provider sessions, runs, attempts, runtime requests, and external agent effects. It does not replace the application event-sourcing data plane. Projects and threads remain first-class application aggregates in one durable, globally ordered event source, and the shell remains a projection of that source.

The in-scope work is split into five sequential architectural shapes: 1, 2, 3, 4.0, and 4.5. The frontend cutover is intentionally divided into Shape 4.0 and Shape 4.5: first restore the existing product on V2, then expose the richer V2-native information. Finish and validate one shape before beginning the next. These shapes are implementation checkpoints only: they exist to keep the work reviewable and easier to reason about, not to define rollout stages or supported compatibility windows. Stage 5 is recorded only as an out-of-scope follow-up boundary.

There will be no rollout while Shapes 1 through 4.5 are in progress. Shape 4.0 produces an internally usable V2 application, but Shape 4.5 is the completion boundary for the new frontend. Migrating installations that already contain V1 threads is a separate Stage 5 and is explicitly outside this plan.

Execution rules:

- Do not dual-write V1 and V2 state.
- Do not mirror production commands into both runtimes.
- Do not write core entity projection tables directly. Project and thread mutations commit application events first; projections are derived transactionally and remain replayable.
- Preserve one application event cursor across project and thread shell changes.
- Shapes 1 and 2 may keep V1 runnable as a development reference while V2 is completed through direct and replay-backed tests; this is not a supported user path or rollout strategy.
- Shape 3 performs the backend hard cut and intentionally breaks the old client protocol.
- Shape 4.0 updates web and mobile to the final protocol while preserving the current product experience and component structure.
- Shape 4.5 enriches that working application with V2-native graph, execution, tool, and context information.
- Do not create a server-side V2-to-V1 compatibility projection. Shape 4.0 may use temporary parity adapters around existing component props, but Shape 4.5 must not grow those adapters into a second complete thread/projection model.
- Keep React bindings platform-owned. Web and mobile may have intentionally similar binding and presentation modules; shared client-runtime ownership applies to projection state and domain semantics, not to React hooks or native UI policy.
- Only the completed Shape 4.5 system is eligible for a fresh-state user-facing release. Shipping an upgrade to an installation with V1 threads additionally requires the separate Stage 5 migration decision.
- Do not drop V1 tables, migrations, provider runtime rows, or attachment files during this plan.
- V1 removal happens inside the shape that replaces it; there is no deferred general cleanup phase.

## Alignment With The Current Production Path

At the start of this plan, the application path was V1 at the orchestration boundary. Between completed Shapes 3 and 4.0, the server was V2-only while the ordinary web and mobile clients still called the removed V1 protocol. Shape 4.0 has now closed that temporary gap. Several provider and selection concepts beneath that boundary were already provider-neutral and have been retained. Shape 4.5 must continue reusing them rather than recreating the existing model, mode, and provider-instance UX.

The historical pre-cut flow was:

```text
Web/mobile model and mode selection
  -> V1 thread command and projection
  -> ProviderCommandReactor
  -> ProviderService.getByInstance(instanceId)
  -> ProviderInstanceRegistry
  -> driver-specific legacy adapter
```

The current post-Shape-4.0 boundary is:

```text
ordinary web/mobile state and commands
  -> shared client-runtime V2 shell and thread projections
  -> final orchestration.* RPCs / V2 application services
  -> shared application event transaction
  -> Agent Orchestrator V2
  -> provider execution

V2 debug client
  -> direct V2 projection and item inspection
  -> reference presentation for Shape 4.5 production enrichment
```

Shape 4.0 closed the intentional client/server gap. Shape 4.5 replaces temporary parity-oriented chat shaping with direct, scoped consumption of the complete V2 projection and its server-authoritative visible item sequence.

Current ownership and intended treatment:

| Concept | Current ownership | Decision |
| --- | --- | --- |
| `ProviderDriverKind` | Neutral `packages/contracts/src/providerInstance.ts` | Keep unchanged. It identifies the protocol implementation. |
| `ProviderInstanceId` | Neutral `packages/contracts/src/providerInstance.ts` | Keep unchanged. It remains the routing key for configured instances. |
| `ProviderInstanceRegistry` | Server provider platform | Keep its configuration, lifecycle, hot reload, unavailable-instance handling, continuation identity, and instance lookup behavior. Replace its legacy adapter surface with V2 during the backend transition. |
| `ModelSelection` | Physically defined in V1 `packages/contracts/src/orchestration.ts`, but used by V1, V2, providers, web, and mobile | Move essentially unchanged to a neutral provider/model contract. Do not redesign the client-facing shape. |
| `RuntimeMode` | Physically defined in V1 `packages/contracts/src/orchestration.ts` | Move unchanged to a neutral runtime contract. |
| `ProviderInteractionMode` | Physically defined in V1 `packages/contracts/src/orchestration.ts` | Move unchanged to a neutral runtime contract. |
| Model and mode UI | Existing web/mobile production code | Preserve the concepts and controls. Shape 4.0 rewires their commands and state source to V2; Shape 4.5 may enrich the surrounding runtime detail. |
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

Implementation status: complete. Shape 3 completed the backend protocol cut; the production web/mobile cutover was subsequently completed in Shape 4.0.

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

- expose one idempotent durable reconciliation path used as a best-effort shutdown finalizer and as the authoritative startup repair
- stop the effect worker and close/revoke live provider sessions before shutdown reconciliation
- mark every persisted nonterminal provider session stopped without eagerly reopening provider processes on startup
- cancel the complete provider-bound active run subtree, close streaming messages/items, return active provider threads to idle, and expire or cancel orphaned runtime requests
- preserve a `waiting` run only when its pending/running replay-safe checkpoint-capture effect can still complete it; cancel a waiting run with no such durable effect as stale
- cancel pending or running process-bound effects whose outcome cannot be replayed safely: provider turn start, interrupt, steer, restart, and runtime-request response
- immediately requeue only explicitly replay-safe effects such as deterministic checkpoint capture, cleanup, detach, and checkpoint-targeted rollback
- commit each thread's durable state repair and process-bound effect cancellation in one transaction
- suppress normal terminal-event queue advancement while reconciliation is committing, then resume genuinely queued runs after startup recovery
- prevent one logical effect from executing concurrently twice

Provider processes remain lazy. A later user turn, a genuinely queued turn, or an explicitly replay-safe effect may reopen a session and resume the provider-native thread then; the mere presence of persisted session or thread metadata must not spawn a process. Replay classification is effect-semantic and provider-neutral, not a provider-name check.

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
- graceful shutdown during an active effect
- idempotent startup reconciliation after a partial or missing shutdown finalizer
- no provider process spawn for idle persisted sessions
- queued turns do not start during shutdown and resume only after startup reconciliation
- provider-native resume
- failed native resume followed by portable fallback

### Shape 2 exit gate

- Application services reproduce all required V1 product behavior without V1 orchestration dependencies.
- Provider session transition decisions preserve current production model, mode, workspace, and instance-routing semantics.
- External side effects are durable and idempotent.
- Restart recovery leaves no permanently active run or request.
- Unknown-outcome provider effects are retired rather than blindly replayed, while explicitly replay-safe effects are reclaimed.
- Clean shutdown performs best-effort reconciliation, and startup remains correct after `SIGKILL`, a crash, or a failed finalizer.
- Idle persisted sessions do not spawn provider processes during recovery.
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

## Shape 4.0: V2 Frontend Cutover And Product Parity

Implementation status: complete.

Implementation outcome:

- Web and mobile now consume the unified V2 shell and full V2 thread projections through the shared client runtime, including reconnect/cursor handling and versioned V2-only caches.
- Ordinary project, thread, message, run-control, runtime-request, settings, archive, delete, checkpoint, attachment, and plan-implementation commands now use the final event-sourced project and V2 orchestration transports.
- Existing root-workspace, newly provisioned worktree, origin-based worktree, and already-prepared worktree launch flows are preserved, including promotion of an empty server thread into a worktree before its first message.
- Existing web and mobile product components consume V2-native parity models. The complete projection and structured turn-item payload remain available, while unsupported rich V2 visualization stays deferred to Shape 4.5.
- The parity models are an explicit temporary bridge for existing product components. They are not the intended Shape 4.5 thread API and may be removed incrementally as direct item consumers replace them.
- Production V1 client reducers, subscriptions, command paths, and persistence writers have been removed. Legacy server state remains untouched for the separate Stage 5 migration decision.

### Goal

Make the existing web and mobile application work end to end against the V2-only backend. Preserve the current product structure and the frontend pieces that already work well. This shape changes the source of truth and command path; it is not a broad visual redesign.

At the end of Shape 4.0, the ordinary application—not only the V2 debug route—must be usable for normal project and thread work on fresh V2 state.

### Shape 4.0 boundary

- Treat the current V1 frontend as the behavioral and interaction reference, not as a data-model contract.
- Reuse existing sidebar, chat, composer, approval, archive, diff, settings, and model-picker components where their behavior remains correct.
- Generalize component props around V2-native view models instead of manufacturing V1 commands, events, activities, or thread projections.
- Retain the complete V2 projection in client state even when the parity UI initially presents only a subset of it.
- Preserve shell and thread-detail state as separately subscribable streams. Shape 4.0 components may compose them locally where required, but the client runtime must not make detail traffic a dependency of shell/sidebar state.
- Keep web and mobile React bindings separate. Similar binding code is intentional and is not a Shape 4.0 deduplication target.
- Provide a safe generic renderer for V2 turn-item types that do not yet have a rich presentation. Do not drop structured tool or execution data merely because Shape 4.5 owns the final renderer.
- Defer graph visualization, rich execution inspection, and provider-native tool presentation to Shape 4.5.
- Do not import V1 server rows or migrate existing V1 threads in this shape.

### 1. Cut client-runtime state over to V2

Replace the production V1 shell and thread stores with V2-backed state for:

- the unified project, active-thread, and archived-thread shell
- full V2 thread projections
- shell and thread committed cursors
- snapshot-to-live catch-up
- connection, synchronization, reconnect, and error state
- optimistic command state only where the committed receipt is not fast enough for interaction feedback

The server's committed application sequence is the shell reconnect boundary. A thread subscription uses its committed V2 event sequence. Connection readiness must not be reported until the initial snapshot and replay window have been applied.

Bump web and mobile orchestration-cache versions. Discard cached V1 shell/thread projections while preserving drafts, credentials, environment configuration, preferences, and unrelated local state. Cache invalidation is not the Stage 5 server-state migration.

### 2. Add a temporary parity-focused V2 presentation adapter

Create shared, V2-native client view models for the existing application surfaces, including:

- project and thread shell rows
- conversation messages
- basic reasoning and work-log entries
- generic tool/execution entries with status, summary, and retained structured payload
- active-run and queued-run state
- pending approval and user-input requests
- plan and checkpoint summaries
- thread capabilities and available actions

Derive these models from the V2 thread projection, `visibleTurnItems`, runs, attempts, runtime requests, and checkpoints. Existing components may be adapted to consume these models, but the adapter must not recreate an `OrchestrationThread`, `OrchestrationThreadActivity`, V1 `latestTurn`, or a V1 event stream.

Web and mobile share the projection reducer and retain the complete structured V2 data. Platform-specific components may render temporary parity views differently. Shape 4.5 owns replacing full-thread parity shaping with direct, scoped item consumption; Shape 4.0 does not need to pre-design that final API.

### 3. Replace production client commands

Move all ordinary app operations off `orchestrationV1.*`:

- route project create, update, and delete through the existing event-sourced `ProjectService` transport
- launch root-workspace and worktree threads through `ThreadLaunchService`
- send messages with explicit auto, queue, steer, or restart behavior
- interrupt active runs
- respond to approvals and user-input requests
- update title, branch/worktree metadata, model selection, runtime mode, and interaction mode
- archive, unarchive, and delete threads
- request checkpoint rollback
- retain current project setup-script and new-thread behavior

Use V2 command IDs and receipt semantics directly. Retrying a client command must not duplicate messages, runs, external effects, or project mutations.

Commands that only exist to expose new V2 capabilities—fork, merge-back, provider switch, provider-session detach, advanced queue reordering, and graph navigation—may remain debug-only until Shape 4.5 unless they are needed to preserve an existing production workflow.

### 4. Restore web product behavior

Rewire the existing web application for:

- project grouping and thread navigation in the sidebar
- project creation, editing, and deletion
- new-thread creation for root workspaces and worktrees
- opening and continuing a thread
- message rendering and composer submission
- queued-message state and active-run controls
- approval and user-input controls
- plan display and implementation entry points
- diff, checkpoint, and rollback views
- archive, unarchive, and deletion flows
- provider, model, runtime-mode, and interaction-mode controls
- reconnecting while a run is active

Preserve the current layout and interaction patterns unless a V2 semantic makes the old behavior incorrect. Keep the V2 debug route available during this shape as an inspection oracle, but production behavior must not depend on it.

### 5. Restore mobile product behavior

Rewire the existing mobile application for:

- project and thread lists
- new-task creation
- thread detail and message timeline
- composer and queued-message behavior
- run status and interruption
- approval and user-input interactions
- archive management
- diff and Git actions
- provider, model, runtime-mode, and interaction-mode selectors
- reconnecting and restoring the selected thread

Mobile consumes the same V2 state and parity derivation as web. Do not maintain a second V1-shaped mobile reducer.

### 6. Remove production V1 client dependencies

After web and mobile are cut over:

- remove production calls to `ORCHESTRATION_WS_METHODS` and every `orchestrationV1.*` method
- remove V1 shell/thread subscriptions, command builders, reducers, and persistence writers
- remove V1 types from production component props and application state
- keep any still-needed legacy schemas isolated and read-only for the future Stage 5 analysis
- do not delete retained application project/event contracts merely because their historical module name contains `orchestration`

### Shape 4.0 tests

Add shared client-runtime coverage for:

- unified shell snapshot and ordered project/thread deltas
- incremental V2 thread projection updates
- shell and thread reconnect from persisted cursors
- cache-version invalidation from V1 to V2
- duplicate command delivery and receipt handling
- active, queued, steering, restarted, interrupted, and terminal run state
- approval and user-input requests across reconnect
- generic fallback presentation for every unrecognized or not-yet-enriched turn item

Add web and mobile integration coverage for:

- project and thread creation
- opening, sending to, and continuing a thread
- root-workspace and worktree launch
- active-run interaction and interrupt
- archive, unarchive, and delete
- provider/model and mode selection
- approvals and input requests
- checkpoint diff and rollback
- reconnect during a live run

### Shape 4.0 exit gate

- The ordinary web and mobile applications use V2 shell, thread, and command APIs exclusively.
- A user can create a project and thread, converse with an agent, reconnect, respond to requests, inspect diffs, archive, and delete.
- Existing V1-era product behavior that remains supported by V2 is present without routing through V1 data shapes.
- Full V2 projections and structured turn-item payloads are retained even when rendered generically.
- Server-projected `visibleTurnItems`, including inherited and synthetic rows, remain intact in client state even when Shape 4.0 surfaces do not render them richly.
- Shell/sidebar state remains independently subscribable from full thread detail.
- Temporary full-thread parity models and separate web/mobile React binding modules are allowed at this boundary; their final cleanup belongs to Shape 4.5.
- No production code calls an `orchestrationV1.*` endpoint.
- No V2-to-V1 server or persistence compatibility projection exists.
- The V2 debug route is no longer the only functional V2 client.
- `vp check`, `vp run typecheck`, and `vp test` pass.
- `vp run lint:mobile` passes for mobile changes.

## Shape 4.5: V2-Native Frontend Enrichment

Implementation status: complete. Production web and mobile now consume the scoped V2 projection directly, and the temporary Shape 4.0 parity facade, V1 client RPC surface, and V2 debug route have been removed.

Completion outcome:

- Production web continues to render the server-authoritative `visibleTurnItems` sequence and now joins individual rows to narrowly selected V2 run, attempt, node, provider, request, checkpoint, subagent, handoff, and transfer state.
- Expandable production inspectors expose command input/output and exit state, file changes and diff navigation, search provenance, dynamic/provider-native structured payloads, checkpoint rollback, subagent/fork navigation, provider identity, attempts, and context handoff state.
- An environment-scoped, cycle-safe relationship graph combines shell lineage with projection subagent and context-transfer edges while retaining missing-node fallback. The web header exposes related-thread navigation plus capability-gated fork, merge-back, and provider-session detach actions.
- Production web exposes queued-run reordering and promotion-to-steer directly from V2 run state. Cross-provider model selection dispatches `provider.switch`; same-provider model changes retain `thread.model-selection.set`.
- Production message rows retain their original projected-item reference. User messages visibly distinguish queued, steer, and queued-then-promoted intent; completed assistant responses expose exact-run forking, including inherited source-thread provenance.
- While a run is active, an empty composer keeps the Stop action. Entering content replaces it with Send, whose current default is explicit steering; `Mod+Enter` explicitly queues. The default action is isolated behind a small policy seam for a future user setting, without adding an action menu now.
- Interrupt request/result, compaction, handoff, fork, and subagent lifecycle items use polished production-native dividers or compact rows. Todo updates remain ordinary work-log items because the Tasks right-panel surface owns rich task progress.
- Shutdown now blocks new mutations, stops the effect worker, closes provider sessions and MCP capabilities, and best-effort reconciles durable state. Startup repeats that repair authoritatively, atomically cancels the complete provider-bound in-flight execution subtree plus its non-replayable effects, allows a waiting run to finish only through its durable replay-safe checkpoint capture, leaves idle provider processes closed, and resumes genuinely queued turns after repair. A development-server restart therefore leaves the interrupted thread terminal and sendable instead of failing projection startup.
- Mobile renders the same server-authoritative `visibleTurnItems` sequence and derives only the runtime, request, and checkpoint summaries required by its concrete surfaces.
- Shared client-runtime selectors cover only demonstrated cross-platform domain needs. Platform-specific presentation remains local to web and mobile; there is no second complete thread presentation model.
- Frozen V1 persistence/event-store decoders remain isolated behind the explicit `legacy-orchestration` contract subpath for the later data-migration stage. No production client imports the legacy thread model or calls a V1 endpoint.

### Goal

Enrich the now-working application with information and workflows that V2 models explicitly but the V1 UI could not represent well. The production chat must move from the temporary Shape 4.0 parity reconstruction to the server-authoritative ordered V2 item sequence without introducing a second complete projection or a shared React presentation layer.

The V2 projection remains the client semantic source of truth. Client enrichment adds environment scope and narrowly derived relationships; it does not copy every projection table into another thread-shaped model.

### Shape 4.5 implementation order

Complete the following sections in order. The client-runtime substrate is intentionally small; web proves the first production presentation, mobile follows from the same projection semantics, and only then are demonstrated shared domain selectors extracted.

### 1. Establish the scoped projection and item atom boundary

Keep shell and detail as independent sources:

- `EnvironmentThreadShell` remains the environment-scoped, list-oriented view of the server shell stream.
- Introduce a detail value containing `environmentId` and the pristine `OrchestrationV2ThreadProjection`. Use a temporary migration name such as `ScopedThreadProjection` while the Shape 4.0 parity facade still owns `EnvironmentThread`; after that facade is removed, the contextual wrapper may take the unversioned `EnvironmentThread` name.
- Preserve `wrapper.projection === projectionState.data` and the identities of every nested projection collection. Do not spread or translate the complete projection into a second object graph.
- Do not attach `environmentId` to every nested message, run, node, or item. Values that leave their scoped thread context or participate in cross-thread relationships must carry an explicit `ScopedThreadRef` or equivalent environment-qualified reference.
- Shell consumers read shell atoms. Detail consumers read `projection.thread` and detail atoms. Do not synthesize a shell from detail, globally merge the streams, or make sidebar state depend on detail traffic. A component that truly needs both subscribes to both explicitly.

The stable client-runtime access surface begins with:

- the full thread state atom, including cached, synchronizing, live, deleted, and error state
- a scoped whole-thread atom for debugger, graph, and other whole-projection consumers
- a `visibleTurnItems` atom exposing the server-projected ordered item rows
- status/error or an equivalently stable synchronization atom that does not invalidate merely because projection content changed

`visibleTurnItems` is the production conversation source. It already carries the discriminated union for messages, reasoning, plans, tools, approvals, input requests, checkpoints, interruption request/result items, compaction, handoff, fork, subagent, and dynamic tools. It also carries local, inherited, and synthetic visibility metadata. Production chat must not reconstruct this sequence by merging separate messages, plans, and work-entry arrays.

Do not publish one atom merely because each projection table exists. Add a derived atom or an entity-by-ID lookup only when a concrete row, control, graph, or inspector needs state absent from its turn item, for example:

- runtime-request response capability for an approval or user-input row
- current checkpoint/ref state for rollback
- run, attempt, or node state for execution inspection
- context-transfer lifecycle for merge-back or provider handoff

These lookups must retain the original V2 entity types and identities. A whole-thread atom is a firehose and must not be the default subscription for granular timeline components.

Keep web and mobile React bindings separate. Do not introduce a shared React package, a shared binding factory, or a `createClientStateGraph` abstraction merely because the two bindings are currently similar.

#### `visibleTurnItems` structural-sharing prerequisite

Fix the incremental client reducer before the production rich timeline depends on it:

- inherited and synthetic rows remain server-authoritative and are never locally reconstructed
- a run or attempt update that does not change visible membership returns the previous `visibleTurnItems` array reference
- a turn-item update with unchanged membership replaces only the affected row and preserves every unaffected row object and position
- positions are recomputed only when visible membership changes
- membership equality alone must not suppress a streaming item-content update

This is a reducer allocation and correctness requirement, not an atom-level equality workaround.

### 2. Move the web conversation to authoritative V2 items

Implement the first Shape 4.5 production vertical slice in web:

- render the conversation directly from `visibleTurnItems`
- preserve item order across interruption request, intervening provider activity, and interruption result
- preserve inherited items and synthetic fork markers
- render user and assistant messages, reasoning, plans, tool activity, requests, checkpoints, compaction, handoffs, forks, subagents, and dynamic tools from the discriminated union
- retain complete structured/provider-native input and output behind a safe fallback for every item type
- join a row to targeted supporting state by ID only when the item itself is insufficient for interaction or inspection

Reuse the proven presentation work in the V2 debugger where it fits, especially its direct `visibleTurnItems` path and item renderers. Do not reuse the debugger's local subscriptions, local projection reducer, log reconstruction fallback, or debug-only state management. Production consumes the client-runtime thread state established in section 1.

Web owns visual row types, icons, labels, folding, adjacent visual grouping, expansion, and copy behavior. Those policies are not client-runtime domain models.

### 3. Move the mobile conversation to the same projection semantics

After the web item path is working, move mobile from its Shape 4.0 parity feed to the same authoritative `visibleTurnItems` sequence and targeted entity lookups.

Mobile keeps its own React bindings and form-factor-specific presentation, including native list behavior, expansion, composer layout, offline/outbox policy, and navigation. It does not need to share web row interfaces, fold policy, labels, or visual grouping.

Promote logic into client-runtime only when both platforms need the same nontrivial domain interpretation and the relationship is not already explicit in V2. Examples may include environment-scoped cross-thread references or capability-safe entity linkage. Do not extract presentation logic merely because two current implementations happen to look alike.

### 4. Enrich tools, execution, and supporting state

Add item renderers and targeted inspectors for:

- command execution with input, working directory where available, lifecycle, output, duration, and exit state
- file changes with affected paths and patch/diff navigation
- file, code, and web search with query and result provenance
- MCP, dynamic, and provider-native tool calls with complete structured fallback
- nested tool work associated with execution nodes or subagents
- queued, steering, restarting, active, interrupted, failed, retried, superseded, and recovered execution
- attempt history, execution-node progress, and retry reasons
- provider session/thread/turn identity where diagnostically useful
- native resume versus portable context handoff
- context-window and token indicators
- plans, todos, approvals, user input, checkpoints, and rollback state

The ordered chat remains item-based. Runs, attempts, nodes, provider state, runtime requests, checkpoints, and transfers are supporting relational state; they enrich specific rows, controls, and inspectors rather than becoming additional reconstructed chat feeds.

Keep primary chat status simple. Detailed execution state belongs in targeted or expandable surfaces. Rendering must preserve live updates without duplicating rows as attempts or provider items change, and large output must remain inspectable without overwhelming the timeline.

### 5. Expose relationships and V2-native workflows

Build environment-scoped, cycle-safe graph/lineage derivation from shell threads, thread lineage, execution nodes, subagents, forks, and context transfers. It must support:

- root, parent, child, fork, and subagent relationships
- navigation between related threads using environment-qualified references
- per-node run and terminal status
- merge-back and context-transfer state
- archived or deleted related threads
- missing-parent and partial-replay fallback

Web should provide an efficient tree or graph surface without replacing the ordinary project/thread sidebar. Mobile should expose the same domain relationships through a form-factor-appropriate drill-down rather than copying the desktop visualization.

Integrate capability-gated workflows for:

- thread fork and merge-back
- provider switching and provider-session detach
- advanced queue reorder and promotion
- subagent navigation and delegated-task state
- plan/todo progress
- checkpoint scope, diff, and rollback
- context handoff and transfer visibility

Actions derive from V2 capability and runtime policy. They must not use provider-name conditionals.

### 6. Retire parity state and finish cleanup

After web and mobile no longer depend on the Shape 4.0 full-thread parity facade:

- remove `presentThread`-style whole-projection remapping and the shell/detail reconciliation it required
- give the environment-scoped projection wrapper the final unversioned client name if doing so improves clarity
- remove message/work/plan feed reconstruction and other obsolete transformations from `session-logic.ts`, mobile `threadActivity.ts`, and equivalent modules while retaining genuinely platform-specific presentation helpers
- remove unused V1 client RPC contracts and compatibility exports
- split still-required project application contracts and frozen legacy thread decoders into clear ownership boundaries instead of deleting reusable application infrastructure
- delete the V2 debug route after its useful inspection and rendering surfaces have production homes

No production client should end with both a complete `OrchestrationV2ThreadProjection` and a second complete thread presentation object containing copied messages, work entries, runs, plans, requests, and checkpoints.

### Shape 4.5 tests

Add client-runtime state and reducer coverage for:

- environment-scoped detail identity without copying or mutating the server projection
- cached, synchronizing, live, deleted, and error state independent of projection content
- preservation of local, inherited, and synthetic `visibleTurnItems`
- unchanged `visibleTurnItems` identity for run/attempt updates that do not change visibility
- single-row replacement and unaffected-row identity for streaming item updates
- membership changes, removal, and position renumbering without losing inherited or synthetic rows
- any targeted entity lookup or shared domain selector introduced by a concrete consumer
- environment-scoped graph construction for roots, forks, subagents, merges, archives, missing nodes, and cycles
- capability-gated action availability

Add web and mobile integration coverage for:

- every known V2 turn-item type and the structured dynamic fallback
- interruption request, intervening activity, and interruption result in committed order
- inherited conversation items and synthetic fork markers
- rich tool expansion and live updates without duplicate rows
- request response capability, checkpoint rollback, and other targeted item/entity joins
- related-thread navigation
- fork and merge-back
- subagent and delegated-task inspection
- queue reorder and promotion
- provider switch and detach
- context handoff
- reconnect while item, graph, tool, request, or attempt state is changing
- all existing Shape 4.0 product flows

### Shape 4.5 exit gate

- Web and mobile remain fully usable for every Shape 4.0 flow.
- Production web and mobile conversations render from server-authoritative `visibleTurnItems`; neither reconstructs the chat by merging separate message, plan, and work-entry collections.
- Thread detail values carry explicit environment scope while retaining the pristine V2 projection and nested entity identities.
- Shell/sidebar and thread-detail state remain independently subscribable; ordinary detail traffic does not invalidate the project/thread shell.
- Granular timeline components consume the item atom and targeted entity lookups rather than subscribing to the whole projection.
- Run/attempt updates with unchanged visibility preserve `visibleTurnItems` identity, while streaming item updates replace only the affected row and remain visible.
- Local, inherited, and synthetic items survive snapshot, incremental update, cache restore, and reconnect.
- Typed tool calls and structured results are visible without losing provider-native fallback data.
- Interruption request, intervening activity, and interruption result remain independently visible and correctly ordered.
- Runs, attempts, retries, recovery, plans, checkpoints, requests, handoffs, and context transfers have coherent targeted presentation without becoming a second reconstructed chat model.
- Thread lineage, forks, subagents, merge relationships, and environment-qualified navigation are available on web and mobile in platform-appropriate forms.
- New V2 capabilities are capability-gated and do not rely on provider-name conditionals.
- Web and mobile retain separate React bindings and presentation policy while consuming the same V2 projection/reducer semantics.
- No production client maintains a complete parallel thread presentation model beside `OrchestrationV2ThreadProjection`; the Shape 4.0 parity facade is removed from production consumers.
- No production TypeScript import references a V1 client orchestration type or endpoint.
- The V2 debug route is removed after its useful production surfaces are integrated.
- `vp check`, `vp run typecheck`, and `vp test` pass.
- `vp run lint:mobile` passes for mobile changes.

## Stage 5: Existing-User State Migration (Out Of Scope)

Stage 5 is deliberately not implemented or decided by this plan. Shapes 4.0 and 4.5 target a fully working V2 application on fresh V2 state while preserving legacy rows and files untouched.

A later migration plan must separately decide:

- which V1 thread, message, project, checkpoint, attachment, and provider-session state is imported
- how provider continuation identifiers are validated and mapped for native resume
- what fidelity is required for historical activities and tool calls that have no exact V2 representation
- whether migration is eager, lazy-on-open, or an explicit user action
- backup, rollback, idempotency, partial-failure, and retry behavior
- how migrated state is verified before legacy storage becomes removable

Nothing in Shape 4.0 or 4.5 may destroy, rewrite, or make assumptions that close off those options. Shipping an upgrade to an installation containing V1 threads requires a separate Stage 5 decision and validation gate.

## Final Outcome

At the end of Shape 4.5:

- V2 is the only live agent orchestration system from provider process through web and mobile UI.
- The existing product experience works on V2, and production conversations render the authoritative environment-scoped V2 item sequence without a parallel full-thread presentation model.
- V2-native graph, execution, tool, request, interruption, and context information is available through targeted platform-appropriate surfaces.
- V1 runtime, server endpoints, production client state, and production client operations are removed.
- Reusable application event-sourcing and platform infrastructure remain.
- Legacy database rows, provider continuation data, attachments, and other migration inputs remain untouched and read-only.
- Fresh V2 state is fully supported; migration of existing V1 user state remains the explicitly separate Stage 5.
