# Provider Runtime Refactor Plan

## Goal

Remove `providerSessionId` and `providerThreadId` from the core application model and make
provider continuity depend only on:

- canonical `threadId`
- provider kind
- runtime mode
- opaque `resumeCursor`

Live provider session/process state becomes ephemeral and provider-private.

## Desired Architecture

### Durable state

Persist only the data required to reconstruct a provider conversation after process restart:

- `threadId`
- `provider`
- `runtimeMode`
- `resumeCursor` (opaque)
- `status`
- `activeTurnId` / `lastError` / `updatedAt` if needed for UX
- optional provider runtime payload only if it is required for resume or useful UX

Do **not** persist:

- `providerSessionId`
- `providerThreadId`
- live child-process/session handles
- adapter-private routing aliases

### Ephemeral state

Each adapter keeps an in-memory map keyed by canonical `threadId`:

- `threadId -> live provider context`

Examples:

- Codex child process context
- Cursor ACP live session
- Claude Code live subprocess context

These are disposable and rebuilt from persisted `resumeCursor`.

### Observability

Provider-native identifiers should live in logs/runtime events only, not in the canonical DB model.

Examples:

- Codex thread id
- Cursor ACP thread/session id
- Claude conversation/thread id

## High-Level Refactor Sequence

### 1. Contracts cleanup

Remove provider identity fields from shared contracts:

- `packages/contracts/src/provider.ts`
- `packages/contracts/src/orchestration.ts`
- `packages/contracts/src/providerRuntime.ts`
- related tests

Planned changes:

- remove `ProviderSessionId` from cross-layer service payloads where possible
- remove `providerSessionId` / `providerThreadId` from thread session snapshot contracts
- keep `resumeCursor` opaque

### 2. Redefine thread runtime/session projection model

Replace thread session projection as a provider-identity carrier with a pure UX/runtime status view.

Possible projected shape:

- `status`
- `providerName`
- `runtimeMode`
- `activeTurnId`
- `lastError`
- `updatedAt`

No provider-native ids in the projection.

Files likely affected:

- `apps/server/src/persistence/Services/ProjectionThreadSessions.ts`
- `apps/server/src/persistence/Layers/ProjectionThreadSessions.ts`
- `apps/server/src/orchestration/projector.ts`
- `apps/server/src/orchestration/Layers/ProjectionPipeline.ts`
- `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts`
- `apps/web/src/store.ts`

### 3. Make provider service thread-keyed

Refactor provider service APIs to route by canonical `threadId`, not `providerSessionId`.

Methods to change:

- `startSession`
- `sendTurn`
- `interruptTurn`
- `respondToRequest`
- `rollbackConversation`
- `stopSession` / equivalent
- `listSessions`

New mental model:

- orchestration calls provider service with `threadId`
- provider service resolves/creates live adapter context for that canonical thread
- adapter handles provider-native resume semantics internally

Files likely affected:

- `apps/server/src/provider/Services/ProviderService.ts`
- `apps/server/src/provider/Layers/ProviderService.ts`
- `apps/server/src/provider/Services/ProviderAdapter.ts`
- all adapter implementations/tests

### 4. Replace session directory with thread-keyed runtime directory

Current `ProviderSessionDirectory` is centered on session ids.
Replace with a thread-keyed directory/repository.

Persist per canonical thread:

- `threadId`
- `provider`
- `runtimeMode`
- `resumeCursor`
- `status`
- optional runtime payload

Likely replacement:

- `ProviderThreadRuntimeDirectory` or similar

Files likely affected:

- `apps/server/src/provider/Services/ProviderSessionDirectory.ts`
- `apps/server/src/provider/Layers/ProviderSessionDirectory.ts`
- `apps/server/src/persistence/Services/ProviderSessionRuntime.ts`
- `apps/server/src/persistence/Layers/ProviderSessionRuntime.ts`

### 5. Database migration

Perform a clean-slate schema migration to remove provider ids from persistence.

Targets:

- remove `provider_session_id`
- remove `provider_thread_id`
- make canonical thread id the primary runtime key where appropriate

Likely tables impacted:

- `provider_session_runtime`
- `projection_thread_sessions`

Because SQLite column removal is awkward, and app is still early. A destructive migration is preferred.
Existing users will need to reset their db so migrations run from scratch.

Migration should also preserve:

- `resume_cursor_json`
- `runtime_mode`
- `runtime_payload_json`
- status metadata

### 6. Orchestration refactor

Remove provider-id assumptions from orchestration.

Affected areas:

- `ProviderCommandReactor`
- `ProviderRuntimeIngestion`
- `CheckpointReactor`
- decider/projector event payloads

Rules:

- orchestration should only know canonical `threadId`
- restart/reconcile should use provider service APIs keyed by canonical thread
- no orchestration logic should depend on provider-native ids

### 7. Adapter refactor

Each adapter should:

- keep a `Map<ThreadId, LiveContext>` (LiveContext is a provider-specific context object, typed independently for each adapter)
- use persisted opaque `resumeCursor` to recreate live state
- emit provider-native ids only in runtime/log events if desired

Specific adapters:

- `CodexAdapter`
- `CursorAdapter`
- `ClaudeCodeAdapter`

### 8. Runtime events and logs

Keep provider-native ids in logs and runtime events only when useful for debugging.

Need to review:

- `packages/contracts/src/providerRuntime.ts`
- `apps/server/src/provider/Layers/*Adapter.ts`
- log sinks / canonical event logging

Goal:

- provider-native ids optional and observational
- not required by orchestration/persistence correctness

### 9. Web/client cleanup

Web should consume only canonical thread status.

Remove use of:

- `providerSessionId`
- `providerThreadId`

Likely files:

- `apps/web/src/store.ts`
- `apps/web/src/types.ts`
- related tests

### 10. Test migration

Update and simplify tests across:

- provider service tests
- orchestration tests
- integration harnesses
- checkpoint/runtime ingestion tests

Tests should validate:

- thread continuity across restart using persisted opaque `resumeCursor`
- runtime mode switches after reopen
- no correctness dependency on provider-native ids

## Suggested Execution Order

1. Add/adjust plan-approved contracts
2. Introduce new thread-keyed provider runtime persistence alongside old code temporarily in implementation
3. Refactor provider service/adapters to use canonical `threadId`
4. Switch orchestration to thread-keyed APIs
5. Switch projections/web contracts
6. Remove old provider-id fields and dead code
7. Run migration and clean tests

## Key Invariants After Refactor

- Canonical `threadId` is the only cross-layer routing key
- `resumeCursor` is the only persisted continuity primitive
- provider-native ids are never required for correctness
- live provider session/process state is always reconstructible and disposable
- restart/reopen behavior is first-class, not a stale-session special case

## Open Questions

1. Should `thread.session` remain in snapshots at all, or be folded into thread runtime fields?
2. Should provider runtime payload remain persisted if not required for resume?
3. Do we want one provider runtime row per canonical thread, or a more generic runtime-state table keyed by thread?

## Recommendation

Proceed with a full clean-slate migration rather than incremental compatibility shims.
The current model is carrying too much provider-native identity into layers that should only reason about canonical threads and opaque resume state.
