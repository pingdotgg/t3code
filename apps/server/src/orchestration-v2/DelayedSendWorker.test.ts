import { assert, it } from "@effect/vitest";
import {
  ComposerContextId,
  CommandId,
  EventId,
  MessageId,
  NodeId,
  PlanId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as DelayedSendWorker from "./DelayedSendWorker.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderRuntimeRecovery from "./ProviderRuntimeRecoveryService.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Runs here never reach a provider"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = ThreadManagementService.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      layerDatabase,
      ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
      EventStore.layer.pipe(Layer.provide(layerDatabase)),
      EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
      ProviderReplayHarness.layerWithRegistry(
        { name: "delayed-send" },
        ProviderAdapterRegistry.layerFromAdapters([adapter]),
        { databaseLayer: layerDatabase, runEffectWorker: false },
      ),
    ),
  ),
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provideMerge(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
  Layer.provideMerge(TestClock.layer()),
);

const FIVE_MINUTES_MS = 5 * 60_000;

const createThread = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId: ProjectId.make("project:delayed-send"),
      title: threadId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
  });

const send = (
  threadId: ThreadId,
  text: string,
  options: {
    readonly mode?: "start_immediately" | "queue_after_active";
    readonly delayMs?: number;
    readonly deliveryIntent?: "steer";
  } = {},
) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`send:${threadId}:${text}`),
      threadId,
      messageId: MessageId.make(`message:${threadId}:${text}`),
      text,
      attachments: [],
      dispatchMode: { type: options.mode ?? "queue_after_active" },
      ...(options.delayMs === undefined ? {} : { delayMs: options.delayMs }),
      ...(options.deliveryIntent === undefined ? {} : { deliveryIntent: options.deliveryIntent }),
      createdBy: "user",
      creationSource: "web",
    });
    const projection = yield* orchestrator.getThreadProjection(threadId);
    return projection.runs.find(
      (run) => run.userMessageId === MessageId.make(`message:${threadId}:${text}`),
    )!;
  });

const dispatch = (command: OrchestrationV2ServerCommand) =>
  Orchestrator.OrchestratorV2.use((orchestrator) => orchestrator.dispatch(command));

const runOf = (threadId: ThreadId, runId: RunId) =>
  Orchestrator.OrchestratorV2.use((orchestrator) =>
    orchestrator.getThreadProjection(threadId),
  ).pipe(Effect.map((projection) => projection.runs.find((run) => run.id === runId)!));

const schedule = (run: OrchestrationV2Run) => ({
  status: run.status,
  releaseAt: run.releaseAt === undefined ? null : DateTime.toEpochMillis(run.releaseAt),
  held: run.queueHeld === true,
});

/** Queue promotion after a run ends happens in a reactor; wait for its committed event. */
const firstRunToReach = (
  threadId: ThreadId,
  status: OrchestrationV2Run["status"],
  afterSequence: number,
) =>
  EventSink.EventSinkV2.use((sink) =>
    sink.stream({ threadId, afterSequence, eventType: "run.updated" }).pipe(
      Stream.map((stored) => (stored.event.type === "run.updated" ? stored.event.payload : null)),
      Stream.filter((run) => run?.status === status),
      Stream.map((run) => run!.id),
      Stream.runHead,
      Effect.map(Option.getOrNull),
    ),
  );

const latestSequence = (threadId: ThreadId) =>
  EventSink.EventSinkV2.use((sink) => sink.latestSequence({ threadId }));

const sweep = DelayedSendWorker.releaseDueScheduledRuns();

