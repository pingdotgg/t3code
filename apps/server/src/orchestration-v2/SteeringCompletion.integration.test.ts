import { assert, it } from "@effect/vitest";
import {
  ChatAttachmentId,
  CommandId,
  MessageId,
  EventId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  ThreadId,
  TurnItemId,
  type ChatAttachment,
  type ModelSelection,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "test-model" };

it.effect.each(
  (
    [
      [false, "during delivery"],
      [false, "before dispatch"],
      [true, "after delivery"],
      [true, "without native steering"],
      [true, "with interrupting native steering"],
      [true, "settled only"],
      [false, "during continuation"],
      ["question", "during delivery"],
    ] as const
  ).map(([kind, timing]) => ({
    mailbox: kind === true,
    question: kind === "question",
    timing,
    label:
      kind === "question" ? "delegated task question" : kind ? "mailbox notification" : "steering",
  })),
)("delivers $label when completion wins $timing", ({ mailbox, question, timing }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace(`steering-completion-${timing.replaceAll(" ", "-")}`);
      const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
      const started: ProviderAdapter.ProviderAdapterV2TurnInput[] = [];
      const steerEntered = yield* Deferred.make<void>();
      const rejectSteer = yield* Deferred.make<void>();
      let steerCalls = 0;
      const capabilities = {
        ...CodexProviderCapabilitiesV2,
        turns: {
          ...CodexProviderCapabilitiesV2.turns,
          supportsActiveSteering: timing !== "without native steering",
          activeSteeringInterruptsTools: timing === "with interrupting native steering",
        },
      };
      const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
        instanceId,
        driver,
        getCapabilities: () => Effect.succeed(capabilities),
        planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
        openSession: (input) =>
          Effect.gen(function* () {
            const now = yield* DateTime.now;
            return {
              instanceId,
              driver,
              providerSessionId: input.providerSessionId,
              providerSession: {
                id: input.providerSessionId,
                driver,
                providerInstanceId: instanceId,
                status: "ready",
                cwd,
                model: modelSelection.model,
                capabilities,
                createdAt: now,
                updatedAt: now,
                lastError: null,
              },
              events: Stream.fromQueue(events),
              ensureThread: ({ threadId }) =>
                Effect.succeed({
                  id: ProviderThreadId.make(`provider-thread:${threadId}`),
                  driver,
                  providerInstanceId: instanceId,
                  providerSessionId: input.providerSessionId,
                  appThreadId: threadId,
                  ownerNodeId: null,
                  nativeThreadRef: { driver, nativeId: "native-thread", strength: "strong" },
                  nativeConversationHeadRef: null,
                  status: "idle",
                  firstRunOrdinal: null,
                  lastRunOrdinal: null,
                  handoffIds: [],
                  forkedFrom: null,
                  createdAt: now,
                  updatedAt: now,
                }),
              resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
              startTurn: (turn) =>
                Effect.gen(function* () {
                  started.push(turn);
                  yield* Queue.offer(events, {
                    type: "provider_turn.updated",
                    driver,
                    providerTurn: {
                      id: ProviderTurnId.make(`provider-turn:${turn.attemptId}`),
                      providerThreadId: turn.providerThread.id,
                      nodeId: turn.rootNodeId,
                      runAttemptId: turn.attemptId,
                      nativeTurnRef: {
                        driver,
                        nativeId: `native:${turn.attemptId}`,
                        strength: "strong",
                      },
                      ordinal: turn.providerTurnOrdinal,
                      status: "running",
                      startedAt: now,
                      completedAt: null,
                    },
                  });
                }),
              steerTurn: (turn) =>
                Effect.gen(function* () {
                  steerCalls += 1;
                  if (timing === "after delivery" || timing === "during continuation") return;
                  yield* Deferred.succeed(steerEntered, undefined);
                  yield* Deferred.await(rejectSteer);
                  return yield* new ProviderAdapter.ProviderAdapterSteerRunError({
                    driver,
                    providerThreadId: turn.providerThread.id,
                    providerTurnId: turn.providerTurnId,
                    cause: "turn already completed",
                  });
                }),
              interruptTurn: () => Effect.void,
              respondToRuntimeRequest: () => Effect.void,
              readThreadSnapshot: () => Effect.die("unused"),
              rollbackThread: () => Effect.die("unused"),
              forkThread: () => Effect.die("unused"),
            };
          }),
      };
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = ThreadId.make("thread:steering-completion");
        const watch = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
          orchestrator.streamDomainEvents.pipe(
            Stream.filter(predicate),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("create"),
          threadId,
          projectId: ProjectId.make("project:steering-completion"),
          title: "Steering race",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: cwd,
          createdBy: "user",
          creationSource: "web",
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("first"),
          threadId,
          messageId: MessageId.make("message:first"),
          text: "first",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        const running = yield* watch(
          (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
        );
        yield* worker.drain();
        yield* Fiber.join(running);
        const first = started[0]!;
        const messageId = MessageId.make("message:steering");
        const taskId = NodeId.make("task:mailbox");
        if (mailbox) {
          const sink = yield* EventSink.EventSinkV2;
          const current = yield* orchestrator.getThreadProjection(threadId);
          const parentRun = current.runs.find((run) => run.id === first.runId)!;
          const now = yield* DateTime.now;
          yield* sink.write({
            events: [
              {
                id: EventId.make("mailbox:cohort"),
                type: "run.updated",
                threadId,
                runId: first.runId,
                occurredAt: now,
                payload: {
                  ...parentRun,
                  delegatedCompletion: {
                    disposition: "open",
                    nextGeneration: 2,
                    delivery: { generation: 1, messageId, taskIds: [taskId] },
                  },
                },
              },
              {
                id: EventId.make("mailbox:task"),
                type: "subagent.updated",
                threadId,
                runId: first.runId,
                nodeId: taskId,
                occurredAt: now,
                payload: {
                  id: taskId,
                  threadId,
                  runId: first.runId,
                  parentNodeId: first.rootNodeId,
                  origin: "app_owned",
                  createdBy: "agent",
                  driver,
                  providerInstanceId: instanceId,
                  providerThreadId: null,
                  childThreadId: null,
                  nativeTaskRef: null,
                  prompt: "Do background work",
                  title: "Background test",
                  model: null,
                  completionWake: timing === "settled only" ? "settled_only" : "always",
                  completionDelivery: { state: "claimed", observedByRunId: null },
                  status: "completed",
                  result: "done",
                  startedAt: now,
                  completedAt: now,
                  updatedAt: now,
                },
              },
            ],
          });
        }
        if (question) {
          const { thread } = yield* orchestrator.getThreadProjection(threadId);
          yield* (yield* EventSink.EventSinkV2).write({
            events: [
              {
                id: EventId.make("event:composer-selection"),
                type: "thread.model-selection-updated",
                threadId,
                providerInstanceId: instanceId,
                occurredAt: yield* DateTime.now,
                payload: { ...thread, modelSelection: composerSelection },
              },
            ],
          });
        }
        const dispatchSteer = orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("steer"),
          threadId,
          messageId,
          text: "fix the popover",
          attachments: [
            {
              type: "image",
              id: "steering-screenshot",
              name: "image.png",
              mimeType: "image/png",
              sizeBytes: 10,
            },
          ],
          dispatchMode:
            mailbox || question
              ? { type: "queue_after_active" }
              : { type: "steer_active", targetRunId: first.runId },
          createdBy: mailbox || question ? "agent" : "user",
          creationSource: mailbox || question ? "server" : "web",
          ...(question
            ? {
                notification: {
                  source: { kind: "delegated_task", taskIds: [taskId] },
                  outcome: "updated",
                  summary: "Delegated task has a question",
                },
              }
            : {}),
          ...(mailbox
            ? {
                delegatedCompletion: {
                  parentRunId: first.runId,
                  generation: 1,
                  taskIds: [taskId],
                },
              }
            : {}),
        });
        if (timing !== "before dispatch") yield* dispatchSteer;
        if (timing === "during continuation") {
          const projection = yield* orchestrator.getThreadProjection(threadId);
          const turn = projection.providerTurns[0]!;
          const failed = yield* watch(
            (event) => event.type === "provider-turn.updated" && event.payload.status === "failed",
          );
          yield* Queue.offer(events, {
            type: "provider_turn.updated",
            driver,
            providerTurn: { ...turn, status: "failed", completedAt: yield* DateTime.now },
          });
          yield* Fiber.join(failed);
          yield* worker.drain();
          assert.equal(steerCalls, 1);
          assert.lengthOf(started, 1);
          const continued = yield* orchestrator.getThreadProjection(threadId);
          assert.equal(continued.runs[0]?.status, "running");
          assert.equal(
            continued.messages.find((message) => message.id === messageId)?.runId,
            first.runId,
          );
          return;
        }
        if (timing === "after delivery") yield* worker.drain();
        const delivery =
          timing === "during delivery" ? yield* worker.runOnce.pipe(Effect.forkScoped) : null;
        if (delivery !== null) yield* Deferred.await(steerEntered);
        const completed = yield* watch(
          (event) =>
            event.type === "run.updated" &&
            event.payload.id === first.runId &&
            event.payload.status === "waiting",
        );
        const projection = yield* orchestrator.getThreadProjection(threadId);
        const turn = projection.providerTurns[0]!;
        yield* Queue.offer(events, {
          type: "provider_turn.updated",
          driver,
          providerTurn: { ...turn, status: "completed", completedAt: yield* DateTime.now },
        });
        yield* Queue.offer(events, {
          type: "turn.terminal",
          driver,
          providerThreadId: turn.providerThreadId,
          providerTurnId: turn.id,
          runOrdinal: first.runOrdinal,
          status: "completed",
          failure: null,
          threadDisposition: "reusable",
        });
        yield* Fiber.join(completed);
        if (delivery !== null) {
          yield* Deferred.succeed(rejectSteer, undefined);
          yield* Fiber.join(delivery);
        }
        if (delivery !== null && !question) {
          const requeued = yield* orchestrator.getThreadProjection(threadId);
          const item = requeued.turnItems.find(
            (item) => item.type === "user_message" && item.messageId === messageId,
          );
          assert.equal(item?.status, "pending");
          assert.isNull(item?.startedAt);
          assert.isNull(item?.completedAt);
        }
        if (timing === "before dispatch") yield* dispatchSteer;
        yield* worker.drain();
        yield* orchestrator.resumeQueuedRuns;
        yield* worker.drain();
        if (timing === "after delivery") {
          assert.equal(steerCalls, 1);
          assert.equal(started.length, 1);
          if (mailbox) {
            const delivered = yield* orchestrator.getThreadProjection(threadId);
            assert.equal(delivered.subagents[0]?.completionDelivery?.state, "delivered");
            assert.equal(delivered.subagents[0]?.completionDelivery?.observedByRunId, null);
            assert.equal(delivered.runs[0]?.delegatedCompletion?.delivery, null);
            assert.equal(
              delivered.turnItems.filter((item) => item.type === "notification").length,
              1,
            );
            yield* orchestrator.dispatch({
              type: "notification.delivery.accept",
              commandId: CommandId.make("duplicate-acceptance"),
              threadId,
              messageId,
            });
            yield* worker.drain();
            assert.equal(steerCalls, 1);
            yield* orchestrator.dispatch({
              type: "delegated_task.completion-delivery.acknowledge",
              commandId: CommandId.make("read-result"),
              parentThreadId: threadId,
              taskId,
              observedByRunId: first.runId,
            });
            const acknowledged = yield* orchestrator.getThreadProjection(threadId);
            assert.equal(acknowledged.subagents[0]?.completionDelivery?.state, "acknowledged");
          }
          return;
        }
        assert.equal(started.length, 2);
        assert.equal(started[1]?.message.messageId, messageId);
        if (mailbox) assert.include(started[1]?.message.text ?? "", String(taskId));
        else assert.equal(started[1]?.message.text, "fix the popover");
        assert.deepEqual(started[1]?.message.attachments, [
          {
            type: "image",
            id: "steering-screenshot",
            name: "image.png",
            mimeType: "image/png",
            sizeBytes: 10,
          },
        ]);
        assert.equal(steerCalls, timing === "during delivery" ? 1 : 0);
        const final = yield* orchestrator.getThreadProjection(threadId);
        if (question) {
          assert.deepEqual(final.thread.modelSelection, composerSelection);
          assert.deepEqual(started[1]?.modelSelection, composerSelection);
        }
        if (!mailbox && !question) {
          assert.equal(
            final.turnItems.find(
              (item) => item.type === "user_message" && item.messageId === messageId,
            )?.status,
            "completed",
          );
        }
        assert.equal(final.messages.filter((message) => message.id === messageId).length, 1);
        assert.equal(
          final.messages.find((message) => message.id === messageId)?.runId,
          started[1]?.runId,
        );
        assert.equal(
          final.turnItems.filter((item) =>
            mailbox || question
              ? item.type === "notification"
              : item.type === "user_message" && item.messageId === messageId,
          ).length,
          1,
        );
        yield* worker.drain();
        assert.equal(started.length, 2);
      }).pipe(
        Effect.provide(
          ProviderReplayHarness.layerWithRegistry(
            { name: `steering-completion-${timing}` },
            ProviderAdapterRegistry.layerSingle(adapter),
            { runEffectWorker: false },
          ),
        ),
      );
    }),
  ),
);

