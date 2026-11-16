# conn-features

Conn's server areas beside the engine: scheduled tasks and annotations.
`docs/conn-only-areas.md` maps every method and `/mcp` tool of these areas in the T3 server,
with its state and what it needs from outside the server.

## What is served

| Area | RPC methods | `/mcp` tools | Not served, and why |
| --- | --- | --- | --- |
| Scheduled tasks | `scheduledTasks.subscribe`, `upsert`, `setEnabled`, `delete`, `runNow`, `rotateWebhookToken`, `listWebhookDeliveries`, `getWebhookDelivery`; the route `/api/hooks/<task id>/<token>` | `schedule_task`, `list_scheduled_tasks`, `delete_scheduled_task`, `run_scheduled_task_now` | Webhook coalescing windows (a save with `coalesceKey` is refused), the T3 Connect relay, managed policy. `fresh_session` tasks are served: each bound run is sent with `freshContext` |
| Annotations | `annotations.subscribe`, `create`, `remove` | `annotations_list`, `annotations_claim`, `annotations_complete`, `annotations_release` | |
| Test logins | `testLogins.list`, `save`, `update`, `remove`, `reveal` | `save_test_login`, `request_credentials` | Browser filling needs the desktop preview relay. |
| Secret requests | `secrets.answerRequest` | `request_secret` | Secret-provider references are not advertised; reference answers fail as unreadable. |
| Panels | `panels.requests`, `panels.respond` | `panel_open`, `database_query` | Browser URL/tab automation needs the unimplemented desktop preview manager and relay. Showing the browser panel without a URL or tab id works. T3 leaves these RPCs unmounted; this server mounts them. |

## Annotations (`src/annotations`)

