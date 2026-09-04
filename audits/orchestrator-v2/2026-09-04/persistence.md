# Orchestrator V2 persistence and lifecycle audit

Date: 2026-09-04  
Frozen branch HEAD: `8af5734365f7c45bc08b57066dbae42f9f7d4235`  
Initial fetched main: `d7cf8aaa8d4fbcbdd523b4f4bc86fda5c47b4a70`  
Final fetched main: `bc03c3640d6d3bb44e5fb477bfd78d7484cd0e00`  
Merge base: `c8f77e0d441264efb0acfac312e852c81ae3da83`  
Prior audit HEAD: `d2f1f511f4cc833bc930d6c355cd0f9b61e835a0`

This audit is limited to schema upgrades, legacy import, projections, startup and recovery, outbox behavior, checkpoint diff and rollback, project and thread lifecycle boundaries, auto-settlement and snooze behavior, durable scheduling, and query cardinality. I reviewed committed source with `git show <commit>:<path>` and local-only changes from the `.snapshot` paths recorded in `worktree-manifest.json`. I did not modify product source or product tests.

## Outcome

Five prior correctness findings remain open, and both prior performance findings are fixed. I found one additional concrete performance issue in the durable scheduler. The final main fingerprint added one late performance-parity gap, M10. Startup corruption verification has a separate, unmeasured safety/performance tradeoff recorded below; it is not a continuation of F15.