const runSelection = {
  instanceId,
  model: "test-model",
  options: [{ id: "effort", value: "xhigh" }],
};
const composerSelection = {
  ...runSelection,
  options: [...runSelection.options, { id: "fastMode", value: false }],
};

const nextTurnSelectionHarness = Effect.fn("nextTurnSelectionHarness")(function* (
  name: string,
  canRestart = false,
  canSteer = true,
  interruptTurn: Effect.Effect<void> = Effect.void,
  steeringAcceptsAttachments = true,
  activeSteeringInterruptsTools = false,
) {
  const cwd = yield* checkpointWorkspace(name);
  const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
  const started: ProviderAdapter.ProviderAdapterV2TurnInput[] = [];
  const steered: string[] = [];
  const interrupted: ProviderTurnId[] = [];
  const capabilities = {
    ...CodexProviderCapabilitiesV2,
    turns: {
      ...CodexProviderCapabilitiesV2.turns,
      supportsActiveSteering: canSteer,
      supportsSteeringByInterruptRestart: canRestart,
      activeSteeringInterruptsTools,
      activeSteeringAcceptsAttachments: steeringAcceptsAttachments,
    },
  };
  const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(capabilities),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (input) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const turnUpdated = (
          turn: ProviderAdapter.ProviderAdapterV2TurnInput,
          status: "running" | "interrupted",
        ) =>
          Queue.offer(events, {
            type: "provider_turn.updated",
            driver,
            providerTurn: {
              id: ProviderTurnId.make(`provider-turn:${turn.attemptId}`),
              providerThreadId: turn.providerThread.id,
              nodeId: turn.rootNodeId,
              runAttemptId: turn.attemptId,
              nativeTurnRef: {
                driver,
                nativeId: `native:${turn.attemptId}`,
                strength: "strong",
              },
              ordinal: turn.providerTurnOrdinal,
              status,
              startedAt: now,
              completedAt: status === "running" ? null : now,
            },
          });
        const startTurn = (turn: ProviderAdapter.ProviderAdapterV2TurnInput) =>
          Effect.gen(function* () {
            started.push(turn);
            yield* turnUpdated(turn, "running");
          });
        return {
          instanceId,
          driver,
          providerSessionId: input.providerSessionId,
          providerSession: {
            id: input.providerSessionId,
            driver,
            providerInstanceId: instanceId,
            status: "ready",
            cwd,
            model: runSelection.model,
            capabilities,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
          events: Stream.fromQueue(events),
          ensureThread: ({ threadId }) =>
            Effect.succeed({
              id: ProviderThreadId.make(`provider-thread:${threadId}`),
              driver,
              providerInstanceId: instanceId,
              providerSessionId: input.providerSessionId,
              appThreadId: threadId,
              ownerNodeId: null,
              nativeThreadRef: { driver, nativeId: "native-thread", strength: "strong" },
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
            }),
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          startTurn,
          compactThread: startTurn,
          steerTurn: (turn) =>
            Effect.sync(() => {
              steered.push(turn.message.text);
            }),
          interruptTurn: ({ providerTurnId }) =>
            Effect.sync(() => {
              interrupted.push(providerTurnId);
            }).pipe(
              Effect.andThen(interruptTurn),
              Effect.andThen(
                Effect.forEach(
                  started.filter(
                    (turn) =>
                      ProviderTurnId.make(`provider-turn:${turn.attemptId}`) === providerTurnId,
                  ),
                  (turn) => turnUpdated(turn, "interrupted"),
                  { discard: true },
                ),
              ),
            ),
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () => Effect.die("unused"),
          rollbackThread: () => Effect.die("unused"),
          forkThread: () => Effect.die("unused"),
        };
      }),
  };
  const databaseLayer = SqlitePersistence.layerMemory;
  const layerRuntime = ProviderReplayHarness.layerWithRegistry(
    { name },
    ProviderAdapterRegistry.layerSingle(adapter),
    { runEffectWorker: false, runContinuationWorker: true, databaseLayer },
  );
  const layer = ThreadManagement.layer.pipe(
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(databaseLayer))),
    Layer.provideMerge(layerRuntime),
  );
  const startFirstTurn = Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    const threadId = ThreadId.make(`thread:${name}`);
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create"),
      threadId,
      projectId: ProjectId.make(`project:${name}`),
      title: "Steer with changed options",
      modelSelection: runSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: cwd,
      createdBy: "user",
      creationSource: "web",
    });
    const running = yield* orchestrator.streamDomainEvents.pipe(
      Stream.filter(
        (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
      ),
      Stream.take(1),
      Stream.runDrain,
      Effect.forkScoped,
    );
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("first"),
      threadId,
      messageId: MessageId.make("message:first"),
      text: "first",
      attachments: [],
      modelSelection: runSelection,
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    yield* worker.drain();
    yield* Fiber.join(running);
    return threadId;
  });
  return { cwd, events, started, steered, interrupted, layer, startFirstTurn };
});

const sendUpdate = Effect.fn("sendUpdate")(function* (
  threadId: ThreadId,
  createdBy: "agent" | "user",
  mode: "auto" | "steer",
  attachments: ReadonlyArray<ChatAttachment> = [],
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const result = yield* threads.sendToThread({
    projectId: (yield* orchestrator.getThreadProjection(threadId)).thread.projectId,
    commandId: CommandId.make("update"),
    threadId,
    messageId: MessageId.make("message:update"),
    text: "progress update",
    attachments,
    mode,
    createdBy,
    creationSource: createdBy === "agent" ? "mcp" : "web",
  });
  yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
  return result;
});

const imageAttachment: ChatAttachment = {
  type: "image",
  id: "attachment-1",
  name: "screen.png",
  mimeType: "image/png",
  sizeBytes: 1,
};

