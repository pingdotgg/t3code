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
| `TitleGenerator`, `TitleRequest`, `TitleKind`, `TitleMessage` | `generateTitle` and `regenerateTitle`; the server wires `text_generation::title::Titles` |
| `TurnObserver`, `TurnPoint`                   | Turn start and end (`/mcp` touch, VCS refresh)                      |
| `EngineConfig::checkpoints`                   | Git checkpoints per turn, diffs, rollback (`src/checkpoint.rs`)     |
| `EngineConfig::clock` (`Clock`, `SystemClock`, `ManualClock`) | Every stored timestamp and the idle release; a replay runs on a `ManualClock` at the epoch, as T3's `TestClock` |
| `SqliteEngine::release_idle_sessions`         | The idle check now, for a moved `ManualClock`                       |
| `SqliteEngine::stored_events`                 | The whole event log, paged (`OrchestrationV2StoredEvent` rows); never pruned |
| `EngineConfig::runtime_policy_override`       | Laid over every turn's policy (`RuntimePolicy.layerWithOverride`); the replay sets the fixture's |
| `EngineConfig::command_output_tap`            | Sees every live command output chunk (T3's `CommandOutputRecorder`) |
| `Engine::await_background_tasks`, `BackgroundWait`, `BackgroundWaitError` | `awaitBackgroundTasks` (`src/background_wait.rs`): the live session of the thread's active provider thread marks or clears background task ids (15 s limit); `/mcp`'s `conn_background_wait` |
| `Engine::thread_transcript`, `ThreadTranscript` | `GET /api/orchestration/threads/:id/transcript` (`src/transcript.rs`): reads visible turn items one at a time on the store thread (indexes `turn_items_in_order`, `turn_item_interrupts`), writes the JSON body as it goes, and stops at the first row past the file limit; a run fork starts with its inherited rows and the fork marker; the thread projection's `visibleTurnItems` uses the same reader (`RowSink`) |
| `EngineHost::response_streaming_mode`, `ResponseStreamingMode` | The project's `responseStreamingMode` (`paragraph` by default, or `turn`), read at each turn start |

`Engine::record_secret_request` is an internal entry point for secret card status changes.
It commits `turn-item.updated` events without storing the value. Pending cards appear as
user-only input in the shell and close when their run ends. A restart closes the card and
does not resume a run waiting on it. Client dispatch cannot send this internal command.

`calls.rs` lists the tags `call` and `open_stream` serve. The server registers them with their
contract types (`methods/orchestration.rs`, `methods/projects.rs`), so a result that does not
decode is a defect, not a broken client.

## dispatchCommand

50 of the 58 command types are handled. The other 8 answer `OrchestrationV2DispatchCommandError`
with a reason the client shows (`commands::refusal`).

| Handled                                                                                                                                                             | Refused, and why                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `thread.create`, `message.dispatch` (all five dispatch modes), `run.interrupt` (`holdQueue`), `thread.stop`, `runtime-request.respond`, `thread.user-input.dismiss` | (none) |
| `queued-run.start`, `.cancel`, `.reorder`, `.edit`, `queue.resume`, `queued-message.promote-to-steer`                                                               | (none)                                                                                       |
| `thread.archive`, `unarchive`, `delete`, `visit`, `mark-unread`, `metadata.update` (`regenerateTitle`), `title.regeneration.complete`                               | `prepared-run.release`, `.progress`, `.fail`, `.retry`: no worktree preparation              |
| `thread.settle`, `auto-settle`, `unsettle`, `snooze`, `unsnooze`, `auto-settle.set`, `pin`, `unpin`, `pin.reorder`, `active.reorder`, `tag.set`                     | (none)                                                                                       |
| `thread.pull-request.link`, `.unlink`, `.watch`, `thread.pull-request-link.sync`, `thread.pull-request.sync` (and the server-only `thread.pull-request-watch.sync` and `.checks-reopen`)                                                               | `thread.guest-share.close`, `thread.guest-message.dismiss`: no guest sharing                 |
| `thread.runtime-mode.set`, `interaction-mode.set`, `model-selection.set`, `provider.switch`, `provider-session.detach`                                              | `notification.delivery.accept`, `subagent.stop`                     |
| `delegated_task.request`, `.wake-policy`, `.completion-delivery.acknowledge`, `.dispose`, `checkpoint.rollback`, `thread.fork`, `thread.created.record` |                                                                                              |

## The refused commands: a map

The T3 sources are under `apps/server/src/orchestration-v2/` unless a path says otherwise.
"Here" says which work item takes the command; "other" means another work item owns it.

| Command | T3 source | What it does | Needs | Here |
| --- | --- | --- | --- | --- |
| `checkpoint.rollback` | `Orchestrator.ts` `dispatchCheckpointRollback`, `CheckpointRollbackService.ts`, `CheckpointRestoreSafety.ts` | Puts the workspace back to a checkpoint, marks later runs `rolled_back`, rolls the provider's native thread back | checkpoints, `Session::rollback_thread`, `conn-vcs` restore | yes |
| `thread.fork` | `ThreadForkService.ts`, `Orchestrator.ts` `dispatchThreadFork` | A new thread from a run of another, with a `fork` context transfer and the provider's native fork | `Session::fork_thread`, `ContextHandoffService.ts` | yes |
| `thread.merge_back` | `Orchestrator.ts` `dispatchThreadMergeBack`, `ContextHandoffService.ts`, `ContextHandoffDelivery.ts` | Records a pending `merge_back` context transfer from a fork to its parent; the parent's next message carries the fork's delta as a `fork_delta_summary` handoff (`merge_back.rs`, `handoff.rs`), injected (Codex) or inline | fork, context transfers, `Session::inject_history` | yes |
| `prepared-run.release`, `.progress`, `.fail`, `.retry` | `ThreadLaunchService.ts`, `Orchestrator.ts` `dispatchPreparedRun*`, `ProjectSetupScriptRunner.ts` | A worktree launch's `preparing` run: progress, failure, retry, release to the provider; setup scripts typed into a `setup-<id>` terminal | `conn-terminal` prompt and marker watch, `conn-vcs` worktree | yes |
| `thread.guest-share.close`, `thread.guest-message.dismiss` | `GuestShareDecider.ts` | Guest sharing | guest share | other |
| `notification.delivery.accept` | `Orchestrator.ts` `dispatchNotificationAccepted`, `NotificationMailbox.ts` | Marks a background notification delivered to a run | a notification mailbox (not built) | later |
| `subagent.stop` | `Orchestrator.ts` `dispatchSubagentStop` | Stops one subagent of a run | `Session::stop_task` in the providers (in the trait, not built) | later |

`orchestration.getTurnDiff` and `orchestration.getFullThreadDiff` were the two unserved
`orchestration.*` methods (`checkpointing/CheckpointDiffQuery.ts`); both are served now.

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
  sets `rollbackFailure` with T3's client message, after T3's retries: up to 5 attempts, 100 ms
  after the first failure and doubling, at most 30 s (`EffectWorker`). **Deliberate difference
  from T3:** a retry repeats only the step that failed, so the provider rollback is sent once
  per request, and the live session moves to the rolled-back thread only after the commit. T3
  repeats the provider rollback on every retry, which cuts a Codex thread again each time
  (`docs/status.md`, "Faults found in the T3 server"). Test:
  `a_failing_restore_rolls_the_provider_back_once`.
  An admitted rollback's outbox row keeps its phase in `progress` until it commits or fails. A
  restart runs it again if the provider rollback was not sent, goes on from the file restore if
  its answer was kept, and records a failure (`ROLLBACK_INTERRUPTED_MESSAGE`) if the server stopped in
  between, where T3 would send the provider rollback again. Test:
  `a_restart_finishes_or_fails_a_rollback_left_pending`.
- **Fork** (`src/fork.rs`). `thread.fork` makes the fork thread and a pending `fork` transfer
  (`ThreadForkService.plan`). Its first turn forks the source's native thread from the source
  run's turn (`Session::fork_thread`) and consumes the transfer (`native_fork`). T3's portable
  path (a `full_thread_summary` handoff when the fork cannot be native, or after a failed
  native fork) is not built: such a message is refused, and a failed native fork fails the
  turn.
- **T3 state import** (`src/t3_import.rs`). `import_t3_state` builds `engine.sqlite` once
  from a T3 server's `statev2.sqlite` in the same folder: projects, threads and every
  projection row with its id and body, read-only from T3's file, renamed into place when
  complete. The server calls it before it opens the engine (`docs/status.md`, "T3 state
  import"); `import_t3_state_with_progress` reports each step for the log. Sessions, peer
  links and scheduled tasks are the server's (`conn-server/src/t3_carry.rs`), which reads
  T3's file through `open_t3_read_only`. Tests: `t3_import::tests`.

- **Buffered delivery** (`src/streaming.rs`, T3's `assistantStreaming.ts` and
  `RunExecutionService`). A running `assistant_message` node is never stored. A streaming
  assistant message, or a streaming `assistant_message` or `reasoning` turn item, is stored
  only at a Markdown boundary (cut there, at most every 400 ms per message) or whole after
  800 ms idle (`paragraph`); in `turn` mode not at all. The final version always passes. What
  is stored stays in the log, so the stored sequence has no gaps and a subscriber that joins
  mid-turn sees the last delivered snapshot. A held turn item reserves its position
  (`turn_item_positions`, T3's `TurnItemPositionStore`). The idle timer runs on the engine's
  clock: on a `ManualClock` a held snapshot comes due when the clock moves, as on T3's
  `TestClock`. At most 64 open messages are tracked per session. Store version 3 dropped the
  index for the old turn-end deletion; a log written before keeps its gaps and loads.
- **Visible items** (`src/visibility.rs`). `visibleTurnItems` follows T3's timeline rule
  (`createOrchestrationV2TurnItemVisibility`): a rolled-back run's items, a queued message
  until its run starts, and an unpaired interrupt result of a superseded attempt are hidden.
  A compact snapshot omits the local rows only when they are the first turn items.
- **Fresh context** (`src/fresh.rs`). A `message.dispatch` with `freshContext` never steers
  (steer and restart queue), is refused while a fork is pending or while the session holds
  background work (unless a schedule sent it), releases the live session and starts a new
  provider thread. A schedule's fresh run is a side conversation: the next plain message
  continues the thread's own provider thread (`conversationProviderThread`).
- **Provider thread at turn start.** The engine writes `firstRunOrdinal`, `lastRunOrdinal`
  and `status: active` and hands that row to the provider (T3's `runningProviderThread`). Every
  turn end (a provider terminal or a failed start) marks it `idle`, or `error` when the
  terminal says the thread is broken (`finalProviderThreadStatus`), while the run is the
  thread's last, as T3's `writeFinalRunEvents`. A cancel, Force stop, delete or restart
  recovery writes `idle` only from `active`.
- **Refusals.** An `OrchestrationV2DispatchCommandError` carries its reason as both `message`
  and `detail`, as T3's `ws.ts` builds it; a generic or empty reason has no `detail`.
- **Loading the native thread.** Each live session keeps a load key: the native thread, the
  provider's load part of the model selection (`Session::thread_load_model_selection`) and
  the runtime policy (T3's `providerThreadLoadKey`). A turn start resumes the thread when the
  key differs: a new session, a changed model or policy, or after a rollback on a new process
  (a rollback's own resume does not count). An `error` thread update forgets the key.
- **Session release.** A closed session (idle, provider switch, fresh start) writes its row as
  `stopped` and expires the requests only it could answer (`writeReleasedSessionEvents`).
- **Effect outbox.** A command's effects are rows in `effect_outbox`, written in the
  transaction that commits the command, as T3's `EventSink` and `EffectOutbox.ts` do; the
  run's end, the checkpoint capture, project writes and the restart write theirs the same
  way. A caller that goes away after the commit (a closed socket aborts its handler) cannot
  lose them. One worker (`effect_worker.rs`, T3's `EffectWorker.ts`) claims and runs them. A
  thread's effects run one at a time in commit order; titles have their own lane, as in T3;
  `AbandonStart` and `RemoteTaskChanged` run at once. What a stopped process left unsettled
  is reconciled at the next start, as T3's `reconcileAfterProcessLoss`: process-bound effects
  (turn start, steer, Stop, answers, model changes) are cancelled and the restart decides again
  from the stored runs; replay-safe ones (capture, session close, cleanups, titles, host
  notices, rollback by its phase) run again. A `running` run with no provider turn for its
  attempt never got its prompt, so the restart sends it again (`rewindUnacceptedRuns`).
  Settled rows are pruned after 7 days. Deviations from T3: one claim loop instead of 4 slots
  (one runtime thread), and no worker retries (a planned follow-up).
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
- **Projection order and rows of other threads** (T3's `ProjectionStore`). Messages are listed
  by the lowest ordinal of the user or assistant message item that shows each, then
  `createdAt`, then id (`sortMessagesByTurnItemOrder`). A thread's projection also lists the
  provider threads its subagents run on, read from the child threads. A provider's
  `provider_thread.updated` goes to its `appThreadId`, and `provider_turn.updated` and
  `runtime_request.updated` to the event's `threadId` (`ProviderEventIngestor`): a subagent's
  turn is written on its child thread and never becomes the run's provider turn.
- **Answers.** `runtime-request.respond` ends the request's node and its turn item
  (`cancelled` for a declined or cancelled request, else `completed`) and records a
  question's answer as `questionAnswer`, as T3's `Orchestrator` does.
- **Search.** `searchThreads` reads a trigram FTS5 index of final message texts
  (`message_search`) with `MATCH` and quoted words, as `ThreadSearch.ts`; SQLite's bundled
  build already has FTS5. The index holds text folded as T3's `trigram remove_diacritics 1`
  tokenizer folds it (`src/fold.rs`), from a table generated from the bundled SQLite
  (`src/sqlite-fold.txt`; a test fails when SQLite folds differently): case, and a single
  diacritic of a Latin letter, so "ecole" finds "École" but "aard" does not find "ǡard" and
  "かかく" does not find "かがく". Queries are NFC and lowercased, then fold the same way. A `meta` mark
  (`message_search_folded`, now 3) folds an older index again from the message texts, once,
  inside the engine's open, a byte-bounded batch at a time; it prints T3's migration lines
  (`databaseMigrationLog.ts`), so a desktop waiting for readiness keeps waiting.
  Every word of three characters or more must match; shorter words only narrow, and a query
  without a long word searches no messages (two CJK characters count as long). Word lengths
  count before the index folds a word. As `messageMatcher`, each word is looked for lowercased,
  then with accents folded when that finds no whole word. A word shorter than four characters
  must start a word in the message (a symbol starts one only where a letter would), and a hit
  inside a hex id does not count. The snippet shows the original text from where the words sit
  side by side as typed, else from the shortest stretch that holds every word, in UTF-16 units,
  and is cut as `buildSearchSnippet` cuts it: from a word start up to 24 units before, emphasis
  and code marks dropped, whitespace collapsed, with ellipses.
  Hidden threads drop out in SQL before the limit. Titles are the client's to match.
- **Background work.** A run that completes leaves its open command, dynamic tool and
  subagent rows running, as T3 does. The shell row's `pendingBackgroundTasks` is
  `derivePendingBackgroundWork` (`src/background.rs`): provider thread rosters, then those
  rows, then pull request watches; `/mcp` reads it for its thread list and the live-caller
  rule. `background_work.updated` (not persisted) holds an idle session like the provider's
  own probe, at most 64 provider turns tracked. `client-check.mjs` compares the roster with
  T3's own function.
- **Find in a thread.** `searchThread` and `searchThreadStream` read the visible timeline
  that `visible_rows` also writes into the transcript, so a run fork searches the parent
  history it shows, through the fork run. Each message counts matches in the text its
  Markdown shows (`src/thread_find.rs`, pulldown-cmark): emphasis and link labels join, link
  destinations stay out, and each block is its own segment. T3's file-link labels, citations,
  skill labels and assistant HTML are not rendered. No parse is cached.
- **Stop.** `thread.stop` and `run.interrupt` record a `run_interrupt_request` item on the
  active run (`markStoppedRun`, message "Stopped by user" or the command's reason); a run that
  ends interrupted gets a `run_interrupt_result` (`makeInterruptResultTurnItem`). When the
  provider answers Stop with `InterruptTimeout`, the run stays open and the request gets
  `unresponsiveAt` (`thread.interrupt.unresponsive`): clients offer Force stop, whose result
  says "Force stopped by user".
- **Stop before the provider accepted the turn** (T3's "before provider start"). A run is
  accepted once `Session::start_turn` returned (an in-memory ledger in the store, one entry per
  active run, pruned at 1,024; nothing is persisted). Before that, Stop, Force stop, a restart
  send and a stopped delegated child end the run in their own commit: the request, the result
  "Run interrupted before provider start", then the attempt, node and run `interrupted`; no
  capture, no provider-thread write. `AbandonStart` (outside the lane) calls
  `Session::abandon_turn_start`; a turn the provider accepts anyway is interrupted. The fake
  provider's `coldstart` and `latestart` messages test it.
- **Model change during a turn.** A `thread.model-selection.set` on the thread's instance
  goes to the running provider turn's session (`provider-session.apply-model-selection`,
  `ProviderTurnControlService.applyModelSelection`); the provider applies what it can live.
  Without a running provider turn only the thread changes. Codex has no live change (as T3).
- **Selection plan.** A model change on the thread's instance asks that provider's
  `plan_selection_transition` with the live session's capabilities (`ProviderSwitchService`):
  `reject` refuses the command; `restart_session` releases the session between turns and is
  refused during a run; `create_with_handoff` is refused. No provider here or in T3 answers it
  for a change on the same instance (T3 accepts it and continues the native thread), so the
  refusal is never reached. Without a session row the change applies at the next turn.
  Claude and Codex answer `apply_on_next_turn`.
- **Session row.** `open_session` returns the provider session; the engine stores it before
  any event. A session whose background tasks end with its process (Claude) clears its
  provider threads' rosters when it is released.
- **Provider switch.** A `thread.model-selection.set` to another instance is a provider switch
  (refused while a run is active). A run on another instance than the live session closes it
  and opens one on its own instance; a provider thread of another instance is never resumed.
- **Provider handoff** (`src/provider_handoff.rs`, T3's `dispatchMessage` and
  `startNextQueuedRun`). A message whose run goes to another instance than the conversation's
  carries the history: a `provider_handoff` transfer (`consumed`), a context handoff
  (`handoff::prepare_provider_handoff`), the run's `contextHandoffId` and a "Provider handoff"
  item before the message. The covered runs are those that reached a provider
  (`isHandoffSourceRun`) after the context boundary and after the last run the target's own
  provider thread took part in. Without such a thread, or with a native ref missing, or with
  a merge-back pending, the strategy is `full_thread_summary` (with inherited fork history and
  v1 imported rows) and the transfer resolves `portable_context`; else
  `delta_since_target_last_seen` and `delta_context`. A queued run decides when it starts,
  against the newest such run's instance. The target's capabilities must take the handoff
  (`ensureContextHandoff`, checked for a message from the provider's `capabilities`, before the
  command reaches its handler), else T3's refusal text. The turn start delivers it as a
  merge-back: injected (Codex) or inline (Claude, Grok, Antigravity). Every provider now says
  `supportsProviderSwitchingViaHandoff: true`, as in T3, so clients open the model picker to
  other providers. Tests: `a_provider_switch_hands_the_history_to_the_new_provider`,
  `a_queued_run_on_another_provider_carries_the_history`,
  `a_switch_to_a_provider_without_handoff_is_refused`,
  `a_steer_to_another_provider_restarts_there`.
  Not built (T3 has them): the `prepareLegacyImport` recovery handoff of a v1 import with no
  completed run, the turn start's resume-fallback and missed-run retry handoffs, cross-instance resume for instances that share native
  history (`restart_and_resume`; here every instance change hands off), the capability check
  for a queued run (all four providers pass it), and the provider thread's `handoffIds`.
- **Live command output.** `command_output.delta` (Codex) feeds a bounded hub in `output.rs`:
  at most 8 running commands, a 64 KiB tail each, dropped when the command settles.

## Memory

MCP App bounds that differ from T3:

- 256 context entries per conversation.
- 16,384 fork ancestors per context lookup.
- 1,024 pending SDK host replies.
- 32 native App calls per SDK query.
- 20 seconds for document capture.

`examples/memory_load.rs` runs fake turns and prints RSS and live heap (`stats_alloc`, dev only):

```sh
cargo run --release -p conn-engine --features fake-provider --example memory_load -- 1000 1
```

`STREAM=1` makes every turn one long streamed reply (400 snapshots, about 40 KB), `REOPEN=0`
keeps one thread view open; the run prints `peak_heap_kib` (sampled every 2 ms). A long
streamed turn with one view open peaked at 588 to 629 KiB live heap with buffered delivery,
662 to 689 KiB before (3 runs each, macOS, release, 2026-11-14).

The live Rust heap is flat under load (one thread, 1,000 turns: 0.33-0.39 MiB from turn 100).
A thread snapshot is built in memory whole: about 13 heap bytes per byte of its JSON at the
peak, so a 4.6 MB thread (1,000 turns) peaks near 60 MiB, and the macOS allocator keeps those
pages in RSS afterwards. Clients that opt in to compact snapshots get each turn item once.

Bounded thread snapshots (`acceptBoundedSnapshot`, `history.rs`): the engine sends the newest
window of rows (10 user turns, or 75 rows without a user turn, within T3's byte budget) with a
`historyCursor`, and serves older pages through `GET /api/orchestration/threads/:id/history`
(`OrchestrationV2ThreadHistoryPage`), as `threadHistoryPaging.ts` does. The store reads a light row
index first (selection fields and sizes, one body at a time) and loads only the chosen bodies.
Work folding (`deferWork`, `view=work`) is not served.

## Checks

- `cargo test -p conn-engine`: commands, streams, restart, families, reads, titles, observer.
- `tools/t3-fixture-replay/check.mjs`: T3's own testkit fixtures through this engine and the
  Claude, Codex and Grok providers on stand-ins, judged by T3's own assertions (the vitest file
  is placed in the monorepo for the run and removed; only the scenario runner is mocked). 69 of
  159 variants pass (Claude 34, Codex 25, Grok 10); `expected-failures.txt` lists the rest by
  cause. The Rust half is `examples/t3_fixture_replay.rs`. T3's replay gate
  (`release_replay_gate`) holds the stub `codex` and the fake SDK host before a labelled
  frame through files in the scenario folder; the ACP stub has none yet. About 3 minutes; `--only <fixture>/<driver>` runs one,
  `--keep` keeps the work folder (each fixture's plan, stub log, database and result).
- `tools/client-check.mjs`: the client's own decoders and reducers over
  `examples/export_turn.rs` output. Needs `vp i` at the monorepo root. From
  `apps/conn-server`:

  ```sh
  cargo run -p conn-engine --features fake-provider --example export_turn -- /tmp/x.json
  node crates/conn-engine/tools/client-check.mjs /tmp/x.json
  ```
