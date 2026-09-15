import * as NodeSqlite from "node:sqlite";
import * as NodeUtil from "node:util";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import { assert, it } from "@effect/vitest";
import {
  EventId,
  ProjectId,
  ProviderInstanceId,
  ScheduledTaskError,
  ScheduledTaskId,
  ThreadId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2ThreadShellSnapshot,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlError from "effect/unstable/sql/SqlError";

import * as Deferred from "effect/Deferred";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import {
  makeSqlitePersistenceLive,
  SqlitePersistenceMemory,
} from "../persistence/Layers/Sqlite.ts";
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

const emptyShellSnapshot = Effect.succeed({
  schemaVersion: 1,
  snapshotSequence: 0,
  threads: [],
  archivedThreads: [],
} as unknown as OrchestrationV2ThreadShellSnapshot);

const updateTestDeps = Layer.mergeAll(
  SqlitePersistenceMemory,
  NodeCrypto.layer,
  Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
  Layer.mock(ThreadManagementService.ThreadManagementService)({
    getShellSnapshot: () => emptyShellSnapshot,
    streamDomainEvents: Stream.empty,
  }),
);

const updateTestLayer = scheduledTaskServiceLayer.pipe(Layer.provide(updateTestDeps));

// Only `boundThreadId` (v2) exists as a live binding target, inside
// `updateProjectId`. `v1ThreadId` exists only in the legacy projection —
// shell reconciliation runs before writes are served, so a thread without a
// v2 row can never dispatch and must be rejected. `deletedThreadId` has a
// deleted v2 row shadowing a live v1 row — v2 is the sole authority.
const boundThreadId = ThreadId.make("thread:in-project");
const v1ThreadId = ThreadId.make("thread:v1-only");
const deletedThreadId = ThreadId.make("thread:deleted");

// Same service plus direct SQL access to its in-memory database, for tests
// that must plant row state the public API cannot express.
const updateTestLayerWithSql = scheduledTaskServiceLayer.pipe(Layer.provideMerge(updateTestDeps));

const seedProjectThreads = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const now = "2026-09-14T00:00:00.000Z";
  yield* sql`
    INSERT INTO orchestration_v2_projection_threads
      (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
       created_at, updated_at, payload_json)
    VALUES
      (${boundThreadId}, ${updateProjectId}, 'bound', 'codex', 'full-access', 'default',
       ${now}, ${now}, '{}'),
      (${deletedThreadId}, ${updateProjectId}, 'deleted', 'codex', 'full-access', 'default',
       ${now}, ${now}, '{}')
  `;
  yield* sql`
    UPDATE orchestration_v2_projection_threads
    SET deleted_at = ${now}
    WHERE thread_id = ${deletedThreadId}
  `;
  // v1-only rows must NOT satisfy the check — dispatch reads only the v2
  // projection, so one of them shadows the deleted v2 row to prove the v1
  // table is never consulted.
  yield* sql`
    INSERT INTO projection_threads
      (thread_id, project_id, title, created_at, updated_at)
    VALUES
      (${v1ThreadId}, ${updateProjectId}, 'v1', ${now}, ${now}),
      (${deletedThreadId}, ${updateProjectId}, 'v1 shadow', ${now}, ${now})
  `;
});

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

// Gated launch barrier: lets a test park the thread dispatch between
// markRunning and the completion write, so an edit lands in a deterministic
// window rather than a racy one.
let launchBarrier: {
  readonly started: Deferred.Deferred<void>;
  readonly release: Deferred.Deferred<void>;
} | null = null;

const gatedLaunchTestLayer = scheduledTaskServiceLayer.pipe(
  Layer.provide(
    Layer.mergeAll(
      SqlitePersistenceMemory,
      NodeCrypto.layer,
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({
        launch: () =>
          Effect.gen(function* () {
            const barrier = launchBarrier;
            if (barrier !== null) {
              yield* Deferred.succeed(barrier.started, undefined);
              yield* Deferred.await(barrier.release);
            }
            return {
              threadId: ThreadId.make("thread:scheduled-run"),
              projection: {} as unknown as OrchestrationV2ThreadProjection,
              resumed: false,
            };
          }),
      }),
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        getShellSnapshot: () => emptyShellSnapshot,
        streamDomainEvents: Stream.empty,
      }),
    ),
  ),
);

it.effect("run completion computes the next due time from an edit committed mid-run", () =>
  Effect.gen(function* () {
    const tasks = yield* ScheduledTaskService;
    yield* seedTask;
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    launchBarrier = { started, release };
    try {
      const runFiber = yield* tasks.runNow({ id: updateTaskId }).pipe(Effect.forkChild);
      // The dispatch is parked: the update below lands after markRunning and
      // before the completion transaction, deterministically.
      yield* Deferred.await(started);
      const edited = yield* tasks.update({
        id: updateTaskId,
        projectId: updateProjectId,
        schedule: { type: "interval", everyMs: 3_600_000 },
      });
      assert.isTrue(Option.isSome(edited));
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(runFiber);
    } finally {
      launchBarrier = null;
    }
    const after = yield* findSeeded;
    assert.isDefined(after);
    assert.deepEqual(after!.schedule, { type: "interval", everyMs: 3_600_000 });
    assert.equal(after!.lastRunStatus, "succeeded");
    // The completion transaction re-read the row, so the new one-hour
    // interval — not the pre-run 60s schedule — sets the next due time.
    assert.isNotNull(after!.nextRunAt);
    assert.isNotNull(after!.lastRunAt);
    const nextMillis = DateTime.toEpochMillis(DateTime.makeUnsafe(after!.nextRunAt!));
    const startedMillis = DateTime.toEpochMillis(DateTime.makeUnsafe(after!.lastRunAt!));
    assert.isAtLeast(nextMillis - startedMillis, 3_500_000);
  }).pipe(Effect.provide(gatedLaunchTestLayer)),
);

it.effect("interrupted run records the failure against the edit committed mid-run", () =>
  Effect.gen(function* () {
    const tasks = yield* ScheduledTaskService;
    yield* seedTask;
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    launchBarrier = { started, release };
    try {
      const runFiber = yield* tasks.runNow({ id: updateTaskId }).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      const edited = yield* tasks.update({
        id: updateTaskId,
        projectId: updateProjectId,
        schedule: { type: "interval", everyMs: 3_600_000 },
      });
      assert.isTrue(Option.isSome(edited));
      // Interrupt while the dispatch is parked: runTask captures the
      // interruption as a failed run, so the failure write must also derive
      // next_run_at from the edited schedule rather than the stale snapshot.
      yield* Fiber.interrupt(runFiber);
    } finally {
      launchBarrier = null;
    }
    const after = yield* findSeeded;
    assert.isDefined(after);
    assert.deepEqual(after!.schedule, { type: "interval", everyMs: 3_600_000 });
    assert.equal(after!.lastRunStatus, "failed");
    assert.isNotNull(after!.nextRunAt);
    assert.isNotNull(after!.lastRunAt);
    const nextMillis = DateTime.toEpochMillis(DateTime.makeUnsafe(after!.nextRunAt!));
    const startedMillis = DateTime.toEpochMillis(DateTime.makeUnsafe(after!.lastRunAt!));
    assert.isAtLeast(nextMillis - startedMillis, 3_500_000);
  }).pipe(Effect.provide(gatedLaunchTestLayer)),
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

it.effect("update applies model selection and project moves patch-style", () =>
  Effect.gen(function* () {
    const tasks = yield* ScheduledTaskService;
    const seeded = yield* seedTask;
    const moved = yield* tasks.update({
      id: updateTaskId,
      projectId: updateProjectId,
      modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "opus-5" },
      nextProjectId: otherProjectId,
      title: "moved",
    });
    const movedTask = Option.getOrThrow(moved).task;
    assert.equal(movedTask.title, "moved");
    assert.deepEqual(movedTask.modelSelection, {
      instanceId: ProviderInstanceId.make("claude"),
      model: "opus-5",
    });
    assert.equal(movedTask.projectId, otherProjectId);
    // Untouched fields — including the pending due time — survive the move.
    assert.equal(movedTask.prompt, seeded.prompt);
    assert.equal(movedTask.nextRunAt, seeded.nextRunAt);

    // After the move, the old project scope can no longer see or edit it.
    const staleScope = yield* tasks.update({
      id: updateTaskId,
      projectId: updateProjectId,
      title: "should not land",
    });
    assert.isTrue(Option.isNone(staleScope));
    const newScope = yield* tasks.update({
      id: updateTaskId,
      projectId: otherProjectId,
      prompt: "new scope works",
    });
    assert.isTrue(Option.isSome(newScope));
  }).pipe(Effect.provide(updateTestLayer)),
);

// ---------- deterministic scheduler probes ----------
// Post-statement hooks on the service's SqlClient pin the contested windows:
// the due-read hook runs after the SELECT's connection permit is released, so
// a competing edit commits in exactly the read/dispatch gap; the mark-read
// hook proves the dispatch transaction revalidated the row; a follow-up
// due-read gives a sleep-free endpoint after which the iteration is done.
type SqlProbe = (
  statement: string,
  rows: ReadonlyArray<unknown>,
) => Effect.Effect<void, SqlError.SqlError> | void;

let sqlProbe: SqlProbe | null = null;

const gatedSqlClient = Layer.unwrap(
  Effect.gen(function* () {
    const inner = yield* SqlClient.SqlClient;
    const call = inner as (
      strings: TemplateStringsArray,
      ...args: ReadonlyArray<unknown>
    ) => Effect.Effect<ReadonlyArray<unknown>, SqlError.SqlError>;
    const gated = Object.assign((strings: unknown, ...args: ReadonlyArray<unknown>): unknown => {
      if (typeof strings === "string") {
        return (inner as (name: string) => unknown)(strings);
      }
      const statement = call(strings as TemplateStringsArray, ...args);
      const effect = statement.pipe(
        Effect.andThen((rows) => {
          const probe = sqlProbe;
          if (probe === null) return Effect.succeed(rows);
          const text = (strings as TemplateStringsArray).join(" ");
          const hook = probe(text, rows);
          return hook === undefined ? Effect.succeed(rows) : Effect.as(hook, rows);
        }),
      );
      // Piping drops the Fragment interface, which `sql.and` clauses rely on
      // to embed — restore the data props so the gated value stays both an
      // executable Effect and an embeddable fragment.
      return Object.assign(effect, {
        "~effect/sql/Fragment": "~effect/sql/Fragment",
        segments: (statement as unknown as { segments: ReadonlyArray<unknown> }).segments,
      });
    }, inner);
    return Layer.succeed(SqlClient.SqlClient, gated as unknown as SqlClient.SqlClient);
  }),
);

let dispatchLaunchCount = 0;
let dispatchLaunched: Deferred.Deferred<void> | null = null;

const countingLaunchLayer = Layer.mock(ThreadLaunchService.ThreadLaunchService)({
  launch: () =>
    Effect.gen(function* () {
      dispatchLaunchCount += 1;
      const signal = dispatchLaunched;
      if (signal !== null) yield* Deferred.succeed(signal, undefined);
      return {
        threadId: ThreadId.make("thread:scheduled-run"),
        projection: {} as unknown as OrchestrationV2ThreadProjection,
        resumed: false,
      };
    }),
});