it.effect.each([
  { mode: "auto", attachments: [] },
  { mode: "steer", attachments: [] },
  // Steering an image natively would still cancel the running tool.
  { mode: "auto", attachments: [imageAttachment] },
  { mode: "steer", attachments: [imageAttachment] },
] as const)(
  "queues an agent $mode update behind a turn whose steering cancels tools (attachments=$attachments.length)",
  ({ mode, attachments }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { events, started, steered, layer, startFirstTurn } = yield* nextTurnSelectionHarness(
          `agent-update-queued-${mode}-${attachments.length}`,
          false,
          true,
          Effect.void,
          true,
          true,
        );
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const threadId = yield* startFirstTurn;
          const first = started[0]!;
          const result = yield* sendUpdate(threadId, "agent", mode, attachments);
          assert.equal(result.delivery, "queued");
          assert.deepEqual(steered, []);
          const pending = yield* orchestrator.getThreadProjection(threadId);
          assert.equal(pending.runs.find((run) => run.id === first.runId)?.status, "running");

          const completed = yield* orchestrator.streamDomainEvents.pipe(
            Stream.filter(
              (event) =>
                event.type === "run.updated" &&
                event.payload.id === first.runId &&
                event.payload.status === "waiting",
            ),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
          const turn = pending.providerTurns[0]!;
          yield* Queue.offer(events, {
            type: "provider_turn.updated",
            driver,
            providerTurn: { ...turn, status: "completed", completedAt: yield* DateTime.now },
          });
          yield* Queue.offer(events, {
            type: "turn.terminal",
            driver,
            providerThreadId: turn.providerThreadId,
            providerTurnId: turn.id,
            runOrdinal: first.runOrdinal,
            status: "completed",
            failure: null,
            threadDisposition: "reusable",
          });
          yield* Fiber.join(completed);
          yield* worker.drain();
          yield* orchestrator.resumeQueuedRuns;
          yield* worker.drain();
          assert.deepEqual(
            started.map((input) => input.message.messageId),
            [MessageId.make("message:first"), MessageId.make("message:update")],
          );
          assert.deepEqual(steered, []);
        }).pipe(Effect.provide(layer));
      }),
    ),
);

it.effect.each([
  { createdBy: "user", activeSteeringInterruptsTools: false },
  { createdBy: "agent", activeSteeringInterruptsTools: false },
] as const)(
  "steers an update from $createdBy when steering is allowed (interruptsTools=$activeSteeringInterruptsTools)",
  ({ createdBy, activeSteeringInterruptsTools }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { started, steered, layer, startFirstTurn } = yield* nextTurnSelectionHarness(
          `update-steered-${createdBy}-${activeSteeringInterruptsTools}`,
          false,
          true,
          Effect.void,
          true,
          activeSteeringInterruptsTools,
        );
        yield* Effect.gen(function* () {
          const threadId = yield* startFirstTurn;
          const result = yield* sendUpdate(
            threadId,
            createdBy,
            createdBy === "agent" ? "auto" : "steer",
          );
          assert.equal(result.delivery, "steered");
          assert.deepEqual(steered, ["progress update"]);
          assert.equal(started.length, 1);
        }).pipe(Effect.provide(layer));
      }),
    ),
);

it.effect("steers a delegated task question notice into the running parent turn", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { started, steered, layer, startFirstTurn } = yield* nextTurnSelectionHarness(
        "delegated-question-steer",
      );
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = yield* startFirstTurn;
        const { thread } = yield* orchestrator.getThreadProjection(threadId);
        yield* (yield* EventSink.EventSinkV2).write({
          events: [
            {
              id: EventId.make("event:composer-selection"),
              type: "thread.model-selection-updated",
              threadId,
              providerInstanceId: instanceId,
              occurredAt: yield* DateTime.now,
              payload: { ...thread, modelSelection: composerSelection },
            },
          ],
        });
        const messageId = MessageId.make("message:delegated-task-question:child-question");
        const notification = {
          source: {
            kind: "delegated_task" as const,
            taskIds: [NodeId.make("task:question")],
            childThreadId: ThreadId.make("thread:question-child"),
          },
          outcome: "updated" as const,
          summary: "Delegated task has a question",
        };
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("question-wake"),
          threadId,
          messageId,
          text: "Delegated task asked a question",
          notification,
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "agent",
          creationSource: "server",
        });
        yield* worker.drain();
        const after = yield* orchestrator.getThreadProjection(threadId);
        assert.deepEqual(steered, ["Delegated task asked a question"]);
        assert.lengthOf(started, 1);
        assert.isFalse(after.runs.some((run) => run.status === "queued"));
        const message = after.messages.find((candidate) => candidate.id === messageId);
        assert.equal(message?.runId, started[0]?.runId);
        assert.deepEqual(message?.notification, notification);
        assert.deepEqual(after.thread.modelSelection, composerSelection);
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("sends a selected held message once and preserves the remaining queue order", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { started, steered, layer, startFirstTurn } =
        yield* nextTurnSelectionHarness("send-held-message");
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = yield* startFirstTurn;
        yield* Effect.forEach(["queued-first", "selected", "queued-last"], (text) =>
          orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(text),
            threadId,
            messageId: MessageId.make(`message:${text}`),
            text,
            attachments: [],
            modelSelection: runSelection,
            dispatchMode: { type: "queue_after_active" },
            createdBy: "user",
            creationSource: "web",
          }),
        );
        const before = yield* orchestrator.getThreadProjection(threadId);
        const selected = before.runs.find(
          (run) => run.userMessageId === MessageId.make("message:selected"),
        )!;
        const sink = yield* EventSink.EventSinkV2;
        const now = yield* DateTime.now;
        // Restart recovery cancels the active run and holds every queued message.
        yield* sink.write({
          events: [
            ...before.runs.map((run) => ({
              id: EventId.make(`restart:${run.id}`),
              type: "run.updated" as const,
              threadId,
              runId: run.id,
              occurredAt: now,
              payload:
                run.status === "queued"
                  ? { ...run, queueHeld: true }
                  : { ...run, status: "cancelled" as const, completedAt: now },
            })),
            ...before.providerTurns.map((turn) => ({
              id: EventId.make(`restart:${turn.id}`),
              type: "provider-turn.updated" as const,
              threadId,
              occurredAt: now,
              payload: { ...turn, status: "cancelled" as const, completedAt: now },
            })),
          ],
        });
        const command = {
          type: "queued-run.start" as const,
          commandId: CommandId.make("send-selected"),
          threadId,
          runId: selected.id,
        };
        yield* orchestrator.dispatch(command);
        yield* worker.drain();
        yield* orchestrator.dispatch(command);
        yield* worker.drain();
        const after = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(after.runs.find((run) => run.id === selected.id)?.status, "running");
        assert.deepEqual(
          started.map((input) => input.message.text),
          ["first", "selected"],
        );
        assert.equal(started[1]?.runId, selected.id);
        assert.equal(started[1]?.message.messageId, selected.userMessageId);
        assert.deepEqual(started[1]?.modelSelection, runSelection);
        assert.deepEqual(steered, []);
        assert.lengthOf(
          after.messages.filter((message) => message.id === selected.userMessageId),
          1,
        );
        assert.deepEqual(
          after.runs.filter((run) => run.status === "queued").map((run) => run.userMessageId),
          [MessageId.make("message:queued-first"), MessageId.make("message:queued-last")],
        );
        assert.isFalse(after.runs.some((run) => run.status === "queued" && run.queueHeld));
        const duplicate = yield* orchestrator
          .dispatch({
            ...command,
            commandId: CommandId.make("send-selected-again"),
          })
          .pipe(Effect.flip);
        assert.equal(duplicate._tag, "OrchestratorDispatchError");
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("force sends multiple queued messages and can force send a requeued message again", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { started, steered, layer, startFirstTurn } = yield* nextTurnSelectionHarness(
        "multiple-promoted-messages",
      );
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = yield* startFirstTurn;
        const queue = (text: string, commandId: string) =>
          orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(commandId),
            threadId,
            messageId: MessageId.make(`message:${text}`),
            text,
            attachments: [],
            dispatchMode: { type: "queue_after_active" },
            createdBy: "user",
            creationSource: "web",
          });
        for (const text of ["one", "two", "remaining"]) yield* queue(text, `queue-${text}`);
        const promote = Effect.fn("test.promote")(function* (text: string, commandId: string) {
          const projection = yield* orchestrator.getThreadProjection(threadId);
          const queued = projection.runs.find(
            (run) =>
              run.status === "queued" && run.userMessageId === MessageId.make(`message:${text}`),
          )!;
          yield* orchestrator.dispatch({
            type: "queued-message.promote-to-steer",
            commandId: CommandId.make(commandId),
            threadId,
            queuedRunId: queued.id,
            targetRunId: started[0]!.runId,
          });
        });
        yield* promote("one", "promote-one");
        yield* promote("two", "promote-two");
        yield* worker.drain();
        assert.deepEqual(steered, ["one", "two"]);

        // The completion-race fallback redispatches the same message into the queue.
        yield* queue("one", "requeue-one");
        const requeued = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(
          requeued.turnItems.find(
            (item) => item.type === "user_message" && item.messageId === "message:one",
          )?.status,
          "pending",
        );
        yield* promote("one", "promote-one-again");
        yield* worker.drain();
        assert.deepEqual(steered, ["one", "two", "one"]);
        assert.lengthOf(started, 1);
        const final = yield* orchestrator.getThreadProjection(threadId);
        assert.deepEqual(
          final.runs.filter((run) => run.status === "queued").map((run) => run.userMessageId),
          [MessageId.make("message:remaining")],
        );
        for (const text of ["one", "two"]) {
          const items = final.turnItems.filter(
            (item) => item.type === "user_message" && item.messageId === `message:${text}`,
          );
          assert.lengthOf(items, 1);
          assert.equal(items[0]?.status, "completed");
        }
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("keeps a message queued when send now races with a running turn", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { started, layer, startFirstTurn } =
        yield* nextTurnSelectionHarness("send-queued-race");
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = yield* startFirstTurn;
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("queue"),
          threadId,
          messageId: MessageId.make("message:queued"),
          text: "queued",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
          creationSource: "web",
        });
        const before = yield* orchestrator.getThreadProjection(threadId);
        const queued = before.runs.find((run) => run.status === "queued")!;
        const error = yield* orchestrator
          .dispatch({
            type: "queued-run.start",
            commandId: CommandId.make("send-now"),
            threadId,
            runId: queued.id,
          })
          .pipe(Effect.flip);
        yield* worker.drain();
        assert.equal(error._tag, "OrchestratorDispatchError");
        assert.equal(started.length, 1);
        const after = yield* orchestrator.getThreadProjection(threadId);
        assert.deepEqual(after.runs, before.runs);
      }).pipe(Effect.provide(layer));
    }),
  ),
);

