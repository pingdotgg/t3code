import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderTurn,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import type {
  ProviderAdapterV2,
  ProviderAdapterV2Event,
  ProviderAdapterV2InterruptInput,
} from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "test-model" };
const pullRequest = { host: "github.com", repository: "pingdotgg/t3code", number: 1 };
const layerDatabase = SqlitePersistence.layerMemory;

/**
 * A thread whose running turn started a background command, delegated a task,
 * and watches a pull request, then gets the Stop button's interrupt.
 * `settled` lets the turn end first, as when Stop comes from the Waiting strip.
 */
const stopWithBackgroundWork = (input: {
  readonly scope?: "turn";
  readonly providerKeepsBackgroundWork: boolean;
  readonly settled?: boolean;
  /** The provider session is gone by the time the interrupt runs. */
  readonly sessionLostBeforeInterrupt?: boolean;
  /** After the interrupt the provider reports no background work left, as a fallback to a full stop does. */
  readonly providerRunsNoBackgroundWork?: boolean;
}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace("turn-scoped-stop");
      const eventsByProviderThread = new Map<
        ProviderThreadId,
        Queue.Queue<ProviderAdapterV2Event>
      >();
      const interrupts: ProviderAdapterV2InterruptInput[] = [];
      const runningTurns = new Map<ProviderTurnId, OrchestrationV2ProviderTurn>();
      const capabilities = {
        ...CodexProviderCapabilitiesV2,
        turns: {
          ...CodexProviderCapabilitiesV2.turns,
          interruptKeepsBackgroundWork: input.providerKeepsBackgroundWork,
        },
      };
      const adapter: ProviderAdapterV2["Service"] = {
        instanceId,
        driver,
        getCapabilities: () => Effect.succeed(capabilities),
        planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
        openSession: (session) =>
          Effect.gen(function* () {
            const now = yield* DateTime.now;
            const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
            return {
              instanceId,
              driver,
              providerSessionId: session.providerSessionId,
              providerSession: {
                id: session.providerSessionId,
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
              ...(input.providerRunsNoBackgroundWork === true
                ? { hasPendingBackgroundWorkForThread: () => Effect.succeed(false) }
                : {}),
              ensureThread: ({ threadId }) =>
                Effect.succeed({
                  id: ProviderThreadId.make(`provider-thread:codex:${threadId}`),
                  driver,
                  providerInstanceId: instanceId,
                  providerSessionId: session.providerSessionId,
                  appThreadId: threadId,
                  ownerNodeId: null,
                  nativeThreadRef: { driver, nativeId: `native:${threadId}`, strength: "strong" },
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
                  const providerTurn: OrchestrationV2ProviderTurn = {
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
                  };
                  runningTurns.set(providerTurn.id, providerTurn);
                  eventsByProviderThread.set(turn.providerThread.id, events);
                  yield* Queue.offer(events, {
                    type: "provider_turn.updated",
                    driver,
                    providerTurn,
                  });
                }),
              steerTurn: () => Effect.die("unused"),
              // Ends a running turn as interrupted; a settled one has nothing left here.
              interruptTurn: (interrupt) =>
                Effect.gen(function* () {
                  interrupts.push(interrupt);
                  const providerTurn = runningTurns.get(interrupt.providerTurnId);
                  if (providerTurn === undefined) return;
                  runningTurns.delete(providerTurn.id);
                  const completedAt = yield* DateTime.now;
                  yield* Queue.offer(events, {
                    type: "provider_turn.updated",
                    driver,
                    providerTurn: { ...providerTurn, status: "interrupted", completedAt },
                  });
                  yield* Queue.offer(events, {
                    type: "turn.terminal",
                    driver,
                    providerThreadId: providerTurn.providerThreadId,
                    providerTurnId: providerTurn.id,
                    runOrdinal: providerTurn.ordinal,
                    status: "interrupted",
                    failure: null,
                    threadDisposition: "reusable",
                    ...(interrupt.keepBackgroundWork === true
                      ? { backgroundWorkContinues: true }
                      : {}),
                  });
                }),
              respondToRuntimeRequest: () => Effect.die("unused"),
              readThreadSnapshot: () => Effect.die("unused"),
              rollbackThread: () => Effect.die("unused"),
              forkThread: () => Effect.die("unused"),
            };
          }),
      };
      return yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const sink = yield* EventSink.EventSinkV2;
        const sql = yield* SqlClient.SqlClient;
        const threadId = ThreadId.make("thread:turn-scoped-stop");
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
          projectId: ProjectId.make("project:turn-scoped-stop"),
          title: "Turn-scoped stop",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: cwd,
          createdBy: "user",
          creationSource: "web",
        });
        yield* orchestrator.dispatch({
          type: "thread.pull-request.watch",
          commandId: CommandId.make("watch"),
          threadId,
          ...pullRequest,
          watching: true,
          link: { url: "https://github.com/pingdotgg/t3code/pull/1", source: "agent" },
        });
        const running = yield* watch(
          (event) =>
            event.type === "provider-turn.updated" &&
            event.threadId === threadId &&
            event.payload.status === "running",
        );
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("start"),
          threadId,
          messageId: MessageId.make("message:start"),
          text: "Start the dev server and review the change",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.drain();
        yield* Fiber.join(running);
        const started = yield* orchestrator.getThreadProjection(threadId);
        const run = started.runs[0]!;
        const providerTurn = started.providerTurns[0]!;
        const devServerId = TurnItemId.make("turn-item:dev-server");
        const now = yield* DateTime.now;
        yield* sink.write({
          events: [
            {
              id: EventId.make("dev-server"),
              type: "turn-item.updated",
              threadId,
              runId: run.id,
              occurredAt: now,
              payload: {
                id: devServerId,
                threadId,
                runId: run.id,
                nodeId: run.rootNodeId,
                providerThreadId: providerTurn.providerThreadId,
                providerTurnId: providerTurn.id,
                nativeItemRef: null,
                parentItemId: null,
                ordinal: 100,
                status: "running",
                title: null,
                startedAt: now,
                completedAt: null,
                updatedAt: now,
                type: "command_execution",
                input: "vp run dev",
              },
            },
          ],
        });
        yield* orchestrator.dispatch({
          type: "delegated_task.request",
          commandId: CommandId.make("delegate"),
          parentThreadId: threadId,
          parentRunId: run.id,
          parentNodeId: run.rootNodeId!,
          task: "Review the change",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          completionWake: "always",
          createdBy: "agent",
          creationSource: "mcp",
        });
        yield* worker.drain();

        if (input.settled === true) {
          const waiting = yield* watch(
            (event) =>
              event.type === "run.updated" &&
              event.payload.id === run.id &&
              event.payload.status === "waiting",
          );
          const events = eventsByProviderThread.get(providerTurn.providerThreadId)!;
          runningTurns.delete(providerTurn.id);
          yield* Queue.offer(events, {
            type: "provider_turn.updated",
            driver,
            providerTurn: { ...providerTurn, status: "completed", completedAt: now },
          });
          yield* Queue.offer(events, {
            type: "turn.terminal",
            driver,
            providerThreadId: providerTurn.providerThreadId,
            providerTurnId: providerTurn.id,
            runOrdinal: run.ordinal,
            status: "completed",
            failure: null,
            threadDisposition: "reusable",
          });
          yield* Fiber.join(waiting);
          yield* worker.drain();
        }

        yield* orchestrator.dispatch({
          type: "run.interrupt",
          commandId: CommandId.make("stop"),
          threadId,
          runId: run.id,
          holdQueue: true,
          ...(input.scope === undefined ? {} : { scope: input.scope }),
        });
        if (input.sessionLostBeforeInterrupt === true) {
          const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
          yield* sessions.release({
            providerSessionId: started.providerThreads[0]!.providerSessionId!,
            reason: "runtime_error",
          });
        }
        yield* worker.drain();

        const after = yield* orchestrator.getThreadProjection(threadId);
        const stopEffects = yield* sql<{ readonly effect_type: string }>`
          SELECT effect_type FROM orchestration_v2_effect_outbox WHERE command_id = 'stop'
        `;
        return {
          interrupt: interrupts
            .filter((interrupt) => interrupt.providerThread.id === providerTurn.providerThreadId)
            .map(({ keepBackgroundWork, requestRuntimeRestart }) => ({
              keepBackgroundWork,
              requestRuntimeRestart,
            })),
          run: after.runs[0]?.status,
          devServer: after.turnItems.find((item) => item.id === devServerId)?.status,
          watched: (after.thread.pullRequests ?? []).some((link) => link.watch !== undefined),
          stopsDelegatedTasks: stopEffects.some(
            (row) => row.effect_type === "delegated-tasks.stop",
          ),
          delegatedWake: after.subagents[0]?.completionDelivery?.state ?? null,
          // The Waiting strip lists a delegated task through this item.
          delegatedItem: after.turnItems.find(
            (item) => item.type === "subagent" && item.origin === "app_owned",
          )?.status,
        };
      }).pipe(
        Effect.provide(
          Layer.merge(
            layerDatabase,
            ProviderReplayHarness.layerWithRegistry(
              { name: "turn-scoped-stop" },
              ProviderAdapterRegistry.layerSingle(adapter),
              { databaseLayer: layerDatabase, runEffectWorker: false },
            ),
          ),
        ),
      );
    }),
  );