// The exact failure a WAL read snapshot raises when a cross-connection
// commit invalidates it mid-transaction (SQLITE_BUSY_SNAPSHOT) — node:sqlite
// reports it via `errcode`, which the classifier misses (UnknownError).
const busySnapshotError = () =>
  new SqlError.SqlError({
    reason: new SqlError.UnknownError({
      cause: Object.assign(new Error("database is locked"), { errcode: 517 }),
    }),
  });

// The same contention as Bun reports it — `code`/`errno`, which the
// classifier maps to a retryable LockTimeoutError. Both shapes must retry.
const bunBusyError = () =>
  new SqlError.SqlError({
    reason: new SqlError.LockTimeoutError({
      cause: Object.assign(new Error("database is locked"), {
        code: "SQLITE_BUSY",
        errno: 5,
      }),
    }),
  });

const gatedDispatchLayer = scheduledTaskServiceLayer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      gatedSqlClient.pipe(Layer.provide(SqlitePersistenceMemory)),
      NodeCrypto.layer,
      countingLaunchLayer,
      Layer.mock(ThreadManagementService.ThreadManagementService)({}),
    ),
  ),
);

const isDueRead = (statement: string) =>
  statement.includes("FROM scheduled_tasks") && statement.includes("next_run_at <=");
const isMarkRead = (statement: string) =>
  statement.includes("FROM scheduled_tasks") &&
  statement.includes("WHERE task_id") &&
  !statement.includes("AND project_id") &&
  !statement.includes("next_run_at <=");
const isTerminalWrite = (statement: string) =>
  statement.includes("UPDATE scheduled_tasks") && statement.includes("run_count = run_count + 1");

// Arms the due-read gate: the first non-empty due read parks the scheduler
// between "found due" and "dispatch"; every later due read ticks nextPoll so
// the test can wait for the iteration to fully drain without sleeping.
const armDueReadGate = (
  dueArrived: Deferred.Deferred<void>,
  dueProceed: Deferred.Deferred<void>,
  nextPoll: Deferred.Deferred<void>,
  rechecked: Deferred.Deferred<void>,
) => {
  let dueSeen = false;
  sqlProbe = (statement, rows) => {
    if (isDueRead(statement)) {
      if (!dueSeen && rows.length > 0) {
        dueSeen = true;
        return Deferred.succeed(dueArrived, undefined).pipe(
          Effect.andThen(Deferred.await(dueProceed)),
        );
      }
      if (dueSeen) return Deferred.succeed(nextPoll, undefined);
      return;
    }
    if (dueSeen && isMarkRead(statement)) {
      return Deferred.succeed(rechecked, undefined);
    }
  };
};

it.effect("scheduled dispatch honours a pause committed after the due read", () =>
  Effect.gen(function* () {
    const tasks = yield* ScheduledTaskService;
    const sql = yield* SqlClient.SqlClient;
    yield* seedTask; // interval 60s: due at T+60s
    const dueArrived = yield* Deferred.make<void>();
    const dueProceed = yield* Deferred.make<void>();
    const rechecked = yield* Deferred.make<void>();
    const nextPoll = yield* Deferred.make<void>();
    dispatchLaunchCount = 0;
    dispatchLaunched = null;
    armDueReadGate(dueArrived, dueProceed, nextPoll, rechecked);
    try {
      const adjust = yield* TestClock.adjust("65 seconds").pipe(Effect.forkChild);
      yield* Deferred.await(dueArrived);
      // The poll found the task due and is parked; pause commits before the
      // dispatch transaction revalidates.
      const paused = yield* tasks.update({
        id: updateTaskId,
        projectId: updateProjectId,
        enabled: false,
      });
      assert.isTrue(Option.isSome(paused));
      yield* Deferred.succeed(dueProceed, undefined);
      yield* Fiber.join(adjust);
      yield* Deferred.await(rechecked); // the mark transaction re-read the row
      yield* TestClock.adjust("5 seconds");
      yield* Deferred.await(nextPoll); // the contested iteration fully drained
      assert.equal(dispatchLaunchCount, 0);
      const row = yield* sql<{
        last_run_status: string;
      }>`SELECT last_run_status FROM scheduled_tasks WHERE task_id = ${updateTaskId}`;
      assert.equal(row[0]?.last_run_status, "never");
    } finally {
      sqlProbe = null;
    }
  }).pipe(Effect.provide(gatedDispatchLayer)),
);

it.effect("scheduled dispatch honours a postpone committed after the due read", () =>
  Effect.gen(function* () {
    const tasks = yield* ScheduledTaskService;
    const sql = yield* SqlClient.SqlClient;
    yield* seedTask;
    const dueArrived = yield* Deferred.make<void>();
    const dueProceed = yield* Deferred.make<void>();
    const rechecked = yield* Deferred.make<void>();
    const nextPoll = yield* Deferred.make<void>();
    dispatchLaunchCount = 0;
    dispatchLaunched = null;
    armDueReadGate(dueArrived, dueProceed, nextPoll, rechecked);
    try {
      const adjust = yield* TestClock.adjust("65 seconds").pipe(Effect.forkChild);
      yield* Deferred.await(dueArrived);
      const postponed = yield* tasks.update({
        id: updateTaskId,
        projectId: updateProjectId,
        schedule: { type: "interval", everyMs: 3_600_000 },
      });
      const postponedAt = Option.getOrThrow(postponed).task.nextRunAt;
      assert.isNotNull(postponedAt);
      yield* Deferred.succeed(dueProceed, undefined);
      yield* Fiber.join(adjust);
      yield* Deferred.await(rechecked);
      yield* TestClock.adjust("5 seconds");
      yield* Deferred.await(nextPoll);
      assert.equal(dispatchLaunchCount, 0);
      const row = yield* sql<{
        next_run_at: string | null;
        last_run_status: string;
      }>`SELECT next_run_at, last_run_status FROM scheduled_tasks WHERE task_id = ${updateTaskId}`;
      // The skipped dispatch must not stamp over the edit's new due time.
      assert.equal(row[0]?.next_run_at, postponedAt);
      assert.equal(row[0]?.last_run_status, "never");
    } finally {
      sqlProbe = null;
    }
  }).pipe(Effect.provide(gatedDispatchLayer)),
);

it.effect("scheduled dispatch honours a delete committed after the due read", () =>
  Effect.gen(function* () {
    const tasks = yield* ScheduledTaskService;
    const sql = yield* SqlClient.SqlClient;
    yield* seedTask;
    const dueArrived = yield* Deferred.make<void>();
    const dueProceed = yield* Deferred.make<void>();
    const rechecked = yield* Deferred.make<void>();
    const nextPoll = yield* Deferred.make<void>();
    dispatchLaunchCount = 0;
    dispatchLaunched = null;
    armDueReadGate(dueArrived, dueProceed, nextPoll, rechecked);
    try {
      const adjust = yield* TestClock.adjust("65 seconds").pipe(Effect.forkChild);
      yield* Deferred.await(dueArrived);
      yield* tasks.delete({ id: updateTaskId });
      yield* Deferred.succeed(dueProceed, undefined);
      yield* Fiber.join(adjust);
      yield* Deferred.await(rechecked);
      yield* TestClock.adjust("5 seconds");
      yield* Deferred.await(nextPoll);
      assert.equal(dispatchLaunchCount, 0);
      const row = yield* sql<{
        n: number;
      }>`SELECT COUNT(*) AS n FROM scheduled_tasks WHERE task_id = ${updateTaskId}`;
      assert.equal(row[0]?.n, 0);
    } finally {
      sqlProbe = null;
    }
  }).pipe(Effect.provide(gatedDispatchLayer)),
);

it.effect("scheduled dispatch still fires when no edit lands in the gap", () =>
  Effect.gen(function* () {
    yield* seedTask;
    const dueArrived = yield* Deferred.make<void>();
    const dueProceed = yield* Deferred.make<void>();
    const rechecked = yield* Deferred.make<void>();
    const nextPoll = yield* Deferred.make<void>();
    const settled = yield* Deferred.make<void>();
    const launched = yield* Deferred.make<void>();
    dispatchLaunchCount = 0;
    dispatchLaunched = launched;
    let dueSeen = false;
    sqlProbe = (statement, rows) => {
      if (isDueRead(statement)) {
        if (!dueSeen && rows.length > 0) {
          dueSeen = true;
          return Deferred.succeed(dueArrived, undefined).pipe(
            Effect.andThen(Deferred.await(dueProceed)),
          );
        }
        if (dueSeen) return Deferred.succeed(nextPoll, undefined);
        return;
      }
      if (dueSeen && isMarkRead(statement)) {
        return Deferred.succeed(rechecked, undefined);
      }
      if (isTerminalWrite(statement)) {
        return Deferred.succeed(settled, undefined);
      }
    };
    try {
      const adjust = yield* TestClock.adjust("65 seconds").pipe(Effect.forkChild);
      yield* Deferred.await(dueArrived);
      yield* Deferred.succeed(dueProceed, undefined);
      yield* Fiber.join(adjust);
      yield* Deferred.await(rechecked);
      yield* Deferred.await(launched);
      yield* Deferred.await(settled);
      assert.equal(dispatchLaunchCount, 1);
      const after = yield* findSeeded;
      assert.equal(after!.lastRunStatus, "succeeded");
      assert.equal(after!.runCount, 1);
    } finally {
      sqlProbe = null;
      dispatchLaunched = null;
    }
  }).pipe(Effect.provide(gatedDispatchLayer)),
);

it.effect("a contended completion write retries instead of stranding the task", () =>
  Effect.gen(function* () {
    const tasks = yield* ScheduledTaskService;
    yield* seedTask;
    dispatchLaunchCount = 0;
    let injected = false;
    sqlProbe = (statement) => {
      // One-shot SQLITE_BUSY_SNAPSHOT on the completion write: without the
      // contention retry the transaction's failure propagates and the row is
      // left last_run_status='running', which due scans then exclude forever.
      if (!injected && isTerminalWrite(statement) && statement.includes("last_run_at =")) {
        injected = true;
        return Effect.fail(busySnapshotError());
      }
    };
    try {
      const ran = yield* tasks.runNow({ id: updateTaskId });
      assert.isTrue(injected); // the probe fired — the retry path ran
      assert.equal(ran.task.lastRunStatus, "succeeded");
      assert.equal(ran.task.runCount, 1);
    } finally {
      sqlProbe = null;
    }
  }).pipe(Effect.provide(gatedDispatchLayer)),
);

