import * as NodeUtil from "node:util";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderInstanceId,
  ScheduledTaskError,
  ScheduledTaskId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as Deferred from "effect/Deferred";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  ScheduledTaskService,
  layer as scheduledTaskServiceLayer,
  listDueTasks,
} from "./ScheduledTaskService.ts";

const isScheduledTaskError = Schema.is(ScheduledTaskError);

const insertRow = (
  sql: SqlClient.SqlClient,
  row: {
    id: string | null;
    next: string | null;
    enabled: number;
    status: string;
    scheduleJson?: string;
    prompt?: string;
  },
  now: string,
) =>
  sql`INSERT INTO scheduled_tasks ${sql.insert({
    task_id: row.id,
    title: "task",
    prompt: row.prompt ?? "Run task",
    enabled: row.enabled,
    schedule_json: row.scheduleJson ?? '{"type":"interval","everyMs":60000}',
    project_id: "project:test",
    thread_id: null,
    workspace_strategy_json: '{"type":"root"}',
    model_selection_json: '{"instanceId":"codex","model":"gpt-5"}',
    runtime_mode: "full-access",
    interaction_mode: "default",
    created_by: "user",
    creation_source: "web",
    created_at: now,
    updated_at: now,
    next_run_at: row.next,
    last_run_at: null,
    last_run_status: row.status,
    last_run_error: null,
    run_count: 0,
  })}`;