// regression: #19210 a provider that can restart the turn must still steer, since restarting ends its native subagents
it.effect(
  "steers a changed turn-scoped selection into a running turn the provider could restart",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { started, steered, layer, startFirstTurn } = yield* nextTurnSelectionHarness(
          "steering-selection-change",
          true,
        );
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const threadId = yield* startFirstTurn;
          const steer = (id: string, selection: ModelSelection) =>
            orchestrator
              .dispatch({
                type: "message.dispatch",
                commandId: CommandId.make(id),
                threadId,
                messageId: MessageId.make(`message:${id}`),
                text: id,
                attachments: [],
                modelSelection: selection,
                dispatchMode: { type: "steer_active", targetRunId: started[0]!.runId },
                createdBy: "user",
                creationSource: "web",
              })
              .pipe(Effect.andThen(worker.drain()));

          yield* steer("steer-changed", composerSelection);
          const changed = yield* orchestrator.getThreadProjection(threadId);
          assert.deepEqual(steered, ["steer-changed"]);
          assert.equal(started.length, 1);
          assert.lengthOf(changed.attempts, 1);
          assert.equal(changed.runs[0]?.status, "running");
          assert.deepEqual(changed.runs[0]?.modelSelection, runSelection);
          assert.deepEqual(changed.thread.modelSelection, composerSelection);

          yield* steer("steer-reverted", runSelection);
          const reverted = yield* orchestrator.getThreadProjection(threadId);
          assert.deepEqual(steered, ["steer-changed", "steer-reverted"]);
          assert.lengthOf(reverted.attempts, 1);
          assert.deepEqual(reverted.thread.modelSelection, runSelection);

          const otherSelection = {
            instanceId: ProviderInstanceId.make("codex-work"),
            model: "other",
          };
          const sink = yield* EventSink.EventSinkV2;
          yield* sink.write({
            events: [
              {
                id: EventId.make("switched-away"),
                type: "thread.provider-switched",
                threadId,
                providerInstanceId: otherSelection.instanceId,
                occurredAt: yield* DateTime.now,
                payload: {
                  ...reverted.thread,
                  providerInstanceId: otherSelection.instanceId,
                  modelSelection: otherSelection,
                },
              },
            ],
          });
          yield* steer("steer-back", runSelection);
          const back = yield* orchestrator.getThreadProjection(threadId);
          assert.deepEqual(steered, ["steer-changed", "steer-reverted", "steer-back"]);
          assert.equal(back.thread.providerInstanceId, instanceId);
          assert.deepEqual(back.thread.modelSelection, runSelection);
        }).pipe(Effect.provide(layer));
      }),
    ),
);

it.effect("restarts the turn for an image when native steering takes text only", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { started, steered, layer, startFirstTurn } = yield* nextTurnSelectionHarness(
        "steering-text-only-attachment",
        true,
        true,
        Effect.void,
        false,
      );
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = yield* startFirstTurn;
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("steer-image"),
          threadId,
          messageId: MessageId.make("message:steer-image"),
          text: "look at this",
          attachments: [
            {
              type: "image",
              id: ChatAttachmentId.make("steer-image"),
              name: "screenshot.png",
              mimeType: "image/png",
              sizeBytes: 4,
            },
          ],
          modelSelection: runSelection,
          dispatchMode: { type: "steer_active", targetRunId: started[0]!.runId },
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.drain();
        assert.deepEqual(steered, []);
        assert.deepEqual(
          started.map((turn) => [turn.message.text, turn.message.attachments.length]),
          [
            ["first", 0],
            ["look at this", 1],
          ],
        );
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("starts a steer that missed the turn on the saved next-turn selection", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { events, started, steered, layer, startFirstTurn } = yield* nextTurnSelectionHarness(
        "steering-selection-follow-up",
      );
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = yield* startFirstTurn;
        const first = started[0]!;
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("steer"),
          threadId,
          messageId: MessageId.make("message:steer"),
          text: "late steer",
          attachments: [],
          modelSelection: composerSelection,
          dispatchMode: { type: "steer_active", targetRunId: first.runId },
          createdBy: "user",
          creationSource: "web",
        });
        const settled = yield* orchestrator.streamDomainEvents.pipe(
          Stream.filter(
            (event) =>
              event.type === "run.updated" &&
              event.payload.id === first.runId &&
              event.payload.status === "waiting",
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
        const turn = (yield* orchestrator.getThreadProjection(threadId)).providerTurns[0]!;
        yield* Queue.offer(events, {
          type: "provider_turn.updated",
          driver,
          providerTurn: { ...turn, status: "completed", completedAt: yield* DateTime.now },
        });
        yield* Queue.offer(events, {
          type: "turn.terminal",
          driver,
          providerThreadId: turn.providerThreadId,
          providerTurnId: turn.id,
          runOrdinal: first.runOrdinal,
          status: "completed",
          failure: null,
          threadDisposition: "reusable",
        });
        yield* Fiber.join(settled);
        yield* worker.drain();
        yield* orchestrator.resumeQueuedRuns;
        yield* worker.drain();

        const projection = yield* orchestrator.getThreadProjection(threadId);
        assert.deepEqual(steered, []);
        assert.equal(started.length, 2);
        assert.equal(started[1]?.message.messageId, MessageId.make("message:steer"));
        assert.deepEqual(started[1]?.modelSelection, composerSelection);
        assert.deepEqual(projection.thread.modelSelection, composerSelection);
      }).pipe(Effect.provide(layer));
    }),
  ),
);

// regression: #26695 cancelling a Copilot prompt to steer it kills its background agents
it.effect("queues a steer until the turn ends when the provider cannot steer it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { events, started, steered, interrupted, layer, startFirstTurn } =
        yield* nextTurnSelectionHarness("steering-unsupported", false, false);
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = yield* startFirstTurn;
        const first = started[0]!;
        const messageId = MessageId.make("message:steer");
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("steer"),
          threadId,
          messageId,
          text: "follow up",
          attachments: [],
          modelSelection: runSelection,
          dispatchMode: { type: "start_immediately" },
          deliveryIntent: "steer",
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.drain();

        const held = yield* orchestrator.getThreadProjection(threadId);
        assert.deepEqual(steered, []);
        assert.deepEqual(interrupted, []);
        assert.equal(started.length, 1);
        assert.equal(held.runs.find((run) => run.id === first.runId)?.status, "running");
        const queued = held.runs.find((run) => run.userMessageId === messageId);
        assert.equal(queued?.status, "queued");

        const settled = yield* orchestrator.streamDomainEvents.pipe(
          Stream.filter(
            (event) =>
              event.type === "run.updated" &&
              event.payload.id === first.runId &&
              event.payload.status === "waiting",
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
        const turn = held.providerTurns[0]!;
        yield* Queue.offer(events, {
          type: "provider_turn.updated",
          driver,
          providerTurn: { ...turn, status: "completed", completedAt: yield* DateTime.now },
        });
        yield* Queue.offer(events, {
          type: "turn.terminal",
          driver,
          providerThreadId: turn.providerThreadId,
          providerTurnId: turn.id,
          runOrdinal: first.runOrdinal,
          status: "completed",
          failure: null,
          threadDisposition: "reusable",
        });
        yield* Fiber.join(settled);
        yield* worker.drain();
        yield* orchestrator.resumeQueuedRuns;
        yield* worker.drain();

        assert.deepEqual(interrupted, []);
        assert.equal(started.length, 2);
        assert.equal(started[1]?.runId, queued?.id);
        assert.equal(started[1]?.message.text, "follow up");
      }).pipe(Effect.provide(layer));
    }),
  ),
);

