import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as Orchestrator from "./Orchestrator.ts";
import {
  ProviderAdapterRuntimeRequestResponseError,
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
const requestId = RuntimeRequestId.make("request:question");
const requestNodeId = NodeId.make("node:question");
const requestItemId = TurnItemId.make("turn-item:question");
const question = { id: "next", header: "Next", question: "What next?", options: [] };

for (const session of ["bound", "detached"] as const) {
  it.effect(
    `an answer whose delivery fails for good is reported, with the session ${session}`,
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const cwd = yield* checkpointWorkspace(`runtime-request-delivery-${session}`);
          const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
          const started: ProviderAdapterV2TurnInput[] = [];
          let deliveryAttempts = 0;
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
                  // The turn starts and immediately asks the user a question it
                  // blocks on, as Claude's AskUserQuestion does.
                  startTurn: (turn) =>
                    Effect.gen(function* () {
                      started.push(turn);
                      const providerTurnId = ProviderTurnId.make(`provider-turn:${turn.attemptId}`);
                      const nativeItemRef = {
                        driver,
                        nativeId: "native-question",
                        strength: "strong" as const,
                      };
                      yield* Queue.offerAll(events, [
                        {
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
                            status: "running",
                            startedAt: now,
                            completedAt: null,
                          },
                        },
                        {
                          type: "node.updated",
                          driver,
                          node: {
                            id: requestNodeId,
                            threadId: turn.threadId,
                            runId: turn.runId,
                            parentNodeId: turn.rootNodeId,
                            rootNodeId: turn.rootNodeId,
                            kind: "user_input_request",
                            status: "waiting",
                            countsForRun: false,
                            providerThreadId: turn.providerThread.id,
                            providerTurnId,
                            nativeItemRef,
                            runtimeRequestId: requestId,
                            checkpointScopeId: null,
                            startedAt: now,
                            completedAt: null,
                          },
                        },
                        {
                          type: "runtime_request.updated",
                          driver,
                          runtimeRequest: {
                            id: requestId,
                            nodeId: requestNodeId,
                            providerTurnId,
                            nativeRequestRef: nativeItemRef,
                            kind: "user_input",
                            status: "pending",
                            responseCapability: {
                              type: "live",
                              providerSessionId: input.providerSessionId,
                            },
                            createdAt: now,
                            resolvedAt: null,
                          },
                        },
                        {
                          type: "turn_item.updated",
                          driver,
                          turnItem: {
                            id: requestItemId,
                            type: "user_input_request",
                            threadId: turn.threadId,
                            runId: turn.runId,
                            nodeId: requestNodeId,
                            providerThreadId: turn.providerThread.id,
                            providerTurnId,
                            nativeItemRef,
                            parentItemId: null,
                            ordinal: 0,
                            status: "waiting",
                            title: null,
                            startedAt: now,
                            completedAt: null,
                            updatedAt: now,
                            requestId,
                            questions: [question],
                          },
                        },
                      ]);
                    }),
                  steerTurn: () => Effect.void,
                  interruptTurn: () => Effect.void,
                  // Like a provider session that no longer holds the request,
                  // e.g. a second server's session for the same thread.
                  respondToRuntimeRequest: (response) =>
                    Effect.gen(function* () {
                      deliveryAttempts += 1;
                      return yield* new ProviderAdapterRuntimeRequestResponseError({
                        driver,
                        requestId: response.requestId,
                        cause: `No pending runtime request ${response.requestId}.`,
                      });
                    }),
                  readThreadSnapshot: () => Effect.die("unused"),
                  rollbackThread: () => Effect.die("unused"),
                  forkThread: () => Effect.die("unused"),
                };
              }),
          };
          yield* Effect.gen(function* () {
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
            const threadId = ThreadId.make(`thread:runtime-request-delivery-${session}`);
            const watch = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
              orchestrator.streamDomainEvents.pipe(
                Stream.filter(predicate),
                Stream.take(1),
                Stream.runDrain,
                Effect.forkScoped,
              );
            const snapshot = Effect.gen(function* () {
              const projection = yield* orchestrator.getThreadProjection(threadId);
              return {
                run: projection.runs[0],
                request: projection.runtimeRequests.find((row) => row.id === requestId),
                errors: projection.turnItems.filter((row) => row.type === "error"),
              };
            });
            // Runs one delivery attempt per step; retries back off below a second.
            const deliverUntil = (attempts: number) =>
              Effect.gen(function* () {
                yield* worker.drain();
                for (let step = 0; step < attempts; step += 1) {
                  if (deliveryAttempts >= attempts) break;
                  yield* TestClock.adjust("1 second");
                  yield* worker.drain();
                }
              });

            yield* orchestrator.dispatch({
              type: "thread.create",
              commandId: CommandId.make("create"),
              threadId,
              projectId: ProjectId.make("project:runtime-request-delivery"),
              title: "Undelivered answer",
              modelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: cwd,
              createdBy: "user",
              creationSource: "web",
            });
            const asked = yield* watch(
              (event) =>
                event.type === "runtime-request.updated" && event.payload.status === "pending",
            );
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
            yield* worker.drain();
            yield* Fiber.join(asked);

            yield* orchestrator.dispatch({
              type: "runtime-request.respond",
              commandId: CommandId.make("answer"),
              threadId,
              requestId,
              answers: { next: "Ship it" },
            });

            // Retries remain, so nothing is reported yet.
            yield* deliverUntil(4);
            assert.deepEqual((yield* snapshot).errors, []);

            if (session === "detached") {
              const request = (yield* snapshot).request!;
              assert.equal(request.responseCapability.type, "live");
              if (request.responseCapability.type === "live") {
                yield* orchestrator.dispatch({
                  type: "provider-session.detach",
                  commandId: CommandId.make("detach"),
                  threadId,
                  providerSessionId: request.responseCapability.providerSessionId,
                });
              }
            }
            yield* deliverUntil(5);
            yield* TestClock.adjust("1 minute");
            yield* worker.drain();
            assert.equal(deliveryAttempts, 5);
            const final = yield* snapshot;
            assert.equal(final.errors.length, 1);
            const error = final.errors[0]!;
            assert.equal(error.status, "failed");
            assert.equal(error.nodeId, requestNodeId);
            assert.equal(error.runId, started[0]!.runId);
            assert.equal(error.type === "error" ? error.failure.class : null, "transport_error");
            const requestNode = (yield* orchestrator.getThreadProjection(threadId)).nodes.find(
              (node) => node.id === requestNodeId,
            );
            assert.equal(error.providerThreadId, requestNode?.providerThreadId);
            assert.equal(error.providerTurnId, requestNode?.providerTurnId);

            // Replaying the failure, as recovery may, records nothing new.
            yield* orchestrator.dispatch({
              type: "runtime-request.delivery.fail",
              commandId: CommandId.make("answer:delivery-failed"),
              threadId,
              requestId,
            });
            assert.equal((yield* snapshot).errors.length, 1);
            // The answer stays recorded, and the run is not marked failed.
            assert.equal(final.request?.status, "resolved");
            assert.deepEqual(final.request?.answers, { next: "Ship it" });
            if (session === "bound") assert.equal(final.run?.status, "running");
          }).pipe(
            Effect.provide(
              makeOrchestratorV2ReplayLayerWithRegistry(
                { name: `runtime-request-delivery-${session}` },
                ProviderAdapterRegistry.makeSingleLayer(adapter),
                { runEffectWorker: false },
              ),
            ),
          );
        }),
      ),
  );
}