it.effect("a contended recovery write retries instead of stranding the task", () =>
  Effect.gen(function* () {
    const tasks = yield* ScheduledTaskService;
    yield* seedTask;
    dispatchLaunchCount = 0;
    let completionFails = 0;
    let releaseFails = 0;
    sqlProbe = (statement) => {
      if (!isTerminalWrite(statement)) return;
      // Fail every completion write past the retry budget so the onError
      // recovery path runs, then fail its terminal write once. Without the
      // contention retry that leaves the row 'running' — excluded from due
      // scans forever. ('failed' is a literal only in releaseStuckRun's SQL.)
      if (statement.includes("last_run_at =")) {
        completionFails += 1;
        return Effect.fail(busySnapshotError());
      }
      if (statement.includes("'failed'")) {
        releaseFails += 1;
        // Bun-style contention shape — exercises the isRetryable branch.
        if (releaseFails === 1) return Effect.fail(bunBusyError());
      }
    };
    try {
      const ran = yield* tasks.runNow({ id: updateTaskId }).pipe(Effect.result);
      assert.isTrue(Result.isFailure(ran)); // the exhausted completion tx surfaces
      const after = yield* findSeeded;
      assert.isAbove(completionFails, 1); // the completion retry really ran
      assert.isAbove(releaseFails, 0); // the recovery write was contested
      assert.equal(after!.lastRunStatus, "failed");
      assert.equal(after!.runCount, 1);
      assert.isNotNull(after!.nextRunAt); // re-aimed, not dropped
    } finally {
      sqlProbe = null;
    }
  }).pipe(Effect.provide(gatedDispatchLayer)),
);

// A second physical connection is required for true contention: the client's
// single connection serializes transactions, so nothing else can interleave
// mid-transaction — a file database plus a raw second handle can.
const fileDbLayer = (dbPath: string) =>
  scheduledTaskServiceLayer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        gatedSqlClient.pipe(Layer.provide(makeSqlitePersistenceLive(dbPath))),
        NodeCrypto.layer,
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
        Layer.mock(ThreadManagementService.ThreadManagementService)({}),
      ),
    ),
  );

// Parks the first scoped-update read (the SELECT inside the update
// transaction) until the test releases it — the deterministic mid-read window
// a competing connection writes into.
const armUpdateReadGate = (readDone: Deferred.Deferred<void>, proceed: Deferred.Deferred<void>) => {
  let fired = false;
  sqlProbe = (statement) => {
    // getScopedRows inside the update transaction.
    if (
      !fired &&
      statement.includes("FROM scheduled_tasks") &&
      statement.includes("AND project_id")
    ) {
      fired = true;
      return Deferred.succeed(readDone, undefined).pipe(Effect.andThen(Deferred.await(proceed)));
    }
  };
};

it.effect("update keeps a project move and a thread binding consistent", () =>
  Effect.gen(function* () {
    const tasks = yield* ScheduledTaskService;
    yield* seedTask;
    yield* seedProjectThreads;
    // Binding to a v2 thread that lives in the task's project works.
    const bound = yield* tasks.update({
      id: updateTaskId,
      projectId: updateProjectId,
      threadId: boundThreadId,
    });
    assert.isTrue(Option.isSome(bound));
    // A v1-only thread cannot be bound: the v2 projection is the only
    // authority dispatch reads, and it has no row for this thread.
    const boundV1 = yield* tasks
      .update({ id: updateTaskId, projectId: updateProjectId, threadId: v1ThreadId })
      .pipe(Effect.result);
    if (Result.isSuccess(boundV1)) assert.fail("expected a typed conflict");
    assert.equal(boundV1.failure._tag, "ScheduledTaskError");
    // A deleted v2 row still wins over a live v1 row for the same thread.
    const deleted = yield* tasks
      .update({ id: updateTaskId, projectId: updateProjectId, threadId: deletedThreadId })
      .pipe(Effect.result);
    if (Result.isSuccess(deleted)) assert.fail("expected a typed conflict");
    assert.equal(deleted.failure._tag, "ScheduledTaskError");
    // The contested merge: a move patch landing on top of the committed
    // binding cannot keep a thread from the old project — the merged pair
    // would fail every dispatch, so it is a typed conflict instead.
    const moved = yield* tasks
      .update({ id: updateTaskId, projectId: updateProjectId, nextProjectId: otherProjectId })
      .pipe(Effect.result);
    if (Result.isSuccess(moved)) assert.fail("expected a typed conflict");
    assert.equal(moved.failure._tag, "ScheduledTaskError");
    const kept = yield* findSeeded;
    assert.equal(kept?.projectId, updateProjectId);
    assert.equal(kept?.threadId, boundThreadId);
    // The explicit escape hatch: unbind and move in the same patch.
    const unbound = yield* tasks.update({
      id: updateTaskId,
      projectId: updateProjectId,
      nextProjectId: otherProjectId,
      threadId: null,
    });
    const movedTask = Option.getOrThrow(unbound).task;
    assert.isNull(movedTask.threadId);
    assert.equal(movedTask.projectId, otherProjectId);
    // The reverse interleaving: after the move, binding a thread from the old
    // project conflicts too.
    const relink = yield* tasks
      .update({ id: updateTaskId, projectId: otherProjectId, threadId: boundThreadId })
      .pipe(Effect.result);
    if (Result.isSuccess(relink)) assert.fail("expected a typed conflict");
    assert.equal(relink.failure._tag, "ScheduledTaskError");
    // And binding a thread that does not exist in the project at all.
    const missing = yield* tasks
      .update({
        id: updateTaskId,
        projectId: otherProjectId,
        threadId: ThreadId.make("thread:nowhere"),
      })
      .pipe(Effect.result);
    if (Result.isSuccess(missing)) assert.fail("expected a typed conflict");
    assert.equal(missing.failure._tag, "ScheduledTaskError");
  }).pipe(Effect.provide(updateTestLayerWithSql)),
);

it.effect("competing updates on separate connections preserve disjoint fields", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectory();
    const dbPath = `${dir}/state.sqlite`;
    yield* Effect.gen(function* () {
      const tasks = yield* ScheduledTaskService;
      yield* seedTask;
      const readDone = yield* Deferred.make<void>();
      const proceed = yield* Deferred.make<void>();
      armUpdateReadGate(readDone, proceed);
      try {
        // The title update parks between its in-transaction read and write.
        const updateFiber = yield* tasks
          .update({ id: updateTaskId, projectId: updateProjectId, title: "title A" })
          .pipe(Effect.forkChild);
        yield* Deferred.await(readDone);
        // A prompt write commits on an independent connection while the
        // first update holds its snapshot.
        const db = new NodeSqlite.DatabaseSync(dbPath);
        try {
          db.exec(
            `UPDATE scheduled_tasks SET prompt = 'prompt B' WHERE task_id = '${updateTaskId}'`,
          );
        } finally {
          db.close();
        }
        yield* Deferred.succeed(proceed, undefined);
        const outcome = yield* Fiber.join(updateFiber);
        assert.isTrue(Option.isSome(outcome));
        const row = yield* findSeeded;
        // Both fields survive a genuinely contested interleaving.
        assert.equal(row?.title, "title A");
        assert.equal(row?.prompt, "prompt B");
      } finally {
        sqlProbe = null;
      }
    }).pipe(Effect.provide(fileDbLayer(dbPath)));
  }).pipe(Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer))),
);

it.effect("a schedule update contended by a committed disable merges on a fresh snapshot", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectory();
    const dbPath = `${dir}/state.sqlite`;
    yield* Effect.gen(function* () {
      const tasks = yield* ScheduledTaskService;
      yield* seedTask;
      const readDone = yield* Deferred.make<void>();
      const proceed = yield* Deferred.make<void>();
      armUpdateReadGate(readDone, proceed);
      try {
        // The schedule update parks with its read snapshot; under WAL its
        // first write attempt after the competing commit lands on a stale
        // snapshot (SQLITE_BUSY_SNAPSHOT) and the service retries, so the
        // patch is rebuilt on the committed state instead of clobbering it.
        const updateFiber = yield* tasks
          .update({
            id: updateTaskId,
            projectId: updateProjectId,
            schedule: { type: "interval", everyMs: 3_600_000 },
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(readDone);
        const db = new NodeSqlite.DatabaseSync(dbPath);
        try {
          db.exec(
            `UPDATE scheduled_tasks SET enabled = 0, next_run_at = NULL WHERE task_id = '${updateTaskId}'`,
          );
        } finally {
          db.close();
        }
        yield* Deferred.succeed(proceed, undefined);
        const outcome = yield* Fiber.join(updateFiber);
        assert.isTrue(Option.isSome(outcome));
        const row = yield* findSeeded;
        // Both edits survive: the disable and the new schedule, with the
        // due time recomputed from the committed state (disabled → null).
        assert.isFalse(row?.enabled);
        assert.isNull(row?.nextRunAt);
        assert.equal(row?.schedule.type, "interval");
        if (row?.schedule.type === "interval") {
          assert.equal(row.schedule.everyMs, 3_600_000);
        }
      } finally {
        sqlProbe = null;
      }
    }).pipe(Effect.provide(fileDbLayer(dbPath)));
  }).pipe(Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer))),
);

it.effect("a delete committed inside the update read window is never resurrected", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectory();
    const dbPath = `${dir}/state.sqlite`;
    yield* Effect.gen(function* () {
      const tasks = yield* ScheduledTaskService;
      yield* seedTask;
      const readDone = yield* Deferred.make<void>();
      const proceed = yield* Deferred.make<void>();
      armUpdateReadGate(readDone, proceed);
      try {
        const updateFiber = yield* tasks
          .update({ id: updateTaskId, projectId: updateProjectId, title: "contended" })
          .pipe(Effect.forkChild);
        yield* Deferred.await(readDone);
        // The update transaction holds its snapshot; this delete commits on
        // an independent connection while the update is parked mid-read.
        const db = new NodeSqlite.DatabaseSync(dbPath);
        try {
          db.exec(`DELETE FROM scheduled_tasks WHERE task_id = '${updateTaskId}'`);
        } finally {
          db.close();
        }
        yield* Deferred.succeed(proceed, undefined);
        const outcome = yield* Fiber.join(updateFiber).pipe(Effect.result);
        // The only permitted result: the committed delete wins and the
        // update reports the task gone — `none`. A typed conflict would mean
        // the delete was misread as a contested edit, and a failure means the
        // contention retry gave up on a single commit; neither is allowed.
        if (Result.isFailure(outcome)) {
          assert.fail(`expected the update to return none, got ${outcome.failure._tag}`);
        }
        assert.isTrue(Option.isNone(outcome.success));
        const check = new NodeSqlite.DatabaseSync(dbPath);
        try {
          const row = check.prepare("SELECT COUNT(*) AS n FROM scheduled_tasks").get() as {
            n: number;
          };
          assert.equal(row.n, 0);
        } finally {
          check.close();
        }
      } finally {
        sqlProbe = null;
      }
    }).pipe(Effect.provide(fileDbLayer(dbPath)));
  }).pipe(Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer))),
);

// Bound-thread lifecycle coverage: the service reads thread liveness from the
// v2 projection table inside its own transactions, so flipping a thread's
// state means writing that row — the map only drives the sendToThread mock,
// which still decides whether an in-flight dispatch is accepted.
const archivedBindingProjectId = ProjectId.make("project:archived-binding");
const archiveBoundThreadId = ThreadId.make("thread:archive-bound");
const boundThreadArchivedAt = "2026-09-10T00:00:00.000Z";
const boundThreadStates = new Map<string, "active" | "archived" | "deleted">();
// Threads with a registered owner reject getProjectThread for other projects;
// unregistered threads accept any project so unrelated tests stay terse.
const boundThreadProjects = new Map<string, string>();
const boundThreadStateOf = (threadId: string) => boundThreadStates.get(threadId) ?? "active";
// Destination thread modes for the execution-mode precondition checks —
// absent entries default to the same modes boundTaskInput stores.
const boundThreadModes = new Map<string, { runtimeMode: string; interactionMode: string }>();
const boundThreadModeOf = (threadId: string) =>
  boundThreadModes.get(threadId) ?? { runtimeMode: "full-access", interactionMode: "default" };
