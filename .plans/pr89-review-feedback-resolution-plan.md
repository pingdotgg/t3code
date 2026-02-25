# PR #89 Review Feedback Resolution Plan

## Context
- Source: GitHub review threads/comments on PR `#89` (`Add server-side orchestration engine with event sourcing`).
- Triage baseline:
  - 147 threads, 149 comments total.
  - 54 active unresolved threads.
  - Deduped to 47 unique active issues.
  - Filtered invalid/wrong claims: 2 issue clusters.
  - Net actionable backlog: 45 unique issues.

## Objectives
1. Remove high-risk runtime failure modes first (worker/fiber death, unrecoverable ingestion stalls).
2. Preserve event-sourcing correctness under failure/retry (projection, receipts, checkpoint ordering).
3. Resolve client-visible correctness regressions (branch/session races, markdown link parsing).
4. Close low-signal or duplicate review noise with explicit disposition.

## Non-Goals
- No protocol reintroduction for removed `providers.event` channel (invalid comment cluster).
- No architecture rewrite beyond targeted hardening and correctness fixes needed to land PR safely.

## Execution Order
1. **Phase A (P0): Runtime fault tolerance**
2. **Phase B (P0/P1): Checkpoint consistency + sequencing**
3. **Phase C (P1): Persistence/projection correctness**
4. **Phase D (P1/P2): Runtime/platform hardening**
5. **Phase E (P1/P2): Web/client correctness**
6. **Phase F (P2): Cleanup/typing hygiene + review thread closure**

---

## Phase A (P0) - Runtime Fault Tolerance

### A1) Provider runtime ingestion loop can die permanently on one dispatch error
- Issue:
  - `ProviderRuntimeIngestion` uses `Effect.forever(Queue.take(...).flatMap(processEvent))` without local recovery. A single failure can terminate the worker fiber.