// Codex flushes held drafts after the final answer; reserve their pre-steer position before turn end.
it.effect("keeps a held commentary draft before the steer when turn end flushes it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { events, started, layer, startFirstTurn } =
        yield* nextTurnSelectionHarness("steering-held-draft");
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = yield* startFirstTurn;
        const first = started[0]!;
        const turn = (yield* orchestrator.getThreadProjection(threadId)).providerTurns[0]!;
        const now = yield* DateTime.now;
        const assistantItem = (id: string, text: string, streaming: boolean) =>
          ({
            type: "turn_item.updated",
            driver,
            turnItem: {
              id: TurnItemId.make(id),
              threadId,
              runId: first.runId,
              nodeId: first.rootNodeId,
              providerThreadId: turn.providerThreadId,
              providerTurnId: turn.id,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 0,
              status: streaming ? "running" : "completed",
              title: null,
              startedAt: now,
              completedAt: streaming ? null : now,
              updatedAt: now,
              type: "assistant_message",
              messageId: MessageId.make(`message:${id}`),
              text,
              streaming,
            },
          }) satisfies ProviderAdapter.ProviderAdapterV2Event;
        const watch = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
          orchestrator.streamDomainEvents.pipe(
            Stream.filter(predicate),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );

        yield* Queue.offer(events, assistantItem("draft", "Let me look at the", true));
        const commentaryWritten = yield* watch(
          (event) => event.type === "turn-item.updated" && event.payload.id === "commentary",
        );
        yield* Queue.offer(events, assistantItem("commentary", "Checking the popover.", false));
        yield* Fiber.join(commentaryWritten);

        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("steer"),
          threadId,
          messageId: MessageId.make("message:steer"),
          text: "fix the popover",
          attachments: [],
          dispatchMode: { type: "steer_active", targetRunId: first.runId },
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.drain();

        const settled = yield* watch(
          (event) =>
            event.type === "run.updated" &&
            event.payload.id === first.runId &&
            event.payload.status === "waiting",
        );
        yield* Queue.offer(events, assistantItem("answer", "All fixed.", false));
        yield* Queue.offer(events, assistantItem("draft", "Let me look at the", false));
        yield* Queue.offer(events, {
          type: "provider_turn.updated",
          driver,
          providerTurn: { ...turn, status: "completed", completedAt: yield* DateTime.now },
        });
        yield* Queue.offer(events, {
          type: "turn.terminal",
          driver,
          providerThreadId: turn.providerThreadId,
          providerTurnId: turn.id,
          runOrdinal: first.runOrdinal,
          status: "completed",
          failure: null,
          threadDisposition: "reusable",
        });
        yield* Fiber.join(settled);
        yield* worker.drain();

        const items = (yield* orchestrator.getThreadProjection(threadId)).turnItems
          .toSorted((left, right) => left.ordinal - right.ordinal)
          .flatMap((item) =>
            item.type === "user_message"
              ? [String(item.messageId)]
              : item.type === "assistant_message"
                ? [String(item.id)]
                : [],
          );
        assert.deepEqual(items, [
          "message:first",
          "draft",
          "commentary",
          "message:steer",
          "answer",
        ]);
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("steers a promoted queued message with the selection it was queued with", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { started, steered, layer, startFirstTurn } = yield* nextTurnSelectionHarness(
        "promote-queued-selection",
      );
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = yield* startFirstTurn;
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("queued"),
          threadId,
          messageId: MessageId.make("message:queued"),
          text: "queued",
          attachments: [],
          modelSelection: composerSelection,
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
          creationSource: "web",
        });
        const queuedRun = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
          (run) => run.status === "queued",
        )!;
        yield* orchestrator.dispatch({
          type: "queued-message.promote-to-steer",
          commandId: CommandId.make("promote"),
          threadId,
          queuedRunId: queuedRun.id,
          targetRunId: started[0]!.runId,
        });
        yield* worker.drain();

        const projection = yield* orchestrator.getThreadProjection(threadId);
        assert.deepEqual(steered, ["queued"]);
        assert.deepEqual(projection.thread.modelSelection, composerSelection);
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("marks the model switch on a promoted message that restarts the turn", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { started, layer, startFirstTurn } = yield* nextTurnSelectionHarness(
        "promote-restart-switch",
        true,
        false,
      );
      const otherSelection = { ...runSelection, model: "other-model" };
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = yield* startFirstTurn;
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("queued"),
          threadId,
          messageId: MessageId.make("message:queued"),
          text: "queued",
          attachments: [],
          modelSelection: otherSelection,
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
          creationSource: "web",
        });
        const queuedRun = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
          (run) => run.status === "queued",
        )!;
        yield* orchestrator.dispatch({
          type: "queued-message.promote-to-steer",
          commandId: CommandId.make("promote"),
          threadId,
          queuedRunId: queuedRun.id,
          targetRunId: started[0]!.runId,
        });
        yield* worker.drain();

        const promoted = (yield* orchestrator.getThreadProjection(threadId)).turnItems.find(
          (item) => item.type === "user_message" && item.messageId === "message:queued",
        );
        assert.deepEqual(promoted?.type === "user_message" ? promoted.modelSwitch : undefined, {
          from: runSelection,
          to: otherSelection,
        });
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("keeps a queued message queued when promoted into a run that Stop reached", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { started, steered, layer, startFirstTurn } =
        yield* nextTurnSelectionHarness("steering-after-stop");
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = yield* startFirstTurn;
        const first = started[0]!;
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("queued"),
          threadId,
          messageId: MessageId.make("message:queued"),
          text: "queued",
          attachments: [],
          modelSelection: runSelection,
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
          creationSource: "web",
        });
        const queuedRun = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
          (run) => run.status === "queued",
        )!;
        // The worker has not delivered the interrupt yet, so the run still reads as running.
        yield* orchestrator.dispatch({
          type: "run.interrupt",
          commandId: CommandId.make("stop"),
          threadId,
          runId: first.runId,
          holdQueue: true,
        });

        const promoteError = yield* orchestrator
          .dispatch({
            type: "queued-message.promote-to-steer",
            commandId: CommandId.make("promote"),
            threadId,
            queuedRunId: queuedRun.id,
            targetRunId: first.runId,
          })
          .pipe(Effect.flip);
        yield* worker.drain();

        const projection = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(promoteError._tag, "OrchestratorDispatchError");
        assert.deepEqual(steered, []);
        const queued = projection.runs.find((run) => run.id === queuedRun.id);
        assert.equal(queued?.status, "queued");
        assert.isTrue(queued?.queueHeld);
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("queues a plain send behind the stopped queue and releases its hold", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const interruptReached = yield* Deferred.make<void>();
      const releaseInterrupt = yield* Deferred.make<void>();
      const { started, steered, layer, startFirstTurn } = yield* nextTurnSelectionHarness(
        "plain-send-after-stop",
        false,
        true,
        Deferred.succeed(interruptReached, undefined).pipe(
          Effect.andThen(Deferred.await(releaseInterrupt)),
        ),
      );
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = yield* startFirstTurn;
        const send = (id: string, delivery: "queue" | "auto") =>
          orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(id),
            threadId,
            messageId: MessageId.make(`message:${id}`),
            text: id,
            attachments: [],
            modelSelection: runSelection,
            ...(delivery === "queue"
              ? { dispatchMode: { type: "queue_after_active" } }
              : { dispatchMode: { type: "start_immediately" }, deliveryIntent: "auto" }),
            createdBy: "user",
            creationSource: "web",
          });
        yield* send("queued", "queue");
        yield* orchestrator.dispatch({
          type: "run.interrupt",
          commandId: CommandId.make("stop"),
          threadId,
          runId: started[0]!.runId,
          holdQueue: true,
        });
        // The provider has not stopped yet, so a plain send still resolves to a steer.
        yield* send("sent", "auto");
        // Once the stop settles, the run-update reactor promotes the queue on
        // its own fiber, so read the queue while the provider is still stopping.
        const draining = yield* worker.drain().pipe(Effect.forkScoped);
        yield* Deferred.await(interruptReached);

        const projection = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(started.length, 1);
        const queued = projection.runs
          .filter((run) => run.status === "queued")
          .sort((left, right) => (left.queuePosition ?? 0) - (right.queuePosition ?? 0));
        assert.deepEqual(
          queued.map(
            (run) => projection.messages.find((message) => message.id === run.userMessageId)?.text,
          ),
          ["queued", "sent"],
        );
        // The user sent it, so the queue they stopped runs again once the provider stops.
        assert.isFalse(queued.some((run) => run.queueHeld === true));
        yield* Deferred.succeed(releaseInterrupt, undefined);
        yield* Fiber.join(draining);
        assert.deepEqual(steered, []);
      }).pipe(Effect.provide(layer));
    }),
  ),
);

const goalHarness = Effect.fn("goalHarness")(function* (name: string) {
  const harness = yield* nextTurnSelectionHarness(name);
  const send = (id: string, text: string, delivery: "queue" | "auto", freshContext = false) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(id),
        threadId: ThreadId.make(`thread:${name}`),
        messageId: MessageId.make(`message:${id}`),
        text,
        attachments: [],
        modelSelection: runSelection,
        ...(freshContext ? { freshContext } : {}),
        ...(delivery === "queue"
          ? { dispatchMode: { type: "queue_after_active" } }
          : { dispatchMode: { type: "start_immediately" }, deliveryIntent: "auto" }),
        createdBy: "user",
        creationSource: "web",
      });
    });
  const read = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const projection = yield* (yield* Orchestrator.OrchestratorV2).getThreadProjection(threadId);
      const textOf = (run: (typeof projection.runs)[number]) =>
        projection.messages.find((message) => message.id === run.userMessageId)?.text;
      return {
        queue: projection.runs
          .filter((run) => run.status === "queued")
          .toSorted((left, right) => (left.queuePosition ?? 0) - (right.queuePosition ?? 0))
          .map(textOf),
        started: harness.started.map((turn) => turn.message.text),
        stopRequested: projection.turnItems.some(
          (item) =>
            item.type === "run_interrupt_request" && item.runId === harness.started[0]?.runId,
        ),
      };
    });
  return { ...harness, send, read };
});

