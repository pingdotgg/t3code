import * as Scheduler from "../scheduling/Scheduler.ts";
import * as NodeUtil from "node:util";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ScheduledTaskError,
  ScheduledTaskId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as SqlClient from "effect/sql/SqlClient";

import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as Deferred from "effect/Deferred";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";

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
      { id: "", next: now, enabled: 1, status: "never" },
      { id: "   ", next: now, enabled: 1, status: "never" },
      { id: null, next: now, enabled: 1, status: "never" },
      {
        id: "due-earlier",
        next: "2026-09-09T11:00:00.000Z",
        enabled: 1,
        status: "failed",
      },
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
    const tasks = yield* ScheduledTaskService.listDueTasks(DateTime.makeUnsafe(now)).pipe(
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
    assert.equal(warnings.length, 6);
    const annotations = warnings.map(
      (warning) => (warning as ReadonlyArray<unknown>)[1] as Record<string, unknown>,
    );
    assert.deepEqual(
      annotations.map((annotation) => annotation.taskId),
      ["due-bad-date", null, "", "   ", "due-corrupt", "due-cred"],
    );
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
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect(
  "releases interrupted runs on startup and still executes due tasks, skipping corrupt rows",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-09-09T12:00:00.000Z";
      const hugeInterval = '{"type":"interval","everyMs":9000000000000000}';
      for (const row of [
        { id: "stuck-valid", next: now, status: "running" },
        { id: "stuck-corrupt", next: now, status: "running", scheduleJson: "broken" },
        { id: "stuck-huge", next: now, status: "running", scheduleJson: hugeInterval },
        { id: null, next: now, status: "running" },
        { id: "due-bad-date", next: "", status: "never" },
        { id: "due-healthy", next: now, status: "never" },
        { id: "due-huge", next: now, status: "never", scheduleJson: hugeInterval },
        { id: "due-second", next: now, status: "never" },
        { id: "due-third", next: now, status: "never" },
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
              ScheduledTaskService.layer,
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
                Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
                  namedProjectsRoot: "/projects",
                  isScratchProject: () => Effect.succeed(false),
                }),
                Layer.mock(ThreadManagementService.ThreadManagementService)({}),
                Layer.mock(SecretRequests.SecretRequests)({}),
                NodeCrypto.layer,
                Scheduler.layer,
              ),
            ),
          );
          // The poll delays before its first pass; advance the frozen clock once.
          yield* TestClock.adjust("6 seconds");
          yield* Deferred.await(lastDispatched);
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
      for (const id of ["due-healthy", "due-huge", "due-second"]) {
        const row = byId.get(id);
        assert.equal(row?.last_run_status, "failed");
        assert.isTrue(row?.last_run_error?.includes("test launch failure") === true);
        assert.equal(row?.run_count, 1);
      }
      assert.isNull(byId.get("due-huge")?.next_run_at);
      assert.equal(byId.get("due-bad-date")?.last_run_status, "never");
      assert.equal(byId.get("due-bad-date")?.run_count, 0);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect(
  "treats a next_run_at corrupted before the dispatch re-read as not due instead of defecting the poll",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-09-09T12:00:00.000Z";
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
              ScheduledTaskService.layer,
              Layer.mergeAll(
                Layer.mock(ThreadLaunchService.ThreadLaunchService)({
                  launch: () =>
                    Ref.updateAndGet(dispatched, (n) => n + 1).pipe(
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
                Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
                  namedProjectsRoot: "/projects",
                  isScratchProject: () => Effect.succeed(false),
                }),
                Layer.mock(ThreadManagementService.ThreadManagementService)({}),
                Layer.mock(SecretRequests.SecretRequests)({}),
                NodeCrypto.layer,
                Scheduler.layer,
              ),
            ),
          );
          yield* TestClock.adjust("6 seconds");
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
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("thread cleanup notifies subscribers and a finishing run cannot recreate the task", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const subscribed = yield* Deferred.make<void>();
    const running = yield* Deferred.make<void>();
    const removed = yield* Deferred.make<void>();
    const layer = ScheduledTaskService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            sendToThread: () =>
              Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(Effect.die("test dispatch failure")),
              ),
          }),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
            namedProjectsRoot: "/projects",
            isScratchProject: () => Effect.succeed(false),
          }),
          NodeCrypto.layer,
          Scheduler.layer,
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const threadId = ThreadId.make("thread:deleted-during-run");
      const { task } = yield* service.upsert({
        id: ScheduledTaskId.make("task:deleted-during-run"),
        title: "Check orchestration",
        prompt: "Check progress",
        enabled: true,
        schedule: { type: "interval", everyMs: 60_000 },
        projectId: ProjectId.make("project:test"),
        threadId,
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
      });
      yield* service.subscribeList().pipe(
        Stream.runForEach(({ tasks }) => {
          const current = tasks.find((candidate) => candidate.id === task.id);
          if (current === undefined) return Deferred.succeed(removed, undefined);
          return current.lastRunStatus === "running"
            ? Deferred.succeed(running, undefined)
            : Deferred.succeed(subscribed, undefined);
        }),
        Effect.forkChild,
      );
      yield* Deferred.await(subscribed);
      const run = yield* service.runNow({ id: task.id }).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* Deferred.await(running);
      yield* service.deleteForThread(threadId);
      yield* Deferred.await(removed);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(run);
      assert.lengthOf((yield* service.list()).tasks, 0);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("a bound run follows its thread when promotion moves it mid-send", () =>
  Effect.gen(function* () {
    const scratch = ProjectId.make("project:scratch");
    const promoted = ProjectId.make("project:promoted");
    const sends = yield* Ref.make<Array<{ projectId: ProjectId; commandId: string }>>([]);
    // Rebind lands first, then the promotion commits between the shell read and the retry.
    const shellProjects = yield* Ref.make([scratch, promoted]);
    const layer = ScheduledTaskService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            sendToThread: (input) =>
              Ref.updateAndGet(sends, (all) => [
                ...all,
                { projectId: input.projectId, commandId: input.commandId },
              ]).pipe(
                Effect.flatMap((all) =>
                  all.length < 3
                    ? Effect.fail(
                        new ThreadManagementService.ThreadManagementThreadNotFoundError({
                          projectId: input.projectId,
                          threadId: input.threadId,
                        }),
                      )
                    : Effect.succeed({} as never),
                ),
              ),
            getThreadShell: () =>
              Ref.modify(shellProjects, ([next, ...rest]) => [
                { projectId: next ?? promoted } as never,
                rest,
              ]),
          }),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
            namedProjectsRoot: "/projects",
            isScratchProject: () => Effect.succeed(false),
          }),
          NodeCrypto.layer,
          Scheduler.layer,
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const threadId = ThreadId.make("thread:promoted-during-run");
      const { task } = yield* service.upsert({
        id: ScheduledTaskId.make("task:promoted-during-run"),
        title: "Check in",
        prompt: "Check progress",
        enabled: true,
        schedule: { type: "interval", everyMs: 60_000 },
        projectId: promoted,
        threadId,
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
      });

      const result = yield* service.runNow({ id: task.id });

      assert.equal(result.threadId, threadId);
      const attempts = yield* Ref.get(sends);
      assert.deepEqual(
        attempts.map((attempt) => attempt.projectId),
        [promoted, scratch, promoted],
      );
      assert.equal(new Set(attempts.map((attempt) => attempt.commandId)).size, 1);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

