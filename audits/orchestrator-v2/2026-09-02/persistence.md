# Orchestration V2 persistence, runtime, and performance audit

Date: 2026-09-02  
Frozen branch: `d2f1f511f4cc833bc930d6c355cd0f9b61e835a0`  
Current main: `57a66608b918d673eeec7e6c94ea5906b756fcd0`  
Prior reviewed tip: `c1791ab2637` (`47f5b100440591d2f49aa30cf3bb69eacae07f52` before rebase)

This was a read-only review of `apps/server/src/orchestration-v2` excluding provider adapters, plus the persistence and project boundaries explicitly requested by the root review. No product source or tests were edited. The only writes are this audit report and the retained audit-only probe artifacts beside it. No live database, provider, server, browser, or production state was used.

## Summary

I confirmed seven findings:

| Severity | Classification                          | Finding                                                                                                                                                                       | Evidence basis                                                           |
| -------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Blocker  | Branch-upgrade rebase regression        | Existing V2 databases through old migration 052 fail on current 053, while new main migration 044 is skipped.                                                                 | Retained actual migration-runner/in-memory SQLite reproduction.          |
| High     | Preexisting V2 integration bug          | WebSocket forced project deletion commits V2 thread deletions before legacy project deletion rejects the still-present imported V1 threads.                                   | Deterministic source trace only; no integrated transport run.            |
| High     | Preexisting V2 integration bug          | HTTP and offline CLI project mutation bypass V2 deletion and drop `force`; create also drops `createWorkspaceRootIfMissing`.                                                  | Deterministic source trace only; no integrated transport run.            |
| High     | V2 correctness gap                      | Full-thread diff fails after an ordinary second run because production reuses one root scope and updates its `runId`, while the query requires that scope to belong to run 1. | Retained real allocator/projection reproduction plus query source trace. |
| Medium   | New auto-settlement regression          | A failure that predates a snooze is treated as waking the snoozed thread and can settle it early.                                                                             | Source and policy-test trace; no timed service run.                      |
| Medium   | Preexisting missed-main performance gap | Checkpoint diff loads an unbounded full V2 thread projection instead of narrow checkpoint context.                                                                            | SQL/source cardinality trace; not benchmarked.                           |
| Medium   | Preexisting V2 performance gap          | Startup recovery loads every persisted row for every active and archived thread before accepting commands.                                                                    | SQL/source cardinality trace; not benchmarked.                           |

The previously fixed token-usage, legacy metadata, migrated search, missing-worktree recovery, unsettled ordering, SQL visibility, stop-request dependency, nested-fork cursor, true-end pagination, and bounded payload invariants remain present at the frozen head. Focused tests passed, but they do not cover the broken upgrade history or populated-project deletion boundaries.

## Confirmed findings relative to main and prior invariants

### 1. Blocker: an existing pre-rebase V2 database cannot migrate to the current head

**Current code.** The current manifest inserts main's `ClearAutomaticProjectModelDefaults` at ID 44 and shifts the old branch migrations to IDs 45 through 53 (`apps/server/src/persistence/Migrations.ts:58-67`, `:123-132`). The migration API documents that only IDs above the latest recorded ID run (`Migrations.ts:156-169`). The underlying Effect migrator implements exactly that rule and does not compare historical names: `currentId <= latestMigrationId` is skipped at `.repos/effect-smol/packages/effect/src/unstable/sql/Migrator.ts:228-259`, specifically `:248-252`.

Current 053 then unconditionally creates `orchestration_v2_legacy_imports` and its index (`apps/server/src/persistence/Migrations/053_LegacyV1ImportState.ts:9-26`). Neither statement uses `IF NOT EXISTS`.

**Historical evidence.** At `c1791ab2637`, the branch manifest assigned `OrchestrationV2` through `LegacyV1ImportState` IDs 44 through 52 (`apps/server/src/persistence/Migrations.ts` at that commit, lines 58-66 and 122-130). Old `052_LegacyV1ImportState.ts` and current `053_LegacyV1ImportState.ts` are byte-identical; both hash to `efc494840b8319531495a28a82f6624947e54be9846ee6f5a260cd7eae27fe1c`. Main's new 044 performs data repair in both `projection_projects` and `orchestration_events` (`apps/server/src/persistence/Migrations/044_ClearAutomaticProjectModelDefaults.ts:7-50`).

