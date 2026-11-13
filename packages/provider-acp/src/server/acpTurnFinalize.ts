// ACP session behaviour extracted from server/adapter.ts (turnFinalize).

import {
  acpSubagentStatusBlocksTurnSettlement,
  acpSubagentHasPendingBackgroundWork,
  type ActiveAcpTurn,
} from "./acpTurnModel.ts";
import {
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import { ACP_DEFERRED_FINALIZE_DEBOUNCE } from "./acpAdapterConfig.ts";
import { isCompactionMessage } from "./acpThreadContext.ts";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import type { AcpSessionCtx19 } from "./acpSessionContext.ts";

export const createAcpTurnFinalize = (ctx: AcpSessionCtx19) => {
  ctx.late.finalizeTurn = Effect.fnUntraced(function* (
    context: ActiveAcpTurn,
    status: "completed" | "interrupted" | "failed" | "cancelled",
    failure?: OrchestrationV2ProviderFailure,
    options?: { readonly childTurnsContinue?: boolean },
  ): Effect.fn.Return<void> {
    if (context.finalized) return;
    const settledStatus = context.interrupted ? "interrupted" : status;
    context.finalizedStatus = settledStatus;
    context.finalized = true;
    const directStopQuarantine = yield* Ref.get(ctx.stoppedRunQuarantine);
    if (ctx.flavor.subagentsIdleOnTurnCompletion === true) {
      for (const subagent of context.subagents.values()) {
        if (!acpSubagentStatusBlocksTurnSettlement(subagent.task.status)) continue;
        yield* ctx.emitSubagent(context, {
          nativeTaskId: subagent.task.nativeTaskRef?.nativeId ?? subagent.task.id,
          prompt: subagent.task.prompt,
          title: subagent.task.title,
          model: subagent.task.model,
          status: settledStatus === "completed" ? "idle" : settledStatus,
          childSessionId: subagent.childSessionId,
          result: null,
        });
      }
    }
    if (settledStatus === "completed") {
      yield* ctx.terminalizeOpenForegroundTools(context);
    } else if (settledStatus === "interrupted") {
      yield* ctx.terminalizeOpenRunOwnedItems(context, {
        terminalizeSubagents: directStopQuarantine,
      });
    }
    yield* ctx.closeTextStreams(context);
    if (settledStatus !== "failed") {
      yield* ctx.emitProviderRetry(context, settledStatus);
    }
    const now = yield* DateTime.now;
    if (
      (ctx.flavor.supportsCompaction === true || ctx.flavor.compactSession !== undefined) &&
      isCompactionMessage(context.input.message) &&
      settledStatus === "completed"
    ) {
      const nativeItemId = `${context.nativeTurnId}:compaction`;
      yield* Ref.update(ctx.compactionMarkers, (current) => {
        const updated = new Map(current);
        updated.set(context.nativeThreadId, Symbol());
        return updated;
      });
      yield* ctx.emitProviderEvent({
        type: "turn_item.updated",
        driver: ctx.driver,
        turnItem: {
          id: ctx.idAllocator.derive.turnItemFromProviderItem({ driver: ctx.driver, nativeItemId }),
          threadId: context.input.threadId,
          runId: context.input.runId,
          nodeId: context.input.rootNodeId,
          providerThreadId: context.input.providerThread.id,
          providerTurnId: context.providerTurnId,
          nativeItemRef: { driver: ctx.driver, nativeId: nativeItemId, strength: "weak" },
          parentItemId: null,
          ordinal: yield* ctx.resolveItemOrdinal(context, nativeItemId),
          type: "compaction",
          driver: ctx.driver,
          status: "completed",
          title: "Context compacted",
          startedAt: context.startedAt,
          completedAt: now,
          updatedAt: now,
        },
      });
    }
    const turn = ctx.providerTurnPayload(context, settledStatus, now);
    yield* Ref.update(ctx.providerTurns, (current) => {
      const updated = new Map(current);
      updated.set(String(turn.id), turn);
      return updated;
    });
    yield* ctx.emitProviderEvent({
      type: "provider_turn.updated",
      driver: ctx.driver,
      threadId: context.input.threadId,
      providerTurn: turn,
    });
    const updatedProviderThread: OrchestrationV2ProviderThread = {
      ...context.input.providerThread,
      providerSessionId: ctx.input.providerSessionId,
      status: "active",
      lastRunOrdinal: context.input.runOrdinal,
      firstRunOrdinal:
        context.input.providerThread.firstRunOrdinal ?? context.input.runOrdinal,
      contextUsage: context.contextUsage,
      nativeMetadata: context.nativeMetadata,
      updatedAt: now,
    };
    yield* Ref.update(ctx.providerThreadByNativeSessionId, (current) =>
      new Map(current).set(context.nativeThreadId, updatedProviderThread),
    );
    yield* ctx.emitProviderEvent({
      type: "provider_thread.updated",
      driver: ctx.driver,
      providerThread: updatedProviderThread,
    });
    const rootSessionId = yield* Ref.get(ctx.activeSessionId);
    const childTurnsContinue =
      settledStatus === "failed" &&
      (options?.childTurnsContinue === true ||
        (ctx.followsAgentWorkState &&
          rootSessionId !== null &&
          ctx.hasWorkingDescendant(rootSessionId)));
    yield* ctx.emitProviderEvent(
      settledStatus === "failed"
        ? {
            type: "turn.terminal",
            driver: ctx.driver,
            providerThreadId: context.input.providerThread.id,
            providerTurnId: context.providerTurnId,
            runOrdinal: context.input.runOrdinal,
            failureItemOrdinal: yield* ctx.resolveItemOrdinal(
              context,
              `terminal-failure:${context.providerTurnId}`,
            ),
            status: settledStatus,
            ...(childTurnsContinue ? { childTurnsContinue: true } : {}),
            failure: failure ?? makeProviderFailure({ class: "provider_error" }),
            ...(context.providerRetry === undefined
              ? {}
              : {
                  retry: context.providerRetry.retry,
                  retryStartedAt: context.providerRetry.startedAt,
                }),
            threadDisposition: "reusable",
          }
        : {
            type: "turn.terminal",
            driver: ctx.driver,
            providerThreadId: context.input.providerThread.id,
            providerTurnId: context.providerTurnId,
            runOrdinal: context.input.runOrdinal,
            status: settledStatus,
            failure: null,
            threadDisposition: "reusable",
          },
    );
    const subagentsRequiringCarryover = [...context.subagents.values()].filter(
      acpSubagentHasPendingBackgroundWork,
    );
    if (subagentsRequiringCarryover.length > 0 && !directStopQuarantine) {
      const sessionId = yield* Ref.get(ctx.activeSessionId);
      if (sessionId !== null) {
        yield* Ref.set(ctx.carryoverSubagents, {
          sessionId,
          projectsLateTerminals: settledStatus === "completed" || childTurnsContinue,
          subagents: subagentsRequiringCarryover,
        });
      }
    }
    yield* Ref.set(ctx.activeTurn, null);
    ctx.steerInjections.clear();
    if (
      ctx.postSettleContinuationEnabled &&
      settledStatus === "completed" &&
      !directStopQuarantine &&
      (yield* Ref.get(ctx.runningBackgroundTaskIds)).size === 0 &&
      ((yield* Ref.get(ctx.wakeBuffer)).length > 0 ||
        (yield* Ref.get(ctx.midTurnUnreportedCompletedTaskIds)).size > 0)
    ) {
      const sessionId = yield* Ref.get(ctx.activeSessionId);
      if (sessionId !== null) {
        yield* ctx.late.offerContinuationRun(sessionId);
      }
    }
    if (
      settledStatus !== "completed" ||
      (yield* Ref.get(ctx.runningBackgroundTaskIds)).size === 0
    ) {
      yield* Ref.set(ctx.midTurnUnreportedCompletedTaskIds, new Set());
    }
    yield* Deferred.succeed(context.completed, undefined).pipe(Effect.ignore);
  });
  ctx.scheduleDeferredFinalize = Effect.fn("scheduleDeferredFinalize")(function* (context) {
    if (!ctx.flavor.deferFinalizeForBackgroundWork) return;
    if (!context.promptSettled || context.finalized || context.interrupted) return;
    if (ctx.hasDeferredBackgroundWork(context)) return;
    context.backgroundFinalizeGeneration += 1;
    const generation = context.backgroundFinalizeGeneration;
    yield* Effect.gen(function* () {
      yield* Effect.sleep(ACP_DEFERRED_FINALIZE_DEBOUNCE);
      if (
        context.finalized ||
        context.interrupted ||
        context.backgroundFinalizeGeneration !== generation
      ) {
        return;
      }
      if (ctx.hasDeferredBackgroundWork(context)) return;
      const status = context.promptSettledStatus ?? "completed";
      yield* ctx.late.finalizeTurn(context, status);
    }).pipe(Effect.forkIn(ctx.sessionScope), Effect.asVoid);
    yield* (
      ctx.options.testHooks?.onDeferredFinalizeScheduled?.(ACP_DEFERRED_FINALIZE_DEBOUNCE) ??
        Effect.void
    );
  });
  return {
  };
};