const turnThreadId = ThreadId.make("thread:turn-outcome");
const epoch = DateTime.makeUnsafe(0);

const runOf = (
  runId: string,
  userMessageId: MessageId,
  status: OrchestrationV2Run["status"],
): OrchestrationV2Run => ({
  id: RunId.make(runId),
  threadId: turnThreadId,
  ordinal: 1,
  providerInstanceId: ProviderInstanceId.make("codex"),
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  providerThreadId: null,
  userMessageId,
  rootNodeId: null,
  activeAttemptId: null,
  status,
  requestedAt: epoch,
  startedAt: null,
  completedAt: null,
  checkpointId: null,
  contextHandoffId: null,
});

const runEvent = (run: OrchestrationV2Run): OrchestrationV2DomainEvent => ({
  id: EventId.make(`event:${run.id}:${run.status}`),
  type: "run.updated",
  threadId: run.threadId,
  runId: run.id,
  occurredAt: epoch,
  payload: run,
});

const providerErrorEvent = (runId: string, message: string): OrchestrationV2DomainEvent => ({
  id: EventId.make(`event:${runId}:error`),
  type: "turn-item.updated",
  threadId: turnThreadId,
  runId: RunId.make(runId),
  occurredAt: epoch,
  payload: {
    id: TurnItemId.make(`turn-item:${runId}:error`),
    threadId: turnThreadId,
    runId: RunId.make(runId),
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "failed",
    title: null,
    startedAt: epoch,
    completedAt: epoch,
    updatedAt: epoch,
    type: "error",
    failure: { class: "usage_limit", message, code: null, retryable: false },
  },
});

