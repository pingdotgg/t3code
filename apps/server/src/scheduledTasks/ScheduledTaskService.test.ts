import * as Scheduler from "../scheduling/Scheduler.ts";
import * as NodeSqlite from "node:sqlite";
import * as NodeUtil from "node:util";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ScheduledTaskError,
  ScheduledTaskId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlError from "effect/unstable/sql/SqlError";

import * as Deferred from "effect/Deferred";
import * as Ref from "effect/Ref";
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
                Scheduler.layer,
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
                Scheduler.layer,
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
  Scheduler.layer,
  Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
  Layer.mock(ThreadManagementService.ThreadManagementService)({}),
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
const archivedThreadId = ThreadId.make("thread:archived");

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
       ${now}, ${now}, '{}'),
      (${archivedThreadId}, ${updateProjectId}, 'archived', 'codex', 'full-access', 'default',
       ${now}, ${now}, '{}')
  `;
  yield* sql`
    UPDATE orchestration_v2_projection_threads
    SET deleted_at = ${now}
    WHERE thread_id = ${deletedThreadId}
  `;
  yield* sql`
    UPDATE orchestration_v2_projection_threads
    SET archived_at = ${now}
    WHERE thread_id = ${archivedThreadId}
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

it.effect("update patches runtimeMode without disturbing other fields", () =>
  Effect.gen(function* () {
    const tasks = yield* ScheduledTaskService;
    const seeded = yield* seedTask;
    const result = yield* tasks.update({
      id: updateTaskId,
      projectId: updateProjectId,
      runtimeMode: "auto",
    });
    assert.isTrue(Option.isSome(result));
    const after = yield* findSeeded;
    assert.isDefined(after);
    assert.equal(after!.runtimeMode, "auto");
    assert.equal(after!.title, seeded.title);
    assert.equal(after!.enabled, true);
    assert.equal(after!.nextRunAt, seeded.nextRunAt);
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

it.effect("concurrent workspaceStrategyPatch edits merge into the live strategy", () =>
  Effect.gen(function* () {
    const tasks = yield* ScheduledTaskService;
    yield* seedTask;
    // Move the seeded task to a worktree strategy carrying a field no client
    // control edits (`branch`), then race two disjoint control patches: two
    // editors saving baseRef and startFromOrigin must both keep their change
    // instead of the second whole-object write reverting the first.
    yield* tasks.update({
      id: updateTaskId,
      projectId: updateProjectId,
      workspaceStrategy: {
        type: "worktree",
        baseRef: "main",
        startFromOrigin: true,
        branch: "release/1.2",
      },
    });
    yield* Effect.all(
      [
        tasks.update({
          id: updateTaskId,
          projectId: updateProjectId,
          workspaceStrategyPatch: { baseRef: "develop" },
        }),
        tasks.update({
          id: updateTaskId,
          projectId: updateProjectId,
          workspaceStrategyPatch: { startFromOrigin: false },
        }),
      ],
      { concurrency: "unbounded" },
    );
    const after = yield* findSeeded;
    assert.isDefined(after);
    assert.deepEqual(after!.workspaceStrategy, {
      type: "worktree",
      baseRef: "develop",
      startFromOrigin: false,
      branch: "release/1.2",
    });
  }).pipe(Effect.provide(updateTestLayer)),
);

it.effect("workspaceStrategyPatch drops keys foreign to a concurrently switched kind", () =>
  Effect.gen(function* () {
    const tasks = yield* ScheduledTaskService;
    yield* seedTask;
    // The seeded strategy is `root`; a stale worktree-control patch has no
    // keys that belong to it, so the merge encodes the stale edit away
    // instead of resurrecting a worktree strategy over the concurrent
    // kind change.
    const result = yield* tasks.update({
      id: updateTaskId,
      projectId: updateProjectId,
      workspaceStrategyPatch: { baseRef: "develop" },
    });
    assert.isTrue(Option.isSome(result));
    const after = yield* findSeeded;
    assert.isDefined(after);
    assert.deepEqual(after!.workspaceStrategy, { type: "root" });
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
      Scheduler.layer,
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
      Layer.mock(ThreadManagementService.ThreadManagementService)({}),
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

it.effect("scoped delete loses to a racing project move instead of deleting cross-project", () =>
  Effect.gen(function* () {
    const tasks = yield* ScheduledTaskService;
    yield* seedTask;
    // The task moves to project B before a delete authorized for project A
    // commits: the scoped DELETE finds no row in A and must not touch B's row.
    const moved = yield* tasks.update({
      id: updateTaskId,
      projectId: updateProjectId,
      nextProjectId: otherProjectId,
    });
    assert.isTrue(Option.isSome(moved));
    const staleDelete = yield* tasks.delete({
      id: updateTaskId,
      projectId: updateProjectId,
    });
    assert.isTrue(Option.isNone(staleDelete));
    const after = yield* findSeeded;
    assert.isDefined(after);
    assert.equal(after?.projectId, otherProjectId);

    // Scoped to the live project the same delete succeeds; an unscoped delete
    // of the now-missing row reports none instead of a false success.
    const liveDelete = yield* tasks.delete({
      id: updateTaskId,
      projectId: otherProjectId,
    });
    assert.isTrue(Option.isSome(liveDelete));
    assert.isUndefined(yield* findSeeded);
    const goneDelete = yield* tasks.delete({ id: updateTaskId });
    assert.isTrue(Option.isNone(goneDelete));
  }).pipe(Effect.provide(updateTestLayer)),
);

it.effect("scoped runNow loses to a racing project move and never dispatches", () =>
  Effect.gen(function* () {
    const tasks = yield* ScheduledTaskService;
    yield* seedTask;
    dispatchLaunchCount = 0;
    // A manual run authorized for project A commits after the task moved to
    // project B: the dispatch transaction's re-read sees B, so the scoped run
    // is a typed not-found and no launch fires under A's authority.
    const moved = yield* tasks.update({
      id: updateTaskId,
      projectId: updateProjectId,
      nextProjectId: otherProjectId,
    });
    assert.isTrue(Option.isSome(moved));
    const staleRun = yield* tasks
      .runNow({ id: updateTaskId, projectId: updateProjectId })
      .pipe(Effect.result);
    assert.isTrue(Result.isFailure(staleRun));
    assert.equal(dispatchLaunchCount, 0);

    // Scoped to the live project the same manual run dispatches normally.
    const liveRun = yield* tasks.runNow({
      id: updateTaskId,
      projectId: otherProjectId,
    });
    assert.equal(liveRun.task.lastRunStatus, "succeeded");
    assert.equal(dispatchLaunchCount, 1);
  }).pipe(Effect.provide(gatedDispatchLayer)),
);

it.effect(
  "replayed commandId upsert loses to a racing project move instead of dragging it back",
  () =>
    Effect.gen(function* () {
      const tasks = yield* ScheduledTaskService;
      const replayId = ScheduledTaskId.make("scheduled-task:cmd:replay-move");
      const replayInput = {
        title: "replay title",
        prompt: "replay prompt",
        enabled: true,
        schedule: { type: "interval", everyMs: 60_000 } as const,
        threadId: null,
        workspaceStrategy: { type: "root" } as const,
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.1-codex" },
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        createdBy: "agent" as const,
        creationSource: "mcp" as const,
        commandId: CommandId.make("cmd:replay-move"),
      };
      const { task: created } = yield* tasks.upsert({
        ...replayInput,
        projectId: updateProjectId,
      });
      assert.equal(created.id, replayId);

      // The task moves to project B before a stale MCP replay of the same
      // schedule_task call lands: the resolved id still matches, but the scoped
      // upsert must answer not-found rather than rewrite the row back into A.
      const moved = yield* tasks.update({
        id: replayId,
        projectId: updateProjectId,
        nextProjectId: otherProjectId,
      });
      assert.isTrue(Option.isSome(moved));
      const replay = yield* tasks
        .upsert({ ...replayInput, projectId: updateProjectId })
        .pipe(Effect.result);
      assert.isTrue(Result.isFailure(replay));
      const { tasks: all } = yield* tasks.list();
      const after = all.find((candidate) => candidate.id === replayId);
      assert.isDefined(after);
      assert.equal(after?.projectId, otherProjectId);
      assert.equal(after?.title, created.title);

      // A replay authorized for the live project is still the idempotent write.
      const liveReplay = yield* tasks.upsert({ ...replayInput, projectId: otherProjectId });
      assert.equal(liveReplay.task.projectId, otherProjectId);
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
      Scheduler.layer,
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
        Scheduler.layer,
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
    // An archived thread is rejected the same way: sendToThread refuses
    // archived targets, so a bound task would save as runnable and then fail
    // every dispatch.
    const archived = yield* tasks
      .update({ id: updateTaskId, projectId: updateProjectId, threadId: archivedThreadId })
      .pipe(Effect.result);
    if (Result.isSuccess(archived)) assert.fail("expected a typed conflict");
    assert.equal(archived.failure._tag, "ScheduledTaskError");
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
