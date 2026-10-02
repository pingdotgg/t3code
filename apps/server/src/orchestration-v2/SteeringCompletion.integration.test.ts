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
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import {
  ProviderAdapterSteerRunError,
  type ProviderAdapterV2Event,
  type ProviderAdapterV2Shape,
  type ProviderAdapterV2TurnInput,
} from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "./testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "./testkit/ReplayFixtureWorkspace.ts";

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "test-model" };

for (const mailbox of [false, true]) {
  for (const timing of [
    "before delivery",
    "during delivery",
    "before dispatch",
    "after delivery",
    "without native steering",
    "settled only",
    "failed terminal",
    "interrupted terminal",
    "user stop",
  ] as const) {
    if (
      !mailbox &&
      (timing === "without native steering" ||
        timing === "settled only" ||
        timing === "interrupted terminal" ||
        timing === "user stop")
    )
      continue;
    it.effect(
      timing === "user stop"
        ? "does not redeliver a mailbox notification after user stop"
        : timing === "interrupted terminal"
          ? "does not redeliver a mailbox notification after receiver interruption"
          : timing === "failed terminal"
            ? mailbox
              ? "redelivers a mailbox notification after receiver failure"
              : "does not replay ordinary steering after receiver failure"
            : `delivers ${mailbox ? "mailbox notification" : "steering"} when completion wins ${timing}`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const cwd = yield* checkpointWorkspace(
              `steering-completion-${timing.replaceAll(" ", "-")}`,
            );
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
                (event) =>
                  event.type === "provider-turn.updated" && event.payload.status === "running",
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
                timing === "during delivery" ||
                timing === "failed terminal" ||
                timing === "interrupted terminal" ||
                timing === "user stop"
                  ? yield* worker.runOnce.pipe(Effect.forkScoped)
                  : null;
              if (delivery !== null) yield* Deferred.await(steerEntered);
              if (timing === "user stop") {
                yield* orchestrator.dispatch({
                  type: "run.interrupt",
                  commandId: CommandId.make("interrupt"),
                  threadId,
                  runId: first.runId,
                });
                const stopped = yield* orchestrator.getThreadProjection(threadId);
                assert.equal(stopped.runs[0]?.delegatedCompletion?.disposition, "stopped");
              }
              {
                const terminalStatus =
                  timing === "user stop" || timing === "interrupted terminal"
                    ? "interrupted"
                    : timing === "failed terminal"
                      ? "failed"
                      : "completed";
                const completed = yield* watch(
                  (event) =>
                    event.type === "run.updated" &&
                    event.payload.id === first.runId &&
                    event.payload.status ===
                      (terminalStatus === "completed" ? "waiting" : terminalStatus),
                );
                const projection = yield* orchestrator.getThreadProjection(threadId);
                const turn = projection.providerTurns[0]!;
                yield* Queue.offer(events, {
                  type: "provider_turn.updated",
                  driver,
                  providerTurn: {
                    ...turn,
                    status: terminalStatus,
                    completedAt: yield* DateTime.now,
                  },
                });
                yield* Queue.offer(events, {
                  type: "turn.terminal",
                  driver,
                  providerThreadId: turn.providerThreadId,
                  providerTurnId: turn.id,
                  runOrdinal: first.runOrdinal,
                  ...(terminalStatus === "failed"
                    ? {
                        status: "failed" as const,
                        failureItemOrdinal: 1,
                        failure: {
                          class: "provider_error" as const,
                          message: "Receiver failed before mailbox delivery",
                          code: null,
                          retryable: false,
                        },
                      }
                    : { status: terminalStatus, failure: null }),
                  threadDisposition: "reusable",
                });
                yield* Fiber.join(completed);
              }
              if (mailbox && (timing === "failed terminal" || timing === "interrupted terminal")) {
                const beforeReject = yield* orchestrator.getThreadProjection(threadId);
                assert.equal(beforeReject.runs[0]?.delegatedCompletion?.disposition, "open");
                assert.equal(beforeReject.subagents[0]?.completionDelivery?.state, "claimed");
              }
              if (delivery !== null) {
                yield* Deferred.succeed(rejectSteer, undefined);
                yield* Fiber.join(delivery);
              }
              if (timing === "before dispatch") yield* dispatchSteer;
              if (
                timing === "failed terminal" ||
                timing === "interrupted terminal" ||
                timing === "user stop"
              ) {
                const outbox = yield* EffectOutbox.EffectOutboxV2;
                for (let remaining = 8; remaining > 0; remaining -= 1) {
                  const steerEffect = (yield* outbox.listByCommandId(CommandId.make("steer"))).find(
                    (row) => row.request.type === "provider-turn.steer",
                  );
                  if (
                    steerEffect !== undefined &&
                    (steerEffect.status === "succeeded" ||
                      steerEffect.status === "failed" ||
                      steerEffect.status === "cancelled")
                  ) {
                    break;
                  }
                  if (steerEffect !== undefined && steerEffect.status === "pending") {
                    const available = DateTime.makeUnsafe(steerEffect.availableAt);
                    const now = yield* DateTime.now;
                    const delayMs = DateTime.toEpochMillis(available) - DateTime.toEpochMillis(now);
                    if (delayMs > 0) {
                      yield* TestClock.adjust(`${delayMs} millis`);
                    }
                  }
                  if (!(yield* worker.runOnce)) {
                    break;
                  }
                }
              } else {
                yield* worker.drain();
              }
              yield* orchestrator.resumeQueuedRuns;
              yield* worker.drain();
              if ((!mailbox && timing === "failed terminal") || timing === "interrupted terminal") {
                const outbox = yield* EffectOutbox.EffectOutboxV2;
                const steerEffect = (yield* outbox.listByCommandId(CommandId.make("steer"))).find(
                  (row) => row.request.type === "provider-turn.steer",
                );
                assert.equal(steerEffect?.status, "failed");
                assert.equal(steerEffect?.attemptCount, 5);
                assert.equal(started.length, 1);
                if (mailbox) {
                  const interrupted = yield* orchestrator.getThreadProjection(threadId);
                  assert.equal(interrupted.runs[0]?.delegatedCompletion?.disposition, "open");
                  assert.equal(interrupted.subagents[0]?.completionDelivery?.state, "claimed");
                }
                return;
              }
              if (timing === "user stop") {
                const stopped = yield* orchestrator.getThreadProjection(threadId);
                const outbox = yield* EffectOutbox.EffectOutboxV2;
                const steerEffect = (yield* outbox.listByCommandId(CommandId.make("steer"))).find(
                  (row) => row.request.type === "provider-turn.steer",
                );
                assert.include(["succeeded", "cancelled"], steerEffect?.status);
                assert.equal(stopped.runs[0]?.delegatedCompletion?.disposition, "stopped");
                assert.equal(started.length, 1);
                return;
              }
              if (mailbox && timing === "failed terminal") {
                const outbox = yield* EffectOutbox.EffectOutboxV2;
                const steerEffect = (yield* outbox.listByCommandId(CommandId.make("steer"))).find(
                  (row) => row.request.type === "provider-turn.steer",
                );
                assert.equal(steerEffect?.status, "succeeded");
              }
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
                  assert.equal(
                    acknowledged.subagents[0]?.completionDelivery?.state,
                    "acknowledged",
                  );
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
              assert.equal(
                steerCalls,
                timing === "during delivery" || timing === "failed terminal" ? 1 : 0,
              );
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
                makeOrchestratorV2ReplayLayerWithRegistry(
                  { name: `steering-completion-${timing}` },
                  ProviderAdapterRegistry.makeSingleLayer(adapter),
                  { runEffectWorker: false },
                ),
              ),
              Effect.provide(TestClock.layer()),
            );
          }),
        ),
    );
  }
}