it.effect("loads only due tasks and skips corrupt due rows without decoding settled tasks", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const now = "2026-09-09T12:00:00.000Z";
    const secret = "PROMPT-SECRET-DO-NOT-LOG";
    const credential = "CREDENTIAL-SECRET-DO-NOT-LOG";
    for (const row of [
      { id: "due-now", next: now, enabled: 1, status: "never" },
      // Ids that cannot decode as ScheduledTaskId — empty, whitespace-only,
      // and NULL (SQLite's TEXT primary key admits it).
      { id: "", next: now, enabled: 1, status: "never" },
      { id: "   ", next: now, enabled: 1, status: "never" },
      { id: null, next: now, enabled: 1, status: "never" },
      {
        id: "due-earlier",
        next: "2026-09-09T11:00:00.000Z",
        enabled: 1,
        status: "failed",
      },
      // An unparseable next_run_at sorts before every real timestamp, so it
      // passes the due filter and would defect the poll if not skipped.
      { id: "due-bad-date", next: "", enabled: 1, status: "never" },
      {
        id: "due-corrupt",
        next: now,
        enabled: 1,
        status: "never",
        scheduleJson: "broken",
      },
      {
        id: "due-cred",
        next: now,
        enabled: 1,
        status: "never",
        scheduleJson: `{"type":"interval","everyMs":"${credential}"}`,
      },
      { id: "disabled", next: now, enabled: 0, status: "never", scheduleJson: "broken" },
      {
        id: "future",
        next: "2026-09-09T12:00:00.001Z",
        enabled: 1,
        status: "never",
        scheduleJson: "broken",
      },
      {
        id: "unscheduled",
        next: null,
        enabled: 1,
        status: "never",
        scheduleJson: "broken",
      },
      { id: "running", next: now, enabled: 1, status: "running", scheduleJson: "broken" },
    ]) {
      yield* insertRow(sql, { ...row, prompt: secret }, now);
    }
    const warnings: unknown[] = [];
    const tasks = yield* listDueTasks(DateTime.makeUnsafe(now)).pipe(
      Effect.provide(
        Logger.layer([
          Logger.make(({ message }) => {
            warnings.push(message);
          }),
        ]),
      ),
    );
    assert.deepEqual(
      tasks.map((task) => task.id),
      ["due-earlier", "due-now"],
    );
    // Corrupt rows sort between the healthy due rows; each is skipped with a
    // warning instead of stopping the poll.
    assert.equal(warnings.length, 6);
    const annotations = warnings.map(
      (warning) => (warning as ReadonlyArray<unknown>)[1] as Record<string, unknown>,
    );
    assert.deepEqual(
      annotations.map((annotation) => annotation.taskId),
      ["due-bad-date", null, "", "   ", "due-corrupt", "due-cred"],
    );
    // The typed diagnostic carries a taskId only when the stored id itself
    // decodes; the corrupt-id rows are still skipped, not fatal.
    const causes = annotations.map((annotation) => annotation.cause);
    assert.deepEqual(
      causes.map((cause) => (isScheduledTaskError(cause) ? cause.taskId : undefined)),
      [undefined, undefined, undefined, undefined, "due-corrupt", "due-cred"],
    );
    for (const cause of causes) {
      if (cause !== undefined) assert.isTrue(isScheduledTaskError(cause));
    }
    const rendered = NodeUtil.inspect(annotations, { depth: null });
    assert.isFalse(rendered.includes(secret));
    assert.isFalse(rendered.includes(credential));
    const running = yield* sql<{
      last_run_status: string;
    }>`SELECT last_run_status FROM scheduled_tasks WHERE task_id = 'running'`;
    assert.equal(running[0]?.last_run_status, "running");
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect(
  "releases interrupted runs on startup and still executes due tasks, skipping corrupt rows",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-09-09T12:00:00.000Z";
      // An interval that decodes but overflows the representable DateTime
      // range must not defect recovery or the poll.
      const hugeInterval = '{"type":"interval","everyMs":9000000000000000}';
      for (const row of [
        { id: "stuck-valid", next: now, status: "running" },
        { id: "stuck-corrupt", next: now, status: "running", scheduleJson: "broken" },
        { id: "stuck-huge", next: now, status: "running", scheduleJson: hugeInterval },
        { id: null, next: now, status: "running" },
        // A due row with an unparseable next_run_at must not defect the poll
        // before the healthy due tasks run.
        { id: "due-bad-date", next: "", status: "never" },
        { id: "due-healthy", next: now, status: "never" },
        { id: "due-huge", next: now, status: "never", scheduleJson: hugeInterval },
        { id: "due-second", next: now, status: "never" },
        { id: "due-third", next: now, status: "never" },
      ]) {
        yield* insertRow(sql, { ...row, enabled: 1 }, now);
      }

      // it.effect freezes the clock; pin it just past the seeded due time so
      // the poll sees the rows as due.
      yield* TestClock.setTime(Date.parse(now) + 1_000);
      // Runs are dispatched serially, so the fourth dispatch can only happen
      // after the first three runs' completions were recorded — a drain
      // receipt for the poll fiber, never a sleep. The fourth launch is held
      // open so its in-flight state is observed deterministically.
      const dispatched = yield* Ref.make(0);
      const lastDispatched = yield* Deferred.make<void>();
      const releaseLast = yield* Deferred.make<void>();
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Layer.build(
            Layer.provideMerge(
              scheduledTaskServiceLayer,
              Layer.mergeAll(
                Layer.mock(ThreadLaunchService.ThreadLaunchService)({
                  launch: () =>
                    Ref.updateAndGet(dispatched, (n) => n + 1).pipe(
                      Effect.andThen((n) =>
                        n === 4
                          ? Deferred.succeed(lastDispatched, undefined).pipe(
                              Effect.andThen(Deferred.await(releaseLast)),
                            )
                          : Effect.void,
                      ),
                      Effect.andThen(Effect.die(new Error("test launch failure"))),
                    ),
                }),
                Layer.mock(ThreadManagementService.ThreadManagementService)({}),
                NodeCrypto.layer,
              ),
            ),
          );
          // The poll loop delays before its first pass, so the frozen test
          // clock must advance once to trigger it.
          yield* TestClock.adjust("6 seconds");
          yield* Deferred.await(lastDispatched);
          // The fourth dispatch implies the first three completions landed;
          // markRunning commits before dispatch, so due-third is 'running'.
          const inflight = yield* sql<{
            last_run_status: string;
          }>`SELECT last_run_status FROM scheduled_tasks WHERE task_id = 'due-third'`;
          assert.equal(inflight[0]?.last_run_status, "running");
          yield* Deferred.succeed(releaseLast, undefined);
        }),
      );

      const rows = yield* sql<{
        task_id: string | null;
        last_run_status: string;
        last_run_error: string | null;
        next_run_at: string | null;
        run_count: number;
      }>`SELECT task_id, last_run_status, last_run_error, next_run_at, run_count
       FROM scheduled_tasks ORDER BY task_id`;
      const byId = new Map(rows.map((row) => [row.task_id, row]));
      assert.equal(rows.length, 9);
      // The decodable stuck run is rescheduled for its next occurrence; the
      // undecodable and unrepresentable rows are released without a next run.
      // A NULL id must still match its own row — `= NULL` never does.
      assert.equal(byId.get("stuck-valid")?.last_run_status, "failed");
      assert.isNotNull(byId.get("stuck-valid")?.next_run_at);
      assert.equal(byId.get("stuck-corrupt")?.last_run_status, "failed");
      assert.equal(byId.get(null)?.last_run_status, "failed");
      const stuckHuge = byId.get("stuck-huge");
      assert.equal(stuckHuge?.last_run_status, "failed");
      assert.isNull(stuckHuge?.next_run_at);
      for (const id of ["stuck-valid", "stuck-corrupt", "stuck-huge", null]) {
        const row = byId.get(id);
        assert.equal(row?.last_run_error, "Run was interrupted by a server restart.");
        assert.equal(row?.run_count, 1);
      }
      // The healthy due tasks were dispatched and recorded failed runs; the
      // corrupt due row was skipped without running.
      for (const id of ["due-healthy", "due-huge", "due-second"]) {
        const row = byId.get(id);
        assert.equal(row?.last_run_status, "failed");
        assert.isTrue(row?.last_run_error?.includes("test launch failure") === true);
        assert.equal(row?.run_count, 1);
      }
      assert.isNull(byId.get("due-huge")?.next_run_at);
      assert.equal(byId.get("due-bad-date")?.last_run_status, "never");
      assert.equal(byId.get("due-bad-date")?.run_count, 0);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect(
  "treats a next_run_at corrupted before the dispatch re-read as not due instead of defecting the poll",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-09-09T12:00:00.000Z";
      // Equal next_run_at means dispatch order follows task_id order.
      for (const row of [
        { id: "run-a", next: now, status: "never" },
        { id: "run-b-victim", next: now, status: "never" },
        { id: "run-c", next: now, status: "never" },
        { id: "run-d", next: now, status: "never" },
      ]) {
        yield* insertRow(sql, { ...row, enabled: 1 }, now);
      }
      yield* TestClock.setTime(Date.parse(now) + 1_000);
      const dispatched = yield* Ref.make(0);
      const lastDispatched = yield* Deferred.make<void>();
      const releaseLast = yield* Deferred.make<void>();
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Layer.build(
            Layer.provideMerge(
              scheduledTaskServiceLayer,
              Layer.mergeAll(
                Layer.mock(ThreadLaunchService.ThreadLaunchService)({
                  launch: () =>
                    Ref.updateAndGet(dispatched, (n) => n + 1).pipe(
                      // A concurrent writer (the CLI shares the SQLite file)
                      // corrupts the next row between the poll read and its
                      // dispatch re-read. Serial dispatch makes the
                      // interleaving deterministic.
                      Effect.andThen((n) =>
                        n === 1
                          ? sql`UPDATE scheduled_tasks
                                SET next_run_at = ''
                                WHERE task_id = 'run-b-victim'`.pipe(Effect.asVoid, Effect.orDie)
                          : n === 3
                            ? Deferred.succeed(lastDispatched, undefined).pipe(
                                Effect.andThen(Deferred.await(releaseLast)),
                              )
                            : Effect.void,
                      ),
                      Effect.andThen(Effect.die(new Error("test launch failure"))),
                    ),
                }),
                Layer.mock(ThreadManagementService.ThreadManagementService)({}),
                NodeCrypto.layer,
              ),
            ),
          );
          yield* TestClock.adjust("6 seconds");
          // The third dispatch (run-d) can only happen after the victim's
          // re-read was handled — a receipt that the poll fiber survived.
          yield* Deferred.await(lastDispatched);
          assert.equal(yield* Ref.get(dispatched), 3);
          const rows = yield* sql<{
            task_id: string;
            last_run_status: string;
            next_run_at: string | null;
            run_count: number;
          }>`SELECT task_id, last_run_status, next_run_at, run_count
             FROM scheduled_tasks ORDER BY task_id`;
          const byId = new Map(rows.map((row) => [row.task_id, row]));
          const victim = byId.get("run-b-victim");
          assert.equal(victim?.last_run_status, "never");
          assert.equal(victim?.run_count, 0);
          assert.equal(victim?.next_run_at, "");
          for (const id of ["run-a", "run-c"]) {
            const row = byId.get(id);
            assert.equal(row?.last_run_status, "failed");
            assert.equal(row?.run_count, 1);
          }
          yield* Deferred.succeed(releaseLast, undefined);
        }),
      );
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