| ID          | Priority | Frozen committed status  | Frozen overlay status   | Result                                                                                                                                                     |
| ----------- | -------- | ------------------------ | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F01         | P1       | Open                     | Open                    | Old V2 migration histories at 052, 053, and 055 still collide with renumbered current migrations and skip newer main migrations.                           |
| F03         | P1       | Open                     | Open                    | A second ordinary run still reuses and reassigns the only root checkpoint scope, while full diff requires a run-1-owned root scope.                        |
| F04         | P1       | Open                     | Open                    | WebSocket forced project deletion still commits V2 thread deletions before a force-less legacy project deletion can reject.                                |
| F05         | P1       | Open, broadened          | Open                    | HTTP and live/offline CLI still bypass the V2-aware project lifecycle. HTTP also drops the newly added update fields.                                      |
| F13         | P2       | Open                     | Open                    | Failed status still wakes a later snooze without proving the failure occurred after the snooze.                                                            |
| F14         | P2       | Fixed                    | Fixed                   | Checkpoint diff now uses a narrow three-query checkpoint context instead of hydrating the transcript.                                                      |
| F15         | P2       | Fixed                    | Fixed                   | Startup recovery now selects unfinished candidates and no longer sequentially loads every active and archived thread history.                              |
| PERSIST-N01 | P2       | New                      | Open                    | The five-second scheduler poll full-scans and decodes every scheduled task instead of using the due-task index.                                            |
| M10         | P2       | Missing late-main parity | Partial groundwork only | V2 metadata and provider-control paths still hydrate unrelated history after main [#9758](https://github.com/pingdotgg/t3code/pull/9758) stopped doing so. |

F01, F03, F04, F05, and F13 are rollout risks. F14 is a real fix in the last committed reconciliation. F15 is fixed by the candidate-selection work in `d98f1d5e38`.

## F01: historical V2 migration cohorts still cannot upgrade

### Evidence

The frozen manifest puts main migrations at 44 through 47 and the V2 sequence at 48 through 58 (`apps/server/src/persistence/Migrations.ts` at frozen HEAD, lines 58-72 and 128-142). The runner executes only IDs above the latest recorded ID (`Migrations.ts:166-184`). It does not use the recorded migration names to reconcile a renamed history.

I verified the manifest-selected migration bodies by Git blob identity, not by filename inference:

| Historical cohort         | Historical manifest   | Current identical bodies |
| ------------------------- | --------------------- | ------------------------ |
| `c1791ab2637`             | V2 migrations 044-052 | Current 048-056          |
| Prior audit `d2f1f511...` | V2 migrations 045-053 | Current 048-056          |
| `d98f1d5e38`              | V2 migrations 045-055 | Current 048-058          |

The old `c1791ab2637` tree contains an unused `044_ClearAutomaticProjectModelDefaults.ts`, but its manifest imports and records `044_OrchestrationV2`. The cohort comparison and probe use the manifest-selected file.

The audit probe uses the actual current migration functions to create those byte-identical historical schemas under their recorded old IDs, then invokes the actual current migrator against in-memory SQLite. Results:

- Old 052 starts current 053 `ApplicationEventSource`, whose old 049 body already ran. Its unconditional `ALTER TABLE ... ADD COLUMN application_event_version` at `053_ApplicationEventSource.ts:33-47` fails with a duplicate-column error.
- Old 053 starts current 054 and reaches current 056 `LegacyV1ImportState`, whose old 053 body already created the table. `056_LegacyV1ImportState.ts:9-26` fails because the table already exists.
- Old 055 starts current 056 and fails at the same preexisting legacy-import table.

All three failures roll the attempted migration batch back to the prior recorded maximum. The probe also confirms that old 055 lacks `auto_pull` and `project_icon_json` because numeric IDs 45 through 47 are treated as already applied.

The skipped work depends on cohort:

- Old 052 skips current 044 through 052, including `ClearAutomaticProjectModelDefaults`, `ProjectionProjectsAutoPull`, `RepairAutomaticSettlementTimestamps`, and `ProjectionProjectIcon`.
- Old 053 and 055 already applied current 044 under that name, but skip current 045 through 047 and the renumbered V2 steps below their maximum.

Main itself ends at migration 047. A database produced by current main therefore advances into branch migration 048 correctly. Fresh installs also work. This is a branch-history compatibility regression, not main lag.

### Trigger and consequence

Start the frozen build against a database previously opened by any of the reproduced V2 cohorts. Server startup fails before readiness. Making only one DDL statement idempotent would move the collision but would not execute the skipped main data repairs and schema additions.

### Required coverage

Use a manifest-aware bridge keyed by recorded `(migration_id, name)` history, then append idempotent repair migrations for any main work skipped by old numeric maxima. Add table-driven upgrade fixtures for each supported historical manifest and useful partial stopping points. Fresh-schema tests cannot prove upgrade compatibility.

### Overlay

The frozen overlay adds migration 059 with three indexes. The audit probe confirms committed 058 upgrades through live 059 and the indexes exist. Historical cohorts still fail at 053 or 056 before 059 can run, so the finding applies equally to frozen committed 058 and the local 059 overlay.

## F03: full diff still fails after an ordinary second run

### Evidence

For a zero baseline, `CheckpointDiffQuery` finds run ordinal 1 and requires a `root_run` scope whose current `runId` equals that first run (`apps/server/src/checkpointing/CheckpointDiffQuery.ts` at frozen HEAD, lines 157-170). If it cannot find that scope, it returns `CheckpointRefUnavailableError` at lines 173-179.

Production creates a different state:

- `IdAllocator.allocate.checkpointScope` derives the ID only from `threadId` and scope name (`orchestration-v2/IdAllocator.ts:295-300`).
- Every ordinary root run requests the same name, `root`, while storing the current `runId` in the scope payload (`CheckpointService.ts:184-210`).
- Projection upsert replaces the prior row for that deterministic scope ID, including its ownership fields.

The real allocator/reducer audit probe allocates and applies two ordinary root scopes. Both allocations return the same ID; after run 2, there is one scope row and its `runId` is run 2. Root independently confirmed the same production ownership shape.

The product test fabricates two different root scope IDs and retains one scope for each run (`checkpointing/CheckpointDiffQuery.test.ts:18-44`). Its happy path therefore cannot be produced by the allocator it is meant to cover.

### Trigger and consequence

Complete two ordinary runs in one Git-backed thread, then request a full diff through turn 2. The shared scope's ordinal-zero baseline ref is still derivable, and the target checkpoint exists, but the query rejects because the shared scope is no longer owned by run 1. Full-thread diff fails from the second completed run onward.

The zero baseline should be resolved from the actual shared root scope, normally the target checkpoint's scope, rather than by joining scope ownership to run ordinal 1. Replace the two-scope fixture with state made by the real allocator/projector.

### Overlay

No frozen overlay file changes `CheckpointDiffQuery`, `IdAllocator`, or `CheckpointService`. The ProjectionStore overlay does not change checkpoint-scope ownership. F03 remains open locally.

## F04: WebSocket force deletion can partially commit

### Evidence

The WebSocket project handler reads active and archived V2 shells, checks `force`, and independently dispatches one `thread.delete` per thread (`apps/server/src/ws.ts` at frozen HEAD, lines 1299-1319). Only after those commits does it call `ProjectService.delete`, omitting `force` (`ws.ts:1320-1323`).

`ProjectDeleteInput` has no force field, and `ProjectService.delete` dispatches a legacy `project.delete` without one (`project/ProjectService.ts:48-51,363-386`). The legacy decider rejects any nonempty project unless `force === true`; with force, it decides thread and project deletion as one sequence (`orchestration/decider.ts:280-313`).

The legacy importer reads `projection_threads` and writes V2 events, but it intentionally leaves the V1 rows in place (`orchestration-v2/LegacyV1ThreadImporter.ts:459-490`). Once a V2 `thread.created` event exists, the importer does not create that thread again.

### Trigger and consequence

Force-delete through WebSocket a project containing imported V1 threads. V2 thread deletions commit first. The legacy project delete sees the still-present V1 threads and rejects because force was dropped. The project and V1 rows remain, the V2 copies are deleted, and later import does not restore them. This is a destructive partial commit, not merely a mismatched error message.

Main's V1 WebSocket path normalizes the original command and sends it intact to one decider transaction (`ws.ts` at main, lines 1263-1296); the decider carries force through the thread/project sequence. The V2 split coordinator regresses that invariant.

### Overlay

The frozen overlay does not contain `ws.ts`, `ProjectService.ts`, the legacy decider, or the importer. F04 is unchanged.

## F05: project lifecycle still diverges across transports

### Evidence

The shared `ProjectMutation` contract carries:

- `createWorkspaceRootIfMissing` on create;
- `autoPull`, `projectIcon`, `faviconPath`, and `defaultThreadEnvMode` on update;
- `force` on delete.

See `packages/contracts/src/project.ts` at frozen HEAD, lines 116-145. The WebSocket create and update branches forward these fields (`apps/server/src/ws.ts:1264-1298`) and perform V2 thread validation/deletion for project removal.

The HTTP mutation handler calls `ProjectService` directly and drops all of the fields above except the older title/root/model/scripts set (`apps/server/src/project/http.ts:45-80`). The live CLI delegates to this HTTP endpoint (`cli/project.ts:324-338`). The offline CLI duplicates the same reduced mapping and direct legacy deletion (`cli/project.ts:423-459`).

The last committed reconciliation added `autoPull`, project icon, favicon, and default environment mode to the shared update contract and WebSocket mapping, but did not add them to HTTP or offline CLI. This broadens F05; it is not a separate finding.

### Triggers and consequences

- Delete a V2-only populated project through HTTP. The V1 read model can see no thread, so the legacy project row is deleted while V2 threads remain and reference a deleted project.
- Force-delete an imported populated project through HTTP, live CLI, or offline CLI. Force is dropped, so the legacy decider rejects.
- Send a typed HTTP create with `createWorkspaceRootIfMissing: true`. The service receives the default false behavior.
- Send a typed HTTP update for `autoPull`, project icon, favicon, or default thread environment mode. The request succeeds without applying that field.

The current HTTP tests cover only error translation (`project/http.test.ts:15-51`). The CLI integration covers add, title rename, and empty-project removal (`cli/project.test.ts:116-133`). Neither suite exercises the dropped fields or populated mixed-store deletion.

One lifecycle coordinator should own validation and mutation across V1/V2, with WebSocket, HTTP, live CLI, and offline CLI preserving the same typed input. Tests need imported and V2-only projects, active and archived threads, force false/true, missing-root creation, and every update field.

### Thread lifecycle note

V2 thread mutation commands remain on the WebSocket command path. The V2 HTTP surface reviewed here serves shell, detail, and history reads through `ThreadManagementService`; it does not define a competing HTTP thread-mutation implementation. I found no separate thread archive/unarchive/delete divergence within that intended split. Project deletion is the cross-store exception because it owns thread cleanup.

### Overlay

No project transport or lifecycle source is present in the frozen overlay. F05 remains open locally.

## F13: stale failure still wakes a newer snooze

### Evidence

For a future snooze, V2 defines `wokeOnError` as `thread.status === "failed"` with no time comparison (`orchestration-v2/ThreadSettlementService.ts` at frozen HEAD, lines 108-117). Completion correctly requires `latestRunCompletedAt > snoozedAt` in the next two lines.

Main's V1 policy requires the error session's `updatedAt` to be newer than `snoozedAt` (`orchestration/ThreadSettlementPolicy.ts` at main, lines 98-109). The V2 shell already exposes the latest run completion time needed for an equivalent ordering check.

The audit probe creates a projected failed run completed on August 20, then a snooze beginning September 1 and ending September 10. At September 4, the production V2 policy returns `true`, treating the old failure as an early wake. The frozen overlay's unit test also explicitly expects any failed status to wake a future snooze without a failure timestamp (`ThreadSettlementService.test.ts.snapshot:127-139`).

### Trigger and consequence

Fail a thread, then snooze it into the future. At the next settlement evaluation, the stale failure defeats the newer snooze. If the thread also matches closed-PR or inactivity settlement policy, it can move to settled before the requested wake time.

Require failed-run completion evidence newer than `snoozedAt`. Cover both failure-before-snooze and failure-after-snooze through the projected candidate path.

### Rejected lead

Closed pull requests should continue to settle when the optional day and on-merge settings are off. `pullRequestSettles` accepts `closed` independently and gates only `merged` on `autoSettleOnMerge` (`ThreadSettlementService.ts:80-92`). The frozen overlay preserves this behavior and its test at `ThreadSettlementService.test.ts.snapshot:230-238`. An unconditional early return when both optional settings are off would remove valid closed-PR behavior and is not recommended.

## F14: checkpoint diff hydration is fixed

Commit `8af5734365` changes checkpoint diff to call `getCheckpointContext` (`checkpointing/CheckpointDiffQuery.ts:102-121`). `ProjectionStore.getCheckpointContext` performs three narrow queries for run ID/ordinal/status, scope ID/run/kind/cwd, and checkpoint scope/run/app ordinal/status/ref (`orchestration-v2/ProjectionStore.ts:2957-3002`). It does not read transcript messages, turn items, provider histories, or fork ancestry.

The focused checkpoint diff suite passes 5 tests. This fixes the prior read-cardinality issue. It does not fix F03 because the narrow query faithfully returns the production shared-scope ownership that the zero-baseline logic mishandles.

The frozen ProjectionStore overlay retains the narrow query unchanged.

## F15: startup recovery targeting is fixed

Commit `d98f1d5e38` removes the prior recovery call over every active and archived shell. `ProviderRuntimeRecoveryService` now asks for `getRecoveryThreadIds("runtime")` and full-loads only those candidates (`ProviderRuntimeRecoveryService.ts:482-511`). The candidate SQL selects nonterminal runs, pending runtime requests, nonterminal sessions, provider-owned background work, relevant nonterminal turn items, and pending/running outbox entries (`ProjectionStore.ts:2696-2787`). The focused recovery tests confirm terminal histories are not loaded for runtime reconciliation.

That fixes F15 as previously defined and recommended. It also removes repeated shared-session and fork-history hydration. The frozen overlay does not regress this path.

## Separate startup corruption-verification tradeoff

Startup still blocks command readiness on `projectionMaintenance.verify` (`serverRuntimeStartup.ts:518-553`). Verification calls `getUnreadableThreadIds` (`ProjectionMaintenance.ts:75-119`), which pages through all 16 canonical projection tables, selects each `payload_json`, and schema-decodes every row (`ProjectionStore.ts:2789-2952`). Messages, turn items, provider turns, checkpoints, active threads, archived threads, and terminal history are all included. Paging at 500 bounds peak row memory and each canonical row is decoded once, but total startup work remains O(all retained V2 projection rows).

This is not the old F15 recovery behavior. It is an intentional safety check that detects corrupt canonical rows and propagates unreadability through fork ancestry before accepting commands. I did not benchmark its latency or memory impact, so it is not reported as a defect. Benchmark representative large databases before deciding whether the readiness cost is acceptable. Any optimization must preserve equivalent corruption detection, for example through validated incremental metadata or another complete verification strategy; simply removing or narrowing the scan would weaken recovery safety.

The frozen overlay improves periodic settlement separately by adding `getSettlementCandidates` and narrow `getThread` reads. Migration 059 supplies the relevant indexes. It does not change startup verification.

## PERSIST-N01: the scheduler ignores its due-task index every five seconds

Priority: P2 performance.

### Evidence

`ScheduledTaskService.selectAllRows` selects every column of every scheduled task and orders the complete table by update time (`scheduledTasks/ScheduledTaskService.ts` at frozen HEAD, lines 175-199). `listTasksLenient` decodes every row's schedule, workspace strategy, and model selection (`:207-224`). `runDueTasks` calls that full-list path and only then filters enabled, due, and non-running tasks in memory (`:583-609`). The loop repeats every five seconds (`:665-669`).

Migration 055 already creates `idx_scheduled_tasks_due(enabled, next_run_at)` with a partial predicate for enabled tasks having a next run (`persistence/Migrations/055_ScheduledTasks.ts:32-36`). The polling query has no `WHERE` clause, so it cannot use that index to bound candidates by `next_run_at`.

### Trigger and consequence

Accumulate many disabled tasks or enabled tasks scheduled far in the future. Even when nothing is due, the server reads, allocates, JSON-decodes, and sorts every row every five seconds. Cost is O(all scheduled tasks) per poll instead of O(due tasks), creating steady database and CPU load.

This scheduler is branch-only at the compared main commit, so the issue is not main lag. It is a scaling defect in the added durable scheduling core. Query due rows directly with `enabled = 1`, non-null `next_run_at`, `next_run_at <= now`, and non-running status. Crash recovery can keep its separate one-time running-row query. Add a behavior/cardinality test that seeds many future/disabled rows and proves the poll decodes only due rows.

## M10 late arrival: metadata and provider-control paths still hydrate history

Priority: P2 performance and failure isolation. Status: missing at frozen committed HEAD. The frozen overlay adds useful groundwork but does not address the affected paths.

Late main commit `6365919f2e5bcfb4fa4020b95e19af26ae40979f`, [#9758](https://github.com/pingdotgg/t3code/pull/9758), splits `ProviderCommandReactor` reads into thread shell and thread detail. Main now uses shell reads for session state, compaction guards, post-generation title checks, interrupt and recovery, approval and user-input forwarding, session stop, and runtime-mode propagation (`ProviderCommandReactor.ts` at that commit, lines 528-538, 572-608, 984-995, 1375-1385, 1442-1640, and 1700-1715). It keeps detail reads for the two operations that consume transcript data: title regeneration and turn start (`:1008-1058` and `:1178-1201`). Three changed behavior tests put invalid JSON in an old message and prove approval response, user-input response, and session stop no longer decode that unrelated body (`ProviderCommandReactor.test.ts` at that commit, lines 517-530, 3556-3595, 3597-3640, and 3846-3886).

V2 distributes the same responsibilities across services, so copying the V1 reactor would be the wrong fix. The actual paths are:

| Behavior                          | V2 committed path                                                                                                                                                                                                                                                                                                                                                                                                           | Assessment                                                                                                                                                                                                                          |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Worktree and branch naming        | `ThreadLaunchService.ts:194-213` generates from the supplied initial message without reading history.                                                                                                                                                                                                                                                                                                                       | Generation is already superseded by the V2 design. The workspace and rename results still dispatch `thread.metadata.update` through the full projection path at `:287-319`.                                                         |
| Initial title generation          | `ThreadTitleRegenerationService.ts:184-228` loads the whole projection to locate one initial message, then dispatches completion at `:169-182` and `:247-253`.                                                                                                                                                                                                                                                              | Missing. Initial generation needs one message and thread metadata, not the full transcript.                                                                                                                                         |
| Explicit title regeneration       | The same service formats the transcript at `:190-228`.                                                                                                                                                                                                                                                                                                                                                                      | Full history is intentional here, matching main's retained detail read. Only the stale guard and completion write should be narrow.                                                                                                 |
| Metadata and mode mutations       | `Orchestrator.ts:1389-1425` routes `thread.metadata.update`, `thread.title.regeneration.complete`, and runtime/interaction mode changes through `getThreadProjection`. Their reducers use thread payload fields at `:1694-1721`; workspace and runtime-mode changes also inspect provider sessions to plan detaches at `:1884-1900`. `ThreadLifecycleService.ts:80-87` then reads the full projection again for its result. | Missing transcript isolation, but not every case is app-thread-only. Title completion and interaction mode need only the thread. Workspace changes and runtime mode need a narrow thread-plus-session context. None needs messages. |
| Approval and user-input responses | `RuntimeRequestService.ts:76-125` loads the full projection to locate one runtime request before calling the live session.                                                                                                                                                                                                                                                                                                  | Missing, but a narrow runtime-request lookup is required. The app-thread-only `getThread` read cannot replace this safely.                                                                                                          |
| Interrupt and restart             | `ProviderTurnControlService.ts:80-162` loads the full projection to validate one provider thread and turn; restart polls the full projection again at `:211-231`.                                                                                                                                                                                                                                                           | Missing. This needs a narrow provider execution context, not a V1 shell port or an app-thread-only read.                                                                                                                            |
| Session stop and detach           | `Orchestrator.ts:2003-2053` loads the full projection to validate one provider session. `ProviderSessionManager.ts:1566-1605` loads it again when a multi-thread-capable runtime must interrupt attached active turns.                                                                                                                                                                                                      | Missing transcript isolation. Preserve the exact session and active-turn checks in a narrow context.                                                                                                                                |
| Provider turn start               | `ProviderTurnStartService.ts:91-125` reads runs, nodes, attempts, messages, checkpoint scopes, handoffs, and provider state.                                                                                                                                                                                                                                                                                                | No gap. Main also keeps detail for turn start.                                                                                                                                                                                      |

The committed generic mutation handler creates a concrete failure boundary. `getThreadProjection` selects every message payload for an unwindowed read (`ProjectionStore.ts:2398-2402`) and schema-decodes all of them (`:2515-2531`). A long thread therefore pays O(retained history) to rename a branch, update a title, complete title regeneration, or change runtime mode. One malformed old message also rejects the metadata command before it can emit its event. This is the same isolation problem that the new main tests cover, expressed through V2's projection tables.

The dirty overlay is not a local-only fix for M10. `ProjectionStore.ts.snapshot:173-175` and `:3003-3019` add `getThread`, which selects and decodes only the app-thread payload. `Orchestrator.ts.snapshot:1389-1430` uses it for `thread.visit`, and `:6944-6975` uses it for the auto-settlement guard. However, `thread.metadata.update`, `thread.title.regeneration.complete`, and mode mutations remain in `dispatchThreadMutation`, whose first operation is still `getThreadProjection` (`Orchestrator.ts.snapshot:1432-1468` and `:6988-6995`). Runtime requests and provider-turn control are unchanged in the frozen overlay.

The smallest V2-shaped fix is command-specific. Route title-only metadata, title completion, and interaction-mode mutations through the overlay's `getThread`. Give workspace metadata and runtime-mode mutations a narrow context containing the app thread plus the provider-session fields their detach logic uses. Initial title generation can use a narrow message lookup plus app-thread metadata. Runtime-request response, session detach, and provider-turn control need narrow queries keyed by their existing IDs. Keep full or purpose-built context reads for explicit title regeneration and turn start. Regression coverage should corrupt an unrelated historical message and prove metadata update, title completion, runtime-request response, interrupt, and session stop remain usable without weakening stale-request, detach, or target-identity checks.

## Feature parity matrix

| Area                                                                                         | Main or intended behavior                                               | Frozen committed branch                                              | Frozen overlay                                                              | Assessment                                                   |
| -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Fresh/main migration                                                                         | Main 047 advances into V2 048                                           | Works                                                                | 058 to 059 probe passes                                                     | Parity for fresh/current-main histories                      |
| Historical V2 upgrade                                                                        | Supported old branch state should start                                 | 052/053/055 cohorts fail                                             | Still fail below 059                                                        | F01 open                                                     |
| Legacy shell import                                                                          | Import metadata cheaply and hydrate transcript on demand                | Preserved and idempotent                                             | Unchanged                                                                   | Pass                                                         |
| Projection recovery targeting                                                                | Load only unfinished/recoverable threads                                | Candidate SQL after `d98f1d5e38`                                     | Unchanged                                                                   | Pass                                                         |
| Projection startup validation                                                                | Detect corrupt projection rows before readiness                         | Paged decode of every canonical row                                  | Unchanged                                                                   | Unmeasured safety/performance tradeoff; benchmark and decide |
| Outbox recovery                                                                              | Requeue durable work, retire process-bound work, drain before readiness | Preserved; focused recovery tests pass                               | Unchanged                                                                   | Pass within tested cases                                     |
| Checkpoint diff read model                                                                   | Narrow metadata lookup                                                  | Three narrow queries                                                 | Preserved                                                                   | F14 fixed                                                    |
| Full diff after run 2                                                                        | Resolve the real baseline for shared scope                              | Requires run-1-owned scope                                           | Unchanged                                                                   | F03 open                                                     |
| Checkpoint rollback                                                                          | Validate state and restore through typed service                        | Focused rollback tests pass                                          | Unchanged                                                                   | Pass within tested cases                                     |
| WS project create/update                                                                     | Preserve typed fields                                                   | Preserves current fields                                             | Unchanged                                                                   | Pass                                                         |
| WS forced project delete                                                                     | Validate and delete without partial commit                              | Split V2 deletes then force-less V1 delete                           | Unchanged                                                                   | F04 open                                                     |
| HTTP project mutation                                                                        | Same semantics as WS                                                    | Drops fields and V2 cleanup                                          | Unchanged                                                                   | F05 open                                                     |
| Live CLI project mutation                                                                    | Same as typed server lifecycle                                          | Inherits HTTP divergence                                             | Unchanged                                                                   | F05 open                                                     |
| Offline CLI project mutation                                                                 | Same lifecycle without server                                           | Direct reduced `ProjectService` mapping                              | Unchanged                                                                   | F05 open                                                     |
| V2 HTTP thread reads                                                                         | Bounded shell/detail/history reads                                      | Uses V2 projection services                                          | Overlay narrows visit/settlement metadata                                   | Pass in scope                                                |
| Metadata/provider command reads after [#9758](https://github.com/pingdotgg/t3code/pull/9758) | Shell or narrow context unless transcript is consumed                   | Generic metadata mutations and provider control hydrate full history | `getThread` exists but is used only for visit and the auto-settlement guard | M10 missing; overlay is partial groundwork                   |
| Snooze ordering                                                                              | Only later failure/completion wakes early                               | Completion ordered, failure unordered                                | Still unordered                                                             | F13 open                                                     |
| Closed-PR settlement                                                                         | Closed PR settles independently of optional flags                       | Preserved                                                            | Preserved                                                                   | Pass; false positive rejected                                |
| Settlement query cost                                                                        | Avoid full shell/history reads per sweep                                | Full shell snapshot at committed HEAD                                | Narrow candidate and metadata reads                                         | Local-only improvement                                       |
| Durable schedule calculation                                                                 | Fixed-time/interval semantics and missed-run handling                   | Focused tests pass                                                   | Unchanged                                                                   | Pass                                                         |
| Durable schedule polling                                                                     | Query only due work                                                     | Full table decode every 5 seconds                                    | Unchanged                                                                   | PERSIST-N01                                                  |
| Git/VCS status used by settlement                                                            | Local status should not pay unnecessary divergence walks                | Full local status at committed HEAD                                  | `--no-ahead-behind`; remote status retains divergence/PR lookup             | Local-only improvement; no correctness regression found      |

## Frozen overlay review

I inspected the requested files separately from committed evidence:

- `Orchestrator.ts.snapshot` moves visits and auto-settlement guards to the new narrow thread metadata read. It preserves forward-only `lastVisitedAt`, deletion checks, and the settlement snapshot guard.
- `ProjectionStore.ts.snapshot` adds narrow thread and settlement candidate queries. Its SQL excludes archived, deleted, overridden, pinned, active-run, and pending-request rows before loading candidate background data. The paired SQL/memory parity test passes. F13 remains because failed ordering is policy logic after the query.
- `ThreadSettlementService.ts.snapshot` consumes the candidate query instead of the full shell snapshot. Closed-PR behavior remains correct.
- `Migrations.ts.snapshot` and `059_OrchestrationV2ShellIndexes.ts.snapshot` add indexes used by the settlement candidate path. The committed-058 to local-059 upgrade probe passes.
- `GitManager.ts.snapshot`, `GitVcsDriver.ts.snapshot`, and `GitVcsDriverCore.ts.snapshot` let local-only status skip ahead/behind revision walks. Remote status still computes upstream divergence and PR association. The review/action path still requests full status. I found no lifecycle or settlement correctness regression from this change.
- `server.ts.snapshot` supplies `ProjectionStoreV2.layer` to the application layer required by the new settlement dependency.
- The new `getThread` primitive is suitable for M10's title-only, title-completion, and other app-thread-only handlers, but the overlay has not routed them through it. It cannot replace workspace/runtime-mode, provider-session, provider-turn, or runtime-request lookups because those need child records.

The overlay's `ProjectionSettlement.test.ts.snapshot` is substantive behavior coverage. It compares SQL and memory candidates, tests background work parity, corrupt historical payload isolation, and query-plan index use. The live version passed. It does not test failure-before-snooze, and the existing settlement unit test currently encodes the opposite behavior.

## Focused validation

No repository-wide check was run. Unique product coverage was 10 files and 52 tests, all passing:

- checkpoint diff, checkpoint rollback, legacy import;
- projection recovery and provider runtime recovery;
- schedule calculation;
- project HTTP error mapping and CLI empty-project lifecycle;
- live dirty-overlay settlement policy and SQL/memory projection settlement.

The audit-only probe has exactly 6 passing cases:

| Probe name                                                             | Result                                                                              |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `upgrades committed-058 state through the live-059 overlay`            | Passed                                                                              |
| `reproduces the old-052 cohort collision against the current migrator` | Passed; asserted the expected current-053 migration failure and rollback            |
| `reproduces the old-055 cohort collision and skipped main columns`     | Passed; asserted the expected current-056 migration failure and absent main columns |
| `reproduces the prior-audit old-053 cohort collision`                  | Passed; asserted the expected current-056 migration failure and rollback            |
| `reproduces root checkpoint-scope reuse across ordinary runs`          | Passed; one shared scope remained owned by run 2                                    |
| `reproduces a stale failed run waking a later snooze`                  | Passed; production policy returned `true` for the reproduced stale-failure state    |

Exact totals for consolidation: 10 unique product test files with 52 tests passed, plus 1 audit-only probe file with 6 tests passed. Combined, 11 unique test files and 58 tests passed. Repeated authoring/rerun invocations are not counted as additional coverage.

The exact commands and results are in `persistence-tests.log`. The probe is `persistence-audit-probes.test.ts`. It uses in-memory SQLite and actual implementations. No live T3 userdata was opened.

The earlier copied-test import failure reported by root was caused by unsuffixed audit snapshots entering Vitest discovery. All frozen overlay copies now end in `.snapshot`; none was discovered in these runs. It is not a product regression.

## Limitations

- I did not launch a server, provider, browser, simulator, or live/offline CLI process. The project lifecycle findings are deterministic handler/service/decider traces; integrated disposable transport tests remain necessary with a fix.
- I did not benchmark startup verification or scheduler polling. Startup verification is recorded only as a safety/performance tradeoff; PERSIST-N01 is based on explicit polling SQL and loop cardinality, not measured latency or memory.
- M10 is a source-only review of late main commit `6365919f2e5bcfb4fa4020b95e19af26ae40979f` and its direct V2 equivalents. I ran no additional tests for this addendum.
- Migration probes cover three known complete historical manifests. Other partial stopping points still need a table-driven compatibility matrix.
- I did not modify existing tests. Current green tests do not contradict F03, F04, F05, or F13 because their fixtures omit the production trigger or encode the faulty behavior.
- Provider adapter protocol behavior, auth/relay, title retry, PR metadata, WebSocket fallback F16, and the separately reviewed archived-thread scheduler/MCP lead are outside this report.
