import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  EventId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  type ModelSelection,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import {
  ProviderAdapterSteerRunError,
  type ProviderAdapterV2Event,
  type ProviderAdapterV2Shape,
  type ProviderAdapterV2TurnInput,
} from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderRuntimeRecoveryService from "./ProviderRuntimeRecoveryService.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "test-model" };

it.effect.each(
  [false, true]
    .flatMap((mailbox) =>
      (
        [
          "before delivery",
          "during delivery",
          "before dispatch",
          "after delivery",
          "without native steering",
          "with interrupting native steering",
          "settled only",
        ] as const
      ).map((timing) => ({
        mailbox,
        timing,
        label: mailbox ? "mailbox notification" : "steering",
      })),
    )
    .filter(
      ({ mailbox, timing }) =>
        mailbox ||
        (timing !== "without native steering" &&
          timing !== "with interrupting native steering" &&
          timing !== "settled only"),
    ),
)("delivers $label when completion wins $timing", ({ mailbox, timing }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace(`steering-completion-${timing.replaceAll(" ", "-")}`);
      const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
      const started: ProviderAdapterV2TurnInput[] = [];
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
      const adapter: ProviderAdapterV2Shape = {
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
                  if (timing === "after delivery") return;
                  yield* Deferred.succeed(steerEntered, undefined);
                  yield* Deferred.await(rejectSteer);
                  return yield* new ProviderAdapterSteerRunError({
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
          dispatchMode: mailbox
            ? { type: "queue_after_active" }
            : { type: "steer_active", targetRunId: first.runId },
          createdBy: mailbox ? "agent" : "user",
          creationSource: mailbox ? "server" : "web",
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
        assert.equal(final.messages.filter((message) => message.id === messageId).length, 1);
        assert.equal(
          final.messages.find((message) => message.id === messageId)?.runId,
          started[1]?.runId,
        );
        assert.equal(
          final.turnItems.filter((item) =>
            mailbox
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

// Claude and Pi steer live but cannot interrupt-and-restart, so a changed
// selection waits for the next turn as the thread's saved selection.
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
  supportsRestart = false,
  observeStreamClose = false,
  databaseLayer?: Layer.Layer<SqlClient.SqlClient>,
) {
  const cwd = yield* checkpointWorkspace(name);
  const events = yield* Queue.unbounded<ProviderAdapterV2Event, Cause.Done>();
  const started: ProviderAdapterV2TurnInput[] = [];
  const steered: string[] = [];
  const subscriptionClosed = yield* Deferred.make<void>();
  const capabilities = {
    ...CodexProviderCapabilitiesV2,
    turns: {
      ...CodexProviderCapabilitiesV2.turns,
      supportsActiveSteering: true,
      supportsSteeringByInterruptRestart: supportsRestart,
    },
  };
  const adapter: ProviderAdapterV2Shape = {
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
          startTurn: (turn) =>
            Effect.gen(function* () {
              started.push(turn);
              // The restart test releases this snapshot after stale predecessor
              // frames, while production routing still has no current root ID.
              if (supportsRestart && started.length > 1) return;
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
            Effect.sync(() => {
              steered.push(turn.message.text);
            }),
          interruptTurn: () =>
            Effect.gen(function* () {
              if (!supportsRestart) return;
              const turn = started.at(-1)!;
              const completedAt = yield* DateTime.now;
              const providerTurnId = ProviderTurnId.make(`provider-turn:${turn.attemptId}`);
              yield* Queue.offer(events, {
                type: "provider_turn.updated",
                driver,
                providerTurn: {
                  id: providerTurnId,
                  providerThreadId: turn.providerThread.id,
                  nodeId: turn.rootNodeId,
                  runAttemptId: turn.attemptId,
                  nativeTurnRef: {
                    driver,
                    nativeId: `native:${turn.attemptId}`,
                    strength: "strong",
                  },
                  ordinal: turn.providerTurnOrdinal,
                  status: "interrupted",
                  startedAt: now,
                  completedAt,
                },
              });
              yield* Queue.offer(events, {
                type: "turn.terminal",
                driver,
                providerThreadId: turn.providerThread.id,
                providerTurnId,
                runOrdinal: turn.runOrdinal,
                status: "interrupted",
                failure: null,
                threadDisposition: "reusable",
              });
            }),
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () => Effect.die("unused"),
          rollbackThread: () => Effect.die("unused"),
          forkThread: () => Effect.die("unused"),
        };
      }),
  };
  const layer = ProviderReplayHarness.layerWithRegistry(
    { name },
    ProviderAdapterRegistry.layerSingle(adapter),
    {
      runEffectWorker: false,
      ...(observeStreamClose ? { continueThreadsAfterServerUpdate: true } : {}),
      ...(databaseLayer === undefined ? {} : { databaseLayer }),
    },
  );
  // Creates the thread and starts its first turn on `runSelection`.
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
    if (observeStreamClose) {
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const projection = yield* orchestrator.getThreadProjection(threadId);
      const providerSessionId = projection.providerThreads[0]!.providerSessionId;
      assert.isNotNull(providerSessionId);
      const runtime = yield* manager.open({
        threadId,
        providerSessionId: providerSessionId!,
        modelSelection: runSelection,
        runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd },
      });
      const subscribe = runtime.subscribeEvents!;
      // Observe the real execution consumer's cleanup without changing its
      // stream or the manager's close/release behavior.
      Object.assign(runtime, {
        subscribeEvents: subscribe.pipe(
          Effect.map((subscription) => ({
            ...subscription,
            close: subscription.close.pipe(
              Effect.andThen(Deferred.succeed(subscriptionClosed, undefined)),
            ),
          })),
        ),
      });
    }
    yield* worker.drain();
    yield* Fiber.join(running);
    return threadId;
  });
  return { events, started, steered, layer, startFirstTurn, subscriptionClosed };
});

it.effect("preserves shutdown cancellation and delivers its prepared restart continuation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const database = Layer.succeed(SqlClient.SqlClient, yield* SqlClient.SqlClient);
      const { layer, startFirstTurn, subscriptionClosed } = yield* nextTurnSelectionHarness(
        "shutdown-stream-restart",
        false,
        true,
        database,
      );
      const { threadId, sourceRunId } = yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        const recovery = yield* ProviderRuntimeRecoveryService.make;
        const threadId = yield* startFirstTurn;
        const original = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
        yield* recovery.prepareForShutdown;
        const effectId = `effect:restart-continuation:${original.id}`;
        assert.isTrue(Option.isSome(yield* outbox.get(effectId)));
        yield* manager.shutdown;
        yield* Deferred.await(subscriptionClosed);
        assert.equal(
          (yield* orchestrator.getThreadProjection(threadId)).runs[0]?.status,
          "running",
          "clean managed shutdown leaves settlement to runtime recovery",
        );
        yield* recovery.reconcile("shutdown");
        const cancelled = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(cancelled.runs[0]?.status, "cancelled");
        assert.equal(cancelled.attempts[0]?.status, "cancelled");
        assert.isFalse(cancelled.turnItems.some((item) => item.type === "error"));
        return { threadId, sourceRunId: original.id };
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            layer,
            ProjectionStore.layer.pipe(Layer.provide(database)),
            EffectOutbox.layer.pipe(Layer.provide(database)),
            ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true }),
            IdAllocator.layer,
          ),
        ),
      );
      // Restart with a fresh manager and worker over the same SQLite state.
      const restarted = yield* nextTurnSelectionHarness(
        "shutdown-stream-resumed",
        false,
        true,
        database,
      );
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const running = yield* orchestrator.streamDomainEvents.pipe(
          Stream.filter(
            (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
        yield* worker.drain();
        yield* Fiber.join(running);
        const resumed = yield* orchestrator.getThreadProjection(threadId);
        assert.isTrue(
          resumed.messages.some(
            (message) =>
              message.id === MessageId.make(`message:restart-continuation:${sourceRunId}`),
          ),
        );
        assert.lengthOf(restarted.started, 1);
        assert.equal(resumed.runs[0]?.status, "cancelled");
        assert.equal(resumed.runs[1]?.restartContinuationOfRunId, sourceRunId);
        assert.equal(resumed.runs[1]?.status, "running");
        assert.equal(resumed.providerTurns.at(-1)?.status, "running");
      }).pipe(Effect.provide(restarted.layer));
    }),
  ).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect.each(["unexpected drain", "manual release", "provider stop", "root terminal"] as const)(
  "settles a managed execution correctly on %s",
  (ending) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { layer, events, startFirstTurn, subscriptionClosed, started } =
          yield* nextTurnSelectionHarness(
            `managed-stream-${ending.replaceAll(" ", "-")}`,
            false,
            true,
          );
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
          const threadId = yield* startFirstTurn;
          const projection = yield* orchestrator.getThreadProjection(threadId);
          const session = projection.providerSessions[0]!;
          if (ending === "manual release") {
            yield* manager.release({ providerSessionId: session.id, reason: "manual_shutdown" });
          } else if (ending === "unexpected drain") {
            yield* Queue.end(events);
          } else if (ending === "provider stop") {
            yield* Queue.offer(events, {
              type: "provider_session.updated",
              driver,
              providerSession: { ...session, status: "stopped" },
            });
            yield* Queue.end(events);
          } else {
            const turn = started[0]!;
            yield* Queue.offer(events, {
              type: "turn.terminal",
              driver,
              providerThreadId: turn.providerThread.id,
              providerTurnId: ProviderTurnId.make(`provider-turn:${turn.attemptId}`),
              runOrdinal: turn.runOrdinal,
              status: "completed",
              failure: null,
              threadDisposition: "reusable",
            });
          }
          yield* Deferred.await(subscriptionClosed);
          if (ending === "root terminal") yield* manager.shutdown;
          const settled = yield* orchestrator.getThreadProjection(threadId);
          assert.equal(settled.runs[0]?.status, ending === "root terminal" ? "waiting" : "failed");
          assert.equal(
            settled.attempts[0]?.status,
            ending === "root terminal" ? "completed" : "failed",
          );
          assert.equal(
            settled.turnItems.filter((item) => item.type === "error").length,
            ending === "root terminal" ? 0 : 1,
          );
        }).pipe(Effect.provide(layer));
      }),
    ),
);