const updateProjectId = ProjectId.make("project:atomic-update");
const otherProjectId = ProjectId.make("project:atomic-update-other");
const updateTaskId = ScheduledTaskId.make("scheduled-task:atomic-update");

const updateTestDeps = Layer.mergeAll(
  SqlitePersistenceMemory,
  NodeCrypto.layer,
  Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
  Layer.mock(ThreadManagementService.ThreadManagementService)({}),
);

const updateTestLayer = scheduledTaskServiceLayer.pipe(Layer.provide(updateTestDeps));

// Same service plus direct SQL access to its in-memory database, for tests
// that must plant row state the public API cannot express.
const updateTestLayerWithSql = scheduledTaskServiceLayer.pipe(Layer.provideMerge(updateTestDeps));

const seedTask = Effect.gen(function* () {
  const tasks = yield* ScheduledTaskService;
  const { task } = yield* tasks.upsert({
    id: updateTaskId,
    title: "title original",
    prompt: "prompt original",
    enabled: true,
    schedule: { type: "interval", everyMs: 60_000 },
    projectId: updateProjectId,
    threadId: null,
    workspaceStrategy: { type: "root" },
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.1-codex" },
    runtimeMode: "full-access",
    interactionMode: "default",
    createdBy: "agent",
    creationSource: "mcp",
  });
  return task;
});

