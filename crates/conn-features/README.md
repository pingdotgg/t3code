# conn-features

Conn's server areas beside the engine: scheduled tasks and annotations.
`docs/conn-only-areas.md` maps every method and `/mcp` tool of these areas in the T3 server,
with its state and what it needs from outside the server.

## What is served

| Area | RPC methods | `/mcp` tools | Not served, and why |
| --- | --- | --- | --- |
| Scheduled tasks | `scheduledTasks.subscribe`, `upsert`, `setEnabled`, `delete`, `runNow` | `schedule_task`, `list_scheduled_tasks`, `delete_scheduled_task`, `run_scheduled_task_now` | Webhook tasks (`rotateWebhookToken`, `listWebhookDeliveries`, `getWebhookDelivery` stay unregistered; a webhook save is refused). `fresh_session` tasks are served: each bound run is sent with `freshContext` |
| Annotations | `annotations.subscribe`, `create`, `remove` | `annotations_list`, `annotations_claim`, `annotations_complete`, `annotations_release` | |
| Panels | none | none | `panels.requests` and `panels.respond` stay unregistered, as the T3 server leaves them unmounted (`wsFork.ts`); this server used to answer `panels.requests` with an empty open stream |

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
- **Deliberate difference from the T3 server:** a project id made only of dots (`.`, `..`)
  gets the folder `%2E` or `%2E%2E`, not the annotations root or the state folder, and every
  folder must be one child of the annotations root. The T3 server's `directoryFor` keeps the
  dots, so there `..` writes into the state folder (`docs/status.md`, "Faults found in the T3
  server"). Folders the T3 server wrote for every other id load under the same name. The lock
  is per folder, so two ids that map to one folder share it.
- **`/mcp`:** the caller thread's project. Failures reach the agent as their plain message:
  Effect's `McpServer` renders a declared `Error` with a message that way
  (`declaredFailureResult`), and `parity.mjs` shows the T3 server does so for this toolkit.
- **Proofs:** 11 unit tests (the 8 cases of `AnnotationStore.test.ts`, the id rule, files
  the T3 server wrote, and 3 for hostile project ids); the 2 cases of `McpAnnotationsToolkit.test.ts` plus the refusals;
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
  row it marked running. `runNow` runs in the caller's future, as in T3: a caller that stops
  waiting stops the run, which is recorded as failed with T3's interrupt text ("All fibers
  interrupted without error"), counted and planned again (`releaseStuckRun`). A follower watches the run up to 24 hours and records a provider
  failure after an accepted message (`recordRunFailure`); one follower per task.
- **Restarts:** rows left `running` are recorded as failed ("Run was interrupted by a server
  restart.") and planned again; a one-time run counts from its start.
- **Thread deletion** removes the tasks bound to that thread (`host.rs`, as T3's
  `ResourceCleanupService`).

### Differences from the T3 server

- No webhook tasks (see the table). No managed policy, so no
  `blockedByPolicy` and no runtime-mode ceiling.
- The timer runs a task at its due time; T3 runs it on the next 5-second poll.
- `upsert` also refuses a 501st task.

### Webhook tasks: what is left

Not built; the three methods stay unregistered, a webhook save is refused, and no `/api/hooks`
route exists. What a port needs, from `apps/server/src/scheduledTasks/`:

- The route (`webhookRoute.ts`): `GET`, `POST`, `PUT`, `PATCH` on
  `/api/hooks/<task id>/<token>`, `HEAD` answers 405; body at most 1 MiB, also when chunked;
  answers 202 (with `x-t3-hook-outcome`), 401, 404 (an unknown hook and a wrong token look
  the same), 409, 410, 413, 429, 500.
- The checks (`ScheduledTaskService.ts:2112`): the token compared in constant time; HMAC-SHA256
  over the raw body (`webhookVerification.ts`, hex or base64, an optional prefix); the
  maximum delivery age; filters (`webhookFilter.ts`); rejected requests rate-limited before
  the signature work.
- Rate and queue: 60 runs a minute per task, 20 queued, replay and coalesce keys with a
  window (`webhookDedupe.ts`, a pending table with states), relay delivery claims kept 48 h.
- The prompt: `renderWebhookPrompt` (`webhookTemplate.ts`) with a random frame id, refused
  above the provider's input limit.
- The log: 50 + 20 + 20 deliveries kept per task, bodies up to 64 KiB, secret headers and
  query values redacted; `listWebhookDeliveries`, `getWebhookDelivery`.
- The secret: stored with the task (T3: the `webhook_secret` column, clear text); here the task
  row in `scheduled-tasks.json` (0600) would hold it. `secretRef` answers need `request_secret`
  (not served).
- The relay (T3 Connect): `url` stays `null` without one; the route works directly.
- Tests to port: `ScheduledTaskService.webhook.test.ts` (2,200 lines), `webhookRoute.test.ts`,
  `webhookFilter.test.ts`, `webhookTemplate.test.ts`, `webhookVerification.test.ts`.

The generated `ScheduledTaskUpsertScheduleWebhookSignature` already hides its `secret` in
`Debug` (`gen-contract.mjs`).

### Proofs

- 31 unit tests: the cases of `Schedule.test.ts`, `ScheduledTaskService.interval.test.ts`,
  `.schedule.test.ts` and `.test.ts` that do not need webhooks or managed policy (with the
  interrupted `runNow`), on a paused tokio clock (`clock::TestClock` follows it), and the engine runner's outcome rules.
- `conn-engine`: `a_scheduled_launch_keeps_its_task_id_and_actor`.
- `effect-client.mjs`: the five methods decode with the real client's decoders.
- `conn-mcp`: refusal tests for every access rule, the normal path, and 19 `parity.mjs` steps
  (no differences), including the argument errors in Effect's words.

## Dependencies

- `jiff` 0.2.43 (`std`, `tz-system`, `tzdb-zoneinfo`; no bundled tz database): the local
  calendar for fixed-time tasks. The release binary on macOS arm64 grew by 615,040 bytes
  (12,855,648 to 13,470,688) for this crate with `jiff`; `jiff`'s share alone is not measured.
- `conn-vcs`: the base ref of a new-thread task's worktree (`base_ref`).