it.effect("a turn-scoped Stop ends only the turn when its provider keeps background work", () =>
  Effect.gen(function* () {
    assert.deepEqual(
      yield* stopWithBackgroundWork({ scope: "turn", providerKeepsBackgroundWork: true }),
      {
        interrupt: [{ keepBackgroundWork: true, requestRuntimeRestart: undefined }],
        run: "interrupted",
        devServer: "running",
        watched: true,
        stopsDelegatedTasks: false,
        delegatedWake: null,
        delegatedItem: "running",
      },
    );
  }),
);

it.effect(
  "a turn-scoped Stop keeps delegated tasks and watches when its provider ends background work with the turn",
  () =>
    Effect.gen(function* () {
      assert.deepEqual(
        yield* stopWithBackgroundWork({ scope: "turn", providerKeepsBackgroundWork: false }),
        {
          interrupt: [{ keepBackgroundWork: undefined, requestRuntimeRestart: true }],
          run: "interrupted",
          devServer: "interrupted",
          watched: true,
          stopsDelegatedTasks: false,
          delegatedWake: null,
          delegatedItem: "running",
        },
      );
    }),
);

it.effect("a Stop without a scope still ends everything, as older clients send it", () =>
  Effect.gen(function* () {
    assert.deepEqual(yield* stopWithBackgroundWork({ providerKeepsBackgroundWork: true }), {
      interrupt: [{ keepBackgroundWork: undefined, requestRuntimeRestart: true }],
      run: "interrupted",
      devServer: "interrupted",
      watched: false,
      stopsDelegatedTasks: true,
      delegatedWake: "disposed",
      delegatedItem: "interrupted",
    });
  }),
);