it.effect("learns a restarted production attempt's root and rejects its predecessor terminal", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { events, started, layer, startFirstTurn } = yield* nextTurnSelectionHarness(
        "production-root-identity-restart",
        true,
      );
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = yield* startFirstTurn;
        const first = started[0]!;
        const firstProjection = yield* orchestrator.getThreadProjection(threadId);
        assert.isNull(firstProjection.attempts[0]?.providerTurnId);
        const oldTurn = firstProjection.providerTurns[0]!;
        const replacementRunning = yield* orchestrator.streamDomainEvents.pipe(
          Stream.filter(
            (event) =>
              event.type === "provider-turn.updated" &&
              event.payload.status === "running" &&
              event.payload.runAttemptId !== first.attemptId,
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
        const admitted = yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("identity-restart"),
          threadId,
          messageId: MessageId.make("message:identity-restart"),
          text: "restart",
          attachments: [],
          modelSelection: runSelection,
          dispatchMode: { type: "restart_active", targetRunId: first.runId },
          createdBy: "user",
          creationSource: "web",
        });
        const admission = admitted.storedEvents.find(
          (stored) => stored.event.type === "run-attempt.created",
        );
        assert.isDefined(admission);
        if (admission.event.type !== "run-attempt.created")
          return yield* Effect.die("missing attempt");
        assert.isNull(admission.event.payload.providerTurnId);
        yield* worker.drain();
        assert.lengthOf(started, 2);
        const second = started[1]!;
        assert.equal(second.providerThread.id, first.providerThread.id);
        assert.equal(second.runOrdinal, first.runOrdinal);
        assert.notEqual(second.attemptId, first.attemptId);
        assert.equal(second.attemptId, admission.event.payload.id);
        const restartedAt = yield* DateTime.now;
        yield* Queue.offer(events, {
          type: "provider_turn.updated",
          driver,
          providerTurn: { ...oldTurn, status: "completed", completedAt: restartedAt },
        });
        yield* Queue.offer(events, {
          type: "turn.terminal",
          driver,
          providerThreadId: oldTurn.providerThreadId,
          providerTurnId: oldTurn.id,
          runOrdinal: second.runOrdinal,
          status: "completed",
          failure: null,
          threadDisposition: "reusable",
        });
        yield* Queue.offer(events, {
          type: "provider_turn.updated",
          driver,
          providerTurn: {
            ...oldTurn,
            id: ProviderTurnId.make(`provider-turn:${second.attemptId}`),
            runAttemptId: second.attemptId,
            nodeId: second.rootNodeId,
            ordinal: second.providerTurnOrdinal,
            nativeTurnRef: { driver, nativeId: `native:${second.attemptId}`, strength: "strong" },
            status: "running",
            startedAt: restartedAt,
            completedAt: null,
          },
        });
        yield* Fiber.join(replacementRunning);
        const running = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(running.runs[0]?.status, "running");
        assert.equal(running.runs[0]?.activeAttemptId, second.attemptId);
        const currentTurn = running.providerTurns.find(
          (turn) => turn.runAttemptId === second.attemptId,
        )!;
        assert.isDefined(currentTurn);

        // Both frames are from the superseded attempt. A fresh current snapshot
        // is the persisted receipt that this subscriber drained them in order.
        const completedAt = yield* DateTime.now;
        const receipt = yield* orchestrator.streamDomainEvents.pipe(
          Stream.filter(
            (event) =>
              event.type === "provider-turn.updated" &&
              event.payload.id === currentTurn.id &&
              event.payload.completedAt !== null,
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
        yield* Queue.offer(events, {
          type: "provider_turn.updated",
          driver,
          providerTurn: { ...oldTurn, status: "completed", completedAt },
        });
        yield* Queue.offer(events, {
          type: "turn.terminal",
          driver,
          providerThreadId: oldTurn.providerThreadId,
          providerTurnId: oldTurn.id,
          runOrdinal: second.runOrdinal,
          status: "completed",
          failure: null,
          threadDisposition: "reusable",
        });
        yield* Queue.offer(events, {
          type: "provider_turn.updated",
          driver,
          providerTurn: { ...currentTurn, status: "completed", completedAt },
        });
        yield* Fiber.join(receipt);
        const afterStale = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(afterStale.runs[0]?.status, "running");
        assert.equal(afterStale.runs[0]?.activeAttemptId, second.attemptId);
        assert.deepEqual(
          afterStale.attempts.map((attempt) => attempt.status),
          ["superseded", "running"],
        );

        const finalized = yield* orchestrator.streamDomainEvents.pipe(
          Stream.filter(
            (event) =>
              event.type === "run.updated" &&
              event.payload.id === second.runId &&
              event.payload.status === "waiting",
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
        yield* Queue.offer(events, {
          type: "turn.terminal",
          driver,
          providerThreadId: currentTurn.providerThreadId,
          providerTurnId: currentTurn.id,
          runOrdinal: second.runOrdinal,
          status: "completed",
          failure: null,
          threadDisposition: "reusable",
        });
        yield* Fiber.join(finalized);
        yield* worker.drain();
        const settled = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(settled.runs[0]?.status, "completed");
        assert.deepEqual(
          settled.attempts.map((attempt) => attempt.status),
          ["superseded", "completed"],
        );
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("steers a changed turn-scoped selection into a provider that cannot restart", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { started, steered, layer, startFirstTurn } = yield* nextTurnSelectionHarness(
        "steering-selection-change",
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

        // Choosing the running run's selection again replaces the saved choice.
        yield* steer("steer-reverted", runSelection);
        const reverted = yield* orchestrator.getThreadProjection(threadId);
        assert.deepEqual(steered, ["steer-changed", "steer-reverted"]);
        assert.lengthOf(reverted.attempts, 1);
        assert.deepEqual(reverted.thread.modelSelection, runSelection);

        // The saved choice moves to another instance while the run keeps going.
        // Steering with the run's selection brings the thread's instance back too.
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
        // The turn ends before the worker delivers the steer, so the steer
        // becomes a follow-up turn.
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