// Dispatches to a bound thread succeed at once; the run's events are fed by hand.
const makeTurnHarness = (
  options: {
    /** Runs inside the dispatch, so the turn's events can land before it returns. */
    readonly duringDispatch?: (
      events: Queue.Queue<OrchestrationV2DomainEvent>,
      messageId: MessageId,
    ) => Effect.Effect<void>;
    /** The run the thread's projection says the scheduled message now belongs to. */
    readonly messageRunId?: RunId;
    /** The runs the thread's projection holds, as read back after the event stream drops. */
    readonly runs?: ReadonlyArray<OrchestrationV2Run>;
    /** How many times the event stream fails before it starts to deliver events. */
    readonly streamFailures?: number;
    /** Reads the thread as deleted, which the projection keeps as a flagged record. */
    readonly threadDeleted?: boolean;
    /**
     * The first stream subscription fails only when the test releases `dropStream`.
     * The listener's first catch-up can run before or after a dispatch, so the drop
     * guarantees one resubscribe catch-up that sees the dispatched run.
     */
    readonly dropStreamOnCommand?: boolean;
    /** Reads about the first dispatched message fail; later messages read normally. */
    readonly firstMessageUnreadable?: boolean;
    /** Makes every projection read fail, as for a thread whose records are gone. */
    readonly recordsUnreadable?: boolean;
    /** Makes the stream a live tail: events from before it was opened are not delivered. */
    readonly liveTail?: boolean;
    /** Runs when the projection's runs are read, so an event can land mid catch-up. */
    readonly duringRunsRead?: (
      events: Queue.Queue<OrchestrationV2DomainEvent>,
    ) => Effect.Effect<void>;
  } = {},
) =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
    const dispatched = yield* Queue.unbounded<MessageId>();
    const subscriptions = yield* Ref.make(0);
    const failedReads = yield* Queue.unbounded<void>();
    const dropStream = yield* Deferred.make<void>();
    const firstMessage = yield* Ref.make<MessageId | null>(null);
    const layer = ScheduledTaskService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            sendToThread: (input) =>
              Ref.update(firstMessage, (first) => first ?? input.messageId).pipe(
                Effect.andThen(Queue.offer(dispatched, input.messageId)),
                Effect.andThen(options.duringDispatch?.(events, input.messageId) ?? Effect.void),
                Effect.as(undefined as never),
              ),
            getThreadRecords: (_threadId, fields: ReadonlyArray<string>, filter) =>
              Effect.gen(function* () {
                const first = yield* Ref.get(firstMessage);
                if (
                  options.recordsUnreadable ||
                  (options.firstMessageUnreadable &&
                    first !== null &&
                    filter?.messageIds?.includes(first))
                ) {
                  yield* Queue.offer(failedReads, undefined);
                  return yield* Effect.fail(new Error("no records") as never);
                }
                if (fields.includes("runs")) yield* options.duringRunsRead?.(events) ?? Effect.void;
                return {
                  thread: { deletedAt: options.threadDeleted ? epoch : null },
                  messages: (filter?.messageIds ?? []).map((id) => ({
                    id,
                    runId: options.messageRunId ?? null,
                  })),
                  runs: (options.runs ?? []).filter(
                    (run) => filter?.runIds === undefined || filter.runIds.includes(run.id),
                  ),
                } as never;
              }),
            streamDomainEvents: Stream.unwrap(
              Ref.getAndUpdate(subscriptions, (n) => n + 1).pipe(
                Effect.flatMap((attempt) =>
                  attempt < (options.streamFailures ?? (options.dropStreamOnCommand ? 1 : 0))
                    ? (options.dropStreamOnCommand ? Deferred.await(dropStream) : Effect.void).pipe(
                        Effect.as(Stream.fail(new Error("event stream dropped") as never)),
                      )
                    : (options.liveTail ? Queue.clear(events) : Effect.void).pipe(
                        Effect.as(Stream.fromQueue(events)),
                      ),
                ),
              ),
            ),
          }),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
            namedProjectsRoot: "/projects",
            isScratchProject: () => Effect.succeed(false),
          }),
          NodeCrypto.layer,
          Scheduler.layer,
        ),
      ),
    );
    return { events, dispatched, subscriptions, failedReads, dropStream, layer };
  });