it.effect("stops the running turn and starts a goal sent into it next", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { steered, layer, startFirstTurn, send, read } = yield* goalHarness("goal-steer");
      yield* Effect.gen(function* () {
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = yield* startFirstTurn;
        yield* send("queued", "queued", "queue");
        yield* send("goal", "/goal all tests pass", "auto");
        yield* worker.drain();

        assert.deepEqual(steered, []);
        assert.deepEqual(yield* read(threadId), {
          queue: ["queued"],
          started: ["first", "/goal all tests pass"],
          stopRequested: true,
        });
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("queues a goal clear without stopping work when no goal drives it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { steered, layer, startFirstTurn, send, read } = yield* goalHarness("goal-clear");
      yield* Effect.gen(function* () {
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = yield* startFirstTurn;
        yield* send("queued", "queued", "queue");
        yield* send("clear", "/goal clear", "auto");
        yield* worker.drain();

        assert.deepEqual(steered, []);
        assert.deepEqual(yield* read(threadId), {
          queue: ["queued", "/goal clear"],
          started: ["first"],
          stopRequested: false,
        });
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("promotes a queued goal by stopping the running turn", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { started, steered, layer, startFirstTurn, send, read } =
        yield* goalHarness("goal-promote");
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = yield* startFirstTurn;
        yield* send("queued", "queued", "queue");
        yield* send("goal", "/goal ship it", "queue");
        const goalRun = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
          (run) => run.userMessageId === MessageId.make("message:goal"),
        )!;
        yield* orchestrator.dispatch({
          type: "queued-message.promote-to-steer",
          commandId: CommandId.make("promote"),
          threadId,
          queuedRunId: goalRun.id,
          targetRunId: started[0]!.runId,
        });
        yield* worker.drain();

        assert.deepEqual(steered, []);
        assert.deepEqual(yield* read(threadId), {
          queue: ["queued"],
          started: ["first", "/goal ship it"],
          stopRequested: true,
        });
      }).pipe(Effect.provide(layer));
    }),
  ),
);

// A fresh message skips compaction as its own turn, which steering a running turn would not.
it.effect.each(["next", "/goal ship it", "fresh next"])(
  "promoting %s into a compaction stops it and sends it next",
  (promoted) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { events, layer, send, read, started, steered, startFirstTurn } = yield* goalHarness(
          `compaction-promote-${promoted.length}`,
        );
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const threadId = yield* startFirstTurn;
          yield* send("compact", "/compact", "queue");
          yield* send("queued", "queued", "queue");
          yield* send("next", promoted, "queue", promoted.startsWith("fresh"));
          const settled = yield* orchestrator.streamDomainEvents.pipe(
            Stream.filter(
              (event) =>
                event.type === "run.updated" &&
                event.payload.id === started[0]!.runId &&
                event.payload.status === "waiting",
            ),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
          const compacting = yield* orchestrator.streamDomainEvents.pipe(
            Stream.filter(
              (event) =>
                event.type === "provider-turn.updated" &&
                event.payload.status === "running" &&
                event.payload.runAttemptId !== started[0]!.attemptId,
            ),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
          const turn = (yield* orchestrator.getThreadProjection(threadId)).providerTurns[0]!;
          yield* Queue.offer(events, {
            type: "provider_turn.updated",
            driver,
            providerTurn: { ...turn, status: "completed", completedAt: yield* DateTime.now },
          });
          yield* Queue.offer(events, {
            type: "turn.terminal",
            driver,
            providerThreadId: turn.providerThreadId,
            providerTurnId: turn.id,
            runOrdinal: started[0]!.runOrdinal,
            status: "completed",
            failure: null,
            threadDisposition: "reusable",
          });
          yield* Fiber.join(settled);
          yield* worker.drain();
          yield* orchestrator.resumeQueuedRuns;
          yield* worker.drain();
          yield* Fiber.join(compacting);
          const compactRun = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
            (run) => run.userMessageId === MessageId.make("message:compact"),
          )!;
          const nextRun = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
            (run) => run.userMessageId === MessageId.make("message:next"),
          )!;
          yield* orchestrator.dispatch({
            type: "queued-message.promote-to-steer",
            commandId: CommandId.make("promote"),
            threadId,
            queuedRunId: nextRun.id,
            targetRunId: compactRun.id,
          });
          yield* worker.drain();

          const projection = yield* orchestrator.getThreadProjection(threadId);
          assert.deepEqual(steered, []);
          assert.isTrue(
            projection.turnItems.some(
              (item) => item.type === "run_interrupt_request" && item.runId === compactRun.id,
            ),
          );
          assert.deepEqual((yield* read(threadId)).queue, ["queued"]);
          assert.deepEqual(
            started.map((turn) => turn.message.text),
            ["first", "/compact", promoted],
          );
        }).pipe(Effect.provide(layer));
      }),
    ),
);

it.effect("stops a turn that is still starting when a goal is sent into it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { cwd, layer, send, started } = yield* goalHarness("goal-during-start");
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = ThreadId.make("thread:goal-during-start");
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("create"),
          threadId,
          projectId: ProjectId.make("project:goal-during-start"),
          title: "Goal during start",
          modelSelection: runSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: cwd,
          createdBy: "user",
          creationSource: "web",
        });
        // The stopped run's end starts the queue, which then needs one more drain.
        const goalStarting = yield* orchestrator.streamDomainEvents.pipe(
          Stream.filter(
            (event) => event.type === "run.updated" && event.payload.status === "starting",
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* send("first", "first", "auto");
        yield* send("goal", "/goal all tests pass", "auto");
        yield* worker.drain();
        yield* Fiber.join(goalStarting);
        yield* worker.drain();

        const projection = yield* orchestrator.getThreadProjection(threadId);
        const statusOf = (text: string) =>
          projection.runs.find(
            (run) =>
              projection.messages.find((message) => message.id === run.userMessageId)?.text ===
              text,
          )?.status;
        assert.equal(statusOf("first"), "interrupted");
        assert.deepEqual(
          started.map((turn) => turn.message.text),
          ["/goal all tests pass"],
        );
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("stops the running turn when a goal clear ends the goal driving it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { events, layer, startFirstTurn, send, read, steered } =
        yield* goalHarness("goal-clear-active");
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = yield* startFirstTurn;
        const providerThread = (yield* orchestrator.getThreadProjection(threadId))
          .providerThreads[0]!;
        const goalSeen = yield* orchestrator.streamDomainEvents.pipe(
          Stream.filter(
            (event) =>
              event.type === "provider-thread.updated" && event.payload.goal?.status === "active",
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* Queue.offer(events, {
          type: "provider_thread.updated",
          driver,
          providerThread: {
            ...providerThread,
            goal: { objective: "all tests pass", status: "active" },
          },
        });
        yield* Fiber.join(goalSeen);
        yield* send("clear", "/goal clear", "auto");
        yield* worker.drain();

        assert.deepEqual(steered, []);
        assert.deepEqual(yield* read(threadId), {
          queue: [],
          started: ["first", "/goal clear"],
          stopRequested: true,
        });
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("a side chat that opens with /goal gets its context on the next question", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { events, layer, started, startFirstTurn } = yield* goalHarness("side-chat-goal");
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const parentId = yield* startFirstTurn;
        const sideChatId = ThreadId.make("thread:side-chat-goal-child");
        yield* orchestrator.dispatch({
          type: "thread.fork",
          commandId: CommandId.make("side-chat"),
          sourceThreadId: parentId,
          targetThreadId: sideChatId,
          sourcePoint: { type: "latest_stable" },
          sideChat: true,
          createdBy: "user",
          creationSource: "web",
        });
        const ask = (id: string, text: string) =>
          orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(id),
            threadId: sideChatId,
            messageId: MessageId.make(`message:${id}`),
            text,
            attachments: [],
            modelSelection: runSelection,
            dispatchMode: { type: "start_immediately" },
            createdBy: "user",
            creationSource: "web",
          });
        const sideChatEvent = (matches: (event: OrchestrationV2DomainEvent) => boolean) =>
          orchestrator.streamDomainEvents.pipe(
            Stream.filter((event) => event.threadId === sideChatId && matches(event)),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped({ startImmediately: true }),
          );
        const running = yield* sideChatEvent(
          (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
        );
        const settled = yield* sideChatEvent(
          (event) => event.type === "run.updated" && event.payload.status === "waiting",
        );
        yield* ask("goal", "/goal clear");
        yield* worker.drain();
        yield* Fiber.join(running);
        const turn = (yield* orchestrator.getThreadProjection(sideChatId)).providerTurns[0]!;
        yield* Queue.offer(events, {
          type: "provider_turn.updated",
          driver,
          providerTurn: { ...turn, status: "completed", completedAt: yield* DateTime.now },
        });
        yield* Queue.offer(events, {
          type: "turn.terminal",
          driver,
          providerThreadId: turn.providerThreadId,
          providerTurnId: turn.id,
          runOrdinal: started[1]!.runOrdinal,
          status: "completed",
          failure: null,
          threadDisposition: "reusable",
        });
        yield* Fiber.join(settled);
        yield* worker.drain();
        yield* ask("question", "What is the main thread doing?");
        yield* worker.drain();

        const [first, goal, question] = started.map((turn) => turn.message.text);
        assert.deepEqual([first, goal], ["first", "/goal clear"]);
        assert.include(question, "You are in a side chat beside the main thread.");
        assert.include(question, "- User: first");
        assert.isTrue(question?.endsWith("What is the main thread doing?"));
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect.each(["auto", "steer"] as const)(
  "rejects an agent %s update after Stop instead of queueing it behind the stopped run",
  (mode) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { started, steered, layer, startFirstTurn } = yield* nextTurnSelectionHarness(
          `agent-update-after-stop-${mode}`,
          false,
          true,
          Effect.void,
          true,
          true,
        );
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const threadId = yield* startFirstTurn;
          yield* orchestrator.dispatch({
            type: "run.interrupt",
            commandId: CommandId.make("stop"),
            threadId,
            runId: started[0]!.runId,
            holdQueue: true,
          });
          // Nothing was queued before Stop, so a queued update would have no hold
          // and would start on its own once the provider stops.
          const error = yield* sendUpdate(threadId, "agent", mode).pipe(Effect.flip);
          yield* worker.drain();

          const projection = yield* orchestrator.getThreadProjection(threadId);
          assert.equal(error._tag, "OrchestratorDispatchError");
          assert.include(String(error.cause), "stopping");
          assert.deepEqual(steered, []);
          assert.equal(started.length, 1);
          assert.isFalse(projection.runs.some((run) => run.status === "queued"));
        }).pipe(Effect.provide(layer));
      }),
    ),
);