- Planned resolution:
  - Wrap per-item processing with `Effect.catch` (don't use `catchAllCause` as that is a signal for detects which should not be recovered from) and structured logging (`event.type`, `sessionId`, `threadId if known`).
  - Keep queue consumer alive after failures.
  - Add a bounded error counter metric/log cadence to avoid log spam.
- Target files:
  - `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts`
  - `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts`
- Tests:
  - Add test where first dispatch fails, second event still processes successfully.
  - Assert worker remains alive and queue continues draining.

### A2) Provider command reactor loop can die permanently on provider-side failure
- Issue:
  - `ProviderCommandReactor` queue consumer also runs forever with no protection around `processDomainEvent`.
- Planned resolution:
  - Apply same per-item fault boundary as A1.
  - Differentiate retryable provider errors vs invariant errors for log level (`warn` vs `error`).
- Target files:
  - `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts`
  - `apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts`
- Tests:
  - Inject provider service failure for one event and verify subsequent events still execute.

### A3) Checkpoint reactor worker can die and halt checkpointing for process lifetime
- Issue:
  - `CheckpointReactor` queue worker has no internal error boundary; checkpoint/git failures can stop all future checkpoint handling.
- Planned resolution:
  - Add per-item recovery with contextual logging.
  - Keep worker alive for transient checkpoint/git errors.
  - Optionally emit `thread.activity.append` error activity for visibility when checkpoint operations fail.
- Target files:
  - `apps/server/src/orchestration/Layers/CheckpointReactor.ts`
  - `apps/server/src/orchestration/Layers/CheckpointReactor.test.ts`
- Tests:
  - Simulate failing `CheckpointStore` call on one event; verify next event still processes.

### A4) WS message handler can surface unhandled rejection at runtime
- Issue:
  - `Effect.runPromise(handleMessage(...))` path flagged for potential unhandled rejection.
- Planned resolution:
  - Add explicit `.catch` with structured logging on message processing invocation path.
  - Ensure one bad message cannot destabilize the WebSocket server.
- Target files:
  - `apps/server/src/wsServer.ts`
  - `apps/server/src/wsServer.test.ts`
- Tests:
  - Add regression test forcing `handleMessage` error and assert server still accepts/processes subsequent messages.

---

## Phase B (P0/P1) - Checkpoint Consistency + Sequencing

### B1) Revert flow uses forked completion dispatch and can expose stale read model window
- Issue:
  - `thread.revert.complete` dispatch is forked in reactor path, allowing downstream logic to observe stale state during revert completion window.
- Planned resolution:
  - Make revert completion dispatch part of the same serialized effect flow (await it rather than fire-and-forget).
  - Preserve ordering guarantees: fs restore/provider rollback/delete ref -> completion command -> next dependent work.
- Target files:
  - `apps/server/src/orchestration/Layers/CheckpointReactor.ts`
  - `apps/server/src/orchestration/Layers/CheckpointReactor.test.ts`
- Tests:
  - Add ordering test ensuring revert completion is visible before subsequent checkpoint-dependent processing.

### B2) Turn-count inference can be wrong when positional index diverges from authoritative count
- Issue:
  - `inferCheckpointTurnCountByTurnId` fallback behavior may infer count from position, leading to incorrect revert semantics.
- Planned resolution:
  - Use authoritative checkpoint metadata when available.
  - Restrict positional fallback to explicit best-effort mode and prevent it from driving destructive operations.
- Target files:
  - `apps/web/src/session-logic.ts`
  - `apps/web/src/session-logic.test.ts`
- Tests:
  - Add cases where positional order differs from persisted turn count and assert correct count resolution.

### B3) Inconsistent input normalization across checkpoint store methods
- Issue:
  - Some `CheckpointStore` methods trim/normalize input while others do not, creating inconsistent ref/cwd behavior.
- Planned resolution:
  - Introduce shared normalization utility and apply uniformly across all public `CheckpointStore` methods.
  - Keep normalization semantics explicit and covered by tests.
- Target files:
  - `apps/server/src/checkpointing/Layers/CheckpointStore.ts`
  - existing checkpointing tests (and add targeted method-level tests)
- Tests:
  - Parameterized tests that call all methods with leading/trailing whitespace and assert consistent behavior.

### B4) Duplicate checkpoint-ref generation logic across runtime and tests
- Issue:
  - `checkpointRefForThreadTurn` logic is duplicated across multiple files, creating drift risk.
- Planned resolution:
  - Extract a single shared helper module for checkpoint ref generation.
  - Migrate runtime and test callsites to helper.
- Target files:
  - `apps/server/src/checkpointing/*` or `apps/server/src/orchestration/*` shared helper (new)
  - `apps/server/src/wsServer.ts`
  - `apps/server/src/orchestration/Layers/CheckpointReactor.ts`
  - impacted tests/integration harnesses
- Tests:
  - Add dedicated helper tests for deterministic encoding format and stability.

---

## Phase C (P1) - Persistence / Projection Correctness

### C1) Event append and projection update can diverge on mid-pipeline failure
- Issue:
  - If event append succeeds and projection/update fails, state can become desynchronized.
- Planned resolution:
  - Rework processing boundary so in-memory and persisted projection updates happen in a single coherent success path.
  - If projection fails, fail command deterministically and record consistent receipt/error path.
- Target files:
  - `apps/server/src/orchestration/Layers/OrchestrationEngine.ts`
  - `apps/server/src/orchestration/Layers/ProjectionPipeline.ts`
  - related persistence layer files as needed
- Tests:
  - Simulate projection failure post-append and verify deterministic observable state + receipt behavior.

### C2) Engine error handling/receipt semantics are incomplete for non-invariant failures
- Issue:
  - Non-invariant failures may not persist failure receipt consistently, weakening idempotency/retry behavior.
- Planned resolution:
  - Define explicit receipt policy for invariant vs infrastructure failures.
  - Persist rejected receipt shape with error classification and retryability signal.
- Target files:
  - `apps/server/src/orchestration/Layers/OrchestrationEngine.ts`
  - `apps/server/src/persistence/Layers/OrchestrationCommandReceipts.ts`
  - `apps/server/src/orchestration/*test.ts`
- Tests:
  - Retry same `commandId` after failure and assert deterministic replay/idempotency behavior.

### C3) Projection pipeline fallback can preserve orphaned messages (FK risk)
- Issue:
  - Gap-filling fallback logic can retain messages tied to removed turns.
- Planned resolution:
  - Remove fallback or strictly filter fallback messages by retained turn ids.
  - Validate FK-safe mutation path.
- Target files:
  - `apps/server/src/orchestration/Layers/ProjectionPipeline.ts`
  - `apps/server/src/orchestration/Layers/ProjectionPipeline.test.ts`
- Tests:
  - Revert/delete turn scenarios proving no orphaned message rows remain.

### C4) Snapshot projector barrier includes projectors not read by snapshot query
- Issue:
  - Barrier can wait for projector state not represented in returned payload, causing sequence mismatch/replay confusion.
- Planned resolution:
  - Align `REQUIRED_SNAPSHOT_PROJECTORS` with actual snapshot query surface.
  - Add explicit comment/contract for inclusion criteria.
- Target files:
  - `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts`
  - `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.test.ts`
- Tests:
  - Validate `snapshotSequence` monotonic correctness against included tables/data only.

### C5) NodeSqlite client resource/typing hazards
- Issue:
  - `executeUnprepared` statement lifecycle and return-shape comments indicate leak/type hazards.
- Planned resolution:
  - Wrap prepare/finalize in `Effect.acquireUseRelease`.
  - Correct return typing contract and caller expectations.
- Target files:
  - `apps/server/src/persistence/NodeSqliteClient.ts`
  - `apps/server/src/persistence/NodeSqliteClient.test.ts`
- Tests:
  - Resource cleanup test (finalize always invoked).
  - Return-shape test for `run` paths.

### C6) Event metadata defaults created at module load are fragile
- Issue:
  - Shared `defaultMetadata` object pattern risks stale defaults if future event construction forgets overrides.
- Planned resolution:
  - Replace static default object with per-event metadata factory function.
  - Avoid mutable shared default structures.
- Target files:
  - `apps/server/src/orchestration/decider.ts`
  - decider/orchestration tests
- Tests:
  - Ensure unique event metadata (`eventId`, timestamps) per decision invocation.

### C7) Provider session directory read-modify-write lost update risk
- Issue:
  - Concurrent upserts can clobber fields without transactional/version guard.
- Planned resolution:
  - Introduce transaction or optimistic version check around merge-upsert path.
- Target files:
  - `apps/server/src/provider/Layers/ProviderSessionDirectory.ts`
  - corresponding test file(s)
- Tests:
  - Concurrency test with competing updates preserving expected merged state.

---

## Phase D (P1/P2) - Runtime / Platform Hardening

### D1) WS upgrade reject path socket safety
- Issue:
  - Potential `EPIPE/ECONNRESET` during reject write path and response flush concerns.
- Planned resolution:
  - Attach socket error listener in reject path and use `socket.end` where appropriate.
  - Keep behavior deterministic under disconnect-mid-handshake.
- Target files:
  - `apps/server/src/wsServer.ts`
  - `apps/server/src/wsServer.test.ts`
- Tests:
  - Add handshake-disconnect scenario confirming no crash.

### D2) PTY adapter platform selection and lifecycle races
- Issue:
  - Bun+Windows selection can hit `Effect.die`.
  - `didExit` guard can drop buffered output.
  - executable-fix flag can be set before successful chmod.
- Planned resolution:
  - Gate Bun PTY path by platform capability.
  - Adjust output/exit ordering to avoid dropped data.
  - Move helper-executable flag set after successful chmod.
- Target files:
  - `apps/server/src/ptyAdapter.ts`
  - `apps/server/src/ptyAdapter.test.ts`
- Tests:
  - Platform selection unit test.
  - Output-after-exit race regression test.
  - chmod failure retry behavior test.

### D3) Shell PATH probing robustness
- Issue:
  - `-il` can pollute output; fish shell PATH formatting may not be colon-separated.
- Planned resolution:
  - Switch probing flags/commands to deterministic non-interactive mode.
  - Add fish-specific join handling or fallback validation.
- Target files:
  - `apps/server/src/os-jank.ts`
  - add/extend tests
- Tests:
  - Parsing tests for bash/zsh/fish simulated outputs.

### D4) Effect callback cleanup omissions
- Issue:
  - Missing cleanup function can leak server handles on interruption.
- Planned resolution:
  - Ensure `Effect.callback` paths return cleanup that closes listeners/servers.
- Target files:
  - `apps/server/src/config.ts`
  - relevant tests
- Tests:
  - Start/interrupt lifecycle test verifies no leaked handles.

---

## Phase E (P1/P2) - Web / Client Correctness

### E1) Pending approvals indicator is non-functional
- Issue:
  - `pendingApprovalByThreadId` map is currently static/empty, so badge never reflects real state.
- Planned resolution:
  - Derive map from authoritative read model activity/pending approval state.
  - Remove dead map initialization pattern.
- Target files:
  - `apps/web/src/components/Sidebar.tsx`
  - add sidebar logic tests
- Tests:
  - Given approval activity in thread, badge appears and clears appropriately.

### E2) Branch toolbar dual-write can cause flicker/inconsistent session state
- Issue:
  - Local `SET_THREAD_BRANCH` + server command dispatch creates temporary contradictory state.
- Planned resolution:
  - Move to single-source update path: server command + read-model sync.
  - Keep optimistic UI only if it is reconciled safely.
- Target files:
  - `apps/web/src/components/BranchToolbar.tsx`
  - `apps/web/src/components/BranchToolbar.logic.test.ts`
- Tests:
  - Ensure no local stale session overwrite when server model update arrives.

### E3) Markdown link parser false-positive scheme + double decode
- Issue:
  - `script.ts:10` misclassified as external scheme.
  - file URL path can be decoded twice.
- Planned resolution:
  - Tighten external scheme detection (`://` or equivalent guard).
  - Avoid second decode when source was already parsed from file URL.
- Target files:
  - `apps/web/src/markdown-links.ts`
  - `apps/web/src/markdown-links.test.ts`
- Tests:
  - Add tests for `script.ts:10`, percent-encoded file names, and valid external schemes.

### E4) WS transport request/error edge cases
- Issue:
  - Spreading params into body can override reserved keys.
  - malformed error payload can resolve instead of reject.
- Planned resolution:
  - Normalize request envelope shape to prevent key collisions.
  - Harden error decoding fallback so promise rejects on any error object.
- Target files:
  - `apps/web/src/wsTransport.ts`
  - add/extend wsTransport tests
- Tests:
  - Reserved key collision case.
  - Error object without message still rejects with fallback.

### E5) Sidebar width bootstrap from localStorage can default incorrectly
- Issue:
  - `Number(null) === 0` can force unintended min width on first load.
- Planned resolution:
  - Explicit null/empty guard before number parse.
- Target files:
  - `apps/web/src/routes/_chat.$threadId.tsx`
  - add route/component unit test
- Tests:
  - First-load with missing key preserves default width behavior.

---

## Phase F (P2) - Cleanup / Typing Hygiene

### F1) Symbol-safe string interpolation for error messages
- Issue:
  - Interpolating raw symbol causes TypeError in some error formatting paths.
- Planned resolution:
  - Use `String(cause)`/safe coercion helper consistently.
- Target files:
  - `apps/server/src/orchestration/Errors.ts`
  - `apps/server/src/provider/Layers/ProviderService.ts`
- Tests:
  - Add symbol/undefined/function cause formatting tests.

### F2) Remove redundant union members and dead error classes if truly unused
- Issue:
  - Redundant type entries and potentially dead error classes increase noise.
- Planned resolution:
  - Remove redundant union members.
  - Either remove dead classes or document retained intent with usage boundary.
- Target files:
  - `apps/server/src/checkpointing/Errors.ts`
  - related type/tests
- Tests:
  - Type-level and runtime regression checks around error mapping.

### F3) Documentation cleanup comments
- Issue:
  - Review flagged temporary marker in docs.
- Planned resolution:
  - Remove transient marker if no longer needed.
- Target files:
  - `AGENTS.md`

---

## Review Comment Disposition Plan

### Duplicate clusters to close with one canonical fix comment
1. `providers.event` restoration requests (same underlying claim).
2. Build script `node scripts/bundle-client.ts` (same claim repeated).
3. CheckpointStore normalization duplicates.
4. `handledTurnStartKeys` growth duplicates.
5. checkpoint-ref helper duplication variants.

### Invalid/wrong clusters to close as “no action”
1. Reintroduce `providers.event` channel:
   - Current contracts/channel surface does not define it.
   - PR is intentionally orchestration-domain-event based.
2. Build script cannot run `.ts` under Node:
   - Repository pins modern Node and script executes successfully in current environment.

---

## Verification and Quality Gates

### Required per phase
1. Implement targeted tests for backend behavior changes (no mocking out core business logic).
2. Run affected package test suites (at minimum):
   - `bun run --cwd apps/server test`
   - `bun run --cwd apps/web test`
3. Run root lint before marking phase complete:
   - `bun run lint`

### Final pre-merge gate
1. Full lint pass with no new warnings introduced by this work.
2. Server tests pass for orchestration/reactor/checkpoint/persistence packages.
3. Web tests pass for markdown/branch/sidebar/ws transport paths.
4. Resolve or explicitly disposition all active review threads with links to fixes.

