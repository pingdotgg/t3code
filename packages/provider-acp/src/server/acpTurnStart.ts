// ACP session behaviour extracted from server/adapter.ts (turnStart).

import {
  acpIsProviderContinuationMessage,
  acpIsAppOwnedWakeTurn,
  acpTurnStartShouldPreserveContinuation,
  type ActiveAcpTurn,
  type ActiveAcpSubagent,
} from "./acpTurnModel.ts";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import { modelSelectionsEqual } from "@t3tools/shared/model";
import { nativeThreadId, isCompactionMessage } from "./acpThreadContext.ts";
import { type OrchestrationV2ProviderThread } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as EffectAcpSchema from "effect-acp/compat";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import type { AcpSessionCtx21 } from "./acpSessionContext.ts";

export const createAcpTurnStart = (ctx: AcpSessionCtx21) => {
  const startTurnUnlocked = Effect.fn("AcpAdapterV2.startTurn")(
    function* (turnInput: ProviderAdapter.ProviderAdapterV2TurnInput) {
      yield* ctx.awaitRuntimeTeardown();
      const existing = yield* Ref.get(ctx.activeTurn);
      if (existing !== null) {
        return yield* new ProviderAdapter.ProviderAdapterProtocolError({
          driver: ctx.driver,
          detail: `ACP provider turn ${existing.providerTurnId} is still active`,
          reason: "previous_turn_active",
        });
      }
      ctx.useProviderThreadIdentity(turnInput.providerThread);
      // load/resume can invoke client methods; install the incoming policy before activation.
      ctx.latestRuntimePolicy = turnInput.runtimePolicy;
      const requestedSessionId = yield* nativeThreadId(ctx.driver, turnInput.providerThread);
      const restartAfterInterrupt = yield* ctx.restartRuntimeAfterTeardownIfRequired(
        turnInput.threadId,
      );
      const needsSessionActivation =
        (yield* Ref.get(ctx.activeSessionId)) !== requestedSessionId || restartAfterInterrupt;
      if (needsSessionActivation) {
        const activated = yield* ctx.activateSession(requestedSessionId, turnInput.threadId);
        yield* Ref.set(ctx.activeSessionId, activated.sessionId);
        yield* ctx.setActiveSessionSetup(activated);
        yield* ctx.configureSession(activated, turnInput.modelSelection, turnInput.runtimePolicy);
        yield* Ref.set(ctx.activeSelection, turnInput.modelSelection);
        yield* Ref.set(ctx.activeInteractionMode, turnInput.runtimePolicy.interactionMode);
      } else {
        const configuredSelection = yield* Ref.get(ctx.activeSelection);
        const configuredInteractionMode = yield* Ref.get(ctx.activeInteractionMode);
        if (
          configuredSelection === null ||
          !modelSelectionsEqual(configuredSelection, turnInput.modelSelection) ||
          configuredInteractionMode !== turnInput.runtimePolicy.interactionMode
        ) {
          const currentSessionSetup = yield* Ref.get(ctx.activeSessionSetup);
          if (currentSessionSetup === null) {
            return yield* new ProviderAdapter.ProviderAdapterProtocolError({
              driver: ctx.driver,
              detail: `ACP session ${requestedSessionId} has no active setup metadata`,
            });
          }
          yield* ctx.configureSession(
            currentSessionSetup,
            turnInput.modelSelection,
            turnInput.runtimePolicy,
          );
          yield* Ref.set(ctx.activeSelection, turnInput.modelSelection);
          yield* Ref.set(ctx.activeInteractionMode, turnInput.runtimePolicy.interactionMode);
        }
      }
      yield* ctx.validateModelSelection(turnInput.modelSelection);
      yield* Ref.set(ctx.lastTurnRoute, {
        threadId: turnInput.threadId,
        providerThreadId: turnInput.providerThread.id,
      });
      yield* Ref.set(ctx.suppressPostSettleMonitorPrompt, false);
      yield* Ref.set(ctx.handledBackgroundTaskIdsInActiveTurn, new Set());
      // Continuations consume existing wake traffic without re-prompting ACP.
      const isContinuationTurn =
        (ctx.postSettleContinuationEnabled || ctx.followsAgentWorkState) &&
        acpIsProviderContinuationMessage(turnInput.message);
      const isAppOwnedWakeTurn = acpIsAppOwnedWakeTurn(turnInput.message);
      if (!isAppOwnedWakeTurn) {
        yield* Ref.set(ctx.midTurnUnreportedCompletedTaskIds, new Set());
      }
      const continuationWasRequested = yield* ctx.continuationPermit.withPermit(
        Effect.gen(function* () {
          const wasRequested = yield* Ref.get(ctx.continuationRequested);
          const preserveBufferedContinuation = acpTurnStartShouldPreserveContinuation({
            continuationRequested: wasRequested,
            isContinuationTurn,
            wakeBufferLength: (yield* Ref.get(ctx.wakeBuffer)).length,
          });
          if (!isContinuationTurn && !isAppOwnedWakeTurn && !preserveBufferedContinuation) {
            yield* Ref.set(ctx.wakeBuffer, []);
            yield* Ref.set(ctx.wakeReports, ctx.noWakeReports);
          }
          if (preserveBufferedContinuation) return wasRequested;
          yield* Ref.update(ctx.continuationGeneration, (value) => value + 1);
          yield* Ref.set(ctx.continuationRequested, false);
          return wasRequested;
        }),
      );
      const promptParts = isContinuationTurn
        ? null
        : yield* ctx.resolvePromptParts(turnInput, requestedSessionId);
      const startedAt = yield* DateTime.now;
      const nativeTurnId = `${requestedSessionId}:turn:${turnInput.providerTurnOrdinal}`;
      const providerTurnId = ctx.deriveProviderTurnId(nativeTurnId);
      const completed = yield* Deferred.make<void, never>();
      const promptWireSettled = yield* Deferred.make<void, never>();
      const promptDispatched = yield* Deferred.make<void, never>();
      const promptStarted = yield* Deferred.make<void, never>();
      const rememberedContextUsage = (yield* Ref.get(ctx.contextUsageBySessionId)).get(
        requestedSessionId,
      );
      const rememberedNativeMetadata = (yield* Ref.get(ctx.nativeMetadataBySessionId)).get(
        requestedSessionId,
      );
      const initialNativeMetadata =
        rememberedNativeMetadata === undefined
          ? (turnInput.providerThread.nativeMetadata ?? null)
          : {
              ...turnInput.providerThread.nativeMetadata,
              ...rememberedNativeMetadata,
            };
      if (initialNativeMetadata !== null) {
        yield* Ref.update(ctx.nativeMetadataBySessionId, (current) =>
          new Map(current).set(requestedSessionId, initialNativeMetadata),
        );
      }
      const context: ActiveAcpTurn = {
        input: turnInput,
        providerTurnId,
        nativeThreadId: requestedSessionId,
        nativeTurnId,
        startedAt,
        completed,
        itemOrdinals: new Map(),
        outgoingPrompt:
          (yield* Ref.get(ctx.activeSessionSetup))?.initializeResult.protocolVersion === 2
            ? promptParts?.prompt
            : undefined,
        user: { current: null, nextSegment: 0 },
        assistant: { current: null, nextSegment: 0 },
        reasoning: { current: null, nextSegment: 0 },
        contextUsage: rememberedContextUsage ?? turnInput.providerThread.contextUsage ?? null,
        nativeMetadata: initialNativeMetadata,
        tools: new Map(),
        toolUpdatesSkipped: new Map(),
        toolStartedAt: new Map(),
        subagents: new Map(),
        subagentsBySessionId: new Map(),
        pendingSubagentNotifications: new Map(),
        toolCallIdsByBackgroundTaskId: new Map(),
        backgroundCommands: new Map(),
        persistentBackgroundTaskIds: new Set(),
        awaitingBackgroundHydration: new Set(),
        pendingInjectedReport: new Set(),
        earlyInjectedReportObserved: false,
        plans: new Map(),
        interrupted: false,
        finalized: false,
        finalizedStatus: null,
        promptSettled: false,
        promptSettledStatus: null,
        workAccepted: false,
        promptWireSettled,
        promptDispatched,
        promptSentAt: null,
        promptStarted,
        promptUsage: undefined,
        backgroundFinalizeGeneration: 0,
        nativePromptId: undefined,
      };
      const carryover = yield* Ref.getAndSet(ctx.carryoverSubagents, null);
      let rehydratedCarryoverSubagents: ReadonlyArray<ActiveAcpSubagent> = [];
      if (carryover !== null && carryover.sessionId === requestedSessionId) {
        rehydratedCarryoverSubagents = carryover.subagents;
        for (const subagent of carryover.subagents) {
          const nativeId = subagent.task.nativeTaskRef?.nativeId ?? null;
          if (nativeId !== null) {
            context.subagents.set(nativeId, subagent);
          }
          if (subagent.childSessionId !== null) {
            context.subagentsBySessionId.set(subagent.childSessionId, subagent);
          }
        }
      }
      yield* Ref.set(ctx.activeTurn, context);
      yield* Ref.set(ctx.stoppedRunQuarantine, false);
      const runningTurn = ctx.providerTurnPayload(context, "running", null);
      yield* Ref.update(ctx.providerTurns, (current) => {
        const updated = new Map(current);
        updated.set(String(runningTurn.id), runningTurn);
        return updated;
      });
      yield* ctx.emitProviderEvent({
        type: "provider_turn.updated",
        driver: ctx.driver,
        threadId: turnInput.threadId,
        providerTurn: runningTurn,
      });
      const activeProviderThread: OrchestrationV2ProviderThread = {
        ...turnInput.providerThread,
        providerSessionId: ctx.input.providerSessionId,
        status: "active",
        contextUsage: context.contextUsage,
        nativeMetadata: context.nativeMetadata,
        updatedAt: startedAt,
      };
      yield* Ref.update(ctx.providerThreadByNativeSessionId, (current) =>
        new Map(current).set(requestedSessionId, activeProviderThread),
      );
      yield* ctx.emitProviderEvent({
        type: "provider_thread.updated",
        driver: ctx.driver,
        providerThread: activeProviderThread,
      });
      yield* ctx.rememberSnapshotMessage({
        createdBy: turnInput.message.createdBy,
        creationSource: turnInput.message.creationSource,
        ...(turnInput.message.scheduledTaskId === undefined
          ? {}
          : { scheduledTaskId: turnInput.message.scheduledTaskId }),
        ...(turnInput.message.senderThreadId === undefined
          ? {}
          : { senderThreadId: turnInput.message.senderThreadId }),
        id: turnInput.message.messageId,
        threadId: turnInput.threadId,
        runId: turnInput.runId,
        nodeId: turnInput.rootNodeId,
        role: "user",
        text: turnInput.message.text,
        attachments: [...turnInput.message.attachments],
        streaming: false,
        createdAt: startedAt,
        updatedAt: startedAt,
      });
      if (ctx.followsAgentWorkState)
        yield* ctx.runtimeCallbackPermit.withPermit(ctx.syncNativeChildren(context));
      const attached = ctx.turnAttached;
      ctx.turnAttached = yield* Deferred.make<boolean>();
      yield* Deferred.succeed(attached, true);
      // Every attach ends the deferred-terminal contract, but only the
      // queued provider continuation owns wake traffic. A user turn may
      // start before that continuation and must leave its buffer intact.
      yield* ctx.projectDeferredCarryoverTerminals(rehydratedCarryoverSubagents);
      // Retain projected terminals during wake drain so monotonic guards reject replayed spawns.
      if (isContinuationTurn) {
        yield* Ref.set(ctx.continuationRequested, false);
        yield* Ref.update(ctx.wakeReports, ({ reports, offered }) => ({
          reports: new Map([...reports].filter(([key]) => !offered.has(key))),
          offered: ctx.noWakeReports.offered,
        }));
        const takeWakeBuffer = Ref.modify(ctx.wakeBuffer, (current) => {
          const next: Array<EffectAcpSchema.SessionNotification> = [];
          return [
            current.filter((notification) => notification.sessionId === requestedSessionId),
            next,
          ] as const;
        });
        if (ctx.followsAgentWorkState) {
          yield* ctx.runtimeCallbackPermit.withPermit(
            Effect.gen(function* () {
              const liveWork = ctx.agentWork;
              yield* Effect.forEach(yield* takeWakeBuffer, ctx.handleSessionUpdate, {
                discard: true,
              });
              ctx.agentWork = liveWork;
              context.workAccepted = true;
              yield* ctx.settleIdleWork(context);
            }),
          );
          return;
        }
        const drainedWakeCount = yield* takeWakeBuffer.pipe(
          Effect.tap((drained) =>
            Effect.forEach(drained, ctx.handleSessionUpdate, {
              concurrency: 1,
              discard: true,
            }),
          ),
          Effect.map((drained) => drained.length),
        );
        context.promptSettled = true;
        context.promptSettledStatus = "completed";
        if (drainedWakeCount === 0) {
          if (continuationWasRequested && ctx.flavor.deferFinalizeForBackgroundWork === true) {
            if (ctx.hasDeferredBackgroundWork(context)) {
              yield* ctx.rearmDeferredFinalize(context);
            } else {
              yield* ctx.scheduleDeferredFinalize(context);
            }
          } else {
            yield* ctx.late.finalizeTurn(context, "completed");
          }
          return;
        }
        if (!context.finalized) {
          if (ctx.hasDeferredBackgroundWork(context)) {
            yield* ctx.rearmDeferredFinalize(context);
          } else {
            yield* ctx.scheduleDeferredFinalize(context);
          }
        }
        return;
      }
      const checkPromptOutcome =
        ctx.flavor.watchPromptOutcome === undefined
          ? undefined
          : yield* ctx.flavor.watchPromptOutcome(requestedSessionId);
      const promptGeneration = yield* Ref.get(ctx.runtimeCallbackGeneration);
      const promptOptions = { dispatched: context.promptDispatched };
      context.promptSentAt = yield* Clock.currentTimeMillis;
      const compactSession = isCompactionMessage(turnInput.message)
        ? ctx.flavor.compactSession
        : undefined;
      yield* (
        compactSession === undefined
          ? ctx.runtime.prompt({ prompt: promptParts!.prompt }, promptOptions)
          : Deferred.succeed(context.promptDispatched, undefined).pipe(
              Effect.andThen(compactSession(ctx.runtime, requestedSessionId)),
              Effect.as({ stopReason: "end_turn" } satisfies EffectAcpSchema.PromptResponse),
            )
      ).pipe(
        Effect.tap(() =>
          Ref.update(ctx.promptInstructionStates, (current) => {
            // Native compaction sends no prompt, so no instructions reached the agent.
            if (promptParts?.instructionState === undefined || compactSession !== undefined)
              return current;
            const updated = new Map(current);
            updated.set(requestedSessionId, promptParts.instructionState);
            return updated;
          }),
        ),
        Effect.tap(() =>
          Ref.update(ctx.compactionMarkers, (current) => {
            if (promptParts?.instructionState === undefined) return current;
            const observedMarker = promptParts.compactionMarker;
            if (
              observedMarker === undefined ||
              current.get(requestedSessionId) !== observedMarker
            )
              return current;
            const updated = new Map(current);
            updated.delete(requestedSessionId);
            return updated;
          }),
        ),
        // Settle the wire before the completion callback's permit so a settled-soft
        // Stop sees the native return. Capture usage only before finalize: a late
        // response must not flip a settled turn.
        Effect.tap((result) =>
          Effect.sync(() => {
            if (ctx.flavor.reportsPerTurnPromptUsage === true && !context.finalized) {
              context.promptUsage = result.usage ?? undefined;
            }
          }).pipe(
            Effect.andThen(
              Deferred.succeed(context.promptWireSettled, undefined).pipe(Effect.asVoid),
            ),
          ),
        ),
        Effect.tap(() => ctx.options.testHooks?.afterPromptWireSettled?.() ?? Effect.void),
        Effect.flatMap((result) =>
          ctx.runRuntimeCallbackAtGeneration(
            promptGeneration,
            Effect.gen(function* () {
              if (context.finalized || ctx.followsAgentWorkState) return;
              // ACP v2 reports a failed prompt as an idle `error`, not an RPC error.
              const idleError = result.stopReason === "error" && !context.interrupted;
              const hiddenFailure =
                checkPromptOutcome === undefined ||
                context.interrupted ||
                result.stopReason === "error" ||
                result.stopReason === "cancelled"
                  ? undefined
                  : yield* checkPromptOutcome(result);
              if (hiddenFailure !== undefined) {
                yield* Ref.set(ctx.runtimeRestartRequired, true);
              }
              const failure =
                hiddenFailure ?? (idleError ? ctx.idleErrorFailure(result.error) : undefined);
              const status =
                failure !== undefined
                  ? "failed"
                  : result.stopReason === "cancelled"
                    ? context.interrupted
                      ? "interrupted"
                      : "cancelled"
                    : "completed";
              if (ctx.flavor.deferFinalizeForBackgroundWork === true && !context.interrupted) {
                context.promptSettled = true;
                context.promptSettledStatus = status;
                for (const [taskId, completion] of context.backgroundCommands) {
                  if (completion === null) continue;
                  yield* ctx.finishRegisteredBackgroundTool({ taskId, ...completion });
                }
              }
              if (failure !== undefined) {
                yield* ctx.terminalizeOpenForegroundTools(context, "failed");
                // Unlike an RPC failure, the agent survives an idle error, so its
                // background tools and subagents keep reporting to this run.
                yield* ctx.late.finalizeTurn(context, "failed", failure, {
                  childTurnsContinue: ctx.hasSurvivingBackgroundWork(context),
                });
                return;
              }
              if (
                ctx.flavor.deferFinalizeForBackgroundWork === true &&
                !context.interrupted &&
                ctx.hasDeferredBackgroundWork(context)
              ) {
                yield* ctx.closeTextStreams(context);
                yield* (
                  ctx.options.testHooks?.afterPromptSettledWithBackgroundWork?.() ?? Effect.void
                );
                return;
              }
              yield* ctx.late.finalizeTurn(context, status);
            }),
          ).pipe(Effect.asVoid),
        ),
        Effect.catchCause((cause) =>
          ctx.runRuntimeCallbackAtGeneration(
            promptGeneration,
            Effect.gen(function* () {
              if (context.finalized) return;
              const error = Cause.findError(cause);
              // Native close rejects prompts cancelled before insertion with -32800.
              const interrupted =
                context.interrupted ||
                (ctx.pendingStopCloseTurn === context &&
                  Result.isSuccess(error) &&
                  error.success._tag === "AcpRequestError" &&
                  error.success.code === -32800);
              const failure = Cause.squash(cause);
              if (!interrupted && ctx.flavor.restartRuntimeAfterPromptError?.(failure) === true) {
                yield* Ref.set(ctx.runtimeRestartRequired, true);
              }
              yield* ctx.late.finalizeTurn(
                context,
                interrupted ? "interrupted" : "failed",
                ctx.flavor.promptFailure?.(failure) ??
                  makeProviderFailure({
                    cause: failure,
                    class: "provider_error",
                  }),
              ).pipe(
                Effect.andThen(
                  Effect.logWarning("orchestration-v2.acp-prompt-failed", {
                    driver: ctx.driver,
                    providerSessionId: ctx.input.providerSessionId,
                    providerThreadId: turnInput.providerThread.id,
                    providerTurnId,
                    cause,
                  }),
                ),
              );
            }),
          ).pipe(Effect.asVoid),
        ),
        Effect.forkIn(ctx.sessionScope),
      );
    },
    (effect, turnInput) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapter.ProviderAdapterTurnStartError({
              driver: ctx.driver,
              threadId: turnInput.threadId,
              providerThreadId: turnInput.providerThread.id,
              runId: turnInput.runId,
              cause,
            }),
        ),
      ),
  );
  const startTurn = Effect.fn("AcpAdapterV2.startTurn.transition")(function* (
    turnInput: ProviderAdapter.ProviderAdapterV2TurnInput,
  ) {
    return yield* ctx.runtimeTransitionPermit.withPermit(startTurnUnlocked(turnInput));
  });
  return {
    startTurnUnlocked,
    startTurn,
  };
};