it.effect.each(["receipt", "withdraw", "cancel", "retry", "resume"] as const)(
  "keeps native boundary ownership through Stop and %s",
  (settlement) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { started, steered, layer, startFirstTurn } = yield* nextTurnSelectionHarness(
          `native-boundary-${settlement}`,
          false,
          true,
          Effect.void,
          true,
          true,
        );
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const requests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
          const threadId = yield* startFirstTurn;
          const first = started[0]!;
          const sent = yield* sendUpdate(threadId, "user", "auto", [imageAttachment]);
          const turn = (yield* orchestrator.getThreadProjection(threadId)).providerTurns[0]!;
          assert.deepEqual(
            yield* requests.claimAgentMessages!({
              threadId,
              runId: first.runId,
              providerTurnId: ProviderTurnId.make("replaced-turn"),
            }),
            [],
          );
          let offers = yield* requests.claimAgentMessages!({
            threadId,
            runId: first.runId,
            providerTurnId: turn.id,
          });
          assert.lengthOf(offers, 1);
          assert.deepEqual(offers[0]?.attachments, [imageAttachment]);
          assert.equal(offers[0]?.messageId, "message:update");
          assert.equal(offers[0]?.createdBy, "user");
          assert.equal(offers[0]?.text, "progress update");
          assert.deepEqual(
            yield* requests.claimAgentMessages!({
              threadId,
              runId: first.runId,
              providerTurnId: turn.id,
            }),
            [],
          );
          assert.equal(
            (yield* orchestrator.getThreadProjection(threadId)).runs.find(
              (run) => run.id === sent.run.id,
            )?.status,
            "queued",
          );
          const edit = yield* orchestrator
            .dispatch({
              type: "queued-run.edit",
              commandId: CommandId.make("edit-offered"),
              threadId,
              runId: sent.run.id,
              text: "changed",
            })
            .pipe(Effect.flip);
          assert.equal(edit._tag, "OrchestratorCommandRejectedError");
          const reordered = yield* orchestrator
            .dispatch({
              type: "queued-run.reorder",
              commandId: CommandId.make("reorder-offered"),
              threadId,
              runId: sent.run.id,
              beforeRunId: null,
            })
            .pipe(Effect.flip);
          assert.equal(reordered._tag, "OrchestratorDispatchError");
          if (settlement === "receipt") {
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make("late-queued"),
              threadId,
              messageId: MessageId.make("message:late-queued"),
              text: "later",
              attachments: [],
              dispatchMode: { type: "queue_after_active" },
              createdBy: "user",
              creationSource: "web",
            });
            const later = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
              (run) => run.userMessageId === "message:late-queued",
            )!;
            const crossed = yield* orchestrator
              .dispatch({
                type: "queued-run.reorder",
                commandId: CommandId.make("cross-offered"),
                threadId,
                runId: later.id,
                beforeRunId: sent.run.id,
              })
              .pipe(Effect.flip);
            assert.equal(crossed._tag, "OrchestratorDispatchError");
            const originalOffers = offers;
            const agentRetry = yield* orchestrator
              .dispatch({
                type: "queued-message.promote-to-steer",
                commandId: CommandId.make("agent-reoffer"),
                threadId,
                queuedRunId: sent.run.id,
                targetRunId: first.runId,
                requestedBy: "agent",
              })
              .pipe(Effect.flip);
            assert.equal(agentRetry._tag, "OrchestratorDispatchError");
            for (const commandId of ["human-reoffer", "human-reoffer-again"]) {
              yield* orchestrator.dispatch({
                type: "queued-message.promote-to-steer",
                commandId: CommandId.make(commandId),
                threadId,
                queuedRunId: sent.run.id,
                targetRunId: first.runId,
              });
            }
            assert.isUndefined(
              (yield* orchestrator.getThreadProjection(threadId)).runs.find(
                (run) => run.id === sent.run.id,
              )?.boundaryOffer,
            );
            yield* requests.acknowledgeAgentMessages!({
              threadId,
              runId: first.runId,
              offers: originalOffers,
            });
            offers = yield* requests.claimAgentMessages!({
              threadId,
              runId: first.runId,
              providerTurnId: turn.id,
            });
            assert.lengthOf(offers, 1);
            assert.notEqual(offers[0]!.id, originalOffers[0]!.id);
          }
          yield* orchestrator.dispatch({
            type: "run.interrupt",
            commandId: CommandId.make("stop"),
            threadId,
            runId: first.runId,
            holdQueue: true,
          });
          const ended = yield* orchestrator.streamDomainEvents.pipe(
            Stream.filter(
              (event) =>
                event.type === "run.updated" &&
                event.payload.id === first.runId &&
                event.payload.status === "interrupted",
            ),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
          yield* worker.drain();
          yield* Fiber.join(ended);
          yield* worker.drain();
          if (settlement === "withdraw") {
            yield* requests.withdrawAgentMessages!({ threadId, runId: first.runId, offers });
          } else if (settlement === "cancel") {
            yield* orchestrator.dispatch({
              type: "queued-run.cancel",
              commandId: CommandId.make("cancel"),
              threadId,
              runId: sent.run.id,
            });
          } else if (settlement === "retry") {
            const refused = yield* orchestrator
              .dispatch({
                type: "queued-run.start",
                commandId: CommandId.make("agent-retry"),
                threadId,
                runId: sent.run.id,
                requestedBy: "agent",
              })
              .pipe(Effect.flip);
            assert.equal(refused._tag, "OrchestratorDispatchError");
            yield* orchestrator.dispatch({
              type: "queued-run.start",
              commandId: CommandId.make("retry"),
              threadId,
              runId: sent.run.id,
            });
            yield* worker.drain();
          } else if (settlement === "resume") {
            yield* orchestrator.dispatch({
              type: "queue.resume",
              commandId: CommandId.make("resume"),
              threadId,
            });
            yield* worker.drain();
            yield* orchestrator.resumeQueuedRuns;
            yield* worker.drain();
          }
          if (settlement !== "resume" && settlement !== "withdraw") {
            yield* requests.acknowledgeAgentMessages!({ threadId, runId: first.runId, offers });
            yield* requests.acknowledgeAgentMessages!({ threadId, runId: first.runId, offers });
          }
          const settled = yield* orchestrator.getThreadProjection(threadId);
          const run = settled.runs.find((run) => run.id === sent.run.id)!;
          const message = settled.messages.find((message) => message.id === "message:update")!;
          if (settlement === "receipt") {
            assert.equal(message.runId, first.runId);
            const item = settled.turnItems.find(
              (item) => item.type === "user_message" && item.messageId === message.id,
            )!;
            assert.equal(item.providerTurnId, turn.id);
            assert.equal(item.nodeId, turn.nodeId);
            assert.equal(message.createdBy, "user");
            assert.deepEqual(message.attachments, [imageAttachment]);
          } else {
            assert.equal(message.runId, sent.run.id);
          }
          if (settlement === "resume" || settlement === "withdraw") {
            assert.equal(run.status, "queued");
            assert.equal(
              run.boundaryOffer?.id,
              settlement === "resume" ? offers[0]!.id : undefined,
            );
            assert.equal(run.queueHeld, settlement === "withdraw");
          }
          if (settlement === "retry") assert.notEqual(run.status, "queued");
          assert.deepEqual(steered, []);
        }).pipe(Effect.provide(layer));
      }),
    ),
);