const boundThreadArchivedShells = () =>
  [...boundThreadStates.entries()]
    .filter(([, state]) => state === "archived")
    .map(
      ([id, state]) =>
        ({
          id,
          archivedAt: state === "archived" ? boundThreadArchivedAt : null,
        }) as unknown as OrchestrationV2ThreadShell,
    );

// Mirror a state flip into the projection row the service's in-transaction
// reads consult; boundThreadStates keeps the sendToThread mock honest.
const setBoundThreadState = (
  threadId: ThreadId,
  state: "active" | "archived" | "deleted",
  projectId: ProjectId = archivedBindingProjectId,
) =>
  Effect.gen(function* () {
    boundThreadStates.set(threadId, state);
    boundThreadProjects.set(threadId, projectId);
    const modes = boundThreadModeOf(threadId);
    const sql = yield* SqlClient.SqlClient;
    const now = "2026-09-14T00:00:00.000Z";
    yield* sql`
      INSERT INTO orchestration_v2_projection_threads
        (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
         created_at, updated_at, archived_at, deleted_at, payload_json)
      VALUES (
        ${threadId}, ${projectId}, 'bound', 'codex', ${modes.runtimeMode}, ${modes.interactionMode},
        ${now}, ${now},
        ${state === "archived" ? boundThreadArchivedAt : null},
        ${state === "deleted" ? now : null}, '{}'
      )
      ON CONFLICT (thread_id) DO UPDATE SET
        project_id = excluded.project_id,
        runtime_mode = excluded.runtime_mode,
        interaction_mode = excluded.interaction_mode,
        archived_at = excluded.archived_at,
        deleted_at = excluded.deleted_at
    `;
  });

// The destination modes a bound run executes under — rewrites only the mode
// columns so a thread's archive state survives the flip.
const setBoundThreadModes = (
  threadId: ThreadId,
  modes: { readonly runtimeMode: string; readonly interactionMode: string } | null,
) =>
  Effect.gen(function* () {
    if (modes === null) {
      boundThreadModes.delete(threadId);
    } else {
      boundThreadModes.set(threadId, modes);
    }
    const effective = boundThreadModeOf(threadId);
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      UPDATE orchestration_v2_projection_threads
      SET runtime_mode = ${effective.runtimeMode},
          interaction_mode = ${effective.interactionMode}
      WHERE thread_id = ${threadId}
    `;
  });
let sendToThreadCalls = 0;
// Optional dispatch gate: parks sendToThread between its entry and return so a
// test can land an archive inside a deterministic mid-dispatch window.
// acceptedAtEntry models a send the thread already accepted when the call
// arrived — the archive may land while the dispatch is in flight without the
// send itself being rejected.
let sendBarrier: {
  readonly started: Deferred.Deferred<void>;
  readonly release: Deferred.Deferred<void>;
  readonly acceptedAtEntry?: boolean;
} | null = null;

// The domain-event stream is a parameter so each service instance gets its
// own tail: a shared queue would let a still-running reactor from another
// test steal this test's events.
const boundThreadManagementMock = (domainEvents: Stream.Stream<OrchestrationV2DomainEvent>) =>
  Layer.mock(ThreadManagementService.ThreadManagementService)({
    getThreadShell: (threadId) =>
      Effect.succeed(
        boundThreadStateOf(threadId) === "deleted"
          ? null
          : ({
              id: threadId,
              projectId: boundThreadProjects.get(threadId) ?? archivedBindingProjectId,
              archivedAt:
                boundThreadStateOf(threadId) === "archived" ? boundThreadArchivedAt : null,
              ...boundThreadModeOf(threadId),
            } as unknown as OrchestrationV2ThreadShell),
      ),
    getProjectThread: ({ projectId, threadId }) =>
      boundThreadStateOf(threadId) === "deleted" ||
      (boundThreadProjects.has(threadId) && boundThreadProjects.get(threadId) !== projectId)
        ? Effect.fail(
            new ThreadManagementService.ThreadManagementThreadNotFoundError({
              projectId,
              threadId,
            }),
          )
        : Effect.succeed({
            thread: {
              archivedAt:
                boundThreadStateOf(threadId) === "archived" ? boundThreadArchivedAt : null,
            },
          } as unknown as OrchestrationV2ThreadProjection),
    getShellSnapshot: () =>
      Effect.succeed({
        schemaVersion: 1,
        snapshotSequence: 0,
        threads: [],
        archivedThreads: boundThreadArchivedShells(),
      } as unknown as OrchestrationV2ThreadShellSnapshot),
    streamDomainEvents: domainEvents,
    sendToThread: (input) =>
      Effect.gen(function* () {
        sendToThreadCalls += 1;
        const barrier = sendBarrier;
        const acceptedAtEntry =
          barrier?.acceptedAtEntry === true
            ? boundThreadStateOf(input.threadId) === "active"
            : null;
        if (barrier !== null) {
          yield* Deferred.succeed(barrier.started, undefined);
          yield* Deferred.await(barrier.release);
        }
        const sendable = acceptedAtEntry ?? boundThreadStateOf(input.threadId) === "active";
        if (!sendable) {
          return yield* new ThreadManagementService.ThreadManagementThreadArchivedError({
            threadId: input.threadId,
          });
        }
        return {} as ThreadManagementService.ThreadManagementSendResult;
      }),
  });

const boundThreadTestDeps = Layer.mergeAll(
  SqlitePersistenceMemory,
  NodeCrypto.layer,
  Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
  boundThreadManagementMock(Stream.never),
);

// Same service plus direct SQL access: the tests plant projection and
// event-log state the public API cannot express.
const boundThreadTestLayerWithSql = scheduledTaskServiceLayer.pipe(
  Layer.provideMerge(boundThreadTestDeps),
);

// A persisted thread lifecycle event row. Rows land in insert order, so the
// archive-vs-enable ordering a test wants is just the order these calls run
// in relative to the task writes.
const insertThreadEvent = (threadId: ThreadId, type: string, occurredAt: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const version = yield* sql<{ next: number }>`
      SELECT COALESCE(MAX(stream_version), -1) + 1 AS next
      FROM orchestration_events
      WHERE aggregate_kind = 'thread' AND stream_id = ${threadId}
    `;
    yield* sql`INSERT INTO orchestration_events ${sql.insert({
      event_id: `event:${type}:${threadId}:${occurredAt}:${version[0]?.next ?? 0}`,
      aggregate_kind: "thread",
      stream_id: threadId,
      stream_version: version[0]?.next ?? 0,
      event_type: type,
      occurred_at: occurredAt,
      command_id: null,
      causation_event_id: null,
      correlation_id: null,
      actor_kind: "server",
      payload_json: "{}",
      metadata_json: "{}",
      application_event_version: 2,
    })}`;
  });

// The service layer needs SqlClient itself: this variant lets a test seed raw
// rows before building the service (the startup sweep runs at layer build).
const boundThreadTestDepsWithoutSqlite = Layer.mergeAll(
  NodeCrypto.layer,
  Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
  boundThreadManagementMock(Stream.never),
);

const boundTaskInput = {
  title: "bound",
  prompt: "bound prompt",
  schedule: { type: "interval", everyMs: 60_000 },
  projectId: archivedBindingProjectId,
  threadId: archiveBoundThreadId,
  workspaceStrategy: { type: "root" },
  modelSelection: {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.1-codex",
  },
  runtimeMode: "full-access",
  interactionMode: "default",
  createdBy: "user",
  creationSource: "web",
} as const;

const seedBoundTask = (enabled: boolean) =>
  Effect.gen(function* () {
    const tasks = yield* ScheduledTaskService;
    const { task } = yield* tasks.upsert({ ...boundTaskInput, enabled });
    return task;
  });

const findTaskById = (id: ScheduledTaskId) =>
  Effect.gen(function* () {
    const tasks = yield* ScheduledTaskService;
    const { tasks: all } = yield* tasks.list();
    return all.find((candidate) => candidate.id === id);
  });

it.effect(
  "rejects binding an enabled task to an archived thread while storing a disabled one",
  () =>
    Effect.gen(function* () {
      const tasks = yield* ScheduledTaskService;
      yield* setBoundThreadState(archiveBoundThreadId, "archived");

      const rejected = yield* tasks.upsert({ ...boundTaskInput, enabled: true }).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(rejected));
      if (Exit.isFailure(rejected)) {
        assert.include(Cause.pretty(rejected.cause), "archived");
      }
      assert.isUndefined(
        yield* Effect.map(tasks.list(), ({ tasks: all }) =>
          all.find((candidate) => candidate.threadId === archiveBoundThreadId),
        ),
      );

      const disabled = yield* tasks.upsert({ ...boundTaskInput, enabled: false });
      assert.isFalse(disabled.task.enabled);
      assert.isNull(disabled.task.nextRunAt);
      assert.equal(disabled.task.threadId, archiveBoundThreadId);
    }).pipe(Effect.provide(boundThreadTestLayerWithSql)),
);

it.effect(
  "archiving a bound thread pauses its task; re-enable stays explicit until unarchive",
  () =>
    Effect.gen(function* () {
      const tasks = yield* ScheduledTaskService;
      yield* setBoundThreadState(archiveBoundThreadId, "active");
      const seeded = yield* seedBoundTask(true);
      assert.isNotNull(seeded.nextRunAt);

      yield* setBoundThreadState(archiveBoundThreadId, "archived");
      yield* tasks.pauseForThread(archiveBoundThreadId);
      const paused = yield* findTaskById(seeded.id);
      assert.isDefined(paused);
      assert.isFalse(paused!.enabled);
      assert.isNull(paused!.nextRunAt);

      const rejected = yield* tasks.setEnabled({ id: seeded.id, enabled: true }).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(rejected));
      if (Exit.isFailure(rejected)) {
        assert.include(Cause.pretty(rejected.cause), "archived");
      }

      // Unarchive alone never resumes the task; the explicit re-enable does.
      yield* setBoundThreadState(archiveBoundThreadId, "active");
      const stillPaused = yield* findTaskById(seeded.id);
      assert.isFalse(stillPaused!.enabled);
      const resumed = yield* tasks.setEnabled({ id: seeded.id, enabled: true });
      assert.isTrue(resumed.task.enabled);
      assert.isNotNull(resumed.task.nextRunAt);
    }).pipe(Effect.provide(boundThreadTestLayerWithSql)),
);

it.effect("a stale archive event still pauses a task that was never re-enabled", () =>
  Effect.gen(function* () {
    const tasks = yield* ScheduledTaskService;
    yield* setBoundThreadState(archiveBoundThreadId, "active");
    const seeded = yield* seedBoundTask(true);
    assert.isNotNull(seeded.nextRunAt);

    // The archive event committed after the task was enabled (higher
    // sequence), then the thread was unarchived before the pause landed: the
    // event is stale, but unarchive alone must not resume the schedule. The
    // occurred_at is deliberately earlier than the enable's write time — the
    // ordering comes from commit sequence, not the wall-clock timestamp.
    yield* insertThreadEvent(archiveBoundThreadId, "thread.archived", "1969-12-31T23:59:59.000Z");
    yield* tasks.pauseForThread(archiveBoundThreadId);

    const after = yield* findTaskById(seeded.id);
    assert.isDefined(after);
    assert.isFalse(after!.enabled);
    assert.isNull(after!.nextRunAt);
  }).pipe(Effect.provide(boundThreadTestLayerWithSql)),
);

it.effect("a compacted archive event still pauses via its command receipt", () =>
  Effect.gen(function* () {
    const tasks = yield* ScheduledTaskService;
    const sql = yield* SqlClient.SqlClient;
    yield* setBoundThreadState(archiveBoundThreadId, "active");
    const seeded = yield* seedBoundTask(true);
    assert.isNotNull(seeded.nextRunAt);

    // The archive committed through the command path, then the thread was
    // unarchived and event compaction deleted every superseded state event —
    // only a later non-archive event and the never-compacted command receipt
    // remain. The receipt's result_sequence is the archived event's
    // sequence, so the enablement watermark still sees the archive and the
    // task pauses instead of dispatching without an explicit re-enable.
    yield* insertThreadEvent(archiveBoundThreadId, "thread.archived", "2026-01-01T00:00:01.000Z");
    const archivedSeq = yield* sql<{ readonly sequence: number }>`
      SELECT sequence FROM orchestration_events
      WHERE aggregate_kind = 'thread' AND stream_id = ${archiveBoundThreadId}
        AND event_type = 'thread.archived'
    `;
    yield* sql`INSERT INTO orchestration_command_receipts ${sql.insert({
      command_id: "command:archive:compacted",
      aggregate_kind: "thread",
      aggregate_id: archiveBoundThreadId,
      command_type: "thread.archive",
      accepted_at: "2026-01-01T00:00:01.000Z",
      result_sequence: archivedSeq[0]!.sequence,
      status: "accepted",
      error: null,
    })}`;
    yield* insertThreadEvent(archiveBoundThreadId, "thread.unarchived", "2026-01-01T00:00:02.000Z");
    yield* insertThreadEvent(archiveBoundThreadId, "thread.pinned", "2026-01-01T00:00:03.000Z");
    yield* sql`
      DELETE FROM orchestration_events
      WHERE aggregate_kind = 'thread' AND stream_id = ${archiveBoundThreadId}
        AND event_type IN ('thread.archived', 'thread.unarchived')
    `;

    yield* tasks.pauseForThread(archiveBoundThreadId);
    const after = yield* findTaskById(seeded.id);
    assert.isDefined(after);
    assert.isFalse(after!.enabled);
    assert.isNull(after!.nextRunAt);
  }).pipe(Effect.provide(boundThreadTestLayerWithSql)),
);

it.effect("a stale archive event spares an explicit post-unarchive re-enable", () =>
  Effect.gen(function* () {
    const tasks = yield* ScheduledTaskService;
    const sql = yield* SqlClient.SqlClient;
    yield* setBoundThreadState(archiveBoundThreadId, "active");
    const seeded = yield* seedBoundTask(true);

    // The archive committed, the pause landed, the thread was unarchived, and
    // the task was explicitly re-enabled after — the re-enable's enabled_seq
    // watermarks past the unarchive event, newer than the archive's sequence.
    yield* insertThreadEvent(archiveBoundThreadId, "thread.archived", "2026-01-01T00:00:01.000Z");
    yield* setBoundThreadState(archiveBoundThreadId, "archived");
    yield* tasks.pauseForThread(archiveBoundThreadId);
    yield* insertThreadEvent(archiveBoundThreadId, "thread.unarchived", "2026-01-01T00:00:02.000Z");
    yield* setBoundThreadState(archiveBoundThreadId, "active");
    const resumed = yield* tasks.setEnabled({ id: seeded.id, enabled: true });
    assert.isTrue(resumed.task.enabled);
    const row = yield* sql<{
      enabled_seq: number | null;
    }>`SELECT enabled_seq FROM scheduled_tasks WHERE task_id = ${seeded.id}`;
    assert.isNotNull(row[0]?.enabled_seq);

    // The delayed archive event finally arrives; the re-enable must stand.
    yield* tasks.pauseForThread(archiveBoundThreadId);
    const after = yield* findTaskById(seeded.id);
    assert.isDefined(after);
    assert.isTrue(after!.enabled);
    assert.isNotNull(after!.nextRunAt);
  }).pipe(Effect.provide(boundThreadTestLayerWithSql)),
);

it.effect("an explicit enable after unarchive is spared even if the pause never ran", () =>
  Effect.gen(function* () {
    const tasks = yield* ScheduledTaskService;
    yield* setBoundThreadState(archiveBoundThreadId, "active");
    const seeded = yield* seedBoundTask(true);

    // Archive and unarchive both commit while the archive event is still
    // queued, so the pause never landed and the task is still enabled. The
    // explicit enable that follows — a no-op flag-wise — must still
    // re-watermark past the archive, or the delayed event pauses a task the
    // user affirmatively enabled.
    yield* insertThreadEvent(archiveBoundThreadId, "thread.archived", "2026-01-01T00:00:01.000Z");
    yield* insertThreadEvent(archiveBoundThreadId, "thread.unarchived", "2026-01-01T00:00:02.000Z");
    const affirmed = yield* tasks.setEnabled({ id: seeded.id, enabled: true });
    assert.isTrue(affirmed.task.enabled);

    yield* tasks.pauseForThread(archiveBoundThreadId);
    const after = yield* findTaskById(seeded.id);
    assert.isDefined(after);
    assert.isTrue(after!.enabled);
    assert.isNotNull(after!.nextRunAt);
  }).pipe(Effect.provide(boundThreadTestLayerWithSql)),
);

it.effect("an enabled:true update after unarchive re-affirms an already-enabled task", () =>
  Effect.gen(function* () {
    const tasks = yield* ScheduledTaskService;
    yield* setBoundThreadState(archiveBoundThreadId, "active");
    const seeded = yield* seedBoundTask(true);

    yield* insertThreadEvent(archiveBoundThreadId, "thread.archived", "2026-01-01T00:00:01.000Z");
    yield* insertThreadEvent(archiveBoundThreadId, "thread.unarchived", "2026-01-01T00:00:02.000Z");
    const updated = yield* tasks.update({
      id: seeded.id,
      projectId: archivedBindingProjectId,
      enabled: true,
    });
    assert.isTrue(Option.isSome(updated));

    yield* tasks.pauseForThread(archiveBoundThreadId);
    const after = yield* findTaskById(seeded.id);
    assert.isDefined(after);
    assert.isTrue(after!.enabled);
    assert.isNotNull(after!.nextRunAt);
  }).pipe(Effect.provide(boundThreadTestLayerWithSql)),
);

const overdueNextRunAt = "2020-01-01T00:00:00.000Z";

// The task's stored enablement was voided by a committed archive whose pause
// never landed (unarchive beat the reactor), leaving an overdue next_run_at.
// Any explicit re-enable is a resume: the interval must restart from now, not
// fire the stale due time a pre-archive schedule left behind.
const pinOverdueAndArchive = (taskId: ScheduledTaskId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE scheduled_tasks SET next_run_at = ${overdueNextRunAt} WHERE task_id = ${taskId}`;
    yield* insertThreadEvent(archiveBoundThreadId, "thread.archived", "2026-01-01T00:00:01.000Z");
    yield* insertThreadEvent(archiveBoundThreadId, "thread.unarchived", "2026-01-01T00:00:02.000Z");
  });