- **Store:** the T3 server's own files, so either server reads the other's:
  `<state-dir>/annotations/<project>/<id>.json`, `<id>.<png|jpg|webp>`, `_sequence.json`,
  `_deleted.json`. Each call reads the project's folder under the project's lock on a
  blocking thread and writes what changed (atomic writes). Nothing stays in memory between
  calls but one lock and one change counter per project used. At most 1,000 annotations per
  project (the T3 server has no limit); a 1,001st is refused as invalid. A screenshot is
  decoded on a blocking thread and may be at most 8 MiB decoded (the T3 server has no cap): a
  larger one is refused as invalid ("The screenshot is larger than 8 MB.") before it is
  decoded. `_deleted.json` keeps the newest 10,000 removed ids per project, oldest dropped
  first (the T3 server keeps all); a longer file the T3 server wrote loads whole, and the next
  removal here trims it.
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
  `runDueTasks`. After a pass that left a due task as it was (its row could not be
  saved, for example on a full disk), the timer waits at least 5 s, the T3 server's poll
  interval, and logs the failure once while it repeats.
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
  interrupted without error"), counted and planned again (`releaseStuckRun`). As in T3, the
  task stays reserved until that release is written, and a release only ends the run it
  belongs to (the row's start time must match). A follower watches the run up to 24 hours and records a provider
  failure after an accepted message (`recordRunFailure`); one follower per task.
- **Restarts:** rows left `running` are recorded as failed ("Run was interrupted by a server
  restart.") and planned again; a one-time run counts from its start.
- **Thread deletion** removes the tasks bound to that thread (`host.rs`, as T3's
  `ResourceCleanupService`).

### Differences from the T3 server

- No managed policy, so no `blockedByPolicy` and no runtime-mode ceiling.
- The timer runs a task at its due time; T3 runs it on the next 5-second poll.
- `upsert` also refuses a 501st task.
- Webhook tasks: see below.

### Webhook tasks (`src/scheduled/webhook`)

- **Save** (`upsert`): the signature header is stored lowercase; dedupe and filters a client
  leaves out are kept, `[]` clears the filters; `maxDeliveryAgeMinutes` is stored as `null`
  when absent. The token (32 random bytes, base64url) stays across saves and restarts;
  `rotateWebhookToken` replaces it. A new secret replaces the stored one, a save without one
  keeps it, and a signature without any secret is refused. Switching to a timer drops the
  token and secret. The contract's checks that the generated types do not hold (trimmed
  header, 1 to 1440 minutes, dedupe templates, 16 filters, filter paths and `in` values)
  refuse the payload as a defect.
- **Token and secret:** stored with the task in `scheduled-tasks.json` (0600), in clear
  text, as the T3 server keeps them in the task row. Never in a list, a `Debug` output or a
  log. `webhook.path` is `/api/hooks/<encodeURIComponent(id)>/<token>`; `url` is `null` (no
  relay). Sessions without `orchestration:operate` get the list without `webhook`.
- **Route** (`crates/conn-server/src/routes/hooks.rs`): `GET`, `POST`, `PUT`, `PATCH`; `HEAD`
  answers 405 with `allow`. A declared length over 1 MiB, or a body that grows past it
  (chunked), answers 413 before any lookup. Answers 202 (`deliveryId`), 401, 404, 409, 429
  (`rate_limited` or `queue_full`), and 500 with no cause; each names its outcome in
  `x-t3-hook-outcome`. A path that does not decode answers 404.
- **Order of checks** (`triggerWebhook`): task and token (constant time; a wrong token and an
  unknown hook both answer 404 and log nothing); the flood window (60 a minute per task,
  taken before the signature work; only the first refusal is logged); paused; signature
  (HMAC-SHA256 over the raw body, hex or base64, optional prefix); filters (at most 10
  filtered rows logged a minute); the run window (60 runs a minute); the replay key; the
  prompt (framed with a random id; over 120,000 characters it is logged as failed and not
  run); the queue (20 waiting per task); then the run, one at a time per task, with command
  id `scheduled-task:<id>:webhook:<delivery id>` and the rendered prompt as its message.
- **Replay keys:** SHA-256 of the raw rendered `replayKey`, kept 7 days per task, checked and
  claimed in one SQLite transaction; a run that does not start gives its key back.
- **Delivery log:** 50 runs + 20 suppressed (duplicate, coalesced, rate limited, prompt too
  long) + 20 filtered per task, in `<state>/scheduled-task-webhooks.sqlite`, opened per call
  on a blocking thread. Bodies up to 64 KiB (a split character dropped), prompts up to 64 KiB,
  credential headers and query values `[redacted]`. A client that does not send
  `acceptAnyOutcome` sees only the outcomes older clients decode. A deleted task's rows and
  keys go with it.
- **Memory:** nothing for the log or the keys between calls (SQLite on disk, a 256 KiB cache
  while a call has it open). Per webhook task: its token and secret, at most 60 times in each
  of two rate windows, 10 in each of two log windows, a queue count and one semaphore. Each
  waiting delivery holds its rendered prompt (at most 120,000 UTF-16 units, so at most about
  360 KiB) in one parked task, at most 20 per task. Not measured as process memory.
- **What a caller without the token can do:** make the server read its request up to 1 MiB,
  look up one task id in memory, compare the token, and answer 404. Nothing is stored, logged
  or run. With the URL token but without the signing secret, on a signed task: at most 61 log
  rows a minute (60 `rejected_signature`, of which the newest 50 stay, and one
  `rate_limited`), then 429 for the rest of the minute; no run. With the token on an unsigned
  task, or with the secret, what any sender may do, within 60 runs a minute, 20 waiting and
  the log bounds.
- **Not built:** coalescing windows (`coalesceKey`, the pending table and its timer): a save
  with one is refused. The T3 Connect relay (signed delivery proofs, held requests, relay
  claims): relay headers are ignored, as T3 ignores them on an environment not linked to T3
  Connect, so `maxDeliveryAgeMinutes` never expires a direct request. Managed policy
  (`limits.webhookTasks`).

### Proofs

- Webhooks: 16 tests ported from `ScheduledTaskService.webhook.test.ts` (`webhook/tests.rs`),
  2 store tests, 29 tests from `webhookTemplate.test.ts`, `webhookFilter.test.ts` and
  `webhookVerification.test.ts`; `tools/webhook-diff.mjs` runs T3's own template, filter,
  redaction and signature functions against `examples/webhook_functions.rs` on 140 cases;
  `effect-client.mjs` decodes the 3 methods and checks the route's refusals.

- 31 unit tests: the cases of `Schedule.test.ts`, `ScheduledTaskService.interval.test.ts`,
  `.schedule.test.ts` and `.test.ts` that do not need webhooks or managed policy (with the
  interrupted `runNow`), on a paused tokio clock (`clock::TestClock` follows it), and the engine runner's outcome rules.
- `conn-engine`: `a_scheduled_launch_keeps_its_task_id_and_actor`.
- `effect-client.mjs`: the five methods decode with the real client's decoders.
- `conn-mcp`: refusal tests for every access rule, the normal path, and 19 `parity.mjs` steps
  (no differences), including the argument errors in Effect's words.

## Dependencies

- `rusqlite` (already in the binary through `conn-engine`) for the webhook log and replay
  keys; `getrandom` (in the tree) for tokens and frame ids.

- `jiff` 0.2.43 (`std`, `tz-system`, `tzdb-zoneinfo`; no bundled tz database): the local
  calendar for fixed-time tasks. The release binary on macOS arm64 grew by 615,040 bytes
  (12,855,648 to 13,470,688) for this crate with `jiff`; `jiff`'s share alone is not measured.
- `conn-vcs`: the base ref of a new-thread task's worktree (`base_ref`).

## Secret requests and panels

Bounds differ from T3: 64 simultaneous secret waits, 1,024 retained answers and files,
16 desktop subscribers, 16 queued panel requests per desktop and 64 pending panel requests.
A full store or wait limit refuses the request; a full desktop queue refuses delivery.
Panel responses cap device names at 200 and errors at 8,192 UTF-16 units; T3 leaves both
unbounded. Secret-provider references and browser URL/tab automation are not served.

## Test logins

`test_logins` reads and writes the settings secret store's `test-logins.bin`, with T3's
version 1 format. It keeps no login cache. A shared lock serializes disk operations on
`spawn_blocking`; list and save return metadata, and only `reveal` returns secrets.
The store refuses more than 1,024 logins or a file over 16 MiB (T3 has no such caps).
These RPCs are mounted here; T3 currently declares them without mounting them.
A corrupt file fails without being overwritten. Password bytes are preserved; labels,
URLs and OTP setup values follow T3's trimming rules.