it.effect("an idle thread holds a scheduled send until its time, then starts it", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make("thread:delayed-idle");
    yield* createThread(threadId);
    const sentAt = DateTime.toEpochMillis(yield* DateTime.now);
    const scheduled = yield* send(threadId, "later", { delayMs: FIVE_MINUTES_MS });
    const releaseAt = sentAt + FIVE_MINUTES_MS;

    assert.deepEqual(schedule(scheduled), { status: "queued", releaseAt, held: false });
    const waiting = yield* orchestrator.getThreadShell(threadId);
    assert.equal(waiting?.status, "idle");
    assert.isNull(waiting?.activeRunId);
    // Not a turn being started: the message has not been sent yet.
    assert.isNull(waiting?.latestUserMessageAt);

    yield* TestClock.adjust(FIVE_MINUTES_MS - 1_000);
    yield* sweep;
    assert.deepEqual(schedule(yield* runOf(threadId, scheduled.id)), {
      status: "queued",
      releaseAt,
      held: false,
    });

    yield* TestClock.adjust(1_000);
    yield* sweep;
    assert.deepEqual(schedule(yield* runOf(threadId, scheduled.id)), {
      status: "starting",
      releaseAt: null,
      held: false,
    });
    const started = yield* orchestrator.getThreadShell(threadId);
    assert.equal(started?.activeRunId, scheduled.id);
    assert.equal(
      started?.latestUserMessageAt === null || started?.latestUserMessageAt === undefined
        ? null
        : DateTime.toEpochMillis(started.latestUserMessageAt),
      sentAt,
    );

    // A sweep that finds nothing due leaves the thread alone.
    yield* sweep;
    assert.equal((yield* runOf(threadId, scheduled.id)).status, "starting");
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "messages sent normally pass a scheduled send, and ending a run never releases it early",
  () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:delayed-bypass");
      yield* createThread(threadId);
      const scheduled = yield* send(threadId, "later", { delayMs: FIVE_MINUTES_MS });
      const releaseAt = schedule(scheduled).releaseAt;

      // An idle thread starts a normal send even with a scheduled one waiting.
      const active = yield* send(threadId, "now", { mode: "start_immediately" });
      assert.equal(active.status, "starting");
      const followUp = yield* send(threadId, "follow-up");
      assert.equal(followUp.status, "queued");

      const beforeInterrupt = yield* latestSequence(threadId);
      yield* dispatch({
        type: "run.interrupt",
        commandId: CommandId.make("interrupt:delayed-bypass:now"),
        threadId,
        runId: active.id,
      });
      assert.equal(yield* firstRunToReach(threadId, "starting", beforeInterrupt), followUp.id);
      assert.deepEqual(schedule(yield* runOf(threadId, scheduled.id)), {
        status: "queued",
        releaseAt,
        held: false,
      });

      const beforeSecondInterrupt = yield* latestSequence(threadId);
      yield* dispatch({
        type: "run.interrupt",
        commandId: CommandId.make("interrupt:delayed-bypass:follow-up"),
        threadId,
        runId: followUp.id,
      });
      // The queue reactor runs startNextQueuedRun after this event; so does resume.
      assert.equal(
        yield* firstRunToReach(threadId, "interrupted", beforeSecondInterrupt),
        followUp.id,
      );
      yield* dispatch({
        type: "queue.resume",
        commandId: CommandId.make("resume:delayed-bypass"),
        threadId,
      });
      assert.deepEqual(schedule(yield* runOf(threadId, scheduled.id)), {
        status: "queued",
        releaseAt,
        held: false,
      });

      yield* TestClock.adjust(FIVE_MINUTES_MS);
      yield* sweep;
      assert.equal((yield* runOf(threadId, scheduled.id)).status, "starting");
    }).pipe(Effect.provide(layerTest)),
);