it.effect("a setEnabled resume after a delayed archive restarts the interval", () =>
  Effect.gen(function* () {
    const tasks = yield* ScheduledTaskService;
    yield* setBoundThreadState(archiveBoundThreadId, "active");
    const seeded = yield* seedBoundTask(true);
    yield* pinOverdueAndArchive(seeded.id);

    const affirmed = yield* tasks.setEnabled({ id: seeded.id, enabled: true });
    assert.isTrue(affirmed.task.enabled);
    assert.isNotNull(affirmed.task.nextRunAt);
    assert.notEqual(affirmed.task.nextRunAt, overdueNextRunAt);
    // The interval restarted from now — under the frozen test clock this is
    // exactly the value the original seed produced.
    assert.equal(affirmed.task.nextRunAt, seeded.nextRunAt);

    // The delayed archive event must still spare the affirmed enablement.
    yield* tasks.pauseForThread(archiveBoundThreadId);
    const after = yield* findTaskById(seeded.id);
    assert.isTrue(after!.enabled);
    assert.isNotNull(after!.nextRunAt);
  }).pipe(Effect.provide(boundThreadTestLayerWithSql)),
);

it.effect("an enabled:true update resume after a delayed archive restarts the interval", () =>
  Effect.gen(function* () {
    const tasks = yield* ScheduledTaskService;
    yield* setBoundThreadState(archiveBoundThreadId, "active");
    const seeded = yield* seedBoundTask(true);
    yield* pinOverdueAndArchive(seeded.id);

    const updated = yield* tasks.update({
      id: seeded.id,
      projectId: archivedBindingProjectId,
      enabled: true,
    });
    assert.isTrue(Option.isSome(updated));
    const updatedTask = Option.getOrThrow(updated).task;
    assert.isNotNull(updatedTask.nextRunAt);
    assert.notEqual(updatedTask.nextRunAt, overdueNextRunAt);
    assert.equal(updatedTask.nextRunAt, seeded.nextRunAt);

    yield* tasks.pauseForThread(archiveBoundThreadId);
    const after = yield* findTaskById(seeded.id);
    assert.isTrue(after!.enabled);
    assert.isNotNull(after!.nextRunAt);
  }).pipe(Effect.provide(boundThreadTestLayerWithSql)),
);

it.effect("an unchanged-schedule upsert resume after a delayed archive restarts the interval", () =>
  Effect.gen(function* () {
    const tasks = yield* ScheduledTaskService;
    yield* setBoundThreadState(archiveBoundThreadId, "active");
    const seeded = yield* seedBoundTask(true);
    yield* pinOverdueAndArchive(seeded.id);

    const { task: saved } = yield* tasks.upsert({
      ...boundTaskInput,
      id: seeded.id,
      enabled: true,
    });
    assert.isNotNull(saved.nextRunAt);
    assert.notEqual(saved.nextRunAt, overdueNextRunAt);
    assert.equal(saved.nextRunAt, seeded.nextRunAt);

    yield* tasks.pauseForThread(archiveBoundThreadId);
    const after = yield* findTaskById(seeded.id);
    assert.isTrue(after!.enabled);
    assert.isNotNull(after!.nextRunAt);
  }).pipe(Effect.provide(boundThreadTestLayerWithSql)),
);

