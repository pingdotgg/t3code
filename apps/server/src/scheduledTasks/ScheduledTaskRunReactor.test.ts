import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  MessageId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2RunStatus,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2TurnItem,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ScheduledTaskId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ScheduledTaskRunReactor from "./ScheduledTaskRunReactor.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";

const threadId = ThreadId.make("thread:bound");
const taskId = ScheduledTaskId.make("task:with:colons");
const at = DateTime.makeUnsafe("2026-09-09T12:00:00.000Z");
const STOP_REASON = "Stopped by user";
const PROVIDER_ERROR = "OpenCode Go weekly usage limit reached";

const runRecord = (
  id: string,
  userMessageId: string,
  status: OrchestrationV2RunStatus,
  extra: Partial<OrchestrationV2Run> = {},
) =>
  ({
    id: RunId.make(id),
    threadId,
    userMessageId: MessageId.make(userMessageId),
    rootNodeId: `node:${id}`,
    status,
    ...extra,
  }) as OrchestrationV2Run;

const messageRecord = (id: string, runId: string) =>
  ({
    id: MessageId.make(id),
    threadId,
    runId: RunId.make(runId),
    scheduledTaskId: taskId,
  }) as OrchestrationV2ConversationMessage;

const providerFailure = (run: OrchestrationV2Run, message: string) =>
  ({
    id: `item:${run.id}`,
    runId: run.id,
    nodeId: run.rootNodeId,
    type: "error",
    status: "failed",
    ordinal: 1,
    updatedAt: at,
    failure: { message },
  }) as unknown as OrchestrationV2TurnItem;

const interruptResult = (run: OrchestrationV2Run, message: string) =>
  ({
    id: `item:${run.id}:interrupt`,
    runId: run.id,
    type: "run_interrupt_result",
    message,
  }) as unknown as OrchestrationV2TurnItem;

const runUpdated = (run: OrchestrationV2Run) =>
  ({
    type: "run.updated",
    threadId: run.threadId,
    payload: run,
  }) as OrchestrationV2DomainEvent;

const makeHarness = () => {
  const state = {
    runs: [] as Array<OrchestrationV2Run>,
    messages: [] as Array<OrchestrationV2ConversationMessage>,
    turnItems: [] as Array<OrchestrationV2TurnItem>,
    pendingContinuations: new Set<RunId>(),
    continuationSettled: new Map<RunId, Deferred.Deferred<void>>(),
    sentMessageIds: [] as Array<MessageId>,
    reads: 0,
    onSend: (_messageId: MessageId) => {},
    onRead: () => {},
    events: [] as Array<OrchestrationV2StoredEvent>,
    subscribe: Effect.void,
    streamEnded: Effect.void,
  };
  // A subscriber that attaches late: it sees what committed after its cursor, nothing earlier.
  const eventsAfter = (cursor: () => number) =>
    Stream.unwrap(
      Effect.suspend(() => state.subscribe).pipe(
        Effect.map(() => {
          const afterSequence = cursor();
          return Stream.fromIterable(
            state.events.filter((stored) => stored.sequence > afterSequence),
          );
        }),
      ),
    ).pipe(Stream.ensuring(Effect.suspend(() => state.streamEnded)));
  const getThreadRecords = (
    _threadId: ThreadId,
    _fields: ReadonlyArray<string>,
    filter?: {
      readonly messageIds?: ReadonlyArray<MessageId>;
      readonly runIds?: ReadonlyArray<RunId>;
      readonly turnItemRunIds?: ReadonlyArray<RunId | null>;
    },
  ) => {
    state.reads += 1;
    const records = {
      runs: state.runs.filter((run) => filter?.runIds?.includes(run.id) ?? true),
      messages: state.messages.filter(
        (message) => filter?.messageIds?.includes(message.id) ?? true,
      ),
      turnItems: state.turnItems.filter(
        (item) => filter?.turnItemRunIds?.includes(item.runId) ?? true,
      ),
    };
    state.onRead();
    return Effect.succeed(records as never);
  };
  const layer = ScheduledTaskRunReactor.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.mock(Orchestrator.OrchestratorV2)({
          restartContinuationPending: (run) =>
            Effect.succeed(state.pendingContinuations.has(run.id)),
          awaitRestartContinuation: (run) => {
            const settled = state.continuationSettled.get(run.id);
            return settled === undefined ? Effect.void : Deferred.await(settled);
          },
          streamDomainEvents: eventsAfter(() => state.events.length).pipe(
            Stream.map((stored) => stored.event),
          ),
        }),
        Layer.mock(EventSink.EventSinkV2)({
          latestSequence: () => Effect.sync(() => state.events.length),
          stream: (input) => eventsAfter(() => input?.afterSequence ?? 0),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({ getThreadRecords }),
        ScheduledTaskService.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              ManagedPolicy.layerTest(),
              Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
              Layer.mock(ThreadManagementService.ThreadManagementService)({
                getThreadRecords,
                getThreadShell: () =>
                  Effect.succeed({
                    projectId: ProjectId.make("project:test"),
                    archivedAt: null,
                    deletedAt: null,
                  } as never),
                sendToThread: (input) =>
                  Effect.sync(() => {
                    state.sentMessageIds.push(input.messageId);
                    state.onSend(input.messageId);
                    return {} as never;
                  }),
              }),
              Layer.mock(SecretRequests.SecretRequests)({}),
              Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
                namedProjectsRoot: "/projects",
                isScratchProject: () => Effect.succeed(false),
              }),
              NodeCrypto.layer,
              Layer.succeed(Scheduler.Scheduler, { register: () => Effect.void }),
            ),
          ),
        ),
      ),
    ),
  );
  return { state, layer };
};