it.effect("Send now releases a scheduled message, and a release that lost a race is a no-op", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:delayed-release");
    yield* createThread(threadId);
    const active = yield* send(threadId, "now", { mode: "start_immediately" });
    const scheduled = yield* send(threadId, "later", { delayMs: FIVE_MINUTES_MS });

    yield* dispatch({
      type: "queued-run.release",
      commandId: CommandId.make("release:delayed-release:manual"),
      threadId,
      runId: scheduled.id,
    });
    // Released into the queue behind the active run, not started over it.
    assert.deepEqual(schedule(yield* runOf(threadId, scheduled.id)), {
      status: "queued",
      releaseAt: null,
      held: false,
    });

    // The due sweep read the run before Send now committed.
    const raced = yield* dispatch({
      type: "queued-run.release",
      commandId: CommandId.make(`scheduled-release:${scheduled.id}:raced`),
      threadId,
      runId: scheduled.id,
    });
    assert.lengthOf(raced.storedEvents, 0);
    const notQueued = yield* dispatch({
      type: "queued-run.release",
      commandId: CommandId.make("release:delayed-release:active"),
      threadId,
      runId: active.id,
    });
    assert.lengthOf(notQueued.storedEvents, 0);
    const unknown = yield* dispatch({
      type: "queued-run.release",
      commandId: CommandId.make("release:delayed-release:unknown"),
      threadId,
      runId: RunId.make("run:delayed-release:unknown"),
    }).pipe(Effect.flip);
    assert.equal(unknown._tag, "OrchestratorDispatchError");

    const beforeInterrupt = yield* latestSequence(threadId);
    yield* dispatch({
      type: "run.interrupt",
      commandId: CommandId.make("interrupt:delayed-release"),
      threadId,
      runId: active.id,
    });
    assert.equal(yield* firstRunToReach(threadId, "starting", beforeInterrupt), scheduled.id);

    // On an idle thread Send now starts the message at once.
    const idleThreadId = ThreadId.make("thread:delayed-release-idle");
    yield* createThread(idleThreadId);
    const idleScheduled = yield* send(idleThreadId, "later", { delayMs: FIVE_MINUTES_MS });
    yield* dispatch({
      type: "queued-run.release",
      commandId: CommandId.make("release:delayed-release-idle"),
      threadId: idleThreadId,
      runId: idleScheduled.id,
    });
    assert.equal((yield* runOf(idleThreadId, idleScheduled.id)).status, "starting");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("editing a scheduled send keeps its time, and a cancelled one never sends", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make("thread:delayed-edit");
    yield* createThread(threadId);
    const scheduled = yield* send(threadId, "later", { delayMs: FIVE_MINUTES_MS });
    const cancelled = yield* send(threadId, "never", { delayMs: FIVE_MINUTES_MS });
    const releaseAt = schedule(scheduled).releaseAt;

    yield* TestClock.adjust(60_000);
    const attachment = {
      type: "image" as const,
      id: "delayed-edit-attachment",
      name: "screenshot.png",
      mimeType: "image/png",
      sizeBytes: 128,
    };
    yield* dispatch({
      type: "queued-run.edit",
      commandId: CommandId.make("edit:delayed-edit"),
      threadId,
      runId: scheduled.id,
      text: "Edited [file](t3-context://v1/file/delayed-edit-file)",
      attachments: [attachment],
      context: {
        version: 1,
        records: [
          {
            version: 1,
            contextId: ComposerContextId.make("delayed-edit-file"),
            kind: "file",
            label: attachment.name,
            attachmentId: attachment.id,
            name: attachment.name,
            mimeType: attachment.mimeType,
            sizeBytes: attachment.sizeBytes,
          },
        ],
      },
    });
    assert.deepEqual(schedule(yield* runOf(threadId, scheduled.id)), {
      status: "queued",
      releaseAt,
      held: false,
    });

    yield* dispatch({
      type: "queued-run.cancel",
      commandId: CommandId.make("cancel:delayed-edit"),
      threadId,
      runId: cancelled.id,
    });

    yield* TestClock.adjust(FIVE_MINUTES_MS);
    yield* sweep;
    const projection = yield* orchestrator.getThreadProjection(threadId);
    assert.equal(projection.runs.find((run) => run.id === scheduled.id)?.status, "starting");
    assert.equal(projection.runs.find((run) => run.id === cancelled.id)?.status, "cancelled");
    const message = projection.messages.find((entry) => entry.id === scheduled.userMessageId);
    assert.equal(message?.text, "Edited [file](t3-context://v1/file/delayed-edit-file)");
    assert.deepEqual(
      message?.attachments.map((entry) => entry.id),
      ["delayed-edit-attachment"],
    );
    assert.deepEqual(
      message?.context?.records.map((record) => record.contextId),
      ["delayed-edit-file"],
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a stopped queue keeps a due scheduled send until the user resumes it", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:delayed-held");
    yield* createThread(threadId);
    yield* send(threadId, "now", { mode: "start_immediately" });
    const scheduled = yield* send(threadId, "later", { delayMs: FIVE_MINUTES_MS });
    const releaseAt = schedule(scheduled).releaseAt;

    yield* dispatch({
      type: "thread.stop",
      commandId: CommandId.make("stop:delayed-held"),
      threadId,
    });
    assert.deepEqual(schedule(yield* runOf(threadId, scheduled.id)), {
      status: "queued",
      releaseAt,
      held: true,
    });

    yield* TestClock.adjust(FIVE_MINUTES_MS);
    yield* sweep;
    assert.deepEqual(schedule(yield* runOf(threadId, scheduled.id)), {
      status: "queued",
      releaseAt: null,
      held: true,
    });

    yield* dispatch({
      type: "queue.resume",
      commandId: CommandId.make("resume:delayed-held"),
      threadId,
    });
    assert.equal((yield* runOf(threadId, scheduled.id)).status, "starting");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a restart holds scheduled sends, and resuming before their time does not send", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make("thread:delayed-restart");
    yield* createThread(threadId);
    const scheduled = yield* send(threadId, "later", { delayMs: FIVE_MINUTES_MS });
    const releaseAt = schedule(scheduled).releaseAt;

    yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService.use((recovery) =>
      recovery.reconcile("startup"),
    ).pipe(
      Effect.provide(
        ProviderRuntimeRecovery.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              IdAllocator.layer,
              Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({
                runRecoveryOnce: Effect.succeed(false),
              }),
            ),
          ),
        ),
      ),
    );
    yield* orchestrator.resumeQueuedRuns;
    assert.deepEqual(schedule(yield* runOf(threadId, scheduled.id)), {
      status: "queued",
      releaseAt,
      held: true,
    });

    yield* dispatch({
      type: "queue.resume",
      commandId: CommandId.make("resume:delayed-restart"),
      threadId,
    });
    assert.deepEqual(schedule(yield* runOf(threadId, scheduled.id)), {
      status: "queued",
      releaseAt,
      held: false,
    });

    yield* TestClock.adjust(FIVE_MINUTES_MS);
    yield* sweep;
    assert.equal((yield* runOf(threadId, scheduled.id)).status, "starting");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("refuses to schedule a steer, and archiving cancels a scheduled send", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:delayed-refused");
    yield* createThread(threadId);
    const steer = yield* send(threadId, "steer", {
      delayMs: FIVE_MINUTES_MS,
      deliveryIntent: "steer",
    }).pipe(Effect.flip);
    assert.equal(steer._tag, "OrchestratorDispatchError");

    const scheduled = yield* send(threadId, "later", { delayMs: FIVE_MINUTES_MS });
    yield* dispatch({
      type: "thread.archive",
      commandId: CommandId.make("archive:delayed-refused"),
      threadId,
    });
    // Unarchiving later must not send a message the user may have forgotten.
    assert.equal((yield* runOf(threadId, scheduled.id)).status, "cancelled");
    yield* TestClock.adjust(FIVE_MINUTES_MS);
    yield* sweep;
    assert.equal((yield* runOf(threadId, scheduled.id)).status, "cancelled");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("refuses to schedule a plan implementation without touching the plan", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:delayed-plan");
    const planId = PlanId.make("plan:delayed-plan");
    yield* createThread(threadId);
    yield* ProjectionStore.ProjectionStoreV2.use((store) =>
      Effect.gen(function* () {
        yield* store.apply({
          id: EventId.make("plan:delayed-plan"),
          type: "plan.updated",
          threadId,
          occurredAt: yield* DateTime.now,
          payload: {
            id: planId,
            threadId,
            runId: null,
            nodeId: NodeId.make("node:delayed-plan"),
            kind: "proposed_plan",
            status: "active",
            markdown: "# Plan\n\n1. Do the thing.",
          },
        });
      }),
    );
    const implement = (key: string, delayMs?: number) =>
      dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`implement:${key}`),
        threadId,
        messageId: MessageId.make(`message:delayed-plan:${key}`),
        text: "Implement the plan.",
        attachments: [],
        sourcePlanRef: { threadId, planId },
        dispatchMode: { type: "start_immediately" },
        ...(delayMs === undefined ? {} : { delayMs }),
        createdBy: "user",
        creationSource: "web",
      });
    const planStatus = ProjectionStore.ProjectionStoreV2.use((store) =>
      store.getPlan(threadId, planId),
    ).pipe(Effect.map((plan) => plan?.status));
    const before = yield* latestSequence(threadId);

    // Queueing completes the plan, so a cancelled scheduled send would strand it as done.
    const refused = yield* implement("later", FIVE_MINUTES_MS).pipe(Effect.flip);
    assert.equal(refused._tag, "OrchestratorDispatchError");
    assert.equal(yield* latestSequence(threadId), before);
    const untouched = yield* Orchestrator.OrchestratorV2.use((orchestrator) =>
      orchestrator.getThreadProjection(threadId),
    );
    assert.isEmpty(untouched.runs);
    assert.isEmpty(untouched.messages);
    assert.equal(yield* planStatus, "active");

    yield* implement("now");
    const started = yield* Orchestrator.OrchestratorV2.use((orchestrator) =>
      orchestrator.getThreadProjection(threadId),
    );
    assert.deepEqual(
      started.runs.map((run) => [run.userMessageId, run.status]),
      [[MessageId.make("message:delayed-plan:now"), "starting"]],
    );
    assert.equal(yield* planStatus, "completed");
  }).pipe(Effect.provide(layerTest)),
);

