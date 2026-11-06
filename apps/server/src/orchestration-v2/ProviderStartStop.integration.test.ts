import { assert, it, vi } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  ThreadId,
  type OrchestrationV2ProviderTurn,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as RunExecutionService from "./RunExecutionService.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";

it.effect.each([
  "succeeded",
  "pending-ingestion",
  "accepted-start-error",
  "queued-promotion",
  "before-ownership",
  "interrupt-error",
  "interrupt-timeout",
  "identity-timeout",
  "identity-timeout-force",
  "unsupported-compact",
  "prompt-refusal",
  "attachment-refusal",
  "manager-release",
  "manager-release-interrupt",
  "provider-stopped",
  "stream-ended",
  "released-before-subscribe",
  "released-during-subscribe",
] as const)("Stop crosses native start: %s", (scenario) =>
  Effect.scoped(
    Effect.gen(function* () {
      const scope = yield* Effect.scope;
      const cwd = yield* checkpointWorkspace(`start-stop-${scenario}`);
      const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event, Cause.Done>();
      const entered = yield* Deferred.make<void>();
      const accept = yield* Deferred.make<void>();
      const nativeAccepted = yield* Deferred.make<void>();
      const releaseIdentity = yield* Deferred.make<void>();
      const releaseStart = yield* Deferred.make<void>();
      const snapshotted = yield* Deferred.make<void>();
      const releaseSnapshot = yield* Deferred.make<void>();
      const ingestionHeld = yield* Deferred.make<void>();
      const releaseIngestion = yield* Deferred.make<void>();
      const interruptCalled = yield* Deferred.make<void>();
      const interruptCancelled = yield* Deferred.make<void>();
      const releaseTerminal = yield* Deferred.make<void>();
      const ownedWait = yield* Deferred.make<void>();
      const beforeOwnership = yield* Deferred.make<void>();
      const closeHeld = yield* Deferred.make<void>();
      const releaseClose = yield* Deferred.make<void>();
      const lateSubscribed = yield* Deferred.make<void>();
      const lateSubscriptionClosed = yield* Deferred.make<void>();
      const lateSubscription =
        scenario === "released-before-subscribe" || scenario === "released-during-subscribe";
      const driver = ProviderDriverKind.make("codex");
      const instanceId = ProviderInstanceId.make("codex");
      const modelSelection = { instanceId, model: "synthetic" };
      const threadId = ThreadId.make(`thread:start-stop:${scenario}`);
      const interrupts: ProviderTurnId[] = [];
      const milestones: string[] = [];
      let active: OrchestrationV2ProviderTurn | undefined;
      let starts = 0;
      const startPending =
        scenario !== "succeeded" &&
        scenario !== "queued-promotion" &&
        scenario !== "accepted-start-error";
      const identityDelayed =
        scenario === "identity-timeout" || scenario === "identity-timeout-force";
      const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
        instanceId,
        driver,
        getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
        planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
        openSession: (input) =>
          Effect.gen(function* () {
            if (scenario === "released-during-subscribe")
              yield* Effect.addFinalizer(() =>
                Deferred.succeed(closeHeld, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseClose)),
                ),
              );
            const now = yield* DateTime.now;
            const startTurn: ProviderAdapter.ProviderAdapterV2SessionRuntime["startTurn"] = (
              turn,
            ) =>
              Effect.gen(function* () {
                if (scenario === "prompt-refusal" || scenario === "attachment-refusal") {
                  return yield* new ProviderAdapter.ProviderAdapterTurnStartError({
                    driver,
                    threadId: turn.threadId,
                    providerThreadId: turn.providerThread.id,
                    runId: turn.runId,
                    cause:
                      scenario === "attachment-refusal"
                        ? new ProviderAdapter.ProviderAdapterProtocolError({
                            driver,
                            reason: "attachment_unreadable",
                            detail: "Synthetic unreadable attachment before prompt delivery",
                          })
                        : {
                            _tag: "ClaudeAppendSystemPromptFileError",
                            path: "/task-owned/missing-file",
                          },
                  });
                }
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(accept);
                assert.isUndefined(active, "native turns must never overlap");
                starts++;
                active = {
                  id: ProviderTurnId.make(`native-turn:${turn.attemptId}`),
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
                milestones.push(`accepted:${active.id}`);
                yield* Deferred.succeed(nativeAccepted, undefined);
                if (identityDelayed) yield* Deferred.await(releaseIdentity);
                // Another attempt and a sibling on this same session cannot supply our identity.
                if (starts === 1) {
                  yield* Queue.offer(events, {
                    type: "provider_turn.updated",
                    driver,
                    providerTurn: {
                      ...active,
                      id: ProviderTurnId.make("foreign:old"),
                      runAttemptId: RunAttemptId.make("foreign:old"),
                    },
                  });
                  yield* Queue.offer(events, {
                    type: "provider_turn.updated",
                    driver,
                    providerTurn: {
                      ...active,
                      id: ProviderTurnId.make("foreign:sibling"),
                      providerThreadId: ProviderThreadId.make("foreign:sibling"),
                      runAttemptId: RunAttemptId.make("foreign:sibling"),
                    },
                  });
                }
                yield* Queue.offer(events, {
                  type: "provider_turn.updated",
                  driver,
                  providerTurn: active,
                });
                if (scenario === "accepted-start-error" && starts === 1)
                  return yield* new ProviderAdapter.ProviderAdapterTurnStartError({
                    driver,
                    threadId: turn.threadId,
                    providerThreadId: turn.providerThread.id,
                    runId: turn.runId,
                    cause: "synthetic lost start response after acceptance",
                  });
                if (startPending && starts === 1) yield* Deferred.await(releaseStart);
              });
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
                model: "synthetic",
                capabilities: CodexProviderCapabilitiesV2,
                createdAt: now,
                updatedAt: now,
                lastError: null,
              },
              events: Stream.fromQueue(events),
              ensureThread: ({ threadId }) =>
                Effect.succeed({
                  id: ProviderThreadId.make(`provider:${threadId}`),
                  driver,
                  providerInstanceId: instanceId,
                  providerSessionId: input.providerSessionId,
                  appThreadId: threadId,
                  ownerNodeId: null,
                  nativeThreadRef: { driver, nativeId: "synthetic-thread", strength: "strong" },
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
              startTurn,
              compactThread: startTurn,
              interruptTurn: (target) =>
                Effect.gen(function* () {
                  interrupts.push(target.providerTurnId);
                  assert.equal(
                    target.providerTurnId,
                    active?.id,
                    "interrupt must target the accepted native identity",
                  );
                  assert.isTrue(target.requestRuntimeRestart);
                  milestones.push(`interrupt:${target.providerTurnId}`);
                  yield* Deferred.succeed(interruptCalled, undefined);
                  if (scenario === "interrupt-error")
                    return yield* new ProviderAdapter.ProviderAdapterInterruptError({
                      driver,
                      providerThreadId: target.providerThread.id,
                      providerTurnId: target.providerTurnId,
                      cause: "synthetic interrupt rejection",
                    });
                  if (scenario === "interrupt-timeout")
                    return yield* Effect.never.pipe(
                      Effect.ensuring(Deferred.succeed(interruptCancelled, undefined)),
                    );
                  yield* Deferred.await(releaseTerminal);
                  const turn = active!;
                  active = undefined;
                  const completedAt = yield* DateTime.now;
                  yield* Queue.offer(events, {
                    type: "provider_turn.updated",
                    driver,
                    providerTurn: { ...turn, status: "interrupted", completedAt },
                  });
                  yield* Queue.offer(events, {
                    type: "turn.terminal",
                    driver,
                    providerThreadId: turn.providerThreadId,
                    providerTurnId: turn.id,
                    runOrdinal: 1,
                    status: "interrupted",
                    failure: null,
                    threadDisposition: "reusable",
                  });
                }),
              steerTurn: () => Effect.die("unused"),
              respondToRuntimeRequest: () => Effect.die("unused"),
              readThreadSnapshot: () => Effect.die("unused"),
              rollbackThread: () => Effect.die("unused"),
              forkThread: () => Effect.die("unused"),
            };
          }),
      };
      const databaseLayer = SqlitePersistence.layerMemory;
      const base = Layer.mergeAll(
        ProviderReplayHarness.layerWithRegistry(
          { name: `start-stop-${scenario}` },
          ProviderAdapterRegistry.layerFromAdapters([adapter]),
          { runEffectWorker: false, databaseLayer },
        ),
        ProjectionStore.layer.pipe(Layer.provide(databaseLayer)),
        EffectOutbox.layer.pipe(Layer.provide(databaseLayer)),
        CommandReceiptStore.layer.pipe(Layer.provide(databaseLayer)),
        ServerSettings.layerTest(),
      );
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const store = yield* ProjectionStore.ProjectionStoreV2;
        const sink = yield* EventSink.EventSinkV2;
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        const execution = yield* RunExecutionService.RunExecutionServiceV2;
        const threads = yield* ThreadManagementService.ThreadManagementService;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("create"),
          threadId,
          projectId: ProjectId.make("project:start-stop"),
          title: "Synthetic acceptance race",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: cwd,
          createdBy: "user",
          creationSource: "web",
        });
        const send = (id: string, queued = false) =>
          orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(id),
            threadId,
            messageId: MessageId.make(id),
            text: queued ? "/goal ship it" : id,
            attachments: [],
            dispatchMode: { type: queued ? "queue_after_active" : "start_immediately" },
            createdBy: "user",
            creationSource: "web",
          });
        const originalStart = execution.startRootRun;
        let staleInput: RunExecutionService.RunExecutionServiceV2StartRootRunInput | undefined;
        using _beforeOwnership = vi.spyOn(execution, "startRootRun").mockImplementation((input) => {
          if (lateSubscription)
            return Effect.gen(function* () {
              const released = yield* manager
                .release({ providerSessionId: input.providerSessionId, reason: "manual_shutdown" })
                .pipe(Effect.orDie, Effect.forkIn(scope));
              if (scenario === "released-before-subscribe") yield* Fiber.join(released);
              else yield* Deferred.await(closeHeld);
              const startup = yield* originalStart({
                ...input,
                session: {
                  ...input.session,
                  subscribeEvents: input.session.subscribeEvents!.pipe(
                    Effect.map((subscription) => ({
                      ...subscription,
                      close: subscription.close.pipe(
                        Effect.tap(() => Deferred.succeed(lateSubscriptionClosed, undefined)),
                      ),
                    })),
                    Effect.tap(() => Deferred.succeed(lateSubscribed, undefined)),
                  ),
                },
              }).pipe(Effect.forkIn(scope));
              yield* Deferred.await(lateSubscribed);
              yield* Deferred.succeed(releaseClose, undefined);
              yield* Fiber.join(released);
              yield* Fiber.join(startup);
            });
          if (scenario === "unsupported-compact") {
            const session = { ...input.session };
            delete session.compactThread;
            return originalStart({
              ...input,
              message: { ...input.message, text: "/compact" },
              session,
            });
          }
          if (scenario !== "before-ownership") return originalStart(input);
          staleInput = input;
          return Deferred.succeed(beforeOwnership, undefined).pipe(Effect.andThen(Effect.never));
        });
        const originalWrite = sink.write;
        using _ingestion = vi.spyOn(sink, "write").mockImplementation((input) => {
          const hold =
            scenario === "pending-ingestion" &&
            input.events.some(
              (event) =>
                event.type === "provider-turn.updated" && event.payload.status === "running",
            );
          return (
            hold
              ? Deferred.succeed(ingestionHeld, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseIngestion)),
                )
              : Effect.void
          ).pipe(Effect.andThen(originalWrite(input)));
        });
        yield* send("first");
        const startup = yield* worker.drain(1).pipe(Effect.forkScoped);
        if (
          scenario === "unsupported-compact" ||
          scenario === "prompt-refusal" ||
          scenario === "attachment-refusal" ||
          lateSubscription
        ) {
          yield* Fiber.join(startup);
          const failed = yield* orchestrator.getThreadProjection(threadId);
          const run = failed.runs[0]!;
          assert.equal(run.status, "failed");
          assert.equal(failed.attempts[0]?.status, "failed");
          assert.equal(failed.nodes.find((node) => node.id === run.rootNodeId)?.status, "failed");
          assert.isTrue(
            Option.isNone(
              yield* execution.getStartOwnership({
                threadId,
                runId: run.id,
                attemptId: run.activeAttemptId!,
              }),
            ),
          );
          assert.equal(starts, 0);
          assert.deepEqual(interrupts, []);
          if (lateSubscription) assert.isTrue(yield* Deferred.isDone(lateSubscriptionClosed));
          return;
        }
        if (scenario === "before-ownership") {
          yield* Deferred.await(beforeOwnership);
          const pending = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
          const missing = yield* execution
            .interruptOwnedStart({
              threadId,
              runId: pending.id,
              attemptId: pending.activeAttemptId!,
            })
            .pipe(Effect.flip);
          assert.isFalse(missing.unresponsive);
          assert.nestedPropertyVal(missing, "cause._tag", "NativeStartOwnershipError");
          assert.nestedPropertyVal(missing, "cause.state", "missing");
          assert.nestedPropertyVal(missing, "cause.threadId", threadId);
          assert.nestedPropertyVal(missing, "cause.runId", pending.id);
          assert.nestedPropertyVal(missing, "cause.attemptId", pending.activeAttemptId);
          yield* orchestrator.dispatch({
            type: "thread.stop",
            commandId: CommandId.make("stop"),
            threadId,
          });
          yield* Fiber.join(startup);
          assert.equal(
            (yield* orchestrator.getThreadProjection(threadId)).runs[0]?.status,
            "interrupted",
          );
          yield* originalStart(staleInput!);
          assert.equal(starts, 0);
          return;
        }
        yield* Deferred.await(entered);
        milestones.push("entered");
        if (scenario === "queued-promotion") yield* send("promoted", true);
        const initial = yield* orchestrator.getThreadProjection(threadId);
        const run = initial.runs.find((run) => run.status === "running")!;
        if (
          [
            "manager-release",
            "manager-release-interrupt",
            "provider-stopped",
            "stream-ended",
          ].includes(scenario)
        ) {
          const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
          const providerSessionId = initial.providerThreads.find(
            (thread) => thread.id === run.providerThreadId,
          )!.providerSessionId!;
          const runtime = Option.getOrThrow(yield* manager.get(providerSessionId));
          if (scenario === "manager-release-interrupt") {
            const accepted = yield* orchestrator.streamDomainEvents.pipe(
              Stream.filter(
                (event) =>
                  event.type === "provider-turn.updated" && event.payload.status === "running",
              ),
              Stream.take(1),
              Stream.runDrain,
              Effect.forkScoped,
            );
            yield* Deferred.succeed(accept, undefined);
            yield* Fiber.join(accepted);
          }
          const waiter = yield* Deferred.succeed(ownedWait, undefined).pipe(
            Effect.andThen(
              execution.interruptOwnedStart({
                threadId,
                runId: run.id,
                attemptId: run.activeAttemptId!,
              }),
            ),
            Effect.forkScoped,
          );
          yield* Deferred.await(ownedWait);
          if (scenario === "manager-release-interrupt") yield* Deferred.await(interruptCalled);
          if (scenario === "provider-stopped" || scenario === "stream-ended") {
            if (scenario === "provider-stopped")
              yield* Queue.offer(events, {
                type: "provider_session.updated",
                driver,
                providerSession: { ...runtime.providerSession, status: "stopped" },
              });
            yield* Queue.end(events);
          } else {
            yield* manager.release({ providerSessionId, reason: "manual_shutdown" });
          }
          yield* Fiber.join(waiter);
          yield* Fiber.join(startup);
          assert.isTrue(
            Option.isNone(
              yield* execution.getStartOwnership({
                threadId,
                runId: run.id,
                attemptId: run.activeAttemptId!,
              }),
            ),
          );
          const failed = yield* orchestrator.getThreadProjection(threadId);
          assert.equal(failed.runs[0]?.status, "failed");
          assert.equal(failed.attempts[0]?.status, "failed");
          assert.isFalse(failed.turnItems.some((item) => item.type === "run_interrupt_result"));
          yield* Deferred.succeed(accept, undefined);
          yield* Deferred.succeed(releaseStart, undefined);
          assert.equal(starts, scenario === "manager-release-interrupt" ? 1 : 0);
          return;
        }
        const original = store.getThreadRecords;
        let armed = true;
        using _snapshot = vi.spyOn(store, "getThreadRecords").mockImplementation((...args) =>
          original(...args).pipe(
            Effect.tap((snapshot) => {
              if (
                !armed ||
                !args[1].includes("providerTurns") ||
                !args[1].includes("attempts") ||
                args[1].includes("providerSessions") ||
                snapshot.providerTurns.length !== 0
              )
                return Effect.void;
              armed = false;
              return Deferred.succeed(snapshotted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseSnapshot)),
              );
            }),
          ),
        );
        const stop = yield* (
          scenario === "queued-promotion"
            ? orchestrator.dispatch({
                type: "queued-message.promote-to-steer",
                commandId: CommandId.make("stop"),
                threadId,
                queuedRunId: initial.runs.find((run) => run.status === "queued")!.id,
                targetRunId: run.id,
              })
            : orchestrator.dispatch({
                type: "thread.stop",
                commandId: CommandId.make("stop"),
                threadId,
              })
        ).pipe(Effect.forkScoped);
        yield* Deferred.await(snapshotted);
        milestones.push("snapshot");
        const accepted = yield* orchestrator.streamDomainEvents.pipe(
          Stream.filter(
            (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
        yield* Deferred.succeed(accept, undefined);
        yield* Deferred.await(nativeAccepted);
        if (!startPending) {
          yield* Fiber.join(startup);
          milestones.push("start-returned");
          yield* Fiber.join(accepted);
        } else if (scenario === "pending-ingestion") yield* Deferred.await(ingestionHeld);
        yield* Deferred.succeed(releaseSnapshot, undefined);
        yield* Fiber.join(stop);
        milestones.push(`stop-request:${run.id}`);
        if (startPending) yield* Fiber.join(startup);
        const stopping = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(
          stopping.runs.find((candidate) => candidate.id === run.id)?.status,
          "running",
          "Stop must not report terminal while the native turn is unresolved",
        );
        assert.isTrue(stopping.turnItems.some((item) => item.type === "run_interrupt_request"));
        assert.isFalse(stopping.turnItems.some((item) => item.type === "run_interrupt_result"));
        const stoppedNativeTurn = active!;
        const stopEffects = yield* outbox.listByCommandId(CommandId.make("stop"));
        assert.equal(
          stopEffects.filter((effect) => effect.request.type === "provider-turn.interrupt-start")
            .length,
          1,
        );
        const originalWait = execution.interruptOwnedStart;
        using _wait = vi
          .spyOn(execution, "interruptOwnedStart")
          .mockImplementation((key) =>
            Deferred.succeed(ownedWait, undefined).pipe(Effect.andThen(originalWait(key))),
          );
        const interrupt = yield* worker.drain(1).pipe(Effect.forkScoped);
        yield* Deferred.await(ownedWait);
        milestones.push("owned-wait");
        if (identityDelayed || scenario === "interrupt-timeout") {
          if (scenario === "interrupt-timeout") yield* Deferred.await(interruptCalled);
          yield* TestClock.adjust("15 seconds");
          yield* Fiber.join(interrupt);
          if (scenario === "interrupt-timeout") yield* Deferred.await(interruptCancelled);
          const unresolved = yield* orchestrator.getThreadProjection(threadId);
          assert.equal(unresolved.runs[0]?.status, "running");
          assert.isTrue(
            unresolved.turnItems.some(
              (item) => item.type === "run_interrupt_request" && item.unresponsiveAt !== undefined,
            ),
          );
          assert.isFalse(unresolved.turnItems.some((item) => item.type === "run_interrupt_result"));
          assert.isTrue(
            Option.isSome(
              yield* execution.getStartOwnership({
                threadId,
                runId: run.id,
                attemptId: run.activeAttemptId!,
              }),
            ),
          );
          if (scenario === "identity-timeout") {
            yield* Deferred.succeed(releaseIdentity, undefined);
            yield* Fiber.join(accepted);
            assert.deepEqual(interrupts, []);
            assert.equal(
              (yield* orchestrator.getThreadProjection(threadId)).runs[0]?.status,
              "running",
            );
          }
          if (scenario === "identity-timeout-force") {
            assert.deepEqual(interrupts, []);
            const outcome = yield* threads.forceStopThread({ threadId, runId: run.id });
            assert.equal(outcome.outcome, "released");
            assert.isTrue(
              Option.isNone(
                yield* execution.getStartOwnership({
                  threadId,
                  runId: run.id,
                  attemptId: run.activeAttemptId!,
                }),
              ),
            );
            const forced = yield* orchestrator.getThreadProjection(threadId);
            assert.equal(forced.runs[0]?.status, "interrupted");
            assert.isTrue(
              forced.turnItems.some(
                (item) =>
                  item.type === "run_interrupt_result" && item.message === "Force stopped by user",
              ),
            );
          }
          return;
        }
        yield* Deferred.await(interruptCalled);
        if (scenario === "interrupt-error") {
          yield* Fiber.join(interrupt);
          const row = (yield* outbox.listByCommandId(CommandId.make("stop"))).find(
            (effect) => effect.request.type === "provider-turn.interrupt-start",
          )!;
          assert.equal(row.status, "pending");
          assert.include(row.lastError!, "synthetic interrupt rejection");
          assert.equal(
            (yield* orchestrator.getThreadProjection(threadId)).runs[0]?.status,
            "running",
          );
          return;
        }
        assert.isTrue(
          Option.isSome(
            yield* execution.getStartOwnership({
              threadId,
              runId: run.id,
              attemptId: run.activeAttemptId!,
            }),
          ),
        );
        assert.equal(
          (yield* orchestrator.getThreadProjection(threadId)).runs.find(
            (candidate) => candidate.id === run.id,
          )?.status,
          "running",
        );
        assert.deepEqual(interrupts, [active!.id]);
        const terminal = yield* orchestrator.streamDomainEvents.pipe(
          Stream.filter(
            (event) =>
              event.type === "run.updated" &&
              event.payload.id === run.id &&
              event.payload.status === "interrupted",
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
        yield* Deferred.succeed(releaseIngestion, undefined);
        yield* Deferred.succeed(releaseTerminal, undefined);
        yield* Fiber.join(interrupt);
        yield* Fiber.join(terminal);
        yield* Fiber.join(accepted);
        milestones.push(`terminal:${run.id}`);
        yield* Deferred.succeed(releaseStart, undefined);
        if (scenario !== "queued-promotion") yield* send("replacement");
        const replacementAccepted = yield* orchestrator.streamDomainEvents.pipe(
          Stream.filter(
            (event) =>
              event.type === "provider-turn.updated" &&
              event.payload.status === "running" &&
              event.payload.runAttemptId !== run.activeAttemptId,
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
        yield* worker.drain();
        yield* Fiber.join(replacementAccepted);
        assert.equal(starts, 2);
        assert.isDefined(active);
        const replacementId = active!.id;
        if (scenario === "pending-ingestion") {
          const afterLateTerminal = yield* orchestrator.streamDomainEvents.pipe(
            Stream.filter(
              (event) =>
                event.type === "provider-turn.updated" && event.payload.id === replacementId,
            ),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
          yield* Queue.offer(events, {
            type: "provider_turn.updated",
            driver,
            providerTurn: {
              ...stoppedNativeTurn,
              status: "interrupted",
              completedAt: yield* DateTime.now,
            },
          });
          yield* Queue.offer(events, {
            type: "turn.terminal",
            driver,
            providerThreadId: stoppedNativeTurn.providerThreadId,
            providerTurnId: stoppedNativeTurn.id,
            runOrdinal: 1,
            status: "interrupted",
            failure: null,
            threadDisposition: "reusable",
          });
          yield* Queue.offer(events, {
            type: "provider_turn.updated",
            driver,
            providerTurn: active!,
          });
          yield* Fiber.join(afterLateTerminal);
        }
        assert.isUndefined(
          yield* execution.interruptOwnedStart({
            threadId,
            runId: run.id,
            attemptId: run.activeAttemptId!,
          }),
        );
        yield* execution.revokeOwnedStart({
          threadId,
          runId: run.id,
          attemptId: run.activeAttemptId!,
        });
        yield* orchestrator.dispatch({
          type: "run.interrupt.unresponsive",
          commandId: CommandId.make("stale-timeout"),
          threadId,
          runId: run.id,
          attemptId: run.activeAttemptId!,
        });
        yield* orchestrator.dispatch({
          type: "run.force-stop.settle",
          commandId: CommandId.make("stale-force"),
          threadId,
          runId: run.id,
          attemptId: run.activeAttemptId!,
          reason: "stale",
        });
        assert.equal(active!.id, replacementId);
        assert.equal(
          (yield* orchestrator.getThreadProjection(threadId)).runs.findLast(
            (candidate) => candidate.status === "running",
          )?.ordinal,
          2,
        );
        assert.equal(interrupts.length, 1);
        if (yield* Config.Boolean("T3_START_STOP_TRANSCRIPT").pipe(Config.withDefault(false)))
          yield* Effect.logInfo({ synthetic: true, scenario, milestones, starts, interrupts }).pipe(
            Effect.provide(Logger.layer([Logger.consoleJson])),
            Effect.provideService(References.MinimumLogLevel, "Info"),
          );
      }).pipe(Effect.provide(ThreadManagementService.layer.pipe(Layer.provideMerge(base))));
    }),
  ),
);