const findSeeded = Effect.gen(function* () {
  const tasks = yield* ScheduledTaskService;
  const { tasks: all } = yield* tasks.list();
  return all.find((candidate) => candidate.id === updateTaskId);
});

it.effect("update keeps disjoint concurrent edits and untouched fields", () =>
  Effect.gen(function* () {
    const tasks = yield* ScheduledTaskService;
    const seeded = yield* seedTask;
    const [first, second] = yield* Effect.all(
      [
        tasks.update({ id: updateTaskId, projectId: updateProjectId, title: "title A" }),
        tasks.update({ id: updateTaskId, projectId: updateProjectId, prompt: "prompt B" }),
      ],
      { concurrency: "unbounded" },
    );
    assert.isTrue(Option.isSome(first));
    assert.isTrue(Option.isSome(second));
    const after = yield* findSeeded;
    assert.isDefined(after);
    // Both disjoint edits survive — neither overwrote the other's column.
    assert.equal(after!.title, "title A");
    assert.equal(after!.prompt, "prompt B");
    // Unset fields keep their seeded values.
    assert.equal(after!.enabled, true);
    assert.deepEqual(after!.schedule, { type: "interval", everyMs: 60_000 });
    assert.equal(after!.projectId, updateProjectId);
    assert.equal(after!.createdAt, seeded.createdAt);
  }).pipe(Effect.provide(updateTestLayer)),
);

it.effect("concurrent schedule and enabled patches merge inside the transaction", () =>
  Effect.gen(function* () {
    const tasks = yield* ScheduledTaskService;
    yield* seedTask;
    // Each update reads the scoped row inside its own transaction, so the
    // second writer sees the first writer's committed columns: whichever
    // commits last must still observe enabled=false and produce a null due
    // time — never a next_run_at computed from the pre-pause snapshot.
    yield* Effect.all(
      [
        tasks.update({
          id: updateTaskId,
          projectId: updateProjectId,
          schedule: { type: "interval", everyMs: 3_600_000 },
        }),
        tasks.update({ id: updateTaskId, projectId: updateProjectId, enabled: false }),
      ],
      { concurrency: "unbounded" },
    );
    const after = yield* findSeeded;
    assert.isDefined(after);
    assert.equal(after!.enabled, false);
    assert.deepEqual(after!.schedule, { type: "interval", everyMs: 3_600_000 });
    assert.isNull(after!.nextRunAt);
  }).pipe(Effect.provide(updateTestLayer)),
);

it.effect("update loses to a racing delete and never recreates the task", () =>
  Effect.gen(function* () {
    const tasks = yield* ScheduledTaskService;
    yield* seedTask;
    yield* Effect.all(
      [
        tasks.update({ id: updateTaskId, projectId: updateProjectId, title: "racing edit" }),
        tasks.delete({ id: updateTaskId }),
      ],
      { concurrency: "unbounded" },
    );
    // Whichever statement committed first, the row must stay deleted — the
    // update is a targeted UPDATE that can never insert.
    assert.isUndefined(yield* findSeeded);

    // Deterministic stale update after the delete: typed `none`, still absent.
    yield* seedTask;
    yield* tasks.delete({ id: updateTaskId });
    const stale = yield* tasks.update({
      id: updateTaskId,
      projectId: updateProjectId,
      title: "stale edit",
    });
    assert.isTrue(Option.isNone(stale));
    assert.isUndefined(yield* findSeeded);
  }).pipe(Effect.provide(updateTestLayer)),
);