**Actual disposable reproduction.** I ran the real current `runMigrations` with the repository's NodeSqlite layer against an in-memory database. The fixture first applied the current schema bodies corresponding to the old branch sequence and recorded the old IDs and names 44 through 52, ending with `[52, "LegacyV1ImportState"]` and an existing `orchestration_v2_legacy_imports` table. On the next current migration run:

```text
latest before current run: 52_LegacyV1ImportState
current run: MigrationError: Migration "53_LegacyV1ImportState" failed
SQLite cause: table orchestration_v2_legacy_imports already exists
latest after rollback: 52_LegacyV1ImportState
```

This exercises the actual migration loader, tracking table, transaction, and SQLite DDL. It does not write any live database.

**Reachable trigger.** Start this frozen build against any database that successfully ran branch tip `c1791ab2637` through migration 52.

**Impact.** Startup fails on 053. Before that failure, the migrator silently treats current 044 through 052 as already applied because their numeric IDs are not above 52. In particular, main's automatic project-model repair at current 044 is never applied to an upgraded branch database. Making only the table creation idempotent fixes the crash but still leaves that repair skipped.

**Compatibility fix.** The migration strategy must explicitly cover every supported historical manifest, not only the reproduced old-052 tip. Making current 053 use `IF NOT EXISTS` would unblock that one cohort, but it would neither apply skipped main 044 nor make arbitrary partially migrated old V2 cohorts safe. For example, an old database ending at 44 can run current 45's shifted copy of the same V2 DDL and collide earlier in the sequence.

Use a manifest-aware compatibility bridge before the ordinary numeric runner, or make every shifted 45-53 step safe for its corresponding old predecessor, then append an idempotent migration that reapplies main 044's repair. A manifest-aware bridge can identify old history by recorded `(migration_id, name)` pairs, reconcile those records/schema to the new numbering, and leave released-main histories distinct. Do not infer history from the maximum ID alone. Add table-driven migration tests for each supported old branch stopping point plus released-main and fresh histories. The exact old-052 regression must remain a fixture. The existing fresh-database test at `apps/server/src/persistence/Migrations/045_046_OrchestrationV2.test.ts:174-230` starts before these IDs and cannot detect any of these upgrade failures.

### 2. High: forced WebSocket project removal can delete V2 threads and then reject the project delete

**Current code.** The WebSocket mutation handler obtains active and archived V2 shells, enforces `force`, and dispatches one `thread.delete` command at a time (`apps/server/src/ws.ts:1238-1258`). Those are independently committed mutations. It then calls `ProjectService.delete` without `force` (`ws.ts:1259-1262`). `ProjectDeleteInput` has no `force` member (`apps/server/src/project/ProjectService.ts:42-45`), and the service dispatches a legacy `project.delete` without it (`ProjectService.ts:348-371`).

The legacy decider rejects a nonempty project unless its command contains `force: true`; when force is present, it deletes legacy threads and the project as one decided sequence (`apps/server/src/orchestration/decider.ts:274-306`). The legacy engine bootstraps that invariant from `getCommandReadModel` (`apps/server/src/orchestration/Layers/OrchestrationEngine.ts:344-345`). That query reads every `projection_threads` row (`apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts:430-463`, `:1858-1918`) and constructs the thread read model at `:2010-2049`.

The V1 importer copies rows from `projection_threads`; it does not delete or supersede those rows (`apps/server/src/orchestration-v2/LegacyV1ThreadImporter.ts:459-560`). It also refuses to import the same thread again once a V2 `thread.created` event exists (`LegacyV1ThreadImporter.ts:481-489`).

**Reachable trigger.** Use the WebSocket `project.delete` mutation with `force: true` on a project whose legacy threads have been imported into V2. This is the normal state after the V2 legacy-shell startup import.