const saveTask = Effect.gen(function* () {
  const service = yield* ScheduledTaskService.ScheduledTaskService;
  yield* service.upsert({
    id: taskId,
    title: "Daily notes",
    prompt: "Update the notes",
    enabled: true,
    schedule: { type: "interval", everyMs: 60_000 },
    projectId: ProjectId.make("project:test"),
    threadId,
    workspaceStrategy: { type: "root" },
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
  });
});

const fire = (state: ReturnType<typeof makeHarness>["state"]) =>
  Effect.gen(function* () {
    const service = yield* ScheduledTaskService.ScheduledTaskService;
    yield* service.runNow({ id: taskId });
    const messageId = state.sentMessageIds.at(-1);
    assert.isDefined(messageId);
    return messageId as string;
  });

const taskRow = Effect.gen(function* () {
  const service = yield* ScheduledTaskService.ScheduledTaskService;
  const { tasks } = yield* service.list();
  const [task] = tasks;
  assert.isDefined(task);
  return { status: task?.lastRunStatus, error: task?.lastRunError };
});

const scenario = <E>(
  test: (
    state: ReturnType<typeof makeHarness>["state"],
  ) => Effect.Effect<
    void,
    E,
    | ScheduledTaskRunReactor.ScheduledTaskRunReactor
    | ScheduledTaskService.ScheduledTaskService
    | SqlClient.SqlClient
  >,
) =>
  Effect.gen(function* () {
    const { state, layer } = makeHarness();
    yield* Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.toEpochMillis(at));
      yield* saveTask;
      yield* test(state);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory));

const reactor = ScheduledTaskRunReactor.ScheduledTaskRunReactor;

it.effect("records the provider's error when a dispatched run fails", () =>
  scenario((state) =>
    Effect.gen(function* () {
      const { handle } = yield* reactor;
      const messageId = yield* fire(state);
      const run = runRecord("run:1", messageId, "failed");
      state.runs.push(run);
      state.messages.push(messageRecord(messageId, run.id));
      state.turnItems.push(providerFailure(run, PROVIDER_ERROR));

      yield* handle(runUpdated(run));

      assert.deepEqual(yield* taskRow, { status: "failed", error: PROVIDER_ERROR });
    }),
  ),
);

it.effect("always gives a failed run an error, because mobile reads only that field", () =>
  scenario((state) =>
    Effect.gen(function* () {
      const { handle } = yield* reactor;
      const messageId = yield* fire(state);
      const run = runRecord("run:1", messageId, "failed");
      state.runs.push(run);
      state.messages.push(messageRecord(messageId, run.id));

      yield* handle(runUpdated(run));

      assert.deepEqual(yield* taskRow, { status: "failed", error: "The run failed." });
    }),
  ),
);

it.effect("records why a run was stopped", () =>
  scenario((state) =>
    Effect.gen(function* () {
      const { handle } = yield* reactor;
      const messageId = yield* fire(state);
      const run = runRecord("run:1", messageId, "interrupted");
      state.runs.push(run);
      state.messages.push(messageRecord(messageId, run.id));
      state.turnItems.push(interruptResult(run, STOP_REASON));

      yield* handle(runUpdated(run));

      assert.deepEqual(yield* taskRow, { status: "failed", error: STOP_REASON });
    }),
  ),
);

it.effect("leaves a completed run as succeeded", () =>
  scenario((state) =>
    Effect.gen(function* () {
      const { handle } = yield* reactor;
      const messageId = yield* fire(state);
      const run = runRecord("run:1", messageId, "completed");
      state.runs.push(run);
      state.messages.push(messageRecord(messageId, run.id));

      yield* handle(runUpdated(run));

      assert.deepEqual(yield* taskRow, { status: "succeeded", error: null });
    }),
  ),
);

