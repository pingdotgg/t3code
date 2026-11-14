# conn-engine

The Conn Server's orchestration: the SQLite event store, projections, the shell and thread
streams, the turn runner, and the [`Engine`](src/lib.rs) trait the method table calls. The
workspace README describes the trait's first methods and the wire.

## Engine API beyond dispatch and the streams

| Item                                          | For                                                                 |
| --------------------------------------------- | ------------------------------------------------------------------- |
| `Engine::methods`, `call`, `open_stream`      | Other unary and stream methods, by RPC tag, with contract JSON      |
| `EngineConfig::home`                          | `scratch/` and `projects/` folders; defaults to the database folder |
| `EngineConfig::idle_session`                  | Closes a provider session after 10 idle minutes (its process too)   |
| `TitleGenerator`, `TitleRequest`, `TitleKind` | `generateTitle` and `regenerateTitle` through a small model         |
| `TurnObserver`, `TurnPoint`                   | Turn start and end (`/mcp` touch, VCS refresh)                      |
| `EngineConfig::checkpoints`                   | Git checkpoints per turn, diffs, rollback (`src/checkpoint.rs`)     |
| `EngineConfig::clock` (`Clock`, `SystemClock`, `ManualClock`) | Every stored timestamp and the idle release; a replay runs on a `ManualClock` at the epoch, as T3's `TestClock` |
| `SqliteEngine::release_idle_sessions`         | The idle check now, for a moved `ManualClock`                       |
| `SqliteEngine::stored_events`                 | The whole event log, paged (`OrchestrationV2StoredEvent` rows); never pruned |
| `EngineConfig::runtime_policy_override`       | Laid over every turn's policy (`RuntimePolicy.layerWithOverride`); the replay sets the fixture's |
| `EngineConfig::command_output_tap`            | Sees every live command output chunk (T3's `CommandOutputRecorder`) |

`calls.rs` lists the tags `call` and `open_stream` serve. The server registers them with their
contract types (`methods/orchestration.rs`, `methods/projects.rs`), so a result that does not
decode is a defect, not a broken client.

## dispatchCommand

43 of the 56 command types are handled. The other 13 answer `OrchestrationV2DispatchCommandError`
with a reason the client shows (`commands::refusal`).

| Handled                                                                                                                                                             | Refused, and why                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `thread.create`, `message.dispatch` (all five dispatch modes), `run.interrupt` (`holdQueue`), `thread.stop`, `runtime-request.respond`, `thread.user-input.dismiss` | `thread.merge_back`: no portable context handoff                                             |
| `queued-run.start`, `.cancel`, `.reorder`, `.edit`, `queue.resume`, `queued-message.promote-to-steer`                                                               | (none)                                                                                       |
| `thread.archive`, `unarchive`, `delete`, `visit`, `mark-unread`, `metadata.update` (`regenerateTitle`), `title.regeneration.complete`                               | `prepared-run.release`, `.progress`, `.fail`, `.retry`: no worktree preparation              |
| `thread.settle`, `auto-settle`, `unsettle`, `snooze`, `unsnooze`, `auto-settle.set`, `pin`, `unpin`, `pin.reorder`, `active.reorder`, `tag.set`                     | `thread.pull-request-link.sync`, `.pull-request.watch`, `.pull-request.sync`: no PR watching |
| `thread.pull-request.link`, `.unlink`                                                                                                                               | `thread.guest-share.close`, `thread.guest-message.dismiss`: no guest sharing                 |
| `thread.runtime-mode.set`, `interaction-mode.set`, `model-selection.set`, `provider.switch`, `provider-session.detach`                                              | `notification.delivery.accept`, `subagent.stop`, `thread.created.record`                     |
| `delegated_task.request`, `.wake-policy`, `.completion-delivery.acknowledge`, `.dispose`, `checkpoint.rollback`, `thread.fork`                                                                            |                                                                                              |

## The refused commands: a map

The T3 sources are under `apps/server/src/orchestration-v2/` unless a path says otherwise.
"Here" says which work item takes the command; "other" means another work item owns it.

| Command | T3 source | What it does | Needs | Here |
| --- | --- | --- | --- | --- |
| `checkpoint.rollback` | `Orchestrator.ts` `dispatchCheckpointRollback`, `CheckpointRollbackService.ts`, `CheckpointRestoreSafety.ts` | Puts the workspace back to a checkpoint, marks later runs `rolled_back`, rolls the provider's native thread back | checkpoints, `Session::rollback_thread`, `conn-vcs` restore | yes |
| `thread.fork` | `ThreadForkService.ts`, `Orchestrator.ts` `dispatchThreadFork` | A new thread from a run of another, with a `fork` context transfer and the provider's native fork | `Session::fork_thread`, `ContextHandoffService.ts` | yes |
| `thread.merge_back` | `Orchestrator.ts` `dispatchThreadMergeBack`, `ContextHandoffService.ts` | Records a pending `merge_back` context transfer from a fork to its parent; the parent's next message carries the fork's delta | fork, context transfers (no checkpoint) | yes |
| `prepared-run.release`, `.progress`, `.fail`, `.retry` | `ThreadLaunchService.ts`, `Orchestrator.ts` `dispatchPreparedRun*`, `ProjectSetupScriptRunner.ts` | A worktree launch's `preparing` run: progress, failure, retry, release to the provider; setup scripts typed into a `setup-<id>` terminal | `conn-terminal` prompt and marker watch, `conn-vcs` worktree | yes |
| `thread.pull-request-link.sync`, `thread.pull-request.watch`, `thread.pull-request.sync` | `ThreadPullRequestService.ts`, `PullRequestWatchReactor.ts` | Pull request links and watches | the forge CLIs | other |
| `thread.guest-share.close`, `thread.guest-message.dismiss` | `GuestShareDecider.ts` | Guest sharing | guest share | other |
| `notification.delivery.accept` | `Orchestrator.ts` `dispatchNotificationAccepted`, `NotificationMailbox.ts` | Marks a background notification delivered to a run | a notification mailbox (not built) | later |
| `subagent.stop` | `Orchestrator.ts` `dispatchSubagentStop` | Stops one subagent of a run | `Session::stop_task` in the providers (in the trait, not built) | later |
| `thread.created.record` | `Orchestrator.ts` `dispatchCreatedThreadRecord` | Records a thread made in a linked environment | linked environments | later |

`orchestration.getTurnDiff` and `orchestration.getFullThreadDiff` were the two unserved
`orchestration.*` methods (`checkpointing/CheckpointDiffQuery.ts`); both are served now, so
all 23 are.

## Behaviour worth knowing

- **Checkpoints** (`src/checkpoint.rs`, on with `EngineConfig::checkpoints`). A thread has one
  root scope in its run's folder. Before the provider gets a message the workspace is captured
  as the baseline (ordinal `run - 1`, 5 s budget). A provider turn that completes leaves the
  run `waiting`; the capture records the run's checkpoint with its changed files (capped at
  200 with `filesTotal`, as T3's wire), a `checkpoint` turn item, and completes the run; the
  parent's wake and the next queued run follow it. Interrupted and cancelled runs are captured
  too. No git repository: `missing` checkpoints. A restart captures a run left `waiting`.
  `getTurnDiff` counts completed runs with a ready checkpoint and cuts the patch at 10 MB with
  T3's marker.
- **Rollback** (`src/rollback.rs`). `checkpoint.rollback` checks the target as T3 does and
  sets `rollbackRequestId`; a file restore needs the thread's own worktree
  (`isCheckpointRestoreIsolated`), else only `restoreFiles: false` (a conversation rewind) is
  accepted. The effect rolls the provider thread back (only when later runs exist), restores
  the files, deletes the stale refs, then commits the provider thread, the `stale`
  checkpoints and the `rolled_back` runs and nodes at once. A failure commits none of that and
  sets `rollbackFailure` with T3's client message. T3 retries the effect up to 5 times; this
  server tries once.
- **Fork** (`src/fork.rs`). `thread.fork` makes the fork thread and a pending `fork` transfer
  (`ThreadForkService.plan`). Its first turn forks the source's native thread from the source
  run's turn (`Session::fork_thread`) and consumes the transfer (`native_fork`). T3's portable
  path (a `full_thread_summary` handoff when the fork cannot be native, or after a failed
  native fork) is not built: such a message is refused, and a failed native fork fails the
  turn.

- **Visible items** (`src/visibility.rs`). `visibleTurnItems` follows T3's timeline rule
  (`createOrchestrationV2TurnItemVisibility`): a rolled-back run's items, a queued message
  until its run starts, and an unpaired interrupt result of a superseded attempt are hidden.
  A compact snapshot omits the local rows only when they are the first turn items.
- **Fresh context** (`src/fresh.rs`). A `message.dispatch` with `freshContext` never steers
  (steer and restart queue), is refused while a fork is pending or while the session holds
  background work (unless a schedule sent it), releases the live session and starts a new
  provider thread. A schedule's fresh run is a side conversation: the next plain message
  continues the thread's own provider thread (`conversationProviderThread`).
- **Provider thread at turn start.** The engine writes `firstRunOrdinal` and `lastRunOrdinal`
  and hands that row to the provider (T3's `runningProviderThread`). T3 also marks it
  `active`; our Codex provider sends no thread updates to mark it `idle` again, so the status
  stays the provider's.
- **Session release.** A closed session (idle, provider switch, fresh start) writes its row as
  `stopped` and expires the requests only it could answer (`writeReleasedSessionEvents`).
- **Rollback order.** A turn start waits while a rollback of its thread is in flight, as T3's
  effect outbox runs them in order.
- **Busy thread.** While a run is active, a message queues (`queue_after_active`, or any start)
  or steers (`steer_active`, or the client's `deliveryIntent` steer). A steer before the
  provider turn runs waits as a queued run with `steerWhenReadyRunId`; a steer the provider
  declines goes first in the queue. Stop and failures hold the queue until a user send,
  `queue.resume` or `queued-run.start`.
- **Delegated tasks.** Ids come from the command id: task `node:delegated-task:<commandId>`,
  child `thread:delegated-task:<commandId>`, so a tool knows them after `dispatch` returns.
  The parent wakes with a queued agent message at once (`completionWake: always`) or after its
  own run ends (`settled_only`). Stop reaches running children.
- **Restart.** A run the provider had ends `cancelled` with a "Server restarted" notice and a
  continuation message runs in the same provider thread (`restart.rs`; at most 3 in a row
  within 5 minutes). A run the provider never took starts again.
- **Retention.** `shell_changes` keeps 1,024 rows and `receipts` 4,096; an older shell cursor
  gets a fresh snapshot. Events and projections are the history and stay.
- **Search.** `searchThreads` reads a trigram FTS5 index of final message texts
  (`message_search`) with `MATCH` and quoted words, as `ThreadSearch.ts`; SQLite's bundled
  build already has FTS5. Every word of three characters or more must match; shorter words
  only narrow, and a query without a long word searches no messages (two CJK characters count
  as long). Hidden threads drop out in SQL before the limit. Titles are the client's to match.
- **Background work.** A run that completes leaves its open command, dynamic tool and
  subagent rows running, as T3 does. The shell row's `pendingBackgroundTasks` is
  `derivePendingBackgroundWork` (`src/background.rs`): provider thread rosters, then those
  rows, then pull request watches; `/mcp` reads it for its thread list and the live-caller
  rule. `background_work.updated` (not persisted) holds an idle session like the provider's
  own probe, at most 64 provider turns tracked. `client-check.mjs` compares the roster with
  T3's own function.
- **Stop.** `thread.stop` and `run.interrupt` record a `run_interrupt_request` item on the
  active run (`markStoppedRun`, message "Stopped by user" or the command's reason); a run that
  ends interrupted gets a `run_interrupt_result` (`makeInterruptResultTurnItem`). When the
  provider answers Stop with `InterruptTimeout`, the run stays open and the request gets
  `unresponsiveAt` (`thread.interrupt.unresponsive`): clients offer Force stop, whose result
  says "Force stopped by user".
- **Model change during a turn.** A `thread.model-selection.set` on the thread's instance
  goes to the running provider turn's session (`provider-session.apply-model-selection`,
  `ProviderTurnControlService.applyModelSelection`); the provider applies what it can live.
  Without a running provider turn only the thread changes. Codex has no live change (as T3).
- **Selection plan.** A model change on the thread's instance asks that provider's
  `plan_selection_transition` with the live session's capabilities (`ProviderSwitchService`):
  `reject` refuses the command; `restart_session` releases the session between turns and is
  refused during a run; `create_with_handoff` is refused (no handoff here). Without a session
  row the change applies at the next turn. Claude and Codex answer `apply_on_next_turn`.
- **Session row.** `open_session` returns the provider session; the engine stores it before
  any event. A session whose background tasks end with its process (Claude) clears its
  provider threads' rosters when it is released.
- **Provider switch.** A `thread.model-selection.set` to another instance is a provider switch
  (refused while a run is active). A run on another instance than the live session closes it
  and opens one on its own instance; a provider thread of another instance is never resumed.
- **Live command output.** `command_output.delta` (Codex) feeds a bounded hub in `output.rs`:
  at most 8 running commands, a 64 KiB tail each, dropped when the command settles.

## Memory

`examples/memory_load.rs` runs fake turns and prints RSS and live heap (`stats_alloc`, dev only):

```sh
cargo run --release -p conn-engine --features fake-provider --example memory_load -- 1000 1
```

The live Rust heap is flat under load (one thread, 1,000 turns: 0.33-0.39 MiB from turn 100).
A thread snapshot is built in memory whole: about 13 heap bytes per byte of its JSON at the
peak, so a 4.6 MB thread (1,000 turns) peaks near 60 MiB, and the macOS allocator keeps those
pages in RSS afterwards. Clients that opt in to compact snapshots get each turn item once.

Next step: bounded thread snapshots (`acceptBoundedSnapshot`). The engine would send the newest
window of rows with a `historyCursor`, and serve older pages through
`GET /api/orchestration/threads/:id/history` (`OrchestrationV2ThreadHistoryPage`), as
`threadHistoryPaging.ts` does (75 items or 10 user turns per page). That needs the route in the
server crate and an `Engine` method for a page.

## Checks

- `cargo test -p conn-engine`: commands, streams, restart, families, reads, titles, observer.
- `tools/t3-fixture-replay/check.mjs`: T3's own testkit fixtures through this engine and the
  Claude and Codex providers on stand-ins, judged by T3's own assertions (the vitest file is
  placed in the monorepo for the run and removed; only the scenario runner is mocked). 33 of
  159 variants pass; `expected-failures.txt` lists the rest by cause. The Rust half is
  `examples/t3_fixture_replay.rs`. About 3 minutes; `--only <fixture>/<driver>` runs one,
  `--keep` keeps the work folder (each fixture's plan, stub log, database and result).
- `tools/client-check.mjs`: the client's own decoders and reducers over
  `examples/export_turn.rs` output. Needs the Conn monorepo in `CONN_MONOREPO`. From the
  repository root:

  ```sh
  cargo run -p conn-engine --features fake-provider --example export_turn -- /tmp/x.json
  CONN_MONOREPO=/path/to/conn node crates/conn-engine/tools/client-check.mjs /tmp/x.json
  ```