**Observed behavior from the source path.** Each V2 thread deletion succeeds first. The subsequent legacy `ProjectService.delete` sees the intact active `projection_threads` rows and rejects because the forwarded command has no force. The project remains, its V1 rows remain, and its V2 thread copies are deleted. A later importer pass will not restore them because their V2 creation events still exist.

**Impact.** A user-authorized project removal fails after partially committing destructive work. The V2 UI loses the project's threads while reporting that the project could not be deleted.

**Minimal fix.** Preserve `force` through `ProjectDeleteInput` and the legacy dispatch so this exact mixed-store path cannot reject after the V2 deletes. Prefer a single project-deletion coordinator used by all transports, with validation over both V1 and V2 and one transactional event commit; otherwise an unrelated failure in the per-thread loop can still partially delete a project. Add a focused test with one imported active thread and one imported archived thread, then force-delete through the WebSocket handler and assert the project and both representations are deleted.

**Classification.** This predates `c1791ab2637`: the current deletion sequence traces to `b1c074b2ec3`, which is an ancestor of the prior rebased tip. It is a previously missed V2 integration bug relative to the V1 force-delete invariant, not a regression introduced by the final rebase.

### 3. High: HTTP and offline CLI project mutations bypass the V2 lifecycle and drop contract fields

**Current code.** `ProjectMutation` explicitly carries `createWorkspaceRootIfMissing` and deletion `force` (`packages/contracts/src/project.ts:70-95`). The WebSocket create handler forwards the former (`apps/server/src/ws.ts:1215-1223`), and `ProjectService.create` uses it when normalizing the workspace (`apps/server/src/project/ProjectService.ts:253-269`).

The production HTTP endpoint is registered at `apps/server/src/server.ts:465-475` from the contract at `packages/contracts/src/environmentHttp.ts:560-575`. Its handler calls `ProjectService` directly. Create omits `createWorkspaceRootIfMissing`, and delete omits `force` and all V2 thread enumeration/deletion (`apps/server/src/project/http.ts:45-80`).

The live CLI uses that HTTP endpoint (`apps/server/src/cli/project.ts:324-338`). Its offline path also maps delete directly to `ProjectService.delete` without force (`cli/project.ts:423-459`). The user-facing command accepts `--force`, describes it as deleting all threads, and includes the flag in its transport command (`cli/project.ts:522-555`). Main V1's invariant and forced sequence are the decider behavior at `apps/server/src/orchestration/decider.ts:274-306`; the prior CLI path passed the force field through to the engine.

**Reachable triggers and actual behavior.**

1. A V2-only project with active or archived V2 threads can be deleted by `POST /api/projects/mutate`. The legacy read model sees no V1 thread, so the project deletion succeeds while the V2 threads remain live and reference a deleted project.
2. An imported project with legacy rows rejects HTTP or CLI `--force` removal because `force` is dropped.
3. `t3 project remove`, live and offline, inherits these deletion outcomes despite promising complete forced cleanup.
4. HTTP and offline CLI project creation with `createWorkspaceRootIfMissing: true` behaves as false because the flag is dropped.

**Impact.** The same typed mutation has materially different safety and filesystem semantics by transport. The deletion variant can orphan V2 threads or make `--force` ineffective.

**Minimal fix.** Route WebSocket, HTTP, live CLI, and offline CLI mutations through one V2-aware project mutation coordinator. Forward both optional fields unchanged. Add transport-parity tests for V2-only populated projects, imported projects, archived threads, force false/true, and missing workspace creation.

**Classification.** The direct HTTP/offline mappings trace to `b56d0e7d53fb`, an ancestor of `c1791ab2637`. This is a previously missed V2 transport integration bug, not a final-rebase regression. New main CLI behavior makes the existing mismatch directly user-facing in `t3 project remove`.

### 4. Medium: auto-settlement treats a failure predating the snooze as an early wake

**Current code.** A future snooze is bypassed whenever `thread.status === "failed"`, with no comparison to `snoozedAt` (`apps/server/src/orchestration-v2/ThreadSettlementService.ts:95-116`, especially `:107-116`). The service then performs normal inactivity/PR evaluation and can dispatch `thread.auto-settle` (`ThreadSettlementService.ts:216-270`). The current test asserts that changing only the status to failed wakes the snooze (`apps/server/src/orchestration-v2/ThreadSettlementService.test.ts:70-87`).