it.effect("does not let an older fire overwrite a newer run", () =>
  scenario((state) =>
    Effect.gen(function* () {
      const { handle } = yield* reactor;
      const older = yield* fire(state);
      yield* TestClock.adjust("1 minute");
      yield* fire(state);
      const run = runRecord("run:older", older, "failed");
      state.runs.push(run);
      state.messages.push(messageRecord(older, run.id));
      state.turnItems.push(providerFailure(run, PROVIDER_ERROR));

      yield* handle(runUpdated(run));

      assert.deepEqual(yield* taskRow, { status: "succeeded", error: null });
    }),
  ),
);

it.effect("records a run that failed before markCompleted committed", () =>
  scenario((state) =>
    Effect.gen(function* () {
      state.onSend = (messageId) => {
        const run = runRecord("run:1", messageId, "failed");
        state.runs.push(run);
        state.messages.push(messageRecord(messageId, run.id));
        state.turnItems.push(providerFailure(run, PROVIDER_ERROR));
      };

      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const { task } = yield* service.runNow({ id: taskId });

      assert.deepEqual(
        { status: task.lastRunStatus, error: task.lastRunError },
        { status: "failed", error: PROVIDER_ERROR },
      );
      assert.deepEqual(yield* taskRow, { status: "failed", error: PROVIDER_ERROR });
    }),
  ),
);

it.effect("matches webhook runs by their delivery id", () =>
  scenario((state) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const { handle } = yield* reactor;
      yield* sql`UPDATE scheduled_tasks
        SET last_run_status = 'succeeded',
            last_run_at = '2026-09-09T12:00:00.000Z',
            last_run_webhook_delivery_id = 'delivery:current'`;
      const fireRun = (delivery: string, id: string) => {
        const messageId = `scheduled-task-message:${taskId}:webhook:${delivery}`;
        const run = runRecord(id, messageId, "failed");
        state.runs.push(run);
        state.messages.push(messageRecord(messageId, run.id));
        state.turnItems.push(providerFailure(run, PROVIDER_ERROR));
        return run;
      };

      yield* handle(runUpdated(fireRun("delivery:older", "run:older")));
      assert.deepEqual(yield* taskRow, { status: "succeeded", error: null });

      yield* handle(runUpdated(fireRun("delivery:current", "run:current")));
      assert.deepEqual(yield* taskRow, { status: "failed", error: PROVIDER_ERROR });
    }),
  ),
);

it.effect("does not treat a Steer promotion as a failure", () =>
  scenario((state) =>
    Effect.gen(function* () {
      const { handle } = yield* reactor;
      const messageId = yield* fire(state);
      const active = runRecord("run:active", "message:user", "failed");
      const queued = runRecord("run:queued", messageId, "cancelled");
      state.runs.push(active, queued);
      state.messages.push(messageRecord(messageId, active.id));
      state.turnItems.push(providerFailure(active, PROVIDER_ERROR));

      yield* handle(runUpdated(queued));

      assert.deepEqual(yield* taskRow, { status: "succeeded", error: null });
    }),
  ),
);

it.effect("treats a cancelled run with no continuation as failed", () =>
  scenario((state) =>
    Effect.gen(function* () {
      const { handle } = yield* reactor;
      const messageId = yield* fire(state);
      const run = runRecord("run:1", messageId, "cancelled");
      state.runs.push(run);
      state.messages.push(messageRecord(messageId, run.id));

      yield* handle(runUpdated(run));

      assert.deepEqual(yield* taskRow, { status: "failed", error: "The run was cancelled." });
    }),
  ),
);

it.effect("lets a restart continuation decide the outcome", () =>
  scenario((state) =>
    Effect.gen(function* () {
      const { handle } = yield* reactor;
      const messageId = yield* fire(state);
      const source = runRecord("run:source", messageId, "cancelled");
      state.runs.push(source);
      state.messages.push(messageRecord(messageId, source.id));
      state.pendingContinuations.add(source.id);
      state.continuationSettled.set(source.id, yield* Deferred.make<void>());

      yield* handle(runUpdated(source));
      assert.deepEqual(yield* taskRow, { status: "succeeded", error: null });

      state.pendingContinuations.delete(source.id);
      const continuation = runRecord("run:continued", "message:restart-continuation", "completed", {
        restartContinuationOfRunId: source.id,
      });
      state.runs.push(continuation);
      yield* handle(runUpdated(continuation));
      assert.deepEqual(yield* taskRow, { status: "succeeded", error: null });

      const failed = { ...continuation, status: "failed" as const };
      state.runs[state.runs.indexOf(continuation)] = failed;
      state.turnItems.push(providerFailure(failed, PROVIDER_ERROR));
      yield* handle(runUpdated(failed));
      assert.deepEqual(yield* taskRow, { status: "failed", error: PROVIDER_ERROR });
    }),
  ),
);