it.effect("update enforces project scope and reports missing tasks as none", () =>
  Effect.gen(function* () {
    const tasks = yield* ScheduledTaskService;
    yield* seedTask;
    const wrongProject = yield* tasks.update({
      id: updateTaskId,
      projectId: otherProjectId,
      title: "cross-project edit",
    });
    assert.isTrue(Option.isNone(wrongProject));
    const after = yield* findSeeded;
    assert.equal(after?.title, "title original");

    const missing = yield* tasks.update({
      id: ScheduledTaskId.make("scheduled-task:missing"),
      projectId: updateProjectId,
      title: "no row",
    });
    assert.isTrue(Option.isNone(missing));
  }).pipe(Effect.provide(updateTestLayer)),
);

it.effect("update retains the pending due time unless the schedule changes", () =>
  Effect.gen(function* () {
    const tasks = yield* ScheduledTaskService;
    const seeded = yield* seedTask;
    assert.isNotNull(seeded.nextRunAt);

    // Move the clock forward inside the pending window: an update that
    // recomputed next_run_at unconditionally would now emit a different
    // timestamp, so the exact-equality checks below discriminate between
    // "retained" and "recomputed". (+30s stays inside the 60s interval, so
    // the task is still not due and the poller cannot fire it.)
    yield* TestClock.adjust("30 seconds");

    // Non-schedule edits keep the pending due time exactly.
    const renamed = yield* tasks.update({
      id: updateTaskId,
      projectId: updateProjectId,
      title: "renamed",
      prompt: "new prompt",
      threadId: null,
      workspaceStrategy: { type: "root" },
    });
    assert.isTrue(Option.isSome(renamed));
    assert.equal(Option.getOrThrow(renamed).task.nextRunAt, seeded.nextRunAt);

    // Explicitly resubmitting the current enabled flag or an equal schedule
    // also retains the pending due time.
    const sameEnabled = yield* tasks.update({
      id: updateTaskId,
      projectId: updateProjectId,
      enabled: true,
    });
    assert.equal(Option.getOrThrow(sameEnabled).task.nextRunAt, seeded.nextRunAt);
    const sameSchedule = yield* tasks.update({
      id: updateTaskId,
      projectId: updateProjectId,
      schedule: { type: "interval", everyMs: 60_000 },
    });
    assert.equal(Option.getOrThrow(sameSchedule).task.nextRunAt, seeded.nextRunAt);

    // A semantically equivalent fixed-time schedule (an explicit all-weekdays
    // mask means the same as an omitted one) retains it too. The due time is
    // planted as a sentinel no recompute from the current clock could
    // produce — exact equality discriminates here, unlike a timestamp
    // reachable from `now`, which recomputes to the same value.
    const sql = yield* SqlClient.SqlClient;
    const fixedTimeId = ScheduledTaskId.make("scheduled-task:fixed-time");
    yield* tasks.upsert({
      id: fixedTimeId,
      title: "fixed",
      prompt: "fixed prompt",
      enabled: true,
      schedule: { type: "fixed_time", timeOfDay: "09:30", weekdays: [0, 1, 2, 3, 4, 5, 6] },
      projectId: updateProjectId,
      threadId: null,
      workspaceStrategy: { type: "root" },
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.1-codex" },
      runtimeMode: "full-access",
      interactionMode: "default",
      createdBy: "agent",
      creationSource: "mcp",
    });
    const overdue = "2001-01-02T09:30:00.000Z";
    yield* sql`UPDATE scheduled_tasks SET next_run_at = ${overdue} WHERE task_id = ${fixedTimeId}`;
    const sameFixed = yield* tasks.update({
      id: fixedTimeId,
      projectId: updateProjectId,
      schedule: { type: "fixed_time", timeOfDay: "09:30" },
    });
    assert.equal(Option.getOrThrow(sameFixed).task.nextRunAt, overdue);

    // A schedule change restarts the run clock.
    const rescheduled = yield* tasks.update({
      id: updateTaskId,
      projectId: updateProjectId,
      schedule: { type: "interval", everyMs: 3_600_000 },
    });
    const rescheduledTask = Option.getOrThrow(rescheduled).task;
    assert.isNotNull(rescheduledTask.nextRunAt);
    assert.notEqual(rescheduledTask.nextRunAt, seeded.nextRunAt);

    // Disabling clears the due time; editing another field while disabled
    // does not resurrect one.
    const paused = yield* tasks.update({
      id: updateTaskId,
      projectId: updateProjectId,
      enabled: false,
    });
    assert.isNull(Option.getOrThrow(paused).task.nextRunAt);
    const editedWhilePaused = yield* tasks.update({
      id: updateTaskId,
      projectId: updateProjectId,
      title: "still paused",
    });
    assert.isNull(Option.getOrThrow(editedWhilePaused).task.nextRunAt);
  }).pipe(Effect.provide(updateTestLayerWithSql)),
);