**Main/prior invariant.** Main V1 only treats an error as a wake when the error session was updated after the snooze. It compares `thread.session.updatedAt` with `thread.snoozedAt` (`apps/server/src/orchestration/ThreadSettlementPolicy.ts` at main, lines 89-107, specifically 98-101). Completion has the same after-snooze rule.

**Reachable trigger.** Let a thread fail, then snooze that already-failed thread into the future. On the next minute sweep, V2 classifies the stale failure as an early wake. If the inactivity or PR rule matches, it settles the thread before the requested wake time.

**Impact.** A newer explicit snooze loses to older failure state, so settled/active sidebar placement contradicts the user's latest action.

**Minimal fix.** Require the failure evidence to be newer than `snoozedAt`, as V1 does. The V2 shell already exposes `latestRunCompletedAt`; for a failed latest run, require that timestamp to be non-null and greater than `snoozedAt`. Add tests for failure before snooze (parked) and failure after snooze (candidate).

## Confirmed V2 correctness and performance gaps

### 5. High: full-thread diff fails after an ordinary second run

**Current code.** For `fromTurnCount === 0`, `CheckpointDiffQuery` finds `runs.ordinal === 1`, requires a `root_run` scope whose current `runId` is that first run, and synthesizes its ordinal-0 ref (`apps/server/src/checkpointing/CheckpointDiffQuery.ts:157-180`). `getFullThreadDiff` always delegates to that path (`CheckpointDiffQuery.ts:204-248`).

Production does not keep one distinct root scope row per run. `IdAllocator` derives a checkpoint scope solely from `threadId` and the constant scope name (`apps/server/src/orchestration-v2/IdAllocator.ts:295-300`). `makeRootRunScope` always requests the name `"root"`, but places the current run, node, provider thread, cwd, and creation time in the payload (`apps/server/src/orchestration-v2/CheckpointService.ts:184-210`, with the constant at `:27`). Each ordinary immediate run emits `checkpoint-scope.created` (`apps/server/src/orchestration-v2/Orchestrator.ts:3558-3567`).

Both projection implementations replace the prior scope because the deterministic ID is the same. The in-memory path uses `upsertById` (`apps/server/src/orchestration-v2/ProjectionStore.ts:343-347`), and SQL uses `ON CONFLICT(scope_id) DO UPDATE`, including overwriting `run_id` (`ProjectionStore.ts:1773-1815`, specifically `:1803-1814`). Checkpoint IDs and refs remain stable by shared scope plus ordinal (`apps/server/src/orchestration-v2/CheckpointService.ts:161-181`). Thus, after run 2, the one root scope row belongs to run 2 while the valid ordinal-0 baseline from run 1 remains under that shared scope ID.

**Test-fixture mismatch.** `CheckpointDiffQuery.test.ts:23-49` fabricates `firstScopeId` and `secondScopeId` and keeps both rows. That state cannot be produced by the real allocator for two root runs in one thread. The happy-path assertion at `:70-96` therefore hides the production failure. The missing-baseline test at `:176-196` also treats absence of a run-1-owned scope as an error, even though that is the normal projection after run 2.

**Actual disposable allocation/projection probe.** I ran the real `IdAllocatorV2.allocate.checkpointScope` twice for the same thread and `"root"`, then applied two real `checkpoint-scope.created` events through `applyToProjection`. The two allocated IDs were equal; after the second event, `checkpointScopes.length` was 1 and the stored row's `runId` was `run:2`. The one-case audit-only Vitest probe passed and was removed afterward.

**Reachable trigger and behavior.** Complete two ordinary immediate runs in a Git workspace, then request `getFullThreadDiff` to turn 2. The target checkpoint and shared ordinal-0 ref exist. The sole root scope now has `runId` 2, so the lookup constrained to run 1 returns undefined and the query raises `CheckpointRefUnavailableError` for the `from` ref. A cancelled/deferred first run is another trigger, but is not required.

