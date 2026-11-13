// ACP session runtime handlers extracted from server/adapter.ts (part 1).

import {
  acpSubagentHasPendingBackgroundWork,
  ACP_STOP_CONFIRM_TIMEOUT_MS,
} from "./acpTurnModel.ts";
import { makeProviderThread, nativeThreadId, STEER_DELIVERY_BOUND } from "./acpThreadContext.ts";
import { type OrchestrationV2ProviderThread, type ModelSelection } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import type { AcpSessionContext } from "./acpSessionContext.ts";

export const createAcpSessionRuntimeHandlers = (
  ctx: AcpSessionContext,
): Omit<
  ProviderAdapter.ProviderAdapterV2SessionRuntime,
  "respondToRuntimeRequest" | "readThreadSnapshot" | "rollbackThread" | "forkThread"
> => {
  const runtimeObject: Omit<
  ProviderAdapter.ProviderAdapterV2SessionRuntime,
  "respondToRuntimeRequest" | "readThreadSnapshot" | "rollbackThread" | "forkThread"
> = {
    instanceId: ctx.options.instanceId,
    driver: ctx.driver,
    providerSessionId: ctx.input.providerSessionId,
    providerSession: ctx.providerSession,
    events: Stream.fromEffectRepeat(Queue.take(ctx.events)),
    ...(ctx.flavor.getModelContextWindow === undefined
      ? {}
      : {
          getModelContextWindow: (selection) => {
            const session = Ref.getUnsafe(ctx.activeSessionSetup);
            return session === null
              ? undefined
              : ctx.flavor.getModelContextWindow?.(selection, session);
          },
        }),
    ...(ctx.postSettleContinuationEnabled || ctx.followsAgentWorkState
      ? {
          hasPendingBackgroundWork: Effect.gen(function* () {
            const rootSessionId = yield* Ref.get(ctx.activeSessionId);
            if (
              ctx.followsAgentWorkState &&
              rootSessionId !== null &&
              ctx.hasWorkingDescendant(rootSessionId)
            )
              return true;
            if (
              ctx.followsAgentWorkState &&
              (ctx.agentWork?.state === "running" ||
                ctx.agentWork?.state === "requires_action" ||
                ctx.agentRequests.size > 0)
            )
              return true;
            if ((yield* Ref.get(ctx.wakeBuffer)).length > 0) return true;
            if (yield* Ref.get(ctx.continuationRequested)) return true;
            if ((yield* Ref.get(ctx.runningBackgroundTaskIds)).size > 0) return true;
            const active = yield* Ref.get(ctx.activeTurn);
            if (
              active !== null &&
              [...active.subagents.values()].some(acpSubagentHasPendingBackgroundWork)
            ) {
              return true;
            }
            const carryover = yield* Ref.get(ctx.carryoverSubagents);
            if (
              carryover !== null &&
              carryover.subagents.some(acpSubagentHasPendingBackgroundWork)
            ) {
              return true;
            }
            return false;
          }),
        }
      : {}),
    ensureThread: Effect.fn("AcpAdapterV2.ensureThread")(
      function* (threadInput: ProviderAdapter.ProviderAdapterV2EnsureThreadInput) {
        return yield* ctx.runtimeTransitionPermit.withPermit(
          Effect.gen(function* () {
            if (threadInput.forceNewNativeThread) {
              const currentTurn = yield* Ref.get(ctx.activeTurn);
              const pendingWork = yield* (
                runtimeObject.hasPendingBackgroundWork ?? Effect.succeed(false)
              );
              if (currentTurn !== null || pendingWork)
                return yield* new ProviderAdapter.ProviderAdapterProtocolError({
                  driver: ctx.driver,
                  detail:
                    "Cannot replace ACP session while a turn or background work is active",
                });
              yield* ctx.awaitRuntimeTeardown();
              const previousItemIdentityVersion = ctx.itemIdentityVersion;
              ctx.itemIdentityVersion = 2;
              ctx.prepareTerminalEnvironment(yield* ctx.readMcpContext(threadInput.threadId));
              yield* ctx.startReplacementAcpRuntime(threadInput.threadId, (candidate) =>
                ctx.commitReplacementSession(threadInput.threadId, candidate),
              ).pipe(
                Effect.tapError(() =>
                  Effect.sync(() => {
                    ctx.itemIdentityVersion = previousItemIdentityVersion;
                  }),
                ),
              );
            }
            const now = yield* DateTime.now;
            const sessionId = yield* Ref.get(ctx.activeSessionId);
            if (sessionId === null) {
              return yield* new ProviderAdapter.ProviderAdapterProtocolError({
                driver: ctx.driver,
                detail: "ACP runtime did not produce a session id",
              });
            }
            const created = makeProviderThread({
              driver: ctx.driver,
              providerInstanceId: ctx.options.instanceId,
              idAllocator: ctx.idAllocator,
              appThreadId: threadInput.threadId,
              providerSessionId: ctx.input.providerSessionId,
              nativeThreadId: sessionId,
              ...(ctx.itemIdentityVersion === undefined ? {} : { itemIdentityVersion: ctx.itemIdentityVersion }),
              now,
            });
            const providerThread =
              threadInput.forceNewNativeThread && threadInput.existingProviderThread
                ? { ...created, id: threadInput.existingProviderThread.id }
                : created;
            yield* Ref.update(ctx.providerThreadByNativeSessionId, (current) =>
              new Map(current).set(sessionId, providerThread),
            );
            return providerThread;
          }),
        );
      },
      (effect, threadInput) =>
        effect.pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapter.ProviderAdapterEnsureThreadError({
                driver: ctx.driver,
                threadId: threadInput.threadId,
                cause,
              }),
          ),
        ),
    ),
    resumeThread: Effect.fn("AcpAdapterV2.resumeThread")(
      function* (threadInput: {
        readonly providerThread: OrchestrationV2ProviderThread;
        readonly modelSelection?: ModelSelection;
        readonly runtimePolicy?: ProviderAdapter.ProviderAdapterV2RuntimePolicy;
      }) {
        return yield* ctx.runtimeTransitionPermit.withPermit(
          Effect.gen(function* () {
            yield* ctx.awaitRuntimeTeardown();
            const sessionId = yield* nativeThreadId(ctx.driver, threadInput.providerThread);
            const previousItemIdentityVersion = ctx.itemIdentityVersion;
            ctx.useProviderThreadIdentity(threadInput.providerThread);
            const restorePreviousItemIdentity = Effect.sync(() => {
              ctx.itemIdentityVersion = previousItemIdentityVersion;
            });
            const restartAfterInterrupt = yield* ctx.restartRuntimeAfterTeardownIfRequired(
              threadInput.providerThread.appThreadId,
            ).pipe(Effect.tapError(() => restorePreviousItemIdentity));
            if ((yield* Ref.get(ctx.activeSessionId)) !== sessionId || restartAfterInterrupt) {
              yield* Ref.set(ctx.snapshot, {
                order: [],
                messages: new Map(),
                loadingRole: null,
                loadingMessageId: null,
                loadingIndex: 0,
              });
              const activated = yield* ctx.activateSession(
                sessionId,
                threadInput.providerThread.appThreadId,
              ).pipe(Effect.tapError(() => restorePreviousItemIdentity));
              yield* Ref.set(ctx.activeSessionId, activated.sessionId);
              yield* ctx.setActiveSessionSetup(activated);
              const nextSelection = threadInput.modelSelection ?? ctx.input.modelSelection;
              const nextRuntimePolicy = threadInput.runtimePolicy ?? ctx.input.runtimePolicy;
              yield* ctx.configureSession(activated, nextSelection, nextRuntimePolicy);
              yield* Ref.set(ctx.activeSelection, nextSelection);
              yield* Ref.set(ctx.activeInteractionMode, nextRuntimePolicy.interactionMode);
            }
            const now = yield* DateTime.now;
            return {
              ...threadInput.providerThread,
              providerSessionId: ctx.input.providerSessionId,
              status: "idle" as const,
              updatedAt: now,
            };
          }),
        );
      },
      (effect, threadInput) =>
        effect.pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapter.ProviderAdapterResumeThreadError({
                driver: ctx.driver,
                providerSessionId: ctx.input.providerSessionId,
                providerThreadId: threadInput.providerThread.id,
                cause,
              }),
          ),
        ),
    ),
    startTurn: ctx.startTurn,
    ...(ctx.flavor.supportsCompaction === true || ctx.flavor.compactSession !== undefined
      ? {
          compactThread: (turnInput: ProviderAdapter.ProviderAdapterV2TurnInput) =>
            ctx.startTurn({
              ...turnInput,
              message: { ...turnInput.message, text: "/compact" },
            }),
        }
      : {}),
    steerTurn: Effect.fn("AcpAdapterV2.steerTurn")(
      function* (turnInput) {
        const steering = ctx.flavor.steering;
        // The agent takes text only, so a steer with attachments waits for the next turn.
        if (steering === undefined || turnInput.message.attachments.length > 0) {
          return yield* new ProviderAdapter.ProviderAdapterSteerRunUnsupportedError({
            driver: ctx.driver,
            providerThreadId: turnInput.providerThread.id,
          });
        }
        const context = yield* Ref.get(ctx.activeTurn);
        if (
          context === null ||
          context.finalized ||
          context.providerTurnId !== turnInput.providerTurnId
        ) {
          return yield* new ProviderAdapter.ProviderAdapterProtocolError({
            driver: ctx.driver,
            detail: `Provider turn ${turnInput.providerTurnId} is not active and cannot be steered.`,
          });
        }
        // An agent that drops an early cancel drops an early steer too.
        const startHold = ctx.flavor.cancelAfterPromptStarts;
        if (startHold !== undefined) {
          yield* Deferred.await(context.promptStarted).pipe(
            Effect.timeoutOption(startHold.bound),
          );
        }
        const steerId = yield* steering.send(
          ctx.runtime,
          context.nativeThreadId,
          turnInput.message.text,
        );
        const injected = ctx.steerInjection(steerId);
        // The agent reads a steer at its next step. One that lands after the last
        // step is dropped, and the turn settles right after; the orchestrator then
        // sends it as a follow-up. The bound keeps Stop from queueing behind a tool.
        const outcome = yield* Effect.raceFirst(
          Deferred.await(injected).pipe(Effect.as("injected" as const)),
          Deferred.await(context.promptWireSettled).pipe(Effect.as("settled" as const)),
        ).pipe(Effect.timeoutOption(STEER_DELIVERY_BOUND));
        ctx.steerInjections.delete(steerId);
        if (Option.contains(outcome, "settled") && !(yield* Deferred.isDone(injected))) {
          return yield* new ProviderAdapter.ProviderAdapterProtocolError({
            driver: ctx.driver,
            detail: `Provider turn ${turnInput.providerTurnId} ended before it read the steering message.`,
          });
        }
      },
      (effect, turnInput) =>
        effect.pipe(
          Effect.mapError((cause) =>
            cause._tag === "ProviderAdapterSteerRunUnsupportedError"
              ? cause
              : new ProviderAdapter.ProviderAdapterSteerRunError({
                  driver: ctx.driver,
                  providerThreadId: turnInput.providerThread.id,
                  providerTurnId: turnInput.providerTurnId,
                  cause,
                }),
          ),
        ),
    ),
    interruptTurn: Effect.fn("AcpAdapterV2.interruptTurn")(
      function* (turnInput: ProviderAdapter.ProviderAdapterV2InterruptInput) {
        return yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            yield* restore(ctx.runtimeTransitionPermit.take(1));
            // Stop's caller times out on this call. The transition runs in its own fiber so
            // a stalled hard teardown keeps its state and permit without holding the caller.
            const transitionFiber = yield* Effect.gen(function* () {
              const transition = yield* Effect.gen(function* () {
                const interruptContext = yield* Ref.get(ctx.activeTurn);
                if (
                  ctx.followsAgentWorkState &&
                  turnInput.requestRuntimeRestart === true &&
                  (interruptContext === null ||
                    interruptContext.providerTurnId === turnInput.providerTurnId)
                ) {
                  // ACP cancel leaves native children alive; close confirms session-wide Stop.
                  ctx.pendingStopCloseTurn = interruptContext;
                  // Interruptible, or neither this timeout nor the caller's could end a hung close.
                  const closed = yield* restore(
                    ctx.runtime
                      .closeSession()
                      .pipe(Effect.timeoutOption(ACP_STOP_CONFIRM_TIMEOUT_MS)),
                  ).pipe(
                    Effect.mapError(
                      (cause) =>
                        new ProviderAdapter.ProviderAdapterProtocolError({
                          driver: ctx.driver,
                          detail:
                            "The agent refused to close its session; background work may still run",
                          cause,
                        }),
                    ),
                  );
                  if (Option.isNone(closed)) {
                    return yield* new ProviderAdapter.ProviderAdapterInterruptTimeoutError({
                      driver: ctx.driver,
                      providerThreadId: turnInput.providerThread.id,
                      providerTurnId: turnInput.providerTurnId,
                      timeoutMs: ACP_STOP_CONFIRM_TIMEOUT_MS,
                    });
                  }
                  yield* ctx.runtimeCallbackPermit.withPermit(
                    Effect.gen(function* () {
                      // Callbacks can settle the turn while close is awaiting confirmation.
                      const context = yield* Ref.get(ctx.activeTurn);
                      const carryover = yield* Ref.get(ctx.carryoverSubagents);
                      yield* Ref.set(ctx.stoppedRunQuarantine, true);
                      yield* Ref.set(ctx.runtimeRestartRequired, true);
                      ctx.agentWork = null;
                      ctx.agentRequests.clear();
                      ctx.nativeChildren.clear();
                      yield* ctx.quarantineStoppedRun();
                      if (context !== null) context.interrupted = true;
                      yield* ctx.late.cancelPendingRuntimeRequests();
                      yield* ctx.terminalizeCarryoverSubagents(carryover);
                      if (context !== null) {
                        yield* ctx.late.finalizeTurn(context, "interrupted");
                      }
                    }),
                  );
                  return undefined;
                }
                const softSteerCandidate =
                  ctx.flavor.preserveRuntimeOnSettledInterrupt === true &&
                  turnInput.requestRuntimeRestart !== true &&
                  interruptContext?.providerTurnId === turnInput.providerTurnId;
                // Native return can precede its callback; drain responses under the permit and check wire settlement before cancel.
                let settledSoftInterrupt = false;
                if (softSteerCandidate && interruptContext !== null) {
                  const promptSettledUnderPermit = yield* ctx.runtimeCallbackPermit.withPermit(
                    ctx.awaitAdmittedNativeResponses.pipe(
                      Effect.andThen(
                        Effect.sync(() => interruptContext.promptSettled === true),
                      ),
                    ),
                  );
                  const wireSettled = yield* Deferred.isDone(
                    interruptContext.promptWireSettled,
                  );
                  settledSoftInterrupt = promptSettledUnderPermit || wireSettled;
                }
                const restartRuntime =
                  !settledSoftInterrupt &&
                  (turnInput.requestRuntimeRestart === true ||
                    ctx.flavor.restartRuntimeOnEveryInterrupt === true);
                const hardRestart =
                  restartRuntime && ctx.flavor.terminateRuntimeProcessGroupOnInterrupt === true;
                if (hardRestart) {
                  const teardownState = yield* Ref.get(ctx.runtimeTeardownState);
                  if (teardownState._tag === "Failed") {
                    return yield* teardownState.error;
                  }
                  if (teardownState._tag === "InProgress") {
                    yield* Effect.logInfo(
                      "ACP interrupt awaiting in-progress hard teardown",
                      {
                        driver: ctx.driver,
                        providerTurnId: turnInput.providerTurnId,
                      },
                    );
                    yield* Deferred.await(teardownState.completed);
                    return undefined;
                  }
                }
                const context = interruptContext;
                if (context?.providerTurnId !== turnInput.providerTurnId) {
                  // Contain orphan runtimes on Stop; session-wide teardown must not touch another active turn.
                  const containOrphanRuntime =
                    context === null &&
                    hardRestart &&
                    turnInput.requestRuntimeRestart === true;
                  yield* Effect.logWarning(
                    containOrphanRuntime
                      ? "ACP Stop raced a soft interrupt that cleared the turn; containing the orphan runtime"
                      : "ACP interrupt raced transport teardown or a prior Stop; treating as already interrupted",
                    {
                      driver: ctx.driver,
                      requestedProviderTurnId: turnInput.providerTurnId,
                      activeProviderTurnId: context?.providerTurnId ?? null,
                      hardRestart,
                      requestRuntimeRestart: turnInput.requestRuntimeRestart === true,
                      teardownState: (yield* Ref.get(ctx.runtimeTeardownState))._tag,
                    },
                  );
                  if (containOrphanRuntime) {
                    const teardownBarrier = yield* Deferred.make<
                      void,
                      ProviderAdapter.ProviderAdapterProtocolError
                    >();
                    yield* ctx.runtimeCallbackPermit.withPermit(
                      Effect.gen(function* () {
                        yield* ctx.awaitAdmittedNativeResponses;
                        const stoppedGeneration = yield* Ref.get(ctx.runtimeCallbackGeneration);
                        yield* ctx.quarantineNativeTransportAtGeneration(stoppedGeneration);
                        yield* Ref.set(ctx.runtimeTeardownState, {
                          _tag: "InProgress",
                          completed: teardownBarrier,
                        });
                        yield* ctx.advanceRuntimeCallbackGeneration;
                      }),
                    );
                    const orphanCarryover = yield* Ref.getAndSet(ctx.carryoverSubagents, null);
                    yield* ctx.quarantineStoppedRun();
                    yield* ctx.late.cancelPendingRuntimeRequests();
                    yield* ctx.terminalizeCarryoverSubagents(orphanCarryover);
                    if (ctx.runtime.terminateProcessGroup === undefined) {
                      const error = new ProviderAdapter.ProviderAdapterProtocolError({
                        driver: ctx.driver,
                        detail:
                          "ACP runtime does not expose its required process-group teardown; the session is poisoned",
                      });
                      yield* Ref.set(ctx.runtimeTeardownState, { _tag: "Failed", error });
                      yield* Deferred.fail(teardownBarrier, error).pipe(Effect.ignore);
                      return yield* error;
                    }
                    const teardownExit = yield* ctx.runtime.terminateProcessGroup.pipe(
                      Effect.exit,
                    );
                    if (Exit.isFailure(teardownExit)) {
                      const error = new ProviderAdapter.ProviderAdapterProtocolError({
                        driver: ctx.driver,
                        detail:
                          "ACP orphan runtime process-group teardown failed; the session is poisoned",
                        payload: Cause.squash(teardownExit.cause),
                      });
                      yield* Ref.set(ctx.runtimeTeardownState, { _tag: "Failed", error });
                      yield* Deferred.fail(teardownBarrier, error).pipe(Effect.ignore);
                      return yield* error;
                    }
                    yield* Ref.set(ctx.runtimeRestartRequired, true);
                    yield* Ref.set(ctx.runtimeTeardownState, { _tag: "Idle" });
                    yield* Deferred.succeed(teardownBarrier, undefined).pipe(Effect.ignore);
                  }
                  return undefined;
                }
                const teardownBarrier = hardRestart
                  ? yield* Deferred.make<void, ProviderAdapter.ProviderAdapterProtocolError>()
                  : null;
                if (teardownBarrier !== null) {
                  yield* ctx.runtimeCallbackPermit.withPermit(
                    Effect.gen(function* () {
                      yield* ctx.awaitAdmittedNativeResponses;
                      const stoppedGeneration = yield* Ref.get(ctx.runtimeCallbackGeneration);
                      yield* ctx.quarantineNativeTransportAtGeneration(stoppedGeneration);
                      yield* Ref.set(ctx.runtimeTeardownState, {
                        _tag: "InProgress",
                        completed: teardownBarrier,
                      });
                      yield* ctx.advanceRuntimeCallbackGeneration;
                    }),
                  );
                }
                return {
                  context,
                  restartRuntime,
                  hardRestart,
                  teardownBarrier,
                  settledSoftInterrupt,
                };
              }).pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    ctx.pendingStopCloseTurn = null;
                  }),
                ),
              );
              if (transition === undefined) return;
              const {
                context,
                restartRuntime,
                hardRestart,
                teardownBarrier,
                settledSoftInterrupt,
              } = transition;
              const poisonTeardown = Effect.fnUntraced(function* (
                detail: string,
                payload?: unknown,
              ) {
                const error = new ProviderAdapter.ProviderAdapterProtocolError({
                  driver: ctx.driver,
                  detail,
                  ...(payload === undefined ? {} : { payload }),
                });
                yield* Ref.set(ctx.runtimeTeardownState, { _tag: "Failed", error });
                yield* Deferred.fail(teardownBarrier!, error).pipe(Effect.ignore);
                return error;
              });
              const runTransition = Effect.gen(function* () {
                context.interrupted = true;
                if (hardRestart || turnInput.requestRuntimeRestart === true) {
                  yield* ctx.quarantineStoppedRun();
                }
                yield* ctx.late.cancelPendingRuntimeRequests();
                // Finalize before killing so projection catches up and concurrent interrupts see activeTurn cleared.
                if (
                  (hardRestart || context.promptSettled || settledSoftInterrupt) &&
                  !context.finalized
                ) {
                  yield* ctx.late.finalizeTurn(context, "interrupted");
                }
                if (hardRestart) {
                  if (ctx.runtime.terminateProcessGroup === undefined) {
                    return yield* poisonTeardown(
                      "ACP runtime does not expose its required process-group teardown; the session is poisoned",
                    ).pipe(Effect.flatMap(Effect.fail));
                  }
                  const teardownExit = yield* ctx.runtime.terminateProcessGroup!.pipe(
                    Effect.exit,
                  );
                  if (Exit.isFailure(teardownExit)) {
                    return yield* poisonTeardown(
                      "ACP runtime process-group teardown failed; the session is poisoned",
                      Cause.squash(teardownExit.cause),
                    ).pipe(Effect.flatMap(Effect.fail));
                  }
                  yield* Ref.set(ctx.runtimeRestartRequired, true);
                  yield* Ref.set(ctx.runtimeTeardownState, { _tag: "Idle" });
                  yield* Deferred.succeed(teardownBarrier!, undefined).pipe(Effect.ignore);
                } else {
                  // Settled soft interrupts have no prompt to cancel; cancel could kill background subagents.
                  if (!settledSoftInterrupt && (yield* ctx.promptStillRunsAfterHold(context))) {
                    yield* ctx.runtime.cancel;
                  }
                  if (restartRuntime && ctx.flavor.restartRuntimeAfterInterrupt === true) {
                    yield* Ref.set(ctx.runtimeRestartRequired, true);
                  }
                }
                const stopped = yield* Deferred.await(context.completed).pipe(
                  Effect.timeoutOption(ACP_STOP_CONFIRM_TIMEOUT_MS),
                );
                // The turn stays open: the agent may still be working, and the user
                // decides whether to Force stop it.
                if (Option.isNone(stopped)) {
                  return yield* new ProviderAdapter.ProviderAdapterInterruptTimeoutError({
                    driver: ctx.driver,
                    providerThreadId: turnInput.providerThread.id,
                    providerTurnId: turnInput.providerTurnId,
                    timeoutMs: ACP_STOP_CONFIRM_TIMEOUT_MS,
                  });
                }
              });
              if (!hardRestart) {
                return yield* restore(runTransition);
              }
              return yield* runTransition.pipe(
                Effect.catchCause((cause) =>
                  Effect.gen(function* () {
                    const state = yield* Ref.get(ctx.runtimeTeardownState);
                    if (state._tag === "InProgress") {
                      yield* poisonTeardown(
                        "ACP hard teardown failed unexpectedly; the session is poisoned",
                        Cause.squash(cause),
                      );
                    }
                    return yield* Effect.failCause(cause);
                  }),
                ),
              );
            }).pipe(
              Effect.ensuring(ctx.runtimeTransitionPermit.release(1)),
              Effect.forkIn(ctx.sessionScope, { startImmediately: true, uninterruptible: true }),
            );
            return yield* restore(Fiber.join(transitionFiber)).pipe(
              Effect.onInterrupt(() =>
                Fiber.interrupt(transitionFiber).pipe(Effect.forkDetach, Effect.asVoid),
              ),
            );
          }),
        );
      },
      (effect, turnInput) =>
        effect.pipe(
          Effect.mapError((cause) =>
            cause._tag === "ProviderAdapterInterruptTimeoutError"
              ? cause
              : new ProviderAdapter.ProviderAdapterInterruptError({
                  driver: ctx.driver,
                  providerThreadId: turnInput.providerThread.id,
                  providerTurnId: turnInput.providerTurnId,
                  cause,
                }),
          ),
        ),
    ),
  };
  return runtimeObject;
};