it.effect(
  "a due run pauses instead of dispatching while an archive+unarchive pause is pending",
  () =>
    Effect.gen(function* () {
      const tasks = yield* ScheduledTaskService;
      yield* setBoundThreadState(archiveBoundThreadId, "active");
      sendToThreadCalls = 0;
      const seeded = yield* seedBoundTask(true);

      // Archive and unarchive committed while the archive event is still queued
      // for the reactor, so the pause never landed. Unarchive alone must not
      // resume the schedule: the claim transaction sees the committed archive
      // postdate the task's enablement and pauses instead of dispatching.
      yield* insertThreadEvent(archiveBoundThreadId, "thread.archived", "2026-01-01T00:00:01.000Z");
      yield* insertThreadEvent(
        archiveBoundThreadId,
        "thread.unarchived",
        "2026-01-01T00:00:02.000Z",
      );

      const attempted = yield* tasks.runNow({ id: seeded.id }).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(attempted));
      assert.equal(sendToThreadCalls, 0);
      const after = yield* findTaskById(seeded.id);
      assert.isDefined(after);
      assert.isFalse(after!.enabled);
      assert.isNull(after!.nextRunAt);
    }).pipe(Effect.provide(boundThreadTestLayerWithSql)),
);

it.effect("a legacy NULL-watermark task is spared on a never-archived thread", () =>
  Effect.gen(function* () {
    const tasks = yield* ScheduledTaskService;
    const sql = yield* SqlClient.SqlClient;
    yield* setBoundThreadState(archiveBoundThreadId, "active");
    const seeded = yield* seedBoundTask(true);
    // A row enabled before enabled_seq existed carries NULL. A pause pass on
    // a thread with no committed archive must leave it alone.
    yield* sql`UPDATE scheduled_tasks SET enabled_seq = NULL WHERE task_id = ${seeded.id}`;
    yield* tasks.pauseForThread(archiveBoundThreadId);

    const after = yield* findTaskById(seeded.id);
    assert.isDefined(after);
    assert.isTrue(after!.enabled);
    assert.isNotNull(after!.nextRunAt);
  }).pipe(Effect.provide(boundThreadTestLayerWithSql)),
);

it.effect("a legacy NULL-watermark task pauses when its thread has archive history", () =>
  Effect.gen(function* () {
    const tasks = yield* ScheduledTaskService;
    const sql = yield* SqlClient.SqlClient;
    yield* setBoundThreadState(archiveBoundThreadId, "active");
    const seeded = yield* seedBoundTask(true);
    yield* sql`UPDATE scheduled_tasks SET enabled_seq = NULL WHERE task_id = ${seeded.id}`;
    // The thread was archived after the task existed, then unarchived before
    // the pause landed — unarchive alone must not spare the legacy row.
    yield* insertThreadEvent(archiveBoundThreadId, "thread.archived", "2026-01-01T00:00:01.000Z");
    yield* tasks.pauseForThread(archiveBoundThreadId);

    const after = yield* findTaskById(seeded.id);
    assert.isDefined(after);
    assert.isFalse(after!.enabled);
    assert.isNull(after!.nextRunAt);
  }).pipe(Effect.provide(boundThreadTestLayerWithSql)),
);

it.effect("rebinding an enabled task is not undone by the destination's earlier archive", () =>
  Effect.gen(function* () {
    const tasks = yield* ScheduledTaskService;
    const rearchiveBoundThreadId = ThreadId.make("thread:previously-archived");
    yield* setBoundThreadState(archiveBoundThreadId, "active");
    yield* setBoundThreadState(rearchiveBoundThreadId, "active");
    const seeded = yield* seedBoundTask(true);

    // The destination thread was archived and unarchived before the task was
    // ever bound to it. The rebind refreshes enabled_seq past that archive,
    // so a delayed pause pass must not disable the healthy task.
    yield* insertThreadEvent(rearchiveBoundThreadId, "thread.archived", "2026-01-01T00:00:01.000Z");
    yield* insertThreadEvent(
      rearchiveBoundThreadId,
      "thread.unarchived",
      "2026-01-01T00:00:02.000Z",
    );
    const rebound = yield* tasks.update({
      id: seeded.id,
      projectId: archivedBindingProjectId,
      threadId: rearchiveBoundThreadId,
    });
    assert.isTrue(Option.isSome(rebound));
    assert.isTrue(Option.getOrThrow(rebound).task.enabled);

    yield* tasks.pauseForThread(rearchiveBoundThreadId);
    const after = yield* findTaskById(seeded.id);
    assert.isDefined(after);
    assert.isTrue(after!.enabled);
    assert.isNotNull(after!.nextRunAt);
  }).pipe(Effect.provide(boundThreadTestLayerWithSql)),
);

it.effect("rebinding off a voided binding restarts the interval on the healthy thread", () =>
  Effect.gen(function* () {
    const tasks = yield* ScheduledTaskService;
    const rearchiveBoundThreadId = ThreadId.make("thread:rebound-healthy");
    yield* setBoundThreadState(archiveBoundThreadId, "active");
    yield* setBoundThreadState(rearchiveBoundThreadId, "active");
    const seeded = yield* seedBoundTask(true);
    // The stored binding's enablement was voided: archive+unarchive committed
    // while the pause is still queued, leaving an overdue due time behind.
    yield* pinOverdueAndArchive(seeded.id);

    const rebound = yield* tasks.update({
      id: seeded.id,
      projectId: archivedBindingProjectId,
      threadId: rearchiveBoundThreadId,
      enabled: true,
    });
    const reboundTask = Option.getOrThrow(rebound).task;
    assert.equal(reboundTask.threadId, rearchiveBoundThreadId);
    assert.isTrue(reboundTask.enabled);
    // The invalidation belongs to the stored binding — the move must restart
    // the interval, not carry the overdue due time onto the new thread.
    assert.notEqual(reboundTask.nextRunAt, overdueNextRunAt);
    assert.equal(reboundTask.nextRunAt, seeded.nextRunAt);
  }).pipe(Effect.provide(boundThreadTestLayerWithSql)),
);

it.effect("rebinding onto a previously archived thread keeps the pending due time", () =>
  Effect.gen(function* () {
    const tasks = yield* ScheduledTaskService;
    const sql = yield* SqlClient.SqlClient;
    const rearchiveBoundThreadId = ThreadId.make("thread:rebound-stale-history");
    yield* setBoundThreadState(archiveBoundThreadId, "active");
    yield* setBoundThreadState(rearchiveBoundThreadId, "active");
    const seeded = yield* seedBoundTask(true);
    // A pending due time mid-interval — the value a wrongful "resume" would
    // overwrite with a fresh interval.
    const pendingDueAt = "2020-06-01T00:00:00.000Z";
    yield* sql`UPDATE scheduled_tasks SET next_run_at = ${pendingDueAt} WHERE task_id = ${seeded.id}`;
    // The destination's archive+unarchive predate this binding entirely; the
    // stored binding was never archived, so this enablement is intact.
    yield* insertThreadEvent(rearchiveBoundThreadId, "thread.archived", "2026-01-01T00:00:01.000Z");
    yield* insertThreadEvent(
      rearchiveBoundThreadId,
      "thread.unarchived",
      "2026-01-01T00:00:02.000Z",
    );

    const rebound = yield* tasks.update({
      id: seeded.id,
      projectId: archivedBindingProjectId,
      threadId: rearchiveBoundThreadId,
      enabled: true,
    });
    const reboundTask = Option.getOrThrow(rebound).task;
    assert.equal(reboundTask.threadId, rearchiveBoundThreadId);
    assert.equal(reboundTask.nextRunAt, pendingDueAt);

    // The rebind watermarked past the destination's old archive, so its
    // delayed pause must not disable the healthy task.
    yield* tasks.pauseForThread(rearchiveBoundThreadId);
    const after = yield* findTaskById(seeded.id);
    assert.isTrue(after!.enabled);
    assert.equal(after!.nextRunAt, pendingDueAt);
  }).pipe(Effect.provide(boundThreadTestLayerWithSql)),
);

it.effect("unbinding a voided binding restarts the interval on the launch path", () =>
  Effect.gen(function* () {
    const tasks = yield* ScheduledTaskService;
    yield* setBoundThreadState(archiveBoundThreadId, "active");
    const seeded = yield* seedBoundTask(true);
    yield* pinOverdueAndArchive(seeded.id);

    const unbound = yield* tasks.update({
      id: seeded.id,
      projectId: archivedBindingProjectId,
      threadId: null,
      enabled: true,
    });
    const unboundTask = Option.getOrThrow(unbound).task;
    assert.isNull(unboundTask.threadId);
    assert.isTrue(unboundTask.enabled);
    assert.notEqual(unboundTask.nextRunAt, overdueNextRunAt);
    assert.equal(unboundTask.nextRunAt, seeded.nextRunAt);
  }).pipe(Effect.provide(boundThreadTestLayerWithSql)),
);

