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
  ThreadId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Subagent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "test-model" };
const taskA = NodeId.make("task:a");
const taskB = NodeId.make("task:b");
const capabilities = {
  ...CodexProviderCapabilitiesV2,
  turns: { ...CodexProviderCapabilitiesV2.turns, supportsActiveSteering: true },
};

// A parent delegated two tasks with completion wakes. Child A's result was
// reserved as a steer into the parent's running turn; child B finished while
// that reservation was outstanding, so it waits behind it. The provider stops
// accepting steers just before its turn ends (seen with Pi), so the steer
// never lands while the parent still looks running.
it.effect.each([
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
  {
    // The settlement offers A's wake, and the user rolls the parent turn back
    // before the continuation worker dispatches it.
    name: "rolled-back",
    title: "drops a recovered delegated wake whose parent turn was rolled back before it started",
    resultRead: false,
    queuedMessage: false,
    rollback: true,
  },
] as const)("$title", (scenario) => {
  const { resultRead, queuedMessage } = scenario;
  const rollback = "rollback" in scenario && scenario.rollback;
  return Effect.scoped(
    Effect.gen(function* () {
      const name = `delegated-steer-settlement-${scenario.name}`;
      const cwd = yield* checkpointWorkspace(name);
      const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
      const started: ProviderAdapter.ProviderAdapterV2TurnInput[] = [];
      let steerCalls = 0;
      // The continuation worker's queue. A closed gate holds the request the
      // worker took, and `workerReady` signals each time the worker asks for
      // its next request, so after a release it marks the dispatch finished.
      const continuationQueue =
        yield* Queue.unbounded<ProviderContinuationRequests.ProviderContinuationRequest>();
      const continuationOffers =
        yield* Queue.unbounded<ProviderContinuationRequests.ProviderContinuationRequest>();
      const workerReady = yield* Queue.unbounded<void>();
      const continuationGate = yield* Latch.make(!rollback);
      const continuationRequests = Layer.succeed(
        ProviderContinuationRequests.ProviderContinuationRequests,
        {
          offer: (request) =>
            Queue.offer(continuationOffers, request).pipe(
              Effect.andThen(Queue.offer(continuationQueue, request)),
              Effect.asVoid,
            ),
          take: Effect.gen(function* () {
            yield* Queue.offer(workerReady, undefined);
            const request = yield* Queue.take(continuationQueue);
            yield* continuationGate.await;
            return request;
          }),
        },
      );
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
                  return yield* new ProviderAdapter.ProviderAdapterSteerRunError({
                    driver,
                    providerThreadId: turn.providerThread.id,
                    providerTurnId: turn.providerTurnId,
                    cause: "turn is not active",
                  });
                }),
              interruptTurn: () => Effect.void,
              respondToRuntimeRequest: () => Effect.void,
              readThreadSnapshot: () => Effect.die("unused"),
              rollbackThread: ({ providerThread }) =>
                Effect.succeed({
                  providerThread,
                  providerTurns: [],
                  messages: [],
                  runtimeRequests: [],
                }),
              forkThread: () => Effect.die("unused"),
            };
          }),
      };
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const sink = yield* EventSink.EventSinkV2;
        const threadId = ThreadId.make(`thread:${name}`);
        // The first matching event on the thread, already stored or still to
        // come. The live-clock bound only turns a missing event into a failed
        // assertion; a passing run never waits on it.
        const awaitEvent = <Type extends OrchestrationV2DomainEvent["type"]>(
          types: ReadonlyArray<Type>,
          predicate: (
            event: Extract<OrchestrationV2DomainEvent, { readonly type: Type }>,
          ) => boolean,
        ) =>
          sink.stream({ threadId }).pipe(
            Stream.map((stored) => stored.event),
            Stream.filter(
              (event): event is Extract<OrchestrationV2DomainEvent, { readonly type: Type }> =>
                (types as ReadonlyArray<string>).includes(event.type) &&
                predicate(event as Extract<OrchestrationV2DomainEvent, { readonly type: Type }>),
            ),
            Stream.runHead,
            Effect.timeoutOption("10 seconds"),
            TestClock.withLive,
            Effect.map(Option.flatten),
          );
        // startTurn's running turn is ingested on the adapter event fiber.
        const runningTurn = (turn: ProviderAdapter.ProviderAdapterV2TurnInput) =>
          Effect.gen(function* () {
            const running = yield* awaitEvent(
              ["provider-turn.updated"],
              (event) =>
                event.payload.runAttemptId === turn.attemptId && event.payload.status === "running",
            );
            if (Option.isNone(running)) {
              return assert.fail(`run ${turn.runId} has no running provider turn`);
            }
            return running.value.payload;
          });
        // Ends the run's provider turn and waits for the run to settle.
        const settle = (input: ProviderAdapter.ProviderAdapterV2TurnInput) =>
          Effect.gen(function* () {
            const turn = yield* runningTurn(input);
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
              runOrdinal: input.runOrdinal,
              status: "completed",
              failure: null,
              threadDisposition: "reusable",
            });
            const runReached = (status: "waiting" | "completed") =>
              awaitEvent(
                ["run.updated"],
                (event) => event.payload.id === input.runId && event.payload.status === status,
              ).pipe(
                Effect.map((event) =>
                  assert.isTrue(Option.isSome(event), `run ${input.runId} never ${status}`),
                ),
              );
            yield* runReached("waiting");
            yield* worker.drain();
            yield* runReached("completed");
          });
        // Waits for the run after the first `startedCount` turns to start, as
        // the continuation worker or queue promotion does it, then runs its turn
        // start. Queue promotion can already have started it while `settle`
        // drained. When none starts, the assertions show the delivery
        // reservation left behind.
        const nextWake = (
          startedCount: number,
          expected: { readonly taskIds: ReadonlyArray<NodeId> },
        ) =>
          Effect.gen(function* () {
            const startedRunIds = new Set(started.slice(0, startedCount).map((turn) => turn.runId));
            // A wake is created starting; a promoted queued run is updated to it.
            const starting = yield* awaitEvent(
              ["run.created", "run.updated"],
              (event) =>
                event.payload.status === "starting" && !startedRunIds.has(event.payload.id),
            );
            if (Option.isNone(starting)) {
              const projection = yield* orchestrator.getThreadProjection(threadId);
              assert.deepEqual(
                projection.runs[0]?.delegatedCompletion?.delivery?.taskIds,
                expected.taskIds,
                "no wake started for the reserved delivery",
              );
              return assert.fail("no wake started for the reserved delivery");
            }
            yield* worker.drain();
            assert.equal(started.length, startedCount + 1);
            const wake = started[startedCount]!;
            assert.equal(wake.runId, starting.value.payload.id);
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
        const parent = started[0]!;
        yield* runningTurn(parent);

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

        yield* settle(parent);
        if (rollback) {
          // The settlement offered A's wake; the worker holds it at the gate.
          const offer = yield* Queue.take(continuationOffers).pipe(
            Effect.timeoutOption("10 seconds"),
            TestClock.withLive,
          );
          assert.isTrue(Option.isSome(offer), "settlement offered no wake");
          assert.equal(
            Option.getOrUndefined(offer)?.delegatedCompletion?.messageId,
            steerMessageId,
          );
          const settled = yield* orchestrator.getThreadProjection(threadId);
          const threadStart = settled.checkpoints.find(
            (checkpoint) => checkpoint.ordinalWithinScope === 0 && checkpoint.status === "ready",
          );
          assert.isDefined(threadStart, "no thread-start checkpoint to roll back to");
          if (threadStart === undefined) return;
          yield* orchestrator.dispatch({
            type: "checkpoint.rollback",
            commandId: CommandId.make("rollback"),
            threadId,
            scopeId: threadStart.scopeId,
            checkpointId: threadStart.id,
            restoreFiles: false,
          });
          yield* worker.drain();
          const rolledBack = yield* orchestrator.getThreadProjection(threadId);
          assert.equal(rolledBack.runs[0]?.status, "rolled_back");
          assert.equal(
            rolledBack.runs[0]?.delegatedCompletion?.delivery?.messageId,
            steerMessageId,
          );

          yield* Queue.clear(workerReady);
          yield* continuationGate.open;
          yield* Queue.take(workerReady);
          yield* worker.drain();
          const final = yield* orchestrator.getThreadProjection(threadId);
          assert.deepEqual(
            final.runs.map((run) => [run.id, run.status]),
            [[parent.runId, "rolled_back"]],
          );
          assert.equal(started.length, 1);
          return;
        }
        if (!resultRead) {
          const wakeA = yield* nextWake(1, { taskIds: [taskA] });
          assert.equal(wakeA.message.messageId, steerMessageId);
          yield* settle(wakeA);
        }
        if (queuedMessage) {
          const queued = yield* nextWake(1, { taskIds: [] });
          assert.equal(queued.message.messageId, queuedMessageId);
          yield* settle(queued);
        }
        const wakeB = yield* nextWake(resultRead ? (queuedMessage ? 2 : 1) : 2, {
          taskIds: [taskB],
        });
        yield* settle(wakeB);

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
          ProviderReplayHarness.layerWithRegistry(
            { name },
            ProviderAdapterRegistry.layerSingle(adapter),
            { runEffectWorker: false, runContinuationWorker: true, continuationRequests },
          ),
        ),
      );
    }),
  );
});