it.effect("records a cancelled run once its restart continuation is declined", () =>
  scenario((state) =>
    Effect.gen(function* () {
      const { handle } = yield* reactor;
      const messageId = yield* fire(state);
      const source = runRecord("run:source", messageId, "cancelled");
      state.runs.push(source);
      state.messages.push(messageRecord(messageId, source.id));
      state.pendingContinuations.add(source.id);
      const settled = yield* Deferred.make<void>();
      state.continuationSettled.set(source.id, settled);
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const failed = yield* Deferred.make<void>();
      yield* service.subscribeList().pipe(
        Stream.runForEach(({ tasks }) =>
          tasks[0]?.lastRunStatus === "failed" ? Deferred.succeed(failed, undefined) : Effect.void,
        ),
        Effect.forkChild,
      );

      yield* handle(runUpdated(source));
      assert.deepEqual(yield* taskRow, { status: "succeeded", error: null });

      state.pendingContinuations.delete(source.id);
      yield* Deferred.succeed(settled, undefined);
      yield* Deferred.await(failed);
      assert.deepEqual(yield* taskRow, { status: "failed", error: "The run was cancelled." });
    }),
  ),
);

it.effect("does no reads for events and runs that are not a scheduled run's bad ending", () =>
  scenario((state) =>
    Effect.gen(function* () {
      const { handle } = yield* reactor;
      const before = state.reads;

      yield* handle({ type: "thread.updated", threadId } as unknown as OrchestrationV2DomainEvent);
      yield* handle(runUpdated(runRecord("run:user", "message:user", "failed")));
      yield* handle(runUpdated(runRecord("run:done", "scheduled-task-message:x", "completed")));

      assert.equal(state.reads, before);
    }),
  ),
);

it.effect("catches up on a run that ended while the server was down", () =>
  scenario((state) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const { reconcile } = yield* reactor;
      const messageId = yield* fire(state);
      const run = runRecord("run:1", messageId, "failed");
      state.runs.push(run);
      state.messages.push(messageRecord(messageId, run.id));
      state.turnItems.push(providerFailure(run, PROVIDER_ERROR));
      yield* sql`INSERT INTO orchestration_v2_projection_messages ${sql.insert({
        message_id: messageId,
        thread_id: threadId,
        run_id: run.id,
        node_id: null,
        role: "user",
        streaming: 0,
        created_at: "2026-09-09T12:00:00.000Z",
        updated_at: "2026-09-09T12:00:00.000Z",
        payload_json: "{}",
      })}`;

      yield* reconcile;

      assert.deepEqual(yield* taskRow, { status: "failed", error: PROVIDER_ERROR });
    }),
  ),
);

it.effect("records a run that fails after the startup catch-up read it", () =>
  scenario((state) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const { start } = yield* reactor;
      const messageId = yield* fire(state);
      const running = runRecord("run:1", messageId, "running");
      state.runs.push(running);
      state.messages.push(messageRecord(messageId, running.id));
      yield* sql`INSERT INTO orchestration_v2_projection_messages ${sql.insert({
        message_id: messageId,
        thread_id: threadId,
        run_id: running.id,
        node_id: null,
        role: "user",
        streaming: 0,
        created_at: "2026-09-09T12:00:00.000Z",
        updated_at: "2026-09-09T12:00:00.000Z",
        payload_json: "{}",
      })}`;
      const committed = yield* Deferred.make<void>();
      const ended = yield* Deferred.make<void>();
      state.subscribe = Deferred.await(committed);
      state.streamEnded = Deferred.succeed(ended, undefined);
      state.onRead = () => {
        state.onRead = () => {};
        const failed = { ...running, status: "failed" as const };
        state.runs[state.runs.indexOf(running)] = failed;
        state.turnItems.push(providerFailure(failed, PROVIDER_ERROR));
        state.events.push({ sequence: 1, event: runUpdated(failed) } as OrchestrationV2StoredEvent);
        Deferred.doneUnsafe(committed, Effect.void);
      };

      yield* Effect.scoped(start().pipe(Effect.andThen(Deferred.await(ended))));

      assert.deepEqual(yield* taskRow, { status: "failed", error: PROVIDER_ERROR });
    }),
  ),
);
