import { assert, it } from "@effect/vitest";
import {
  CheckpointScopeId,
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as CheckpointService from "./CheckpointService.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as SqlClient from "effect/sql/SqlClient";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

it.effect(
  "checkpoint retry exhaustion and Stop recover the shared fake-provider path and held queue",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captureStarted = yield* Deferred.make<void>();
        let stopCapture = false;
        const driver = ProviderDriverKind.make("codex");
        const instanceId = ProviderInstanceId.make("codex");
        const modelSelection = { instanceId, model: "test-model" };
        const cwd = yield* checkpointWorkspace("checkpoint-exhaustion");
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

        const checkpointLayer = Layer.mock(CheckpointService.CheckpointServiceV2)({
          prepareRootRunScope: (input) =>
            Effect.succeed({
              id: CheckpointScopeId.make(`scope:${input.runId}`),
              ...input,
              runId: input.runId,
              nodeId: input.rootNodeId,
              parentScopeId: null,
              kind: "root_run" as const,
              ordinalWithinParent: 0,
              advancesAppRunCount: true,
            }),
          ensureScope: (scope) => Effect.succeed(scope),
          captureBaseline: () => Effect.void,
          materializeBaselineCheckpoint: ({ scope }) =>
            Effect.suspend(() =>
              stopCapture
                ? Deferred.succeed(captureStarted, undefined).pipe(Effect.andThen(Effect.never))
                : Effect.fail(
                    new CheckpointService.CheckpointCaptureError({
                      scopeId: scope.id,
                      cause: "synthetic capture failure",
                    }),
                  ),
            ),
        });
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const sink = yield* EventSink.EventSinkV2;
          const threadId = ThreadId.make("thread:checkpoint-exhaustion");
          const watch = (
            predicate: (event: import("@t3tools/contracts").OrchestrationV2DomainEvent) => boolean,
          ) =>
            Effect.gen(function* () {
              const afterSequence = yield* sink.latestSequence();
              return yield* sink.stream({ afterSequence }).pipe(
                Stream.map((stored) => stored.event),
                Stream.filter(predicate),
                Stream.take(1),
                Stream.runDrain,
                Effect.forkScoped,
              );
            });
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make("create"),
            threadId,
            projectId: ProjectId.make("project:checkpoint-exhaustion"),
            title: "Checkpoint exhaustion",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: cwd,
            createdBy: "user",
            creationSource: "web",
          });
          const send = (name: string, mode: "start_immediately" | "queue_after_active") =>
            orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make(name),
              threadId,
              messageId: MessageId.make(`message:${name}`),
              text: name,
              attachments: [],
              dispatchMode: { type: mode },
              createdBy: "user",
              creationSource: "web",
            });
          const running = yield* watch(
            (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
          );
          yield* send("first", "start_immediately");
          yield* worker.drain();
          yield* Fiber.join(running);
          yield* send("follow-up", "queue_after_active");
          const before = yield* orchestrator.getThreadProjection(threadId);
          const run = before.runs[0]!;
          const now = yield* DateTime.now;
          const queued = before.runs[1]!;
          // Reproduce messages already held by the user's earlier Stop attempt.
          yield* sink.write({
            events: [
              {
                id: EventId.make("held-queue"),
                type: "run.updated",
                threadId,
                runId: queued.id,
                occurredAt: now,
                payload: { ...queued, queueHeld: true },
              },
            ],
          });
          const finish = (projection: typeof before, target: typeof run) =>
            Effect.gen(function* () {
              const turn = projection.providerTurns.find(
                (candidate) => candidate.runAttemptId === target.activeAttemptId,
              )!;
              const waiting = yield* watch(
                (event) =>
                  event.type === "run.updated" &&
                  event.payload.id === target.id &&
                  event.payload.status === "waiting",
              );
              yield* Queue.offer(events, {
                type: "provider_turn.updated",
                driver,
                providerTurn: { ...turn, status: "completed", completedAt: now },
              });
              yield* Queue.offer(events, {
                type: "turn.terminal",
                driver,
                providerThreadId: turn.providerThreadId,
                providerTurnId: turn.id,
                runOrdinal: target.ordinal,
                status: "completed",
                failure: null,
                threadDisposition: "reusable",
              });
              yield* Fiber.join(waiting);
            });
          yield* finish(before, run);
          yield* worker.drain();
          assert.equal(
            (yield* orchestrator.getThreadProjection(threadId)).runs[0]?.status,
            "waiting",
          );
          yield* TestClock.adjust("1 minute");
          yield* worker.drain();
          const after = yield* orchestrator.getThreadProjection(threadId);
          assert.equal(after.runs[0]?.status, "failed");
          assert.equal(after.runs[0]?.checkpointId, null);
          const sql = yield* SqlClient.SqlClient;
          const rows = yield* sql<{
            status: string;
            attempt_count: number;
          }>`SELECT status, attempt_count FROM orchestration_v2_effect_outbox WHERE effect_type = 'checkpoint.capture'`;
          assert.deepEqual(rows, [{ status: "failed", attempt_count: 2 }]);
          assert.equal(after.runs[1]?.queueHeld, true);
          assert.equal(
            after.turnItems.find((item) => item.title === "Checkpoint capture failed")?.type,
            "system_notice",
          );
          const resumed = yield* watch(
            (event) =>
              event.type === "provider-turn.updated" &&
              event.payload.status === "running" &&
              event.payload.id !== before.providerTurns[0]?.id,
          );
          const promoted = yield* watch(
            (event) =>
              event.type === "run.updated" &&
              event.payload.ordinal === 2 &&
              event.payload.status === "starting",
          );
          yield* orchestrator.dispatch({
            type: "queue.resume",
            commandId: CommandId.make("resume"),
            threadId,
          });
          yield* Fiber.join(promoted);
          yield* worker.drain();
          yield* Fiber.join(resumed);
          assert.lengthOf(started, 2);
          assert.equal(
            (yield* orchestrator.getThreadProjection(threadId)).runs[1]?.status,
            "running",
          );
          yield* send("after-stop", "queue_after_active");
          const secondProjection = yield* orchestrator.getThreadProjection(threadId);
          const secondRun = secondProjection.runs[1]!;
          stopCapture = true;
          yield* finish(secondProjection, secondRun);
          const capturing = yield* worker.runOnce.pipe(Effect.forkScoped);
          yield* Deferred.await(captureStarted);
          yield* orchestrator.dispatch({
            type: "run.interrupt",
            commandId: CommandId.make("stop-checkpoint"),
            threadId,
            runId: secondRun.id,
            holdQueue: true,
          });
          yield* Fiber.join(capturing);
          assert.equal(
            (yield* orchestrator.getThreadProjection(threadId)).runs[1]?.status,
            "interrupted",
          );
          const stoppedRows = yield* sql<{
            status: string;
          }>`SELECT status FROM orchestration_v2_effect_outbox WHERE effect_id = ${`effect:checkpoint.capture:${secondRun.id}`}`;
          assert.deepEqual(stoppedRows, [{ status: "cancelled" }]);
          assert.lengthOf(
            interrupts,
            0,
            "Stop during checkpointing must not interrupt a finished provider turn",
          );
          const nextRunning = yield* watch(
            (event) =>
              event.type === "provider-turn.updated" &&
              event.payload.status === "running" &&
              event.payload.runAttemptId !== secondRun.activeAttemptId,
          );
          const nextPromoted = yield* watch(
            (event) =>
              event.type === "run.updated" &&
              event.payload.ordinal === 3 &&
              event.payload.status === "starting",
          );
          yield* orchestrator.dispatch({
            type: "queue.resume",
            commandId: CommandId.make("resume-after-stop"),
            threadId,
          });
          yield* Fiber.join(nextPromoted);
          yield* worker.drain();
          yield* Fiber.join(nextRunning);
          assert.lengthOf(started, 3);
        }).pipe(
          Effect.provide(
            ProviderReplayHarness.layerWithRegistry(
              { name: "checkpoint-exhaustion" },
              ProviderAdapterRegistry.layerSingle(adapter),
              {
                runEffectWorker: false,
                checkpointServiceLayer: checkpointLayer,
                effectWorkerOptions: { maxAttempts: 2 },
                databaseLayer: SqlitePersistence.layerMemory,
              },
            ).pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
          ),
        );
      }),
    ),
);