**Impact.** Full-thread diff is unavailable for normal multi-turn threads from the second completed run onward.

**Minimal fix.** Stop joining the zero baseline through `firstRun.id`. Resolve the root scope by the target checkpoint's shared `scopeId`, then use that scope's ordinal-0 checkpoint/ref. Prefer the stored ready baseline ref and validate that it exists. Rewrite the happy-path test with the real allocator or one shared root scope whose current `runId` is run 2, and retain separate corrupt/missing-baseline coverage.

**Classification.** The bad lookup traces to `b56d0e7d53fb`, while deterministic scope reuse and projection upsert predate it. `b56d0e7d53fb` is an ancestor of `c1791ab2637`, so this is a previously missed V2 correctness bug rather than a final-rebase regression.

### 6. Medium: checkpoint diff reintroduces unbounded transcript hydration fixed on main

**Current code.** Every nonempty diff first calls `ThreadManagementService.getThreadProjection` (`apps/server/src/checkpointing/CheckpointDiffQuery.ts:102-121`). V2's method is the unwindowed `readProjection` path (`apps/server/src/orchestration-v2/ProjectionStore.ts:2598-2599`). With no window, that path loads every turn item (`ProjectionStore.ts:2023-2030`) and selects all rows from each run, attempt, node, session, provider thread/turn, request, message, plan, checkpoint, and handoff table (`ProjectionStore.ts:2163-2399`), then decodes all of them (`ProjectionStore.ts:2401-2433`). Fork ancestry can recurse through additional full projections (`ProjectionStore.ts:2467-2589`).

**Main invariant.** Main #8988 (`b17cc3d1bf0`) reduced full tool-output hydration, and #8992 (`7e460f429b7`) added a dedicated full-thread-diff query. The retained V1 implementation demonstrates the intended shape: a small thread/workspace query at `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts:985-1001`, a single-row full-diff query at `:1533-1562`, and narrow service methods at `:2512-2583`. Main's `CheckpointDiffQuery` calls `getThreadCheckpointContext` or `getFullThreadDiffContext`; current V2 does neither.

**Reachable trigger.** Request a turn diff or full-thread diff for any long thread, especially one with large tool outputs or fork ancestry.

**Impact/cardinality.** Work is O(all persisted child rows for the thread and its fork ancestors), although the operation needs only workspace identity, run status/ordinal, scope identity, and a few checkpoint refs. A diff request can load and decode unrelated transcript bodies into memory.

**Minimal fix.** Add V2 SQL queries equivalent to `getThreadCheckpointContext` and `getFullThreadDiffContext`, against V2 projection tables, and have the diff service use them. The full-thread endpoint needs one target checkpoint, the latest available completed turn count, a valid zero baseline, and the workspace path; it should not instantiate `OrchestrationV2ThreadProjection`. Add a cardinality test with a large unrelated tool payload and assert that the narrow query does not read/decode it.

**Classification.** This gap was already present at `c1791ab2637`, even though main's #8988/#8992 optimizations were already in its ancestry. It is a missed main performance invariant from the prior review, not a new final-rebase regression.

### 7. Medium: startup recovery fully hydrates every active and archived thread before readiness

**Current code.** Recovery loads the V2 shell, iterates `shell.threads` plus `shell.archivedThreads` sequentially, and calls full `getThreadProjection` for every one (`apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts:470-499`). The reconciliation only needs nonterminal runs, pending runtime requests, live provider/background state, and unsettled process-bound effects (`ProviderRuntimeRecoveryService.ts:130-175` and the remainder of `reconcileProjection`).

As above, `getThreadProjection` is unbounded (`apps/server/src/orchestration-v2/ProjectionStore.ts:2023-2030`, `:2163-2433`, `:2598-2599`) and recursively loads complete source projections for forked threads (`:2467-2589`). Startup awaits this recovery as an ordered phase (`apps/server/src/serverRuntimeStartup.ts:456-508`) and does not signal command readiness until `:615-617`.

