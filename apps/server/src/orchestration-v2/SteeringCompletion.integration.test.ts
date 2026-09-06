import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
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
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { OrchestrationEffectWorkerV2 } from "./EffectWorker.ts";
import { OrchestratorV2 } from "./Orchestrator.ts";
import {
  ProviderAdapterSteerRunError,
  type ProviderAdapterV2Event,
  type ProviderAdapterV2Shape,
  type ProviderAdapterV2TurnInput,
} from "./ProviderAdapter.ts";
import { makeSingleLayer } from "./ProviderAdapterRegistry.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "./testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "./testkit/ReplayFixtureWorkspace.ts";

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "test-model" };

for (const timing of [
  "before delivery",
  "during delivery",
  "before dispatch",
  "after delivery",
] as const) {
  it.effect(`delivers steering as a follow-up when completion wins ${timing}`, () =>
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
          const orchestrator = yield* OrchestratorV2;
          const worker = yield* OrchestrationEffectWorkerV2;
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
            dispatchMode: { type: "steer_active", targetRunId: first.runId },
            createdBy: "user",
            creationSource: "web",
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
            return;
          }
          assert.equal(started.length, 2);
          assert.equal(started[1]?.message.messageId, messageId);
          assert.equal(started[1]?.message.text, "fix the popover");
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
            final.turnItems.filter(
              (item) => item.type === "user_message" && item.messageId === messageId,
            ).length,
            1,
          );
          yield* worker.drain();
          assert.equal(started.length, 2);
        }).pipe(
          Effect.provide(
            makeOrchestratorV2ReplayLayerWithRegistry(
              { name: `steering-completion-${timing}` },
              makeSingleLayer(adapter),
              { runEffectWorker: false },
            ),
          ),
        );
      }),
    ),
  );
}
