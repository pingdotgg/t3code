# conn-features

Conn's server areas beside the engine: scheduled tasks and annotations.
`docs/conn-only-areas.md` maps every method and `/mcp` tool of these areas in the T3 server,
with its state and what it needs from outside the server.

## What is served

| Area | RPC methods | `/mcp` tools | Not served, and why |
| --- | --- | --- | --- |
| Scheduled tasks | `scheduledTasks.subscribe`, `upsert`, `setEnabled`, `delete`, `runNow` | `schedule_task`, `list_scheduled_tasks`, `delete_scheduled_task`, `run_scheduled_task_now` | Webhook tasks (`rotateWebhookToken`, `listWebhookDeliveries`, `getWebhookDelivery` stay unregistered; a webhook save is refused); `fresh_session` tasks (refused: the engine cannot start a fresh provider session on a send) |
| Annotations | `annotations.subscribe`, `create`, `remove` | `annotations_list`, `annotations_claim`, `annotations_complete`, `annotations_release` | |

## Annotations (`src/annotations`)

- **Store:** the T3 server's own files, so either server reads the other's:
  `<state-dir>/annotations/<project>/<id>.json`, `<id>.<png|jpg|webp>`, `_sequence.json`,
  `_deleted.json`. Each call reads the project's folder under the project's lock on a
  blocking thread and writes what changed (atomic writes). Nothing stays in memory between
  calls but one lock and one change counter per project used. At most 1,000 annotations per
  project (the T3 server has no limit); a 1,001st is refused as invalid.
- **Rules from `AnnotationStore.ts`:** numbers per project are never reused; an edit keeps the
  number, status and times; a removed id can never come back; claim by id only from `todo`,
  otherwise the oldest todo that is not a question; complete and release are idempotent from
  their end state; removal records the ids first, so a stopped removal finishes on the next
  read. Ids name files, so an id outside `^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$` never reaches a
  path (a defect over RPC, `-32602` over `/mcp`, as the schema refuses it).
- **`/mcp`:** the caller thread's project. Failures reach the agent as their plain message:
  Effect's `McpServer` renders a declared `Error` with a message that way
  (`declaredFailureResult`), and `parity.mjs` shows the T3 server does so for this toolkit.
- **Proofs:** 11 unit tests (the 8 cases of `AnnotationStore.test.ts`, the id rule, and files
  the T3 server wrote); the 2 cases of `McpAnnotationsToolkit.test.ts` plus the refusals;
  the 3 methods decode with the real client's decoders; 7 `parity.mjs` steps, no differences.
- **Not done:** no client reducer check: the web client keeps the stream's latest list as it
  is, so the decode check is what it needs.

## Scheduled tasks (`src/scheduled`)

- **Store:** `<state-dir>/scheduled-tasks.json` (0600), the contract's `ScheduledTask` rows,
  written whole through `conn_support::fs::write_private` after each change. In memory: the
  same list, at most 500 tasks (the T3 server has no limit). A file that does not parse moves
  aside to `scheduled-tasks.json.unreadable`; a row that does not decode is skipped.
- **Timer:** one task sleeps until the earliest next run of an enabled task that is not
  running, or until a change wakes it. It never polls. It sleeps at most 10 minutes before it
  reads the wall clock again, so a clock change or a host that slept is seen (the T3 server's
  due hint ages out after the same). Due tasks run one after another, oldest first, as T3's
  `runDueTasks`.
- **Idle cost:** with no tasks, the timer waits on a `Notify` and never wakes. With tasks, it
  wakes at each due time and at most every 10 minutes. Memory: the task list (about 1 KiB a
  task) and one parked task. Not measured as process memory.
- **Rules from `Schedule.ts`:** intervals add elapsed time (at least 60 s); fixed times use the
  server's IANA zone (`jiff`, the system tz database), across daylight saving; a time a DST gap
  skips moves forward; a one-time run is stored as UTC and must lie in the future when saved
  or resumed. A fixed time more than 10 minutes late is skipped and recorded as missed.
- **Runs (`runTask`):** a reservation per task (a second `runNow` answers "Schedule task is
  already running."); the row is read again first, so a task deleted or paused since cannot
  fire; a recurring run is skipped while an earlier copy waits in its bound thread's queue;
  unbound tasks launch a thread through `launchThread` (the first message carries
  `scheduledTaskId` and the task's creator), bound tasks queue a `message.dispatch` in their
  thread and follow it when it moves to another project. The run's end is recorded only on the
  row it marked running. A follower watches the run up to 24 hours and records a provider
  failure after an accepted message (`recordRunFailure`); one follower per task.
- **Restarts:** rows left `running` are recorded as failed ("Run was interrupted by a server
  restart.") and planned again; a one-time run counts from its start.
- **Thread deletion** removes the tasks bound to that thread (`host.rs`, as T3's
  `ResourceCleanupService`).

### Differences from the T3 server

- A run started by `runNow` goes on when the caller stops waiting, and always records its end.
  T3 cancels it and records it as failed.
- No webhook tasks and no `fresh_session` tasks (see the table). No managed policy, so no
  `blockedByPolicy` and no runtime-mode ceiling.
- The timer runs a task at its due time; T3 runs it on the next 5-second poll.
- `upsert` also refuses a 501st task.

### Proofs

- 31 unit tests: the cases of `Schedule.test.ts`, `ScheduledTaskService.interval.test.ts`,
  `.schedule.test.ts` and `.test.ts` that do not need webhooks or managed policy, on a paused
  tokio clock (`clock::TestClock` follows it), and the engine runner's outcome rules.
- `conn-engine`: `a_scheduled_launch_keeps_its_task_id_and_actor`.
- `effect-client.mjs`: the five methods decode with the real client's decoders.
- `conn-mcp`: refusal tests for every access rule, the normal path, and 19 `parity.mjs` steps
  (no differences), including the argument errors in Effect's words.

## Dependencies

- `jiff` 0.2.43 (`std`, `tz-system`, `tzdb-zoneinfo`; no bundled tz database): the local
  calendar for fixed-time tasks. The release binary on macOS arm64 grew by 615,040 bytes
  (12,855,648 to 13,470,688) for this crate with `jiff`; `jiff`'s share alone is not measured.
- `conn-vcs`: the base ref of a new-thread task's worktree (`base_ref`).