it.effect("a turn-scoped Stop ends the background work of a provider session that died", () =>
  Effect.gen(function* () {
    const stopped = yield* stopWithBackgroundWork({
      scope: "turn",
      providerKeepsBackgroundWork: true,
      sessionLostBeforeInterrupt: true,
    });
    assert.deepEqual(stopped.interrupt, []);
    assert.equal(stopped.devServer, "interrupted");
  }),
);

it.effect("a turn-scoped Stop ends the background work its provider no longer runs", () =>
  Effect.gen(function* () {
    const stopped = yield* stopWithBackgroundWork({
      scope: "turn",
      providerKeepsBackgroundWork: true,
      providerRunsNoBackgroundWork: true,
    });
    assert.deepEqual(stopped.interrupt, [
      { keepBackgroundWork: true, requestRuntimeRestart: undefined },
    ]);
    assert.equal(stopped.devServer, "interrupted");
    assert.isTrue(stopped.watched);
    assert.isFalse(stopped.stopsDelegatedTasks);
    assert.equal(stopped.delegatedItem, "running");
  }),
);

it.effect("a turn-scoped Stop of a settled turn ends its background work", () =>
  Effect.gen(function* () {
    assert.deepEqual(
      yield* stopWithBackgroundWork({
        scope: "turn",
        providerKeepsBackgroundWork: true,
        settled: true,
      }),
      {
        interrupt: [{ keepBackgroundWork: undefined, requestRuntimeRestart: true }],
        run: "completed",
        devServer: "interrupted",
        watched: false,
        stopsDelegatedTasks: true,
        delegatedWake: "disposed",
        delegatedItem: "interrupted",
      },
    );
  }),
);
