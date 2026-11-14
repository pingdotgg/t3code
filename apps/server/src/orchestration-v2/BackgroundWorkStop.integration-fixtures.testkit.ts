// @effect-diagnostics preferSchemaOverJson:off
// shared fixtures for every BackgroundWorkStop.integration-* part
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
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import {
  applyStalledRunScenario,
  makeSettledRunFactory,
  makeSubagentThreadFactory,
} from "./BackgroundWorkStop.integration-fixtures-work.testkit.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

export const driver = ProviderDriverKind.make("codex");

export const instanceId = ProviderInstanceId.make("codex");

export const modelSelection = { instanceId, model: "test-model" };


export const stopEarlierBackgroundWork = ({
  wakeAfterStop = false,
  failedStart = false,
  stopWithQueue,
  olderStart = false,
  backgroundWorkAfterStop,
  stalledRun,
  workflowMember = false,
}: {
  readonly wakeAfterStop?: boolean;
  readonly failedStart?: boolean;
  readonly backgroundWorkAfterStop?: "running" | "unknown";
  readonly stopWithQueue?: "thread.stop" | "run.interrupt";
  readonly olderStart?: boolean;
  readonly workflowMember?: boolean;
  readonly stalledRun?: "missing-session-terminal" | "returned-interrupt" | "superseded-attempt";
}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace("background-work-stop");
      const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
      const started: ProviderAdapter.ProviderAdapterV2TurnInput[] = [];
      const interrupts: ProviderAdapter.ProviderAdapterV2InterruptInput[] = [];
      const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
        instanceId,
        driver,
        getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
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
                capabilities: CodexProviderCapabilitiesV2,
                createdAt: now,
                updatedAt: now,
                lastError: null,
              },
              events: Stream.fromQueue(events),
              ...(failedStart
                ? {
                    hasPendingBackgroundWorkForThread: (providerThread) =>
                      Effect.gen(function* () {
                        if (
                          !interrupts.some((input) => input.providerThread.id === providerThread.id)
                        ) {
                          return false;
                        }
                        if (backgroundWorkAfterStop === "unknown") {
                          return yield* Effect.die("Background work probe failed");
                        }
                        return backgroundWorkAfterStop === "running";
                      }),
                  }
                : {}),
              ensureThread: ({ threadId }) =>
                Effect.succeed({
                  id: ProviderThreadId.make(`provider-thread:codex:${threadId}`),
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
              steerTurn: () => Effect.die("unused"),
              interruptTurn: (interrupt) =>
                Effect.sync(() => {
                  interrupts.push(interrupt);
                }),
              respondToRuntimeRequest: () => Effect.die("unused"),
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
        const threadId = ThreadId.make("thread:background-work-stop");
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
          projectId: ProjectId.make("project:background-work-stop"),
          title: "Background work stop",
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
          commandId: CommandId.make("start-dev-server"),
          threadId,
          messageId: MessageId.make("message:start-dev-server"),
          text: "Start the dev server",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.drain();
        yield* Fiber.join(running);
        if (wakeAfterStop) {
          const send = (id: string, provider = false) =>
            orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make(id),
              threadId,
              messageId: MessageId.make(`message:${id}`),
              text: id,
              attachments: [],
              dispatchMode: { type: "queue_after_active" },
              createdBy: provider ? "agent" : "user",
              creationSource: provider ? "provider" : "web",
            });
          yield* send("follow-up");
          yield* orchestrator.dispatch({
            type: "thread.stop",
            commandId: CommandId.make("stop"),
            threadId,
          });
          // Stop is committed, but its provider interrupt has not run yet.
          yield* send("Background task completed.", true);
          const [stopped, followUp, wake] = (yield* orchestrator.getThreadProjection(threadId))
            .runs;
          assert.equal(stopped?.status, "running");
          assert.isTrue(followUp?.queueHeld);
          assert.isTrue(wake?.queueHeld);

          yield* worker.drain();
          yield* orchestrator.resumeQueuedRuns;
          yield* worker.drain();
          const after = yield* orchestrator.getThreadProjection(threadId);
          assert.deepEqual(
            after.runs.map((run) => run.status),
            ["interrupted", "queued", "queued"],
          );
          assert.isTrue(after.runs.find((run) => run.id === followUp?.id)?.queueHeld);
          assert.isTrue(after.runs.find((run) => run.id === wake?.id)?.queueHeld);
          assert.lengthOf(started, 1);
          return;
        }
        const first = started[0]!;
        const codexTurn = (yield* orchestrator.getThreadProjection(threadId)).providerTurns[0]!;
        const devServerId = TurnItemId.make("turn-item:dev-server");
        const now = yield* DateTime.now;
        yield* sink.write({
          events: [
            {
              id: EventId.make("dev-server"),
              type: "turn-item.updated",
              threadId,
              runId: first.runId,
              occurredAt: now,
              payload: {
                id: devServerId,
                threadId,
                runId: first.runId,
                nodeId: first.rootNodeId,
                providerThreadId: codexTurn.providerThreadId,
                providerTurnId: codexTurn.id,
                nativeItemRef: null,
                parentItemId: null,
                ordinal: 100,
                status: "running",
                title: null,
                startedAt: now,
                completedAt: null,
                updatedAt: now,
                type: "command_execution",
                input: "vp run dev --share",
              },
            },
          ],
        });
        if (stalledRun !== undefined) {
          yield* applyStalledRunScenario({
            orchestrator,
            sink,
            threadId,
            now,
            stalledRun,
            first,
            codexTurn,
            events,
            devServerId,
            // The watcher only ever drains a filter, so its fiber cannot fail.
            watch: (predicate) =>
              watch(predicate).pipe(
                Effect.map((fiber) => fiber as Fiber.Fiber<void, never>),
              ),
            worker,
          });
          return;
        }
        const settled = yield* watch(
          (event) =>
            event.type === "run.updated" &&
            event.payload.id === first.runId &&
            event.payload.status === "waiting",
        );
        yield* Queue.offer(events, {
          type: "provider_turn.updated",
          driver,
          providerTurn: { ...codexTurn, status: "completed", completedAt: now },
        });
        yield* Queue.offer(events, {
          type: "turn.terminal",
          driver,
          providerThreadId: codexTurn.providerThreadId,
          providerTurnId: codexTurn.id,
          runOrdinal: first.runOrdinal,
          status: "completed",
          failure: null,
          threadDisposition: "reusable",
        });
        yield* Fiber.join(settled);
        yield* worker.drain();

        const codexProviderThread = (yield* orchestrator.getThreadProjection(threadId))
          .providerThreads[0]!;
        const backgroundTasks = [
          { taskId: "sleep", description: "Wait before the recheck", kind: "command" as const },
        ];
        const otherBackgroundTasks = [{ ...backgroundTasks[0]!, taskId: "other-sleep" }];
        const { subagentThread } = makeSubagentThreadFactory({
          orchestrator,
          sink,
          threadId,
          cwd,
          now,
          instanceId,
          modelSelection,
        });
        const { threadId: reviewerThreadId, rootId: reviewerRootId } =
          yield* subagentThread("reviewer");
        const { settledRun } = makeSettledRunFactory({
          threadId,
          now,
          instanceId,
          modelSelection,
          driver,
          reviewerThreadId,
        });
        const tester = yield* subagentThread("tester");
        const nestedSubagentId = NodeId.make("subagent:nested");
        const nestedItemId = TurnItemId.make("turn-item:nested-subagent");
        const nested = {
          threadId: reviewerThreadId,
          runId: null,
          origin: "provider_native",
          driver,
          providerInstanceId: instanceId,
          providerThreadId: null,
          childThreadId: tester.threadId,
          prompt: "Check the tests",
          title: null,
          status: "running",
          result: null,
          startedAt: now,
          completedAt: null,
          updatedAt: now,
        } as const;
        yield* sink.write({
          events: [
            ...(workflowMember
              ? []
              : [
                  {
                    id: EventId.make("nested-subagent-item"),
                    type: "turn-item.updated",
                    threadId: reviewerThreadId,
                    occurredAt: now,
                    payload: {
                      ...nested,
                      id: nestedItemId,
                      nodeId: nestedSubagentId,
                      providerTurnId: null,
                      nativeItemRef: null,
                      parentItemId: null,
                      ordinal: 1,
                      type: "subagent",
                      subagentId: nestedSubagentId,
                    },
                  } as const,
                ]),
            {
              id: EventId.make("nested-subagent"),
              type: "subagent.updated",
              threadId: reviewerThreadId,
              occurredAt: now,
              payload: {
                ...nested,
                id: nestedSubagentId,
                parentNodeId: reviewerRootId,
                createdBy: "agent",
                nativeTaskRef: workflowMember
                  ? { driver, nativeId: "workflow:member", strength: "strong" }
                  : null,
                model: null,
              },
            },
          ],
        });
        if (workflowMember) {
          const memberRoot = (yield* orchestrator.getThreadProjection(tester.threadId)).nodes[0]!;
          yield* sink.write({
            events: [
              {
                id: EventId.make("workflow-member-node"),
                type: "node.updated",
                threadId: reviewerThreadId,
                occurredAt: now,
                payload: {
                  ...memberRoot,
                  id: nestedSubagentId,
                  threadId: reviewerThreadId,
                  parentNodeId: reviewerRootId,
                  rootNodeId: reviewerRootId,
                  kind: "subagent",
                },
              },
            ],
          });
        }

        const watcherId = TurnItemId.make("turn-item:watcher");
        const otherProviderThreadId = ProviderThreadId.make("provider-thread:other");
        const watcherRun = settledRun({
          ordinal: 2,
          providerThreadId: olderStart ? otherProviderThreadId : codexProviderThread.id,
          ...(olderStart ? {} : { runningItem: { id: watcherId, kind: "command" as const } }),
        });
        const reviewerId = TurnItemId.make("turn-item:reviewer");
        const reviewerRun = settledRun({
          ordinal: 3,
          providerThreadId: codexProviderThread.id,
          runningItem: { id: reviewerId, kind: "subagent" },
        });
        const latestRun = settledRun({ ordinal: 4, providerThreadId: otherProviderThreadId });
        yield* sink.write({
          events: [
            ...watcherRun.events,
            ...reviewerRun.events,
            {
              id: EventId.make("provider-thread:other"),
              type: "provider-thread.updated",
              threadId,
              occurredAt: now,
              payload: {
                ...codexProviderThread,
                id: otherProviderThreadId,
                firstRunOrdinal: 4,
                lastRunOrdinal: 4,
                ...(failedStart ? { pendingBackgroundTasks: otherBackgroundTasks } : {}),
              },
            },
            ...latestRun.events,
          ],
        });

        const failedRun = settledRun({ ordinal: 5, providerThreadId: codexProviderThread.id });
        if (failedStart) {
          yield* sink.write({
            events: [
              {
                id: EventId.make("failed-start-roster"),
                type: "provider-thread.updated",
                threadId,
                occurredAt: now,
                payload: {
                  ...codexProviderThread,
                  lastRunOrdinal: 5,
                  pendingBackgroundTasks: backgroundTasks,
                },
              },
              ...failedRun.events.flatMap((event): Array<OrchestrationV2DomainEvent> => {
                switch (event.type) {
                  case "provider-turn.updated":
                    return [];
                  case "run.created":
                    return [{ ...event, payload: { ...event.payload, status: "failed" } }];
                  case "node.updated":
                    return [
                      {
                        ...event,
                        payload: { ...event.payload, status: "failed", providerTurnId: null },
                      },
                    ];
                  case "run-attempt.created":
                    return [
                      {
                        ...event,
                        payload: { ...event.payload, status: "failed", providerTurnId: null },
                      },
                    ];
                  default:
                    return [event];
                }
              }),
            ],
          });
          // The older turn reports an empty roster, but the refused run owns the row now.
          const clear = yield* sink.writeIfProviderThreadOwner({
            providerThreadId: codexProviderThread.id,
            runId: reviewerRun.runId,
            activeAttemptId: RunAttemptId.make("attempt:3"),
            expectedLastRunOrdinal: 3,
            events: [
              {
                id: EventId.make("dropped-roster-clear"),
                type: "provider-thread.updated",
                threadId,
                occurredAt: now,
                payload: { ...codexProviderThread, pendingBackgroundTasks: [] },
              },
            ],
          });
          assert.isFalse(clear.committed);
          const beforeStop = (yield* orchestrator.getThreadProjection(
            threadId,
          )).providerThreads.find((thread) => thread.id === codexProviderThread.id)!;
          assert.equal(beforeStop.lastRunOrdinal, 5);
          assert.deepEqual(beforeStop.pendingBackgroundTasks, backgroundTasks);
        }

        if (stopWithQueue !== undefined) {
          const owner = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
            (run) => run.id === latestRun.runId,
          )!;
          yield* sink.write({
            events: [
              {
                id: EventId.make("latest-run-waiting"),
                type: "run.updated",
                threadId,
                runId: owner.id,
                occurredAt: now,
                payload: { ...owner, status: "waiting", completedAt: null },
              },
            ],
          });
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("queue-follow-up"),
            threadId,
            messageId: MessageId.make("message:queue-follow-up"),
            text: "Follow up after the background work",
            attachments: [],
            dispatchMode: { type: "queue_after_active" },
            createdBy: "user",
            creationSource: "web",
          });
          const queued = (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)!;
          assert.equal(queued.status, "queued");
          yield* sink.write({
            events: [
              {
                id: EventId.make("queue-held"),
                type: "run.updated",
                threadId,
                runId: queued.id,
                occurredAt: now,
                payload: { ...queued, queueHeld: true },
              },
              {
                id: EventId.make("latest-run-settled"),
                type: "run.updated",
                threadId,
                runId: owner.id,
                occurredAt: now,
                payload: owner,
              },
            ],
          });
        }

        if (olderStart) {
          const older = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
            (run) => run.id === watcherRun.runId,
          )!;
          yield* sink.write({
            events: [
              {
                id: EventId.make("older-run-starting"),
                type: "run.updated",
                threadId,
                runId: older.id,
                occurredAt: now,
                payload: { ...older, status: "starting", startedAt: null, completedAt: null },
              },
            ],
          });
        }

        yield* orchestrator.dispatch(
          stopWithQueue === "thread.stop"
            ? {
                type: "thread.stop",
                commandId: CommandId.make("stop-background-work"),
                threadId,
              }
            : {
                type: "run.interrupt",
                commandId: CommandId.make("stop-background-work"),
                threadId,
                runId: olderStart
                  ? watcherRun.runId
                  : failedStart
                    ? failedRun.runId
                    : latestRun.runId,
                ...(stopWithQueue === undefined ? {} : { holdQueue: true }),
              },
        );
        yield* worker.drain();

        assert.sameDeepMembers(
          interrupts.map((interrupt) => [interrupt.providerThread.id, interrupt.providerTurnId]),
          [
            ...(olderStart || failedStart
              ? []
              : [[otherProviderThreadId, latestRun.providerTurnId]]),
            [codexProviderThread.id, reviewerRun.providerTurnId],
          ],
        );
        const after = yield* orchestrator.getThreadProjection(threadId);
        if (olderStart) {
          assert.equal(
            after.runs.find((run) => run.id === watcherRun.runId)?.status,
            "interrupted",
          );
        }
        if (stopWithQueue !== undefined) {
          assert.equal(after.runs.at(-1)?.status, "queued");
          assert.equal(after.runs.at(-1)?.queueHeld, true);
          assert.lengthOf(started, 1);
        }
        assert.deepEqual(
          [devServerId, ...(olderStart ? [] : [watcherId]), reviewerId].map(
            (id) => after.turnItems.find((item) => item.id === id)?.status,
          ),
          olderStart
            ? ["interrupted", "interrupted"]
            : ["interrupted", "interrupted", "interrupted"],
        );
        assert.equal(after.subagents[0]?.status, "interrupted");
        const reviewerThread = yield* orchestrator.getThreadProjection(reviewerThreadId);
        assert.equal(reviewerThread.nodes[0]?.status, "interrupted");
        assert.equal(reviewerThread.subagents[0]?.status, "interrupted");
        if (workflowMember) {
          assert.isUndefined(reviewerThread.turnItems.find((item) => item.id === nestedItemId));
          assert.equal(
            reviewerThread.nodes.find((node) => node.id === nestedSubagentId)?.status,
            "interrupted",
          );
        } else {
          assert.equal(
            reviewerThread.turnItems.find((item) => item.id === nestedItemId)?.status,
            "interrupted",
          );
        }
        const testerThread = yield* orchestrator.getThreadProjection(tester.threadId);
        assert.equal(testerThread.nodes[0]?.status, "interrupted");
        if (failedStart) {
          assert.deepEqual(
            after.providerThreads.find((candidate) => candidate.id === codexProviderThread.id)
              ?.pendingBackgroundTasks,
            backgroundWorkAfterStop === undefined ? [] : backgroundTasks,
          );
          assert.deepEqual(
            after.providerThreads.find((candidate) => candidate.id === otherProviderThreadId)
              ?.pendingBackgroundTasks,
            otherBackgroundTasks,
          );
        }
      }).pipe(
        Effect.provide(
          ProviderReplayHarness.layerWithRegistry(
            { name: "background-work-stop" },
            ProviderAdapterRegistry.layerSingle(adapter),
            { runEffectWorker: false },
          ),
        ),
      );
    }),
  );
