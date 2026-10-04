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
import type {
  ProviderAdapterV2Event,
  ProviderAdapterV2InterruptInput,
  ProviderAdapterV2Shape,
  ProviderAdapterV2TurnInput,
} from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "./testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "./testkit/ReplayFixtureWorkspace.ts";

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "test-model" };

// Codex turns leave commands running, then the thread moves to another
// provider thread (a provider switch). Stop on the newer, settled run must
// reach both provider threads and end all of the Codex work.
const stopEarlierBackgroundWork = (failedStart: boolean) =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace("background-work-stop");
      const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
      const started: ProviderAdapterV2TurnInput[] = [];
      const interrupts: ProviderAdapterV2InterruptInput[] = [];
      const adapter: ProviderAdapterV2Shape = {
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
        // A settled run with its root node, attempt, provider turn and,
        // optionally, a command or native subagent it left running.
        const settledRun = (input: {
          readonly ordinal: number;
          readonly providerThreadId: ProviderThreadId;
          readonly runningItem?: {
            readonly id: TurnItemId;
            readonly kind: "command" | "subagent";
          };
        }) => {
          const runId = RunId.make(`run:${input.ordinal}`);
          const attemptId = RunAttemptId.make(`attempt:${input.ordinal}`);
          const nodeId = NodeId.make(`node:${input.ordinal}`);
          const providerTurnId = ProviderTurnId.make(`provider-turn:${input.ordinal}`);
          const events: Array<OrchestrationV2DomainEvent> = [
            {
              id: EventId.make(`run:${input.ordinal}`),
              type: "run.created",
              threadId,
              occurredAt: now,
              payload: {
                id: runId,
                threadId,
                ordinal: input.ordinal,
                providerInstanceId: instanceId,
                modelSelection,
                providerThreadId: input.providerThreadId,
                userMessageId: MessageId.make(`message:${input.ordinal}`),
                rootNodeId: nodeId,
                activeAttemptId: attemptId,
                status: "completed",
                requestedAt: now,
                startedAt: now,
                completedAt: now,
                checkpointId: null,
                contextHandoffId: null,
              },
            },
            {
              id: EventId.make(`node:${input.ordinal}`),
              type: "node.updated",
              threadId,
              runId,
              occurredAt: now,
              payload: {
                id: nodeId,
                threadId,
                runId,
                parentNodeId: null,
                rootNodeId: nodeId,
                kind: "root_turn",
                status: "completed",
                countsForRun: true,
                providerThreadId: input.providerThreadId,
                providerTurnId,
                nativeItemRef: null,
                runtimeRequestId: null,
                checkpointScopeId: null,
                startedAt: now,
                completedAt: now,
              },
            },
            {
              id: EventId.make(`attempt:${input.ordinal}`),
              type: "run-attempt.created",
              threadId,
              occurredAt: now,
              payload: {
                id: attemptId,
                runId,
                attemptOrdinal: 1,
                rootNodeId: nodeId,
                providerInstanceId: instanceId,
                providerThreadId: input.providerThreadId,
                providerTurnId,
                reason: "initial",
                status: "completed",
                startedAt: now,
                completedAt: now,
              },
            },
            {
              id: EventId.make(`provider-turn:${input.ordinal}`),
              type: "provider-turn.updated",
              threadId,
              occurredAt: now,
              payload: {
                id: providerTurnId,
                providerThreadId: input.providerThreadId,
                nodeId,
                runAttemptId: attemptId,
                nativeTurnRef: null,
                ordinal: input.ordinal,
                status: "completed",
                startedAt: now,
                completedAt: now,
              },
            },
          ];
          const item = input.runningItem;
          if (item !== undefined) {
            const base = {
              id: item.id,
              threadId,
              runId,
              nodeId,
              providerThreadId: input.providerThreadId,
              providerTurnId,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: input.ordinal * 100,
              status: "running",
              title: null,
              startedAt: now,
              completedAt: null,
              updatedAt: now,
            } as const;
            events.push({
              id: EventId.make(`item:${input.ordinal}`),
              type: "turn-item.updated",
              threadId,
              runId,
              occurredAt: now,
              payload:
                item.kind === "command"
                  ? { ...base, type: "command_execution", input: "vp run test --watch" }
                  : {
                      ...base,
                      // A native subagent item names its own provider thread
                      // but its parent's provider turn.
                      providerThreadId: ProviderThreadId.make("provider-thread:codex-subagent"),
                      type: "subagent",
                      subagentId: NodeId.make(`subagent:${input.ordinal}`),
                      origin: "provider_native",
                      driver,
                      providerInstanceId: instanceId,
                      childThreadId: null,
                      prompt: "Review the change",
                      result: null,
                    },
            });
          }
          return { runId, providerTurnId, events };
        };

        // Later Codex runs leave a second command and a native subagent. Then
        // the thread moves on to another provider thread, which also has a
        // live session.
        const watcherId = TurnItemId.make("turn-item:watcher");
        const watcherRun = settledRun({
          ordinal: 2,
          providerThreadId: codexProviderThread.id,
          runningItem: { id: watcherId, kind: "command" },
        });
        const reviewerId = TurnItemId.make("turn-item:reviewer");
        const reviewerRun = settledRun({
          ordinal: 3,
          providerThreadId: codexProviderThread.id,
          runningItem: { id: reviewerId, kind: "subagent" },
        });
        const otherProviderThreadId = ProviderThreadId.make("provider-thread:other");
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
              },
            },
            ...latestRun.events,
          ],
        });

        const failedRun = settledRun({ ordinal: 5, providerThreadId: otherProviderThreadId });
        if (failedStart) {
          yield* sink.write({
            events: failedRun.events.flatMap((event): Array<OrchestrationV2DomainEvent> => {
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
          });
        }

        yield* orchestrator.dispatch({
          type: "run.interrupt",
          commandId: CommandId.make("stop-background-work"),
          threadId,
          runId: failedStart ? failedRun.runId : latestRun.runId,
        });
        yield* worker.drain();

        // Stop reaches both provider threads. The Codex one is interrupted at
        // its latest pending work, the subagent's parent turn, so its settle
        // covers all three Codex runs.
        assert.sameDeepMembers(
          interrupts.map((interrupt) => [interrupt.providerThread.id, interrupt.providerTurnId]),
          [
            [otherProviderThreadId, latestRun.providerTurnId],
            [codexProviderThread.id, reviewerRun.providerTurnId],
          ],
        );
        const after = yield* orchestrator.getThreadProjection(threadId);
        assert.deepEqual(
          [devServerId, watcherId, reviewerId].map(
            (id) => after.turnItems.find((item) => item.id === id)?.status,
          ),
          ["interrupted", "interrupted", "interrupted"],
        );
      }).pipe(
        Effect.provide(
          makeOrchestratorV2ReplayLayerWithRegistry(
            { name: "background-work-stop" },
            ProviderAdapterRegistry.makeSingleLayer(adapter),
            { runEffectWorker: false },
          ),
        ),
      );
    }),
  );

it.effect("Stop reaches background work an earlier provider thread still runs", () =>
  stopEarlierBackgroundWork(false),
);

it.effect(
  "Stop reaches earlier background work after the newest run fails before provider start",
  () => stopEarlierBackgroundWork(true),
);
