import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  type OrchestrationV2DomainEvent,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeRequestId,
  ScheduledTaskId,
  ThreadId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ScheduledTaskSnoozeReactor from "./ScheduledTaskSnoozeReactor.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = (snoozeThreadsUntilScheduledTask: boolean) =>
  ScheduledTaskSnoozeReactor.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        layerDatabase,
        ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
        ServerSettings.layerTest({ snoozeThreadsUntilScheduledTask }),
        ProviderReplayHarness.layerWithRegistry(
          { name: "scheduled-task-snooze" },
          ProviderAdapterRegistry.layerFromAdapters([adapter]),
          { databaseLayer: layerDatabase, runEffectWorker: false },
        ),
      ),
    ),
  );

const threadId = ThreadId.make("thread:scheduled-snooze");
const NEXT_RUN = "2030-01-01T09:00:00.000Z";

const insertTask = (
  sql: SqlClient.SqlClient,
  task: { id: string; threadId: string; next: string | null; enabled?: number; created?: string },
) =>
  sql`INSERT INTO scheduled_tasks ${sql.insert({
    task_id: task.id,
    title: "task",
    prompt: "Run task",
    enabled: task.enabled ?? 1,
    schedule_json: '{"type":"interval","everyMs":60000}',
    project_id: "project:scheduled-snooze",
    thread_id: task.threadId,
    workspace_strategy_json: '{"type":"root"}',
    model_selection_json: '{"instanceId":"codex","model":"gpt-5"}',
    runtime_mode: "full-access",
    interaction_mode: "default",
    created_by: "user",
    creation_source: "web",
    created_at: task.created ?? "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    next_run_at: task.next,
    last_run_at: null,
    last_run_status: "never",
    last_run_error: null,
    run_count: 0,
  })}`;

/** Starts a turn from `message`, writes its completion, and lets the reactor see it. */
const completeTurn = Effect.fn("test.completeTurn")(function* (
  message: { scheduledTaskId?: ScheduledTaskId } = {},
  options: {
    startedAt?: string | null;
    queueAnother?: boolean;
    pendingQuestion?: boolean;
    sendBeforeHandle?: boolean;
    snoozeBeforeComplete?: boolean;
  } = {},
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const reactor = yield* ScheduledTaskSnoozeReactor.ScheduledTaskSnoozeReactor;
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make("create-scheduled-snooze"),
    threadId,
    projectId: ProjectId.make("project:scheduled-snooze"),
    title: "Scheduled snooze",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  yield* orchestrator.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make("send-scheduled-snooze"),
    threadId,
    messageId: MessageId.make("message:scheduled-snooze"),
    text: "Schedule a daily check",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "web",
    ...message,
  });
  if (options.queueAnother === true) {
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("queue-scheduled-snooze"),
      threadId,
      messageId: MessageId.make("message:scheduled-snooze-queued"),
      text: "And another thing",
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
      createdBy: "user",
      creationSource: "web",
    });
  }
  const { runs } = yield* projections.getThreadRecords(threadId, ["runs"]);
  const run = runs.find((candidate) => candidate.ordinal === 1)!;
  const now = yield* DateTime.now;
  if (options.snoozeBeforeComplete) {
    yield* orchestrator.dispatch({
      type: "thread.snooze",
      commandId: CommandId.make("manual-scheduled-snooze"),
      threadId,
      snoozedUntil: "2031-01-01T00:00:00.000Z",
    });
  }
  const events: OrchestrationV2DomainEvent[] = [];
  if (options.pendingQuestion === true) {
    events.push({
      id: EventId.make("event:scheduled-snooze-question"),
      type: "runtime-request.updated",
      threadId,
      runId: run.id,
      occurredAt: now,
      payload: {
        id: RuntimeRequestId.make("request:scheduled-snooze"),
        nodeId: run.rootNodeId!,
        providerTurnId: null,
        nativeRequestRef: null,
        kind: "user_input",
        status: "pending",
        responseCapability: { type: "message" },
        createdAt: now,
        resolvedAt: null,
      },
    });
  }
  const completed = {
    id: EventId.make("event:scheduled-snooze-completed"),
    type: "run.updated",
    threadId,
    runId: run.id,
    occurredAt: now,
    payload: {
      ...run,
      status: "completed",
      startedAt:
        options.startedAt === null
          ? null
          : options.startedAt === undefined
            ? now
            : DateTime.makeUnsafe(options.startedAt),
      completedAt: now,
    },
  } satisfies OrchestrationV2DomainEvent;
  events.push(completed);
  yield* eventSink.write({ events });
  if (options.sendBeforeHandle === true) {
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("follow-up-scheduled-snooze"),
      threadId,
      messageId: MessageId.make("message:scheduled-snooze-follow-up"),
      text: "One more thing",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
  }
  yield* reactor.handle(completed);
  return completed;
});