**Reachable trigger.** Restart an environment with many terminal threads, archived threads, long transcripts, tool payloads, checkpoints, or fork chains. No active provider work is required.

**Impact/cardinality.** Startup database reads and decoding are O(total retained V2 projection history), not O(recoverable runtime state). The loop is sequential across threads. This can delay every local and remote client from issuing commands and creates a peak-memory cost before readiness. I did not benchmark it, so no latency number is claimed.

**Classification.** This is a preexisting V2 design/performance gap, not a regression newly introduced by the final rebase. V1's startup read model also scans all thread shells, but it does not hydrate every transcript row, so this is not classified as a main-both bug.

**Minimal fix.** Add an indexed recovery-candidate query that returns only thread IDs with a nonterminal run, pending request, live provider session/background item, or pending/running process-bound outbox entry. Then load a narrow recovery projection for only those IDs. Add a startup test containing many large terminal archived threads and assert that they are not passed to full projection reads.

## Rejected candidate

### Source-control lookup with inactivity and merge settings disabled is intentional

An earlier draft classified recurring Git/PR lookup as unnecessary when `sidebarAutoSettleAfterDays` is null and `sidebarAutoSettleOnMerge` is false. Reviewer feedback correctly rejected that conclusion.

Closed pull requests are an always-on settlement rule. V2 accepts `state === "closed"` regardless of `autoSettleOnMerge` and only gates the `"merged"` state on that setting (`apps/server/src/orchestration-v2/ThreadSettlementService.ts:71-91`). `shouldAutoSettleThread` evaluates that PR rule before the optional inactivity rule (`:119-140`). Main V1 has the same policy (`apps/server/src/orchestration/ThreadSettlementPolicy.ts:45-86`), and its test explicitly expects a closed request to settle with merge settlement disabled (`ThreadSettlementPolicy.test.ts:65-66`).

The retained audit probe confirms that a closed PR newer than the user's last action settles with both optional settings off. Therefore the sweep must inspect PR state to preserve current product behavior. An early return based only on those settings would be a regression. No performance finding or fix recommendation remains for this candidate.

## Intentional differences and separately owned gaps

