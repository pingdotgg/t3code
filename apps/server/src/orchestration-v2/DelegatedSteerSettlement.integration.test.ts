import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  type RunId,
  ThreadId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2Subagent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
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
const taskA = NodeId.make("task:a");
const taskB = NodeId.make("task:b");
const yieldToRuntime = Effect.yieldNow.pipe(
  Effect.andThen(Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)))),
);
const capabilities = {
  ...CodexProviderCapabilitiesV2,
  turns: { ...CodexProviderCapabilitiesV2.turns, supportsActiveSteering: true },
};

// A parent delegated two tasks with completion wakes. Child A's result was
// reserved as a steer into the parent's running turn; child B finished while
// that reservation was outstanding, so it waits behind it. The provider stops
// accepting steers just before its turn ends (seen with Pi), so the steer
// never lands while the parent still looks running.
for (const scenario of [
  {
    name: "unaccepted",
    title:
      "re-offers a steered delegated delivery whose steer never landed when the parent settles",
    resultRead: false,
    queuedMessage: false,
  },
  {
    name: "read",
    title: "releases a steered delegated delivery the parent already read when it settles",
    resultRead: true,
    queuedMessage: false,
  },
  {
    // B waits only for settlement, and a queued user message starts the moment
    // the parent settles. B must still wake the parent after that message.
    name: "read-queued",
    title: "reserves a settled-only sibling when a queued message starts at settlement",
    resultRead: true,
    queuedMessage: true,
  },
] as const) {
  const { resultRead, queuedMessage } = scenario;
  it.effect(scenario.title, () =>
    Effect.scoped(
      Effect.gen(function* () {
        const name = `delegated-steer-settlement-${scenario.name}`;
        const cwd = yield* checkpointWorkspace(name);
        const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
        const started: ProviderAdapterV2TurnInput[] = [];
        let steerCalls = 0;
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
                    return yield* new ProviderAdapterSteerRunError({
                      driver,
                      providerThreadId: turn.providerThread.id,
                      providerTurnId: turn.providerTurnId,
                      cause: "turn is not active",
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
          const sink = yield* EventSink.EventSinkV2;
          const threadId = ThreadId.make(`thread:${name}`);
          const watch = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
            orchestrator.streamDomainEvents.pipe(
              Stream.filter(predicate),
              Stream.take(1),
              Stream.runDrain,
              Effect.forkScoped,
            );
          // Ends the run's provider turn and waits for the run to settle.
          const settle = (runId: RunId, runOrdinal: number) =>
            Effect.gen(function* () {
              const waiting = yield* watch(
                (event) =>
                  event.type === "run.updated" &&
                  event.payload.id === runId &&
                  event.payload.status === "waiting",
              );
              const completed = yield* watch(
                (event) =>
                  event.type === "run.updated" &&
                  event.payload.id === runId &&
                  event.payload.status === "completed",
              );
              // startTurn's running turn is ingested on the adapter event fiber.
              let turn: OrchestrationV2ProviderTurn | undefined;
              for (let attempt = 0; attempt < 200 && turn === undefined; attempt++) {
                const projection = yield* orchestrator.getThreadProjection(threadId);
                const run = projection.runs.find((candidate) => candidate.id === runId);
                turn = projection.providerTurns.find(
                  (candidate) =>
                    candidate.runAttemptId === run?.activeAttemptId &&
                    candidate.status === "running",
                );
                if (turn === undefined) yield* yieldToRuntime;
              }
              assert.isDefined(turn, `run ${runId} has no running provider turn`);
              if (turn === undefined) return;
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
                runOrdinal,
                status: "completed",
                failure: null,
                threadDisposition: "reusable",
              });
              yield* Fiber.join(waiting);
              yield* worker.drain();
              yield* Fiber.join(completed);
            });
          // The continuation worker runs on its own fiber, so drain the effect
          // worker and yield to it until a wake starts. When none does, the
          // assertions show the delivery reservation left behind.
          const nextWake = (
            startedCount: number,
            expected: { readonly taskIds: ReadonlyArray<NodeId> },
          ) =>
            Effect.gen(function* () {
              for (let attempt = 0; attempt < 200 && started.length === startedCount; attempt++) {
                yield* worker.drain();
                if (started.length === startedCount) yield* yieldToRuntime;
              }
              if (started.length === startedCount) {
                const projection = yield* orchestrator.getThreadProjection(threadId);
                assert.deepEqual(
                  projection.runs[0]?.delegatedCompletion?.delivery?.taskIds,
                  expected.taskIds,
                  "no wake started for the reserved delivery",
                );
                assert.fail("no wake started for the reserved delivery");
              }
              const wake = started[startedCount]!;
              assert.equal(started.length, startedCount + 1);
              for (const taskId of [taskA, taskB]) {
                if (expected.taskIds.includes(taskId)) {
                  assert.include(wake.message.text, String(taskId));
                } else {
                  assert.notInclude(wake.message.text, String(taskId));
                }
              }
              return wake;
            });

          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make("create"),
            threadId,
            projectId: ProjectId.make(`project:${name}`),
            title: "Delegated steer settlement",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: cwd,
            createdBy: "user",
            creationSource: "web",
          });
          const running = yield* watch(
            (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
          );
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("first"),
            threadId,
            messageId: MessageId.make("message:first"),
            text: "delegate two tasks",
            attachments: [],
            dispatchMode: { type: "start_immediately" },
            createdBy: "user",
            creationSource: "web",
          });
          yield* worker.drain();
          yield* Fiber.join(running);
          const parent = started[0]!;

          const steerMessageId = MessageId.make("message:delegated-steer");
          const projection = yield* orchestrator.getThreadProjection(threadId);
          const parentRun = projection.runs.find((run) => run.id === parent.runId)!;
          const now = yield* DateTime.now;
          const task = (
            id: NodeId,
            completionDelivery: OrchestrationV2Subagent["completionDelivery"],
            completionWake: OrchestrationV2Subagent["completionWake"],
          ): OrchestrationV2Subagent => ({
            id,
            threadId,
            runId: parent.runId,
            parentNodeId: parent.rootNodeId,
            origin: "app_owned",
            createdBy: "agent",
            driver,
            providerInstanceId: instanceId,
            providerThreadId: null,
            childThreadId: null,
            nativeTaskRef: null,
            prompt: `Do ${id}`,
            title: null,
            model: null,
            completionWake,
            completionDelivery,
            status: "completed",
            result: `${id} done`,
            startedAt: now,
            completedAt: now,
            updatedAt: now,
          });
          yield* sink.write({
            events: [
              {
                id: EventId.make("seed:cohort"),
                type: "run.updated",
                threadId,
                runId: parent.runId,
                occurredAt: now,
                payload: {
                  ...parentRun,
                  delegatedCompletion: {
                    disposition: "open",
                    nextGeneration: 2,
                    delivery: { generation: 1, messageId: steerMessageId, taskIds: [taskA] },
                  },
                },
              },
              ...[
                task(taskA, { state: "claimed", observedByRunId: null }, "always"),
                task(
                  taskB,
                  { state: "pending", observedByRunId: null },
                  queuedMessage ? "settled_only" : "always",
                ),
              ].map((payload) => ({
                id: EventId.make(`seed:${payload.id}`),
                type: "subagent.updated" as const,
                threadId,
                runId: parent.runId,
                nodeId: payload.id,
                occurredAt: now,
                payload,
              })),
            ],
          });
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("delegated-steer"),
            threadId,
            messageId: steerMessageId,
            text: "Delegated task finished",
            attachments: [],
            dispatchMode: { type: "queue_after_active" },
            createdBy: "agent",
            creationSource: "server",
            delegatedCompletion: { parentRunId: parent.runId, generation: 1, taskIds: [taskA] },
          });
          // Every retry is rejected while the parent turn still looks running.
          for (let attempt = 0; attempt < 5; attempt++) {
            yield* worker.drain();
            yield* TestClock.adjust("1 minute");
          }
          yield* worker.drain();
          assert.equal(steerCalls, 5);
          if (resultRead) {
            // task_status read A's result during the turn, emptying A's reservation.
            yield* orchestrator.dispatch({
              type: "delegated_task.completion-delivery.acknowledge",
              commandId: CommandId.make("read-a"),
              parentThreadId: threadId,
              taskId: taskA,
              observedByRunId: parent.runId,
            });
          }
          const queuedMessageId = MessageId.make("message:queued");
          if (queuedMessage) {
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make("queued"),
              threadId,
              messageId: queuedMessageId,
              text: "one more thing",
              attachments: [],
              dispatchMode: { type: "queue_after_active" },
              createdBy: "user",
              creationSource: "web",
            });
          }
          const beforeSettle = yield* orchestrator.getThreadProjection(threadId);
          assert.equal(beforeSettle.runs[0]?.status, "running");
          assert.equal(
            beforeSettle.runs[0]?.delegatedCompletion?.delivery?.messageId,
            steerMessageId,
          );

          yield* settle(parent.runId, parent.runOrdinal);
          if (!resultRead) {
            const wakeA = yield* nextWake(1, { taskIds: [taskA] });
            assert.equal(wakeA.message.messageId, steerMessageId);
            yield* settle(wakeA.runId, wakeA.runOrdinal);
          }
          if (queuedMessage) {
            const queued = yield* nextWake(1, { taskIds: [] });
            assert.equal(queued.message.messageId, queuedMessageId);
            yield* settle(queued.runId, queued.runOrdinal);
          }
          const wakeB = yield* nextWake(resultRead ? (queuedMessage ? 2 : 1) : 2, {
            taskIds: [taskB],
          });
          yield* settle(wakeB.runId, wakeB.runOrdinal);

          const final = yield* orchestrator.getThreadProjection(threadId);
          assert.equal(final.runs[0]?.delegatedCompletion?.delivery, null);
          assert.deepEqual(
            final.subagents.map((row) => [row.id, row.completionDelivery?.state]),
            [
              [taskA, resultRead ? "acknowledged" : "delivered"],
              [taskB, "delivered"],
            ],
          );
          assert.equal(steerCalls, 5);
        }).pipe(
          Effect.provide(
            makeOrchestratorV2ReplayLayerWithRegistry(
              { name },
              ProviderAdapterRegistry.makeSingleLayer(adapter),
              { runEffectWorker: false, runContinuationWorker: true },
            ),
          ),
        );
      }),
    ),
  );
}