it.effect("an upsert whose write lands after a committed pause restarts fresh", () =>
  Effect.gen(function* () {
    yield* Effect.scoped(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const gateArmed = yield* Ref.make(false);
        const deps = yield* Layer.build(
          Layer.mergeAll(
            SqlitePersistenceMemory,
            NodeCrypto.layer,
            Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
            boundThreadManagementMock(Stream.never),
          ),
        );
        const sqlClient = Context.get(deps, SqlClient.SqlClient);
        const realWithTransaction = sqlClient.withTransaction;
        Object.assign(sqlClient, {
          withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
            Effect.suspend(() =>
              Ref.modify(gateArmed, (armed) => (armed ? [true, false] : [false, armed])),
            ).pipe(
              Effect.flatMap((gated) =>
                gated
                  ? Deferred.succeed(entered, undefined).pipe(
                      Effect.andThen(Deferred.await(release)),
                      Effect.andThen(realWithTransaction(effect)),
                    )
                  : realWithTransaction(effect),
              ),
            ),
        });
        const context = yield* Layer.build(
          scheduledTaskServiceLayer.pipe(Layer.provide(Layer.succeedContext(deps))),
        );
        const tasks = Context.get(context, ScheduledTaskService);
        yield* setBoundThreadState(archiveBoundThreadId, "active");
        const { task: seeded } = yield* tasks.upsert({ ...boundTaskInput, enabled: true });
        yield* sqlClient`UPDATE scheduled_tasks SET next_run_at = ${overdueNextRunAt} WHERE task_id = ${seeded.id}`;

        // The upsert's whole transaction is parked while the archive pause
        // commits: the row it reads must already be the paused one, or the
        // save would restore the overdue due time the pause just cleared.
        yield* Ref.set(gateArmed, true);
        const upsertExit = yield* tasks
          .upsert({ ...boundTaskInput, id: seeded.id, enabled: true })
          .pipe(Effect.exit, Effect.forkChild);
        yield* Deferred.await(entered);
        yield* insertThreadEvent(
          archiveBoundThreadId,
          "thread.archived",
          "2026-01-01T00:00:01.000Z",
        );
        yield* setBoundThreadState(archiveBoundThreadId, "archived");
        yield* tasks.pauseForThread(archiveBoundThreadId);
        yield* insertThreadEvent(
          archiveBoundThreadId,
          "thread.unarchived",
          "2026-01-01T00:00:02.000Z",
        );
        yield* setBoundThreadState(archiveBoundThreadId, "active");
        yield* Deferred.succeed(release, undefined);
        const saved = yield* Fiber.join(upsertExit);
        assert.isTrue(Exit.isSuccess(saved));
        if (Exit.isSuccess(saved)) {
          assert.isTrue(saved.value.task.enabled);
          assert.isNotNull(saved.value.task.nextRunAt);
          assert.notEqual(saved.value.task.nextRunAt, overdueNextRunAt);
        }
      }),
    );
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("a binding-only update on a voided enablement restarts the interval", () =>
  Effect.gen(function* () {
    const tasks = yield* ScheduledTaskService;
    const rearchiveBoundThreadId = ThreadId.make("thread:rebound-binding-only");
    yield* setBoundThreadState(archiveBoundThreadId, "active");
    yield* setBoundThreadState(rearchiveBoundThreadId, "active");
    const seeded = yield* seedBoundTask(true);
    yield* pinOverdueAndArchive(seeded.id);

    // No enabled field at all: the rebind alone refreshes the watermark past
    // the stored binding's archive, escaping the queued pause — so the
    // overdue due time must restart rather than fire on the new thread.
    const rebound = yield* tasks.update({
      id: seeded.id,
      projectId: archivedBindingProjectId,
      threadId: rearchiveBoundThreadId,
    });
    const reboundTask = Option.getOrThrow(rebound).task;
    assert.isTrue(reboundTask.enabled);
    assert.equal(reboundTask.threadId, rearchiveBoundThreadId);
    assert.notEqual(reboundTask.nextRunAt, overdueNextRunAt);
    assert.equal(reboundTask.nextRunAt, seeded.nextRunAt);

    yield* tasks.pauseForThread(rearchiveBoundThreadId);
    const after = yield* findTaskById(seeded.id);
    assert.isTrue(after!.enabled);
  }).pipe(Effect.provide(boundThreadTestLayerWithSql)),
);

it.effect("update rejects when the destination thread's modes drifted since authorization", () =>
  Effect.gen(function* () {
    const tasks = yield* ScheduledTaskService;
    yield* setBoundThreadState(archiveBoundThreadId, "active");
    const seeded = yield* seedBoundTask(true);

    // The destination's modes elevated after the caller pinned full-access —
    // the write must fail rather than arm the task under modes the caller
    // never authorized.
    const drifted = yield* tasks
      .update({
        id: seeded.id,
        projectId: archivedBindingProjectId,
        title: "stale modes",
        expectedExecutionRuntimeMode: "approval-required",
      })
      .pipe(Effect.exit);
    assert.isTrue(Exit.isFailure(drifted));
    if (Exit.isFailure(drifted)) {
      assert.include(Cause.pretty(drifted.cause), "changed since it was loaded");
    }

    // Matching expected execution modes proceed normally.
    yield* setBoundThreadModes(archiveBoundThreadId, {
      runtimeMode: "approval-required",
      interactionMode: "plan",
    });
    const matched = yield* tasks.update({
      id: seeded.id,
      projectId: archivedBindingProjectId,
      title: "authorized",
      expectedExecutionRuntimeMode: "approval-required",
      expectedExecutionInteractionMode: "plan",
    });
    assert.equal(Option.getOrThrow(matched).task.title, "authorized");
    yield* setBoundThreadModes(archiveBoundThreadId, null);
  }).pipe(Effect.provide(boundThreadTestLayerWithSql)),
);

it.effect("update and delete reject a row that drifted since the caller loaded it", () =>
  Effect.gen(function* () {
    const tasks = yield* ScheduledTaskService;
    yield* setBoundThreadState(archiveBoundThreadId, "active");
    const seeded = yield* seedBoundTask(true);

    const driftedUpdate = yield* tasks
      .update({
        id: seeded.id,
        projectId: archivedBindingProjectId,
        title: "stale",
        expectedRuntimeMode: "approval-required",
      })
      .pipe(Effect.exit);
    assert.isTrue(Exit.isFailure(driftedUpdate));
    if (Exit.isFailure(driftedUpdate)) {
      assert.include(Cause.pretty(driftedUpdate.cause), "changed since it was loaded");
    }

    const driftedDelete = yield* tasks
      .delete({ id: seeded.id, expectedThreadId: null })
      .pipe(Effect.exit);
    assert.isTrue(Exit.isFailure(driftedDelete));
    assert.isDefined(yield* findTaskById(seeded.id));

    // A delete authorized against a scoped load must not land after the task
    // moved to another project — the pin catches a relocated row too.
    const relocatedDelete = yield* tasks
      .delete({
        id: seeded.id,
        expectedProjectId: ProjectId.make("project:other-project"),
      })
      .pipe(Effect.exit);
    assert.isTrue(Exit.isFailure(relocatedDelete));
    assert.isDefined(yield* findTaskById(seeded.id));

    // The same preconditions succeed when they match the committed row.
    const matched = yield* tasks.update({
      id: seeded.id,
      projectId: archivedBindingProjectId,
      title: "pinned",
      expectedThreadId: archiveBoundThreadId,
      expectedRuntimeMode: "full-access",
      expectedInteractionMode: "default",
    });
    assert.equal(Option.getOrThrow(matched).task.title, "pinned");

    const deleted = yield* tasks.delete({
      id: seeded.id,
      expectedProjectId: archivedBindingProjectId,
      expectedThreadId: archiveBoundThreadId,
    });
    assert.equal(deleted.id, seeded.id);
    assert.isUndefined(yield* findTaskById(seeded.id));
  }).pipe(Effect.provide(boundThreadTestLayerWithSql)),
);

it.effect("update cannot enable or bind an archived-thread task, but unbinding stays allowed", () =>
  Effect.gen(function* () {
    const tasks = yield* ScheduledTaskService;
    yield* setBoundThreadState(archiveBoundThreadId, "active");
    const pausedBound = yield* seedBoundTask(false);
    const { task: unbound } = yield* tasks.upsert({
      ...boundTaskInput,
      enabled: true,
      threadId: null,
    });

    yield* setBoundThreadState(archiveBoundThreadId, "archived");

    const enableRejected = yield* tasks
      .update({ id: pausedBound.id, projectId: archivedBindingProjectId, enabled: true })
      .pipe(Effect.exit);
    assert.isTrue(Exit.isFailure(enableRejected));

    const bindRejected = yield* tasks
      .update({
        id: unbound.id,
        projectId: archivedBindingProjectId,
        threadId: archiveBoundThreadId,
      })
      .pipe(Effect.exit);
    assert.isTrue(Exit.isFailure(bindRejected));
    const unboundTask = yield* findTaskById(unbound.id);
    assert.isNull(unboundTask!.threadId);

    // Unbinding while archived is the supported escape hatch.
    const unboundUpdate = yield* tasks.update({
      id: pausedBound.id,
      projectId: archivedBindingProjectId,
      enabled: true,
      threadId: null,
    });
    assert.isTrue(Option.isSome(unboundUpdate));
    assert.isTrue(Option.getOrThrow(unboundUpdate).task.enabled);
    assert.isNull(Option.getOrThrow(unboundUpdate).task.threadId);
    assert.isNotNull(Option.getOrThrow(unboundUpdate).task.nextRunAt);
  }).pipe(Effect.provide(boundThreadTestLayerWithSql)),
);

// Parks the next sql.withTransaction call between two Deferreds so a second
// mutation can commit deterministically in the gap. With the bound-thread
// guard outside the transaction, setEnabled validates the stale pre-image
// and then enables the racing update's binding; inside the transaction it
// re-reads the committed row and rejects.
it.effect("an enable racing a committed rebind still validates the new binding", () =>
  Effect.gen(function* () {
    yield* Effect.scoped(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const gateArmed = yield* Ref.make(false);
        // Wrap the built SqlClient instance in place so the service sees the
        // gate regardless of layer-merge precedence.
        const deps = yield* Layer.build(
          Layer.mergeAll(
            SqlitePersistenceMemory,
            NodeCrypto.layer,
            Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
            boundThreadManagementMock(Stream.never),
          ),
        );
        const sqlClient = Context.get(deps, SqlClient.SqlClient);
        const realWithTransaction = sqlClient.withTransaction;
        Object.assign(sqlClient, {
          withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
            Effect.suspend(() =>
              Ref.modify(gateArmed, (armed) => (armed ? [true, false] : [false, armed])),
            ).pipe(
              Effect.flatMap((gated) =>
                gated
                  ? Deferred.succeed(entered, undefined).pipe(
                      Effect.andThen(Deferred.await(release)),
                      Effect.andThen(realWithTransaction(effect)),
                    )
                  : realWithTransaction(effect),
              ),
            ),
        });
        const context = yield* Layer.build(
          scheduledTaskServiceLayer.pipe(Layer.provide(Layer.succeedContext(deps))),
        );
        const tasks = Context.get(context, ScheduledTaskService);
        const { task: seeded } = yield* tasks.upsert({
          ...boundTaskInput,
          enabled: false,
          threadId: null,
        });
        // The service runs on the explicitly-built sqlClient — a second
        // in-memory database — so the projection row must be written there,
        // not through the test's ambient client.
        yield* setBoundThreadState(archiveBoundThreadId, "archived").pipe(
          Effect.provideService(SqlClient.SqlClient, sqlClient),
        );

        // setEnabled parks just before its transaction; the concurrent
        // update then commits the archived binding while the task is still
        // disabled — the only interleaving the old outside-transaction check
        // could miss.
        yield* Ref.set(gateArmed, true);
        const enableExit = yield* tasks
          .setEnabled({ id: seeded.id, enabled: true })
          .pipe(Effect.exit, Effect.forkChild);
        yield* Deferred.await(entered);
        const bound = yield* tasks.update({
          id: seeded.id,
          projectId: archivedBindingProjectId,
          threadId: archiveBoundThreadId,
        });
        assert.isTrue(Option.isSome(bound));
        yield* Deferred.succeed(release, undefined);
        const enable = yield* Fiber.join(enableExit);
        assert.isTrue(Exit.isFailure(enable));
        const after = yield* Effect.map(tasks.list(), ({ tasks: all }) =>
          all.find((candidate) => candidate.id === seeded.id),
        );
        assert.isDefined(after);
        assert.isFalse(after!.enabled);
      }),
    );
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("a binding committed while disabled is still caught when enabling", () =>
  Effect.gen(function* () {
    const tasks = yield* ScheduledTaskService;
    const { task: seeded } = yield* tasks.upsert({
      ...boundTaskInput,
      enabled: false,
      threadId: null,
    });

    // The bind lands while the task is disabled — allowed, since a stored
    // disabled task may point anywhere. The enable that follows must still
    // validate the binding the earlier write committed.
    yield* setBoundThreadState(archiveBoundThreadId, "archived");
    const bound = yield* tasks.update({
      id: seeded.id,
      projectId: archivedBindingProjectId,
      threadId: archiveBoundThreadId,
    });
    assert.isTrue(Option.isSome(bound));
    assert.equal(Option.getOrThrow(bound).task.threadId, archiveBoundThreadId);

    const rejected = yield* tasks.setEnabled({ id: seeded.id, enabled: true }).pipe(Effect.exit);
    assert.isTrue(Exit.isFailure(rejected));
    if (Exit.isFailure(rejected)) {
      assert.include(Cause.pretty(rejected.cause), "archived");
    }
  }).pipe(Effect.provide(boundThreadTestLayerWithSql)),
);

it.effect("a run firing against a cross-project thread pauses instead of dispatching", () =>
  Effect.gen(function* () {
    const tasks = yield* ScheduledTaskService;
    const crossProjectThreadId = ThreadId.make("thread:archive-cross-project");
    yield* setBoundThreadState(crossProjectThreadId, "active");
    sendToThreadCalls = 0;
    const { task: seeded } = yield* tasks.upsert({
      ...boundTaskInput,
      enabled: true,
      threadId: crossProjectThreadId,
    });

    // The thread is owned by another project — a binding that write-time
    // validation can no longer produce, but the fire-time check must still
    // pause it rather than loop a guaranteed sendToThread rejection.
    yield* setBoundThreadState(
      crossProjectThreadId,
      "active",
      ProjectId.make("project:other-owner"),
    );
    const attempted = yield* tasks.runNow({ id: seeded.id }).pipe(Effect.exit);
    assert.isTrue(Exit.isFailure(attempted));
    assert.equal(sendToThreadCalls, 0);
    const after = yield* findTaskById(seeded.id);
    assert.isDefined(after);
    assert.isFalse(after!.enabled);
    assert.isNull(after!.nextRunAt);
  }).pipe(Effect.provide(boundThreadTestLayerWithSql)),
);

it.effect("a run firing after its bound thread is deleted pauses instead of dispatching", () =>
  Effect.gen(function* () {
    const tasks = yield* ScheduledTaskService;
    const deletedThreadId = ThreadId.make("thread:fire-deleted");
    yield* setBoundThreadState(deletedThreadId, "active");
    sendToThreadCalls = 0;
    const { task: seeded } = yield* tasks.upsert({
      ...boundTaskInput,
      enabled: true,
      threadId: deletedThreadId,
    });

    // The thread was deleted but its pause has not landed — the fire-time
    // check sees no shell at all and must pause, not loop sendToThread.
    yield* setBoundThreadState(deletedThreadId, "deleted");
    const attempted = yield* tasks.runNow({ id: seeded.id }).pipe(Effect.exit);
    assert.isTrue(Exit.isFailure(attempted));
    assert.equal(sendToThreadCalls, 0);
    const after = yield* findTaskById(seeded.id);
    assert.isDefined(after);
    assert.isFalse(after!.enabled);
    assert.isNull(after!.nextRunAt);
  }).pipe(Effect.provide(boundThreadTestLayerWithSql)),
);

it.effect("a run firing after archive pauses the task instead of dispatching", () =>
  Effect.gen(function* () {
    const tasks = yield* ScheduledTaskService;
    yield* setBoundThreadState(archiveBoundThreadId, "active");
    sendToThreadCalls = 0;
    const seeded = yield* seedBoundTask(true);

    // The archive committed but its pause has not landed yet — the
    // fire-time check is the backstop that must not dispatch.
    yield* setBoundThreadState(archiveBoundThreadId, "archived");
    const attempted = yield* tasks.runNow({ id: seeded.id }).pipe(Effect.exit);
    assert.isTrue(Exit.isFailure(attempted));
    assert.equal(sendToThreadCalls, 0);
    const after = yield* findTaskById(seeded.id);
    assert.isDefined(after);
    assert.isFalse(after!.enabled);
    assert.isNull(after!.nextRunAt);
    // Nothing was dispatched, so no phantom run may be recorded.
    assert.equal(after!.lastRunStatus, "never");
    assert.equal(after!.runCount, 0);
  }).pipe(Effect.provide(boundThreadTestLayerWithSql)),
);

it.effect("records a rejected run when archive lands mid-dispatch and never re-arms", () =>
  Effect.gen(function* () {
    const tasks = yield* ScheduledTaskService;
    yield* setBoundThreadState(archiveBoundThreadId, "active");
    sendToThreadCalls = 0;
    const seeded = yield* seedBoundTask(true);
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    sendBarrier = { started, release };
    try {
      const runFiber = yield* tasks.runNow({ id: seeded.id }).pipe(Effect.forkChild);
      // The dispatch is parked inside sendToThread: the archive pause lands
      // deterministically between markRunning and the completion write.
      yield* Deferred.await(started);
      yield* setBoundThreadState(archiveBoundThreadId, "archived");
      yield* tasks.pauseForThread(archiveBoundThreadId);
      yield* Deferred.succeed(release, undefined);
      const finished = yield* Fiber.join(runFiber);
      // The rejected run is recorded once as failed — the archive pause is
      // not overwritten by the completion write.
      assert.equal(finished.task.lastRunStatus, "failed");
      assert.equal(finished.task.runCount, 1);
      assert.isFalse(finished.task.enabled);
      assert.isNull(finished.task.nextRunAt);
    } finally {
      sendBarrier = null;
    }
    const after = yield* findTaskById(seeded.id);
    assert.isDefined(after);
    assert.isFalse(after!.enabled);
    assert.isNull(after!.nextRunAt);
    // No recurring doomed dispatches: a second fire refuses before sending.
    const second = yield* tasks.runNow({ id: seeded.id }).pipe(Effect.exit);
    assert.isTrue(Exit.isFailure(second));
    assert.equal(sendToThreadCalls, 1);
  }).pipe(Effect.provide(boundThreadTestLayerWithSql)),
);

it.effect(
  "keeps a durably accepted run's success when archive lands mid-dispatch and never re-arms",
  () =>
    Effect.gen(function* () {
      const tasks = yield* ScheduledTaskService;
      yield* setBoundThreadState(archiveBoundThreadId, "active");
      sendToThreadCalls = 0;
      const seeded = yield* seedBoundTask(true);
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      // The thread accepted the dispatch before the archive landed, so the
      // send itself completes — the pause must not drop or re-arm it.
      sendBarrier = { started, release, acceptedAtEntry: true };
      try {
        const runFiber = yield* tasks.runNow({ id: seeded.id }).pipe(Effect.forkChild);
        yield* Deferred.await(started);
        yield* setBoundThreadState(archiveBoundThreadId, "archived");
        yield* tasks.pauseForThread(archiveBoundThreadId);
        yield* Deferred.succeed(release, undefined);
        const finished = yield* Fiber.join(runFiber);
        // The accepted run is recorded exactly once as succeeded — the
        // completion write respects the pause that landed mid-dispatch.
        assert.equal(finished.task.lastRunStatus, "succeeded");
        assert.equal(finished.task.runCount, 1);
        assert.isFalse(finished.task.enabled);
        assert.isNull(finished.task.nextRunAt);
      } finally {
        sendBarrier = null;
      }
      const after = yield* findTaskById(seeded.id);
      assert.isDefined(after);
      assert.isFalse(after!.enabled);
      assert.isNull(after!.nextRunAt);
      assert.equal(after!.lastRunStatus, "succeeded");
      assert.equal(after!.runCount, 1);
      // No recurring doomed dispatches: a second fire refuses before sending.
      const second = yield* tasks.runNow({ id: seeded.id }).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(second));
      assert.equal(sendToThreadCalls, 1);
    }).pipe(Effect.provide(boundThreadTestLayerWithSql)),
);

it.effect("the domain-event reactor pauses tasks on thread archive and delete", () =>
  Effect.gen(function* () {
    // scoped so the built layer's reactor fiber lives for the whole test body.
    yield* Effect.scoped(
      Effect.gen(function* () {
        sendToThreadCalls = 0;
        const domainEvents = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
        // The reactor subscribes when the layer builds, so the service must come
        // up inside the test with this queue already wired into the mock.
        const context = yield* Layer.build(
          scheduledTaskServiceLayer.pipe(
            Layer.provide(
              Layer.mergeAll(
                NodeCrypto.layer,
                Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
                boundThreadManagementMock(Stream.fromQueue(domainEvents)),
              ),
            ),
          ),
        );
        const tasks = Context.get(context, ScheduledTaskService);
        const archivedThreadId = ThreadId.make("thread:reactor-archived");
        const deletedThreadId = ThreadId.make("thread:reactor-deleted");
        yield* setBoundThreadState(archivedThreadId, "active");
        yield* setBoundThreadState(deletedThreadId, "active");
        const archivedTask = yield* tasks.upsert({
          ...boundTaskInput,
          enabled: true,
          threadId: archivedThreadId,
        });
        const deletedTask = yield* tasks.upsert({
          ...boundTaskInput,
          enabled: true,
          threadId: deletedThreadId,
        });

        const emittedAt = DateTime.makeUnsafe(boundThreadArchivedAt);
        // The events mean the state change already committed — the mock must
        // reflect it because the pause rechecks the live shell and ignores
        // stale events (a thread unarchived before the event is consumed).
        yield* setBoundThreadState(archivedThreadId, "archived");
        yield* setBoundThreadState(deletedThreadId, "deleted");
        yield* Queue.offer(domainEvents, {
          id: EventId.make("event:reactor-archived"),
          type: "thread.archived",
          threadId: archivedThreadId,
          providerInstanceId: ProviderInstanceId.make("codex"),
          occurredAt: emittedAt,
          payload: { id: archivedThreadId },
        } as unknown as OrchestrationV2DomainEvent);
        yield* Queue.offer(domainEvents, {
          id: EventId.make("event:reactor-deleted"),
          type: "thread.deleted",
          threadId: deletedThreadId,
          providerInstanceId: ProviderInstanceId.make("codex"),
          occurredAt: emittedAt,
          payload: { id: deletedThreadId, deletedAt: emittedAt },
        } as unknown as OrchestrationV2DomainEvent);

        // subscribeList re-emits on notifyChanged, so each pause is awaited on a
        // real change receipt rather than a sleep.
        const awaitPaused = (id: ScheduledTaskId) =>
          tasks.subscribeList().pipe(
            Stream.map(({ tasks: all }) => all.find((candidate) => candidate.id === id)),
            Stream.filter((task) => task !== undefined && task.enabled === false),
            Stream.runHead,
          );
        yield* awaitPaused(archivedTask.task.id);
        yield* awaitPaused(deletedTask.task.id);
        assert.equal(sendToThreadCalls, 0);
      }),
    );
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("the startup sweep pauses enabled tasks whose thread was archived while down", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const now = "2026-09-09T12:00:00.000Z";
    yield* sql`INSERT INTO scheduled_tasks ${sql.insert({
      task_id: "scheduled-task:swept",
      title: "swept",
      prompt: "swept prompt",
      enabled: 1,
      schedule_json: '{"type":"interval","everyMs":60000}',
      project_id: archivedBindingProjectId,
      thread_id: archiveBoundThreadId,
      workspace_strategy_json: '{"type":"root"}',
      model_selection_json: '{"instanceId":"codex","model":"gpt-5"}',
      runtime_mode: "full-access",
      interaction_mode: "default",
      created_by: "user",
      creation_source: "web",
      created_at: now,
      updated_at: now,
      next_run_at: "2027-09-09T12:00:00.000Z",
      last_run_at: null,
      last_run_status: "never",
      last_run_error: null,
      run_count: 0,
    })}`;
    yield* setBoundThreadState(archiveBoundThreadId, "archived");

    // Building the service against the seeded database runs the archive
    // sweep before the test body — this is the crash-window recovery path.
    const context = yield* Effect.scoped(
      Layer.build(scheduledTaskServiceLayer.pipe(Layer.provide(boundThreadTestDepsWithoutSqlite))),
    );
    const service = Context.get(context, ScheduledTaskService);
    const { tasks: all } = yield* service.list();
    const swept = all.find(
      (candidate) => candidate.id === ScheduledTaskId.make("scheduled-task:swept"),
    );
    assert.isDefined(swept);
    assert.isFalse(swept!.enabled);
    assert.isNull(swept!.nextRunAt);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