| Area                                                | Classification and result                                                                                                                                                                                                                                |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Continue active threads after server update (#9167) | Explicitly deferred for V2 at this head. V2 recovery terminalizes interrupted work rather than persisting main's continuation marker. This is a feature-intent gap owned by the root review, not reported above as an accidental persistence regression. |
| Automatic title retry (#8087)                       | The root review independently confirmed that V2 lacks main's bounded retries. It is omitted from this report's findings to avoid duplicate ownership.                                                                                                    |
| Provider adapters and client surfaces               | Excluded by assignment and covered by other reviewers. Persistence-facing provider state was reviewed, but adapter protocol correctness was not.                                                                                                         |
| Legacy import retention                             | Keeping `projection_threads` after import is current design and is not itself labeled a bug. The project-deletion coordinators are buggy because they assume one representation while both remain authoritative for different paths.                     |

## Prior-fix retention status

The supplied `prior-fixes-range-diff.txt` shows the previous review patch series rebased through `c1791ab2637`. I rechecked the production paths, not only patch identity.

| Prior invariant                                 | Status at frozen head                   | Current evidence                                                                                                                                                                                                                                         |
| ----------------------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Persist current token usage                     | Preserved                               | Live merge retains existing usage when a terminal update omits it (`apps/server/src/orchestration-v2/ProjectionStore.ts:159-169`); SQL projection reads the prior payload before overwrite (`:1556-1574`).                                               |
| Persisted provider usage                        | Preserved                               | Same SQL merge path above; `ProviderTurnTokenUsage.test.ts:12-42` covers the terminal omission case, and `ProjectionStore.test.ts:93-199` covers persistence.                                                                                            |
| Import legacy pins/order/snooze/PR metadata     | Preserved                               | Import mapping at `LegacyV1ThreadImporter.ts:142-210`; repair selection and patch at `:390-457`.                                                                                                                                                         |
| Repair already imported legacy shells           | Preserved                               | Metadata-repair events at `LegacyV1ThreadImporter.ts:390-457`; focused importer tests passed.                                                                                                                                                            |
| Migrated ownership/archive/deletion search      | Preserved                               | Search joins V1 and V2 ownership and filters both lifecycle representations at `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts:814-877`; search tests passed.                                                                           |
| Missing-worktree send recovery                  | Preserved                               | Existence check and recreate-before-turn path at `apps/server/src/orchestration-v2/ProviderTurnStartService.ts:142-177`; focused tests passed.                                                                                                           |
| Unsettled ordering/state                        | Preserved                               | Explicit settlement transitions retain/reanchor `unsettledAt` at `apps/server/src/orchestration-v2/Orchestrator.ts:1574-1598`; automatic completion path at `:2870-2893`; runtime tests passed.                                                          |
| Automatic-completion queue order                | Preserved                               | `queuedRunsInDeliveryOrder` prioritizes delegated completion, then queue position and ordinal (`apps/server/src/orchestration-v2/QueuedRunOrder.ts:12-31`); focused tests passed.                                                                        |
| SQL visible cohort before `LIMIT`               | Preserved                               | Eligibility filters rollback, cancelled queued messages, superseded interrupts, source cutoff, and required-run handling before `selected ... LIMIT` (`apps/server/src/orchestration-v2/ProjectionStore.ts:2031-2126`). Projection/history tests passed. |
| Paired stop-request dependency                  | Preserved                               | SQL retained cohort adds the matching `run_interrupt_request` (`ProjectionStore.ts:2101-2110`); bounded projection also reserves dependencies (`threadHistoryPaging.ts:400-448`).                                                                        |
| Nested fork cursor identity and empty ancestors | Preserved                               | Cursor source identity at `threadHistoryPaging.ts:92-140` and `:218-249`; recursive source anchoring and empty-ancestor suppression at `ProjectionStore.ts:2467-2589`. Focused nested-fork tests passed.                                                 |
| History actual-end pagination                   | Preserved                               | SQL fetch uses max page plus two rows (`apps/server/src/orchestration-v2/http.ts:132-149`); history response uses the computed page end (`:216-254`). Focused pagination tests passed.                                                                   |
| Snapshot/detail/control-payload budget          | Preserved                               | Central budgets and control-plane reservation at `apps/server/src/orchestration-v2/threadHistoryPaging.ts:10-46`, `:381-496`; bounded HTTP exposes overflow status at `apps/server/src/orchestration-v2/http.ts:195-212`.                                |
| Waiting checkpoint recovery                     | Preserved, with separate diff bug above | Recovery leaves a waiting run intact when its checkpoint effect is replayable (`ProviderRuntimeRecoveryService.ts:134-155`); checkpoint capture is at-least-once (`CheckpointCaptureService.ts:68-93`).                                                  |
| Outbox recovery and settlement                  | No new correctness regression found     | Reconciliation requeues replayable work and retires process-bound work; focused recovery, runtime-layer, checkpoint-capture, run-finalization, and effect-worker tests passed. The full-state startup cost is finding 7.                                 |

## Coverage

| Area                                     | Files/path inspected                                                                                                        | Result                                                                                                                                           |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Migration numbering and runner semantics | `Migrations.ts`, old `c179` manifest, current 044/053, Effect `Migrator.ts`                                                 | Blocker confirmed with real in-memory runner.                                                                                                    |
| Projection persistence and rebuild       | `ProjectionStore.ts`, `ProjectionMaintenance.ts`, event projection tests                                                    | Prior state/usage/history fixes retained; no additional data-loss finding.                                                                       |
| Windowing/history SQL                    | `ProjectionStore.ts`, `threadHistoryPaging.ts`, V2 HTTP handlers                                                            | Prior SQL visibility, dependency, fork, pagination, and budget fixes retained.                                                                   |
| Legacy import and repair                 | `LegacyV1ThreadImporter.ts`, importer tests, V1 search query                                                                | Metadata/search fixes retained; preserved V1 rows expose deletion boundary bug.                                                                  |
| Runtime recovery                         | `ProviderRuntimeRecoveryService.ts`, `serverRuntimeStartup.ts`, recovery tests                                              | Semantics tests pass; all-thread full hydration cost confirmed.                                                                                  |
| Queue and settlement                     | `QueuedRunOrder.ts`, `ThreadSettlementService.ts`, orchestrator settlement commands                                         | Queue fix retained; snooze ordering regression confirmed; disabled-policy cost candidate rejected because closed-PR settlement is always active. |
| Effect queue/outbox/leases               | `EffectOutbox.ts`, `EffectWorker.ts`, runtime layer and worker tests                                                        | No additional correctness finding; recovery candidate query remains too broad.                                                                   |
| Checkpoint scheduling/capture/diff       | `CheckpointCaptureService.ts`, `CheckpointService.ts`, `IdAllocator.ts`, `RunExecutionService.ts`, `CheckpointDiffQuery.ts` | Capture/replay invariant retained; ordinary multi-run shared-scope diff bug and full-read cost confirmed.                                        |
| Project lifecycle boundary               | WS, HTTP, CLI, `ProjectService`, V1 decider/read model                                                                      | Two high-severity preexisting transport/coordinator bugs confirmed.                                                                              |
| New main server features                 | Main-since-prior inventory, checkpoint optimizations, settlement, update continuation, project removal/model migration      | Relevant discrepancies classified above; continuation/title are separately owned.                                                                |

## Focused validation

All commands used repository-local disposable state or mocks. No repo-wide check was run.

| Test group                                                                                                                                     | Result                                                                                   |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `EffectWorker.test.ts`, `ThreadSettlementService.test.ts`, migration 045/046 test                                                              | 3 files, 24 tests passed                                                                 |
| `ProjectionStore.test.ts`, `threadHistoryPaging.test.ts`, legacy importer, two runtime recovery suites, provider-turn start/usage, queue order | 8 files, 45 tests passed                                                                 |
| Search, runtime layer, checkpoint capture, run finalization                                                                                    | 4 files, 16 tests passed                                                                 |
| `CheckpointDiffQuery.test.ts`                                                                                                                  | 1 file, 5 tests passed; the current missing-first-scope expectation is part of finding 5 |
| Product-test subtotal                                                                                                                          | 16 files, 90 tests passed                                                                |
| Retained audit-only migration/scope/policy probes                                                                                              | 1 file, 3 tests passed                                                                   |

The retained `audits/orchestrator-v2/2026-09-02/persistence-runtime-probes.test.ts` uses the actual migration runner with in-memory SQLite, the real checkpoint allocator and projection reducer, and the production V2 settlement policy. Its fixtures use typed domain events, branded identifiers, real `DateTime.Utc` values, `emptyProjection`, and `threadShellFromProjection`; there are no permissive projection/event casts. Its migration case expects and captures the current 053 failure, so the probe suite itself passes while reproducing the blocker. Its scope case confirms that two root-run allocations produce one shared scope row whose `runId` is overwritten by run 2. Its policy case records the reviewer rejection above. Audit probes are not included in the 90-product-test total.

Exact rerun command and output are retained in `audits/orchestrator-v2/2026-09-02/persistence-runtime-probes.log`.

## Remaining validation gaps

- I did not mutate product tests to add the missing historical-manifest fixtures. The retained audit-only probe uses the same migration loader and SQL layer for the confirmed old-052 cohort; other supported partial old-branch stopping points still need table-driven validation.
- I did not invoke a live WebSocket/HTTP server or CLI. The project-deletion outcomes are deterministic source traces across typed handlers, committed V2 commands, and the legacy decider. An integrated disposable server test should be added with the fixes.
- I did not benchmark startup recovery or checkpoint diff. Cardinality claims above follow the explicit unwindowed SQL and loops; they do not claim measured latency or memory.
- I did not test live GitHub/PR providers. Settlement PR grouping and local Git call order were inspected statically.
- Provider adapters, browser clients, desktop/mobile behavior, build/auth compatibility, and title retries are assigned to other reviewers/root.
- The explicit server-update continuation gap needs a product decision and V2 design; it is not silently counted as passing parity.