const upsertBoundTask = (
  service: ScheduledTaskService.ScheduledTaskService["Service"],
  enabled = false,
) =>
  service.upsert({
    id: ScheduledTaskId.make("task:turn-outcome"),
    title: "Check orchestration",
    prompt: "Check progress",
    enabled,
    schedule: { type: "interval", everyMs: 60_000 },
    projectId: ProjectId.make("project:test"),
    threadId: turnThreadId,
    workspaceStrategy: { type: "root" },
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
  });

const untilStatus = (
  service: ScheduledTaskService.ScheduledTaskService["Service"],
  id: ScheduledTaskId,
  status: string,
) =>
  service.subscribeList().pipe(
    Stream.filter(({ tasks }) => tasks.some((t) => t.id === id && t.lastRunStatus === status)),
    Stream.take(1),
    Stream.runDrain,
  );

it.effect("a failed turn replaces the dispatched run's status with the provider error", () =>
  Effect.gen(function* () {
    const harness = yield* makeTurnHarness();
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const { task } = yield* upsertBoundTask(service);
      const ran = yield* service.runNow({ id: task.id });
      // Accepted is not finished: the turn has not ended yet.
      assert.equal(ran.task.lastRunStatus, "running");
      assert.equal(ran.task.runCount, 0);
      const messageId = yield* Queue.take(harness.dispatched);
      yield* Queue.offerAll(harness.events, [
        runEvent(runOf("run:usage-limit", messageId, "queued")),
        runEvent(runOf("run:usage-limit", messageId, "running")),
        providerErrorEvent("run:usage-limit", "You have reached your usage limit."),
        runEvent(runOf("run:usage-limit", messageId, "failed")),
      ]);
      yield* untilStatus(service, task.id, "failed");
      const [settled] = (yield* service.list()).tasks;
      assert.equal(settled?.lastRunStatus, "failed");
      assert.equal(settled?.lastRunError, "You have reached your usage limit.");
      assert.equal(settled?.runCount, 1);
    }).pipe(Effect.provide(harness.layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("a completed turn records the run as succeeded", () =>
  Effect.gen(function* () {
    const harness = yield* makeTurnHarness();
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const { task } = yield* upsertBoundTask(service);
      yield* service.runNow({ id: task.id });
      const messageId = yield* Queue.take(harness.dispatched);
      yield* Queue.offerAll(harness.events, [
        runEvent(runOf("run:completes", messageId, "running")),
        runEvent(runOf("run:completes", messageId, "completed")),
      ]);
      yield* untilStatus(service, task.id, "succeeded");
      const [settled] = (yield* service.list()).tasks;
      assert.isNull(settled?.lastRunError);
    }).pipe(Effect.provide(harness.layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("an earlier run's turn ending cannot overwrite a newer run", () =>
  Effect.gen(function* () {
    const harness = yield* makeTurnHarness();
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const { task } = yield* upsertBoundTask(service);
      yield* service.runNow({ id: task.id });
      const first = yield* Queue.take(harness.dispatched);
      // Run now again while the first turn is still in flight.
      yield* TestClock.adjust("1 second");
      yield* service.runNow({ id: task.id });
      const second = yield* Queue.take(harness.dispatched);
      yield* Queue.offerAll(harness.events, [
        runEvent(runOf("run:first", first, "failed")),
        runEvent(runOf("run:second", second, "completed")),
      ]);
      yield* untilStatus(service, task.id, "succeeded");
      const [settled] = (yield* service.list()).tasks;
      assert.equal(settled?.lastRunStatus, "succeeded");
      assert.isNull(settled?.lastRunError);
      assert.equal(settled?.runCount, 2);
    }).pipe(Effect.provide(harness.layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

const messageMovedEvent = (messageId: MessageId, runId: string): OrchestrationV2DomainEvent => ({
  id: EventId.make(`event:${messageId}:moved`),
  type: "message.updated",
  threadId: turnThreadId,
  runId: RunId.make(runId),
  occurredAt: epoch,
  payload: {
    id: messageId,
    threadId: turnThreadId,
    runId: RunId.make(runId),
    nodeId: null,
    role: "user",
    text: "Check progress",
    attachments: [],
    streaming: false,
    createdAt: epoch,
    updatedAt: epoch,
    createdBy: "user",
    creationSource: "web",
  },
});

it.effect("a turn that ends while the dispatch is being recorded still advances the schedule", () =>
  Effect.gen(function* () {
    const harness = yield* makeTurnHarness({
      duringDispatch: (events, messageId) =>
        Queue.offerAll(events, [
          runEvent(runOf("run:fast", messageId, "queued")),
          runEvent(runOf("run:fast", messageId, "failed")),
        ]),
    });
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const { task } = yield* upsertBoundTask(service, true);
      yield* TestClock.adjust("30 seconds");
      yield* service.runNow({ id: task.id });
      yield* untilStatus(service, task.id, "failed");
      const [settled] = (yield* service.list()).tasks;
      assert.equal(settled?.runCount, 1);
      // Dispatched 30 seconds after the task was saved, so the next run is 60 seconds on from then.
      assert.equal(
        settled?.nextRunAt,
        DateTime.formatIso(DateTime.makeUnsafe(Date.parse(task.nextRunAt!) + 30_000)),
      );
    }).pipe(Effect.provide(harness.layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("a queued message promoted to a steer keeps its run going in the active run", () =>
  Effect.gen(function* () {
    const harness = yield* makeTurnHarness({ messageRunId: RunId.make("run:active") });
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const { task } = yield* upsertBoundTask(service);
      yield* service.runNow({ id: task.id });
      const messageId = yield* Queue.take(harness.dispatched);
      yield* Queue.offerAll(harness.events, [
        runEvent(runOf("run:queued", messageId, "queued")),
        // Promotion cancels the queued run before it moves the message into the active one.
        runEvent(runOf("run:queued", messageId, "cancelled")),
        messageMovedEvent(messageId, "run:active"),
        runEvent(runOf("run:active", MessageId.make("message:active-turn"), "completed")),
      ]);
      yield* service.subscribeList().pipe(
        Stream.filter(({ tasks }) => tasks.some((t) => t.lastRunStatus !== "running")),
        Stream.take(1),
        Stream.runDrain,
      );
      const [settled] = (yield* service.list()).tasks;
      assert.equal(settled?.lastRunStatus, "succeeded");
      assert.isNull(settled?.lastRunError);
    }).pipe(Effect.provide(harness.layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("a run whose outcome cannot be saved is released instead of left running", () =>
  Effect.gen(function* () {
    const harness = yield* makeTurnHarness();
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const sql = yield* SqlClient.SqlClient;
      const { task } = yield* upsertBoundTask(service);
      yield* service.runNow({ id: task.id });
      const messageId = yield* Queue.take(harness.dispatched);
      // Only the release path may write the terminal state.
      yield* sql`CREATE TRIGGER fail_outcome BEFORE UPDATE ON scheduled_tasks
        WHEN OLD.last_run_status = 'running' AND NEW.last_run_status = 'succeeded'
        BEGIN SELECT RAISE(FAIL, 'outcome unavailable'); END`;
      yield* Queue.offerAll(harness.events, [
        runEvent(runOf("run:unsaved", messageId, "completed")),
      ]);
      yield* untilStatus(service, task.id, "failed");
      const [settled] = (yield* service.list()).tasks;
      assert.equal(settled?.lastRunError, "Could not record how the run ended.");
    }).pipe(Effect.provide(harness.layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("a dropped event stream is resumed, and runs that ended meanwhile are caught up", () =>
  Effect.gen(function* () {
    const runId = RunId.make("run:during-gap");
    const harness = yield* makeTurnHarness({
      streamFailures: 1,
      messageRunId: runId,
      runs: [runOf(runId, MessageId.make("unused"), "completed")],
    });
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const { task } = yield* upsertBoundTask(service);
      yield* service.runNow({ id: task.id });
      yield* Queue.take(harness.dispatched);
      // The run completed while no one was listening; the resumed listener finds it.
      yield* TestClock.adjust("30 seconds");
      yield* untilStatus(service, task.id, "succeeded");
      assert.equal(yield* Ref.get(harness.subscriptions), 2);
    }).pipe(Effect.provide(harness.layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("the event stream keeps being resumed after many failures", () =>
  Effect.gen(function* () {
    const runId = RunId.make("run:late");
    const harness = yield* makeTurnHarness({
      streamFailures: 8,
      messageRunId: runId,
      runs: [runOf(runId, MessageId.make("unused"), "failed")],
    });
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const { task } = yield* upsertBoundTask(service);
      yield* service.runNow({ id: task.id });
      yield* Queue.take(harness.dispatched);
      yield* TestClock.adjust("10 minutes");
      yield* untilStatus(service, task.id, "failed");
      assert.equal(yield* Ref.get(harness.subscriptions), 9);
    }).pipe(Effect.provide(harness.layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("an event landing while the resumed listener catches up is not missed", () =>
  Effect.gen(function* () {
    const runId = RunId.make("run:handoff");
    const harness = yield* makeTurnHarness({
      streamFailures: 1,
      liveTail: true,
      messageRunId: runId,
      // The projection read is stale: the run ends right after it.
      runs: [runOf(runId, MessageId.make("unused"), "running")],
      duringRunsRead: (events) =>
        Queue.offer(events, runEvent(runOf(runId, MessageId.make("unused"), "completed"))).pipe(
          Effect.asVoid,
        ),
    });
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const { task } = yield* upsertBoundTask(service);
      yield* service.runNow({ id: task.id });
      yield* Queue.take(harness.dispatched);
      yield* TestClock.adjust("30 seconds");
      yield* untilStatus(service, task.id, "succeeded");
    }).pipe(Effect.provide(harness.layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("a cancelled run is still recorded when its first save fails", () =>
  Effect.gen(function* () {
    const harness = yield* makeTurnHarness();
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const sql = yield* SqlClient.SqlClient;
      const { task } = yield* upsertBoundTask(service);
      yield* service.runNow({ id: task.id });
      const messageId = yield* Queue.take(harness.dispatched);
      // Fails the first write only; the retry must still record the cancel.
      yield* sql`CREATE TABLE fail_once (id INTEGER)`;
      yield* sql`INSERT INTO fail_once VALUES (1)`;
      yield* sql`CREATE TRIGGER fail_first_outcome BEFORE UPDATE ON scheduled_tasks
        WHEN OLD.last_run_status = 'running' AND NEW.last_run_status = 'failed'
          AND EXISTS (SELECT 1 FROM fail_once)
        BEGIN DELETE FROM fail_once; SELECT RAISE(FAIL, 'outcome unavailable'); END`;
      yield* Queue.offerAll(harness.events, [
        runEvent(runOf("run:cancelled", messageId, "queued")),
        runEvent(runOf("run:cancelled", messageId, "cancelled")),
      ]);
      yield* untilStatus(service, task.id, "failed");
      const [settled] = (yield* service.list()).tasks;
      assert.equal(settled?.lastRunError, "The run was cancelled.");
    }).pipe(Effect.provide(harness.layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect(
  "a run whose thread cannot be read during catch-up is released, not retried forever",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeTurnHarness({ streamFailures: 1, recordsUnreadable: true });
      yield* Effect.gen(function* () {
        const service = yield* ScheduledTaskService.ScheduledTaskService;
        const { task } = yield* upsertBoundTask(service);
        yield* service.runNow({ id: task.id });
        yield* Queue.take(harness.dispatched);
        yield* TestClock.adjust("1 minute");
        yield* untilStatus(service, task.id, "failed");
        const [settled] = (yield* service.list()).tasks;
        assert.equal(settled?.lastRunError, "Could not read how the run ended.");
        // The stream was resubscribed once for the drop, not again for the unreadable thread.
        assert.equal(yield* Ref.get(harness.subscriptions), 2);
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("a thread deleted while the stream was down fails its run on catch-up", () =>
  Effect.gen(function* () {
    const harness = yield* makeTurnHarness({ streamFailures: 1, threadDeleted: true });
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const { task } = yield* upsertBoundTask(service);
      yield* service.runNow({ id: task.id });
      yield* Queue.take(harness.dispatched);
      yield* TestClock.adjust("30 seconds");
      yield* untilStatus(service, task.id, "failed");
      const [settled] = (yield* service.list()).tasks;
      assert.equal(settled?.lastRunError, "The thread was deleted.");
    }).pipe(Effect.provide(harness.layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("giving up on a catch-up read leaves a newer run of the same task tracked", () =>
  Effect.gen(function* () {
    const harness = yield* makeTurnHarness({
      dropStreamOnCommand: true,
      firstMessageUnreadable: true,
    });
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const { task } = yield* upsertBoundTask(service);
      yield* service.runNow({ id: task.id });
      yield* Queue.take(harness.dispatched);
      // Dropping the stream makes the resubscribe catch up the dispatched run, whose
      // first read fails and backs off.
      yield* Deferred.succeed(harness.dropStream, undefined);
      yield* TestClock.adjust("1 second");
      yield* Queue.take(harness.failedReads);
      yield* TestClock.adjust("1 second");
      yield* service.runNow({ id: task.id });
      const newer = yield* Queue.take(harness.dispatched);
      // The catch-up for the first run runs out of retries and gives up.
      yield* TestClock.adjust("30 seconds");
      yield* Queue.offer(harness.events, runEvent(runOf("run:newer", newer, "completed")));
      yield* untilStatus(service, task.id, "succeeded");
    }).pipe(Effect.provide(harness.layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("records the provider error for every task steered into the same run", () =>
  Effect.gen(function* () {
    const harness = yield* makeTurnHarness();
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const { task } = yield* upsertBoundTask(service);
      const { task: second } = yield* service.upsert({
        ...task,
        id: ScheduledTaskId.make("task:second-shared-run"),
      });
      yield* service.runNow({ id: task.id });
      const firstMessage = yield* Queue.take(harness.dispatched);
      yield* service.runNow({ id: second.id });
      const secondMessage = yield* Queue.take(harness.dispatched);
      yield* Queue.offerAll(harness.events, [
        messageMovedEvent(firstMessage, "run:shared"),
        messageMovedEvent(secondMessage, "run:shared"),
        providerErrorEvent("run:shared", "You have reached your usage limit."),
        runEvent(runOf("run:shared", firstMessage, "failed")),
      ]);
      yield* service.subscribeList().pipe(
        Stream.filter(({ tasks }) => tasks.every((t) => t.lastRunStatus === "failed")),
        Stream.take(1),
        Stream.runDrain,
      );
      for (const settled of (yield* service.list()).tasks) {
        assert.equal(settled.lastRunError, "You have reached your usage limit.");
        assert.equal(settled.runCount, 1);
      }
    }).pipe(Effect.provide(harness.layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("catches an outcome missed by reconnect while dispatch is still in flight", () =>
  Effect.gen(function* () {
    const releaseDispatch = yield* Deferred.make<void>();
    const runId = RunId.make("run:dispatch-reconnect");
    const harness = yield* makeTurnHarness({
      dropStreamOnCommand: true,
      liveTail: true,
      messageRunId: runId,
      runs: [runOf(runId, MessageId.make("other"), "completed")],
      duringDispatch: () => Deferred.await(releaseDispatch),
    });
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const { task } = yield* upsertBoundTask(service);
      const dispatch = yield* service.runNow({ id: task.id }).pipe(Effect.forkChild);
      yield* Queue.take(harness.dispatched);
      yield* Deferred.succeed(harness.dropStream, undefined);
      yield* TestClock.adjust("1 second");
      assert.equal(yield* Ref.get(harness.subscriptions), 2);
      yield* Deferred.succeed(releaseDispatch, undefined);
      yield* Fiber.join(dispatch);
      yield* untilStatus(service, task.id, "succeeded");
      assert.equal((yield* service.list()).tasks[0]?.runCount, 1);
    }).pipe(Effect.provide(harness.layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);