// Claude steers live but cannot interrupt-and-restart. A composer whose model
// options differ from the running run (an explicit `fastMode: false`) must still
// steer, keeping the new selection for the next turn.
it.effect("steers a changed turn-scoped selection into a provider that cannot restart", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace("steering-selection-change");
      const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
      const started: ProviderAdapterV2TurnInput[] = [];
      const steered: string[] = [];
      const capabilities = {
        ...CodexProviderCapabilitiesV2,
        turns: {
          ...CodexProviderCapabilitiesV2.turns,
          supportsActiveSteering: true,
          supportsSteeringByInterruptRestart: false,
        },
      };
      const runSelection = {
        instanceId,
        model: "test-model",
        options: [{ id: "effort", value: "xhigh" }],
      };
      const composerSelection = {
        ...runSelection,
        options: [...runSelection.options, { id: "fastMode", value: false }],
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
        const threadId = ThreadId.make("thread:steering-selection-change");
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("create"),
          threadId,
          projectId: ProjectId.make("project:steering-selection-change"),
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

        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("steer"),
          threadId,
          messageId: MessageId.make("message:steer"),
          text: "use the File component",
          attachments: [],
          modelSelection: composerSelection,
          dispatchMode: { type: "steer_active", targetRunId: started[0]!.runId },
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.drain();

        const projection = yield* orchestrator.getThreadProjection(threadId);
        assert.deepEqual(steered, ["use the File component"]);
        assert.equal(started.length, 1);
        assert.lengthOf(projection.attempts, 1);
        assert.equal(projection.runs[0]?.status, "running");
        assert.deepEqual(projection.runs[0]?.modelSelection, runSelection);
        assert.deepEqual(projection.thread.modelSelection, composerSelection);
      }).pipe(
        Effect.provide(
          makeOrchestratorV2ReplayLayerWithRegistry(
            { name: "steering-selection-change" },
            ProviderAdapterRegistry.makeSingleLayer(adapter),
            { runEffectWorker: false },
          ),
        ),
      );
    }),
  ),
);
