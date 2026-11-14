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
| `TurnObserver`, `TurnPoint`                   | Turn start and end, the hook for git checkpoints                    |

`calls.rs` lists the tags `call` and `open_stream` serve. The server registers them with their
contract types (`methods/orchestration.rs`, `methods/projects.rs`), so a result that does not
decode is a defect, not a broken client.

## dispatchCommand

41 of the 56 command types are handled. The other 15 answer `OrchestrationV2DispatchCommandError`
with a reason the client shows (`commands::refusal`).

| Handled                                                                                                                                                             | Refused, and why                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `thread.create`, `message.dispatch` (all five dispatch modes), `run.interrupt` (`holdQueue`), `thread.stop`, `runtime-request.respond`, `thread.user-input.dismiss` | `checkpoint.rollback`, `thread.merge_back`: no checkpoints yet                               |
| `queued-run.start`, `.cancel`, `.reorder`, `.edit`, `queue.resume`, `queued-message.promote-to-steer`                                                               | `thread.fork`                                                                                |
| `thread.archive`, `unarchive`, `delete`, `visit`, `mark-unread`, `metadata.update` (`regenerateTitle`), `title.regeneration.complete`                               | `prepared-run.release`, `.progress`, `.fail`, `.retry`: no worktree preparation              |
| `thread.settle`, `auto-settle`, `unsettle`, `snooze`, `unsnooze`, `auto-settle.set`, `pin`, `unpin`, `pin.reorder`, `active.reorder`, `tag.set`                     | `thread.pull-request-link.sync`, `.pull-request.watch`, `.pull-request.sync`: no PR watching |
| `thread.pull-request.link`, `.unlink`                                                                                                                               | `thread.guest-share.close`, `thread.guest-message.dismiss`: no guest sharing                 |
| `thread.runtime-mode.set`, `interaction-mode.set`, `model-selection.set`, `provider.switch`, `provider-session.detach`                                              | `notification.delivery.accept`, `subagent.stop`, `thread.created.record`                     |
| `delegated_task.request`, `.wake-policy`, `.completion-delivery.acknowledge`, `.dispose`                                                                            |                                                                                              |

## Behaviour worth knowing

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
- `tools/client-check.mjs`: the client's own decoders and reducers over
  `examples/export_turn.rs` output. Needs the Conn monorepo in `CONN_MONOREPO`. From the
  repository root:

  ```sh
  cargo run -p conn-engine --features fake-provider --example export_turn -- /tmp/x.json
  CONN_MONOREPO=/path/to/conn node crates/conn-engine/tools/client-check.mjs /tmp/x.json
  ```