it.effect(
  "keeps forty simultaneous human and agent boundary updates in committed queue order",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { events, started, steered, layer, startFirstTurn } = yield* nextTurnSelectionHarness(
          "native-boundary-mixed-batch",
          false,
          true,
          Effect.void,
          true,
          true,
        );
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const threads = yield* ThreadManagement.ThreadManagementService;
          const requests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
          const threadId = yield* startFirstTurn;
          const projectId = (yield* orchestrator.getThreadProjection(threadId)).thread.projectId;
          const first = started[0]!;
          yield* Effect.forEach(
            Array.from({ length: 40 }, (_, index) => index),
            (index) =>
              threads.sendToThread({
                projectId,
                threadId,
                commandId: CommandId.make(`mixed:${index}`),
                messageId: MessageId.make(`message:mixed:${index}`),
                text: `mixed update ${index}`,
                attachments: index === 17 ? [imageAttachment] : [],
                mode: index % 3 === 0 ? "steer" : "auto",
                createdBy: index % 2 === 0 ? "user" : "agent",
                creationSource: index % 2 === 0 ? "web" : "mcp",
              }),
            { concurrency: "unbounded", discard: true },
          );
          const pending = yield* orchestrator.getThreadProjection(threadId);
          const expected = pending.runs
            .filter((run) => run.status === "queued")
            .toSorted((left, right) => left.queuePosition! - right.queuePosition!)
            .map((run) => pending.messages.find((message) => message.id === run.userMessageId)!);
          assert.lengthOf(expected, 40);
          const turn = pending.providerTurns[0]!;
          const offers = yield* requests.claimAgentMessages!({
            threadId,
            runId: first.runId,
            providerTurnId: turn.id,
          });
          assert.deepEqual(
            offers.map((offer) => offer.messageId),
            expected.map((message) => message.id),
          );
          assert.deepEqual(
            offers.map((offer) => offer.createdBy),
            expected.map((message) => message.createdBy),
          );
          assert.deepEqual(
            offers.map((offer) => offer.text),
            expected.map((message) => message.text),
          );
          assert.deepEqual(
            offers.map((offer) => offer.attachments),
            expected.map((message) => message.attachments),
          );
          assert.lengthOf(new Set(offers.map((offer) => offer.id)), 40);
          const now = yield* DateTime.now;
          const itemBase = {
            threadId,
            runId: first.runId,
            nodeId: first.rootNodeId,
            providerThreadId: turn.providerThreadId,
            providerTurnId: turn.id,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 0,
            status: "completed" as const,
            title: null,
            startedAt: now,
            completedAt: now,
            updatedAt: now,
          };
          const replyId = TurnItemId.make("native-batch-reply");
          const replyCommitted = yield* orchestrator.streamDomainEvents.pipe(
            Stream.filter(
              (event) => event.type === "turn-item.updated" && event.payload.id === replyId,
            ),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
          const received = yield* orchestrator.streamDomainEvents.pipe(
            Stream.filter(
              (event) =>
                event.type === "message.updated" &&
                event.payload.id === offers.at(-1)!.messageId &&
                event.payload.runId === first.runId,
            ),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
          yield* Queue.offer(events, {
            type: "turn_item.updated",
            driver,
            turnItem: {
              ...itemBase,
              id: TurnItemId.make("native-batch-tool"),
              type: "command_execution",
              input: "synthetic noisy tool",
              exitCode: 0,
              output: Array.from({ length: 100 }, (_, index) => `noise ${index}`).join("\n"),
            },
          });
          yield* Queue.offer(events, {
            type: "boundary_messages.updated",
            driver,
            threadId,
            runId: first.runId,
            providerTurnId: turn.id,
            step: "reserve",
            offers,
          });
          yield* Queue.offer(events, {
            type: "turn_item.updated",
            driver,
            turnItem: {
              ...itemBase,
              id: replyId,
              type: "assistant_message",
              messageId: MessageId.make("message:native-batch-reply"),
              text: "Received all forty human and agent updates in order.",
              streaming: false,
            },
          });
          yield* Fiber.join(replyCommitted);
          yield* Queue.offer(events, {
            type: "boundary_messages.updated",
            driver,
            threadId,
            runId: first.runId,
            providerTurnId: turn.id,
            step: "receipt",
            offers,
          });
          yield* Fiber.join(received);
          yield* requests.acknowledgeAgentMessages!({ threadId, runId: first.runId, offers });
          const settled = yield* orchestrator.getThreadProjection(threadId);
          assert.isFalse(settled.runs.some((run) => run.status === "queued"));
          assert.deepEqual(
            settled.turnItems
              .filter((item) => item.runId === first.runId)
              .toSorted((left, right) => left.ordinal - right.ordinal)
              .map((item) => (item.type === "user_message" ? item.messageId : item.id)),
            [
              MessageId.make("message:first"),
              TurnItemId.make("native-batch-tool"),
              ...offers.map((offer) => offer.messageId),
              replyId,
            ],
          );
          assert.deepEqual(
            settled.turnItems
              .filter((item) => item.type === "user_message" && item.runId === first.runId)
              .toSorted((left, right) => left.ordinal - right.ordinal)
              .map((item) => (item.type === "user_message" ? item.messageId : null)),
            [MessageId.make("message:first"), ...offers.map((offer) => offer.messageId)],
          );
          for (const original of expected) {
            const delivered = settled.messages.find((message) => message.id === original.id)!;
            assert.equal(delivered.runId, first.runId);
            assert.equal(delivered.createdBy, original.createdBy);
            assert.equal(delivered.creationSource, original.creationSource);
            assert.equal(delivered.text, original.text);
            assert.deepEqual(delivered.attachments, original.attachments);
          }
          assert.deepEqual(steered, []);
        }).pipe(Effect.provide(layer));
      }),
    ),
);

it.effect(
  "a late native receipt uses the saved attempt after the run changes provider and node",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { started, layer, startFirstTurn } = yield* nextTurnSelectionHarness(
          "native-boundary-restarted-identity",
          false,
          true,
          Effect.void,
          true,
          true,
        );
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const sink = yield* EventSink.EventSinkV2;
          const requests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
          const threadId = yield* startFirstTurn;
          const first = started[0]!;
          const sent = yield* sendUpdate(threadId, "agent", "auto");
          const original = yield* orchestrator.getThreadProjection(threadId);
          const originalRun = original.runs.find((run) => run.id === first.runId)!;
          const originalTurn = original.providerTurns[0]!;
          const originalAttempt = original.attempts.find(
            (attempt) => attempt.id === originalRun.activeAttemptId,
          )!;
          const originalNode = original.nodes.find((node) => node.id === originalRun.rootNodeId)!;
          const originalThread = original.providerThreads.find(
            (thread) => thread.id === originalRun.providerThreadId,
          )!;
          const offers = yield* requests.claimAgentMessages!({
            threadId,
            runId: first.runId,
            providerTurnId: originalTurn.id,
          });
          assert.lengthOf(offers, 1);
          const providerInstanceId = ProviderInstanceId.make("replacement-provider");
          const providerThreadId = ProviderThreadId.make("replacement-thread");
          const providerTurnId = ProviderTurnId.make("replacement-turn");
          const rootNodeId = NodeId.make("replacement-root");
          const activeAttemptId = RunAttemptId.make("replacement-attempt");
          const now = yield* DateTime.now;
          yield* sink.write({
            events: [
              {
                id: EventId.make("replacement-thread"),
                type: "provider-thread.updated",
                threadId,
                providerInstanceId,
                occurredAt: now,
                payload: {
                  ...originalThread,
                  id: providerThreadId,
                  providerInstanceId,
                  providerSessionId: null,
                  nativeThreadRef: { driver, nativeId: "replacement-native", strength: "strong" },
                },
              },
              {
                id: EventId.make("replacement-node"),
                type: "node.updated",
                threadId,
                runId: first.runId,
                nodeId: rootNodeId,
                providerInstanceId,
                occurredAt: now,
                payload: {
                  ...originalNode,
                  id: rootNodeId,
                  rootNodeId,
                  providerThreadId,
                  providerTurnId,
                },
              },
              {
                id: EventId.make("replacement-attempt"),
                type: "run-attempt.updated",
                threadId,
                runId: first.runId,
                nodeId: rootNodeId,
                providerInstanceId,
                occurredAt: now,
                payload: {
                  ...originalAttempt,
                  id: activeAttemptId,
                  attemptOrdinal: originalAttempt.attemptOrdinal + 1,
                  rootNodeId,
                  providerThreadId,
                  providerTurnId,
                  providerInstanceId,
                },
              },
              {
                id: EventId.make("replacement-turn"),
                type: "provider-turn.updated",
                threadId,
                runId: first.runId,
                nodeId: rootNodeId,
                providerInstanceId,
                occurredAt: now,
                payload: {
                  ...originalTurn,
                  id: providerTurnId,
                  nodeId: rootNodeId,
                  providerThreadId,
                  runAttemptId: activeAttemptId,
                },
              },
              {
                id: EventId.make("replacement-run"),
                type: "run.updated",
                threadId,
                runId: first.runId,
                nodeId: rootNodeId,
                providerInstanceId,
                occurredAt: now,
                payload: {
                  ...originalRun,
                  rootNodeId,
                  activeAttemptId,
                  providerThreadId,
                  providerInstanceId,
                  modelSelection: { ...originalRun.modelSelection, instanceId: providerInstanceId },
                },
              },
            ],
          });
          const receipt = yield* orchestrator.dispatch({
            type: "queued-message.promote-to-steer",
            commandId: CommandId.make("late-native-receipt"),
            threadId,
            queuedRunId: sent.run.id,
            targetRunId: first.runId,
            boundaryOffer: { id: offers[0]!.id, step: "receipt" },
          });
          const settled = yield* orchestrator.getThreadProjection(threadId);
          const message = settled.messages.find((message) => message.id === "message:update")!;
          const item = settled.turnItems.find(
            (item) => item.type === "user_message" && item.messageId === message.id,
          )!;
          assert.equal(message.nodeId, originalNode.id);
          assert.equal(item.nodeId, originalNode.id);
          assert.equal(item.providerTurnId, originalTurn.id);
          assert.equal(item.providerThreadId, originalThread.id);
          const savedMessage = receipt.storedEvents.find(
            (event) => event.event.type === "message.updated",
          );
          assert.equal(savedMessage?.event.providerInstanceId, originalAttempt.providerInstanceId);
        }).pipe(Effect.provide(layer));
      }),
    ),
);