const storageCases = (["sqlite", "memory"] as const).map((storage) => ({
  storage,
  storeLayer:
    storage === "sqlite"
      ? ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory))
      : ProjectionStore.layerMemory,
}));

function storedThreadEvents(input: {
  readonly threadId: ThreadId;
  readonly now: DateTime.Utc;
  readonly archived: boolean;
  readonly runs: ReadonlyArray<{
    readonly key: string;
    readonly status: OrchestrationV2Run["status"];
    readonly releaseInMs?: number;
    readonly messageAgeMs: number;
  }>;
}): ReadonlyArray<OrchestrationV2DomainEvent> {
  const { threadId, now } = input;
  const providerThreadId = ProviderThreadId.make(`provider-thread:${threadId}`);
  const driver = ProviderDriverKind.make("codex");
  const common = { threadId, occurredAt: now };
  return [
    {
      ...common,
      id: EventId.make(`${threadId}:thread`),
      type: "thread.created",
      payload: {
        id: threadId,
        projectId: ProjectId.make("project:delayed-send"),
        title: threadId,
        providerInstanceId: instanceId,
        modelSelection,
        createdBy: "user",
        creationSource: "web",
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: "/workspace",
        activeProviderThreadId: providerThreadId,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: input.archived ? now : null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      },
    },
    {
      ...common,
      id: EventId.make(`${threadId}:provider-thread`),
      type: "provider-thread.updated",
      payload: {
        id: providerThreadId,
        driver,
        providerInstanceId: instanceId,
        providerSessionId: null,
        appThreadId: threadId,
        ownerNodeId: null,
        nativeThreadRef: null,
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: null,
        lastRunOrdinal: null,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      },
    },
    ...input.runs.flatMap((run, index): ReadonlyArray<OrchestrationV2DomainEvent> => {
      const runId = RunId.make(`run:${threadId}:${run.key}`);
      const messageId = MessageId.make(`message:${threadId}:${run.key}`);
      const nodeId = NodeId.make(`node:${threadId}:${run.key}`);
      const messageAt = DateTime.subtract(now, { milliseconds: run.messageAgeMs });
      return [
        {
          ...common,
          id: EventId.make(`${runId}:created`),
          type: "run.created",
          payload: {
            id: runId,
            threadId,
            ordinal: index + 1,
            providerInstanceId: instanceId,
            modelSelection,
            providerThreadId,
            userMessageId: messageId,
            rootNodeId: nodeId,
            activeAttemptId: RunAttemptId.make(`attempt:${threadId}:${run.key}`),
            status: run.status,
            queuePosition: run.status === "queued" ? index + 1 : null,
            ...(run.releaseInMs === undefined
              ? {}
              : { releaseAt: DateTime.add(now, { milliseconds: run.releaseInMs }) }),
            requestedAt: messageAt,
            startedAt: null,
            completedAt: run.status === "queued" ? null : messageAt,
            checkpointId: null,
            contextHandoffId: null,
          },
        },
        {
          ...common,
          id: EventId.make(`${runId}:message`),
          type: "message.updated",
          payload: {
            id: messageId,
            threadId,
            runId,
            nodeId,
            role: "user",
            text: run.key,
            attachments: [],
            streaming: false,
            createdBy: "user",
            creationSource: "web",
            createdAt: messageAt,
            updatedAt: messageAt,
          },
        },
      ];
    }),
  ];
}