const snoozedUntil = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const thread = yield* projections.getThread(threadId);
  return thread.snoozedUntil == null ? null : DateTime.formatIso(thread.snoozedUntil);
});

it.effect.each([false, true])(
  "preserves manual wakes after completion with prior snooze %s",
  (snoozeBeforeComplete) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* insertTask(sql, { id: "later", threadId, next: "2030-02-01T00:00:00.000Z" });
      yield* insertTask(sql, { id: "soonest", threadId, next: NEXT_RUN });
      yield* insertTask(sql, {
        id: "paused",
        threadId,
        next: "2029-06-01T00:00:00.000Z",
        enabled: 0,
      });
      yield* insertTask(sql, { id: "overdue", threadId, next: "1969-01-01T00:00:00.000Z" });
      yield* insertTask(sql, { id: "webhook", threadId, next: null });
      yield* insertTask(sql, {
        id: "other",
        threadId: "thread:other",
        next: "2029-06-01T00:00:00.000Z",
      });
      const completed = yield* completeTurn({}, { snoozeBeforeComplete });
      assert.strictEqual(
        yield* snoozedUntil,
        snoozeBeforeComplete ? "2031-01-01T00:00:00.000Z" : NEXT_RUN,
      );

      // A re-emitted completion must not undo a manual wake.
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      yield* orchestrator.dispatch({
        type: "thread.unsnooze",
        commandId: CommandId.make("wake-scheduled-snooze"),
        threadId,
        reason: "user",
      });
      const reactor = yield* ScheduledTaskSnoozeReactor.ScheduledTaskSnoozeReactor;
      yield* reactor.handle(completed);
      assert.strictEqual(yield* snoozedUntil, null);
    }).pipe(Effect.provide(layerTest(true))),
);

it.effect.each([
  { name: "the setting is off", setting: false },
  { name: "the run is the task's own", setting: true, fromTask: true },
  { name: "another run is still queued", setting: true, queueAnother: true },
  { name: "the turn ended on a question", setting: true, pendingQuestion: true },
  { name: "a message arrives before the snooze", setting: true, sendBeforeHandle: true },
])("leaves the thread awake when $name", (scenario) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // Created before the run, so the task's own run did not schedule it.
    yield* insertTask(sql, {
      id: "soonest",
      threadId,
      next: NEXT_RUN,
      created: "1969-01-01T00:00:00.000Z",
    });
    yield* completeTurn(
      scenario.fromTask === true ? { scheduledTaskId: ScheduledTaskId.make("soonest") } : {},
      scenario,
    );
    assert.strictEqual(yield* snoozedUntil, null);
  }).pipe(Effect.provide(layerTest(scenario.setting))),
);

it.effect.each([
  { created: "1970-01-01T00:00:30.000Z", startedAt: "1970-01-01T00:01:00.000Z", expected: null },
  {
    created: "1970-01-01T00:01:30.000Z",
    startedAt: "1970-01-01T00:01:00.000Z",
    expected: NEXT_RUN,
  },
  { created: "1970-01-01T00:01:30.000Z", startedAt: null, expected: null },
])("snoozes only for tasks created during execution: $created / $startedAt", (scenario) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* insertTask(sql, {
      id: "follow-up",
      threadId,
      next: NEXT_RUN,
      created: scenario.created,
    });
    yield* completeTurn(
      { scheduledTaskId: ScheduledTaskId.make("current") },
      { startedAt: scenario.startedAt },
    );
    assert.strictEqual(yield* snoozedUntil, scenario.expected);
  }).pipe(Effect.provide(layerTest(true))),
);