it.effect.each(storageCases)(
  "$storage: only queued sends past their time are due, and none of them start the queue",
  ({ storeLayer }) =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:delayed-store");
      const archivedThreadId = ThreadId.make("thread:delayed-store-archived");
      const events = [
        ...storedThreadEvents({
          threadId,
          now,
          archived: false,
          runs: [
            { key: "sent", status: "cancelled", releaseInMs: -1_000, messageAgeMs: 180_000 },
            { key: "due", status: "queued", releaseInMs: -1_000, messageAgeMs: 0 },
            { key: "future", status: "queued", releaseInMs: 60_000, messageAgeMs: 0 },
          ],
        }),
        ...storedThreadEvents({
          threadId: archivedThreadId,
          now,
          archived: true,
          runs: [{ key: "due", status: "queued", releaseInMs: -1_000, messageAgeMs: 0 }],
        }),
      ];
      yield* Effect.forEach(events, (event) => store.apply(event), { discard: true });
      const dueRunId = RunId.make(`run:${threadId}:due`);

      assert.deepEqual(
        (yield* store.getDueScheduledRuns(now)).map((run) => [run.threadId, run.runId]),
        [[threadId, dueRunId]],
      );
      assert.isFalse(yield* store.canStartQueuedRun(threadId));
      const userMessageTimes = Effect.gen(function* () {
        const shell = (yield* store.getThreadShell(threadId))!;
        const [candidate] = yield* store.getSettlementCandidates(threadId);
        assert.isDefined(candidate);
        const millis = (at: DateTime.Utc | null | undefined) =>
          DateTime.toEpochMillis(at!) - DateTime.toEpochMillis(now);
        return {
          status: shell.status,
          shell: [millis(shell.latestUserMessageAt), millis(shell.latestUserAuthoredMessageAt)],
          settlement: [
            millis(candidate!.latestUserMessageAt),
            millis(candidate!.latestUserAuthoredMessageAt),
          ],
        };
      });
      // Settlement must not count a message the user has not sent yet as recent activity.
      assert.deepEqual(yield* userMessageTimes, {
        status: "cancelled",
        shell: [-180_000, -180_000],
        settlement: [-180_000, -180_000],
      });

      const due = events.find(
        (event): event is Extract<OrchestrationV2DomainEvent, { readonly type: "run.created" }> =>
          event.type === "run.created" && event.payload.id === dueRunId,
      )!;
      const { releaseAt: _releaseAt, ...released } = due.payload;
      yield* store.apply({
        ...due,
        id: EventId.make(`${dueRunId}:released`),
        type: "run.updated",
        runId: dueRunId,
        payload: released,
      });
      assert.isEmpty(yield* store.getDueScheduledRuns(now));
      assert.isTrue(yield* store.canStartQueuedRun(threadId));
      assert.deepEqual(yield* userMessageTimes, {
        status: "queued",
        shell: [0, 0],
        settlement: [0, 0],
      });
    }).pipe(Effect.provide(storeLayer)),
);
