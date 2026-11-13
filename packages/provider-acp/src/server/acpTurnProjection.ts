// ACP session behaviour extracted from server/adapter.ts (turnProjection).

import {
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2PlanArtifact,
} from "@t3tools/contracts";
import { makeProviderRetryTurnItem } from "@t3tools/provider-core/server/failure";
import { type ActiveAcpTurn, type ActiveAcpSubagent } from "./acpTurnModel.ts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import type { AcpSessionCtx2 } from "./acpSessionContext.ts";

export const createAcpTurnProjection = Effect.fn("acpSession.turnProjection")(function* (ctx: AcpSessionCtx2) {
  const resolveItemOrdinal = (context: ActiveAcpTurn, nativeItemId: string) =>
    Effect.sync(() => {
      const existing = context.itemOrdinals.get(nativeItemId);
      if (existing !== undefined) return existing;
      const ordinal = context.input.providerTurnOrdinal * 100 + context.itemOrdinals.size + 1;
      context.itemOrdinals.set(nativeItemId, ordinal);
      return ordinal;
    });
  const resolveSubagentChildOrdinal = (subagent: ActiveAcpSubagent, nativeItemId: string) => {
    const existing = subagent.childItemOrdinals.get(nativeItemId);
    if (existing !== undefined) return existing;
    const ordinal = subagent.nextChildOrdinal++;
    subagent.childItemOrdinals.set(nativeItemId, ordinal);
    return ordinal;
  };
  const emitProviderRetry = Effect.fnUntraced(function* (
    context: ActiveAcpTurn,
    status: "running" | "completed" | "interrupted" | "cancelled",
  ) {
    const state = context.providerRetry;
    if (state === undefined) return;
    yield* ctx.emitProviderEvent({
      type: "turn_item.updated",
      driver: ctx.driver,
      turnItem: makeProviderRetryTurnItem({
        driver: ctx.driver,
        threadId: context.input.threadId,
        runId: context.input.runId,
        nodeId: context.input.rootNodeId,
        providerThreadId: context.input.providerThread.id,
        providerTurnId: context.providerTurnId,
        ...state,
        status,
        updatedAt: yield* DateTime.now,
      }),
    });
    if (status !== "running") context.providerRetry = undefined;
  });
  const reportProviderRetry = Effect.fnUntraced(function* (notice: {
    readonly sessionId: string;
    readonly failure: OrchestrationV2ProviderFailure;
  }) {
    const context = yield* Ref.get(ctx.activeTurn);
    if (
      context === null ||
      context.finalized ||
      context.interrupted ||
      context.nativeThreadId !== notice.sessionId ||
      (yield* Ref.get(ctx.stoppedRunQuarantine))
    )
      return;
    const previous = context.providerRetry;
    context.providerRetry = {
      failure: notice.failure,
      retry: {
        attempt: (previous?.retry.attempt ?? 0) + 1,
        maxAttempts: null,
        retryDelayMs: null,
      },
      startedAt: previous?.startedAt ?? (yield* DateTime.now),
      itemOrdinal:
        previous?.itemOrdinal ??
        (yield* resolveItemOrdinal(context, `terminal-failure:${context.providerTurnId}`)),
    };
    yield* emitProviderRetry(context, "running");
  });
  const lastCapturedProposedPlan = yield* Ref.make<{
    readonly nativeTurnId: string;
    readonly markdown: string;
    readonly planId: OrchestrationV2PlanArtifact["id"];
  } | null>(null);
  const captureProposedPlan = Effect.fnUntraced(function* (input: {
    readonly planMarkdown: string;
  }) {
    const context = yield* Ref.get(ctx.activeTurn);
    if (context === null) return;
    const markdown = input.planMarkdown.trim();
    if (markdown.length === 0) return;
    const previous = yield* Ref.get(lastCapturedProposedPlan);
    if (
      previous !== null &&
      previous.nativeTurnId === context.nativeTurnId &&
      previous.markdown === markdown
    ) {
      return;
    }
    const nativeItemId = `${context.nativeTurnId}:proposed-plan`;
    const planId =
      previous !== null && previous.nativeTurnId === context.nativeTurnId
        ? previous.planId
        : yield* ctx.idAllocator.allocate
            .plan({
              threadId: context.input.threadId,
              runId: context.input.runId,
              driver: ctx.driver,
            })
            .pipe(Effect.orDie);
    yield* Ref.set(lastCapturedProposedPlan, {
      nativeTurnId: context.nativeTurnId,
      markdown,
      planId,
    });
    const now = yield* DateTime.now;
    const nodeId = ctx.idAllocator.derive.nodeFromProviderItem({ driver: ctx.driver, nativeItemId });
    const turnItemId = ctx.idAllocator.derive.turnItemFromProviderItem({ driver: ctx.driver, nativeItemId });
    const ordinal = yield* resolveItemOrdinal(context, nativeItemId);
    const nativeItemRef = { driver: ctx.driver, nativeId: nativeItemId, strength: "weak" as const };
    yield* ctx.emitProviderEvent({
      type: "node.updated",
      driver: ctx.driver,
      node: {
        id: nodeId,
        threadId: context.input.threadId,
        runId: context.input.runId,
        parentNodeId: context.input.rootNodeId,
        rootNodeId: context.input.rootNodeId,
        kind: "plan",
        status: "completed",
        countsForRun: false,
        providerThreadId: context.input.providerThread.id,
        providerTurnId: context.providerTurnId,
        nativeItemRef,
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt: context.startedAt,
        completedAt: now,
      },
    });
    yield* ctx.emitProviderEvent({
      type: "plan.updated",
      driver: ctx.driver,
      plan: {
        id: planId,
        threadId: context.input.threadId,
        runId: context.input.runId,
        nodeId,
        kind: "proposed_plan",
        status: "completed",
        markdown,
      },
    });
    yield* ctx.emitProviderEvent({
      type: "turn_item.updated",
      driver: ctx.driver,
      turnItem: {
        id: turnItemId,
        threadId: context.input.threadId,
        runId: context.input.runId,
        nodeId,
        providerThreadId: context.input.providerThread.id,
        providerTurnId: context.providerTurnId,
        nativeItemRef,
        parentItemId: null,
        ordinal,
        status: "completed",
        title: null,
        startedAt: context.startedAt,
        completedAt: now,
        updatedAt: now,
        type: "proposed_plan",
        planId,
        markdown,
        streaming: false,
      },
    });
  });
  const lastProposedPlanMarkdown = Effect.gen(function* () {
    const context = yield* Ref.get(ctx.activeTurn);
    const previous = yield* Ref.get(lastCapturedProposedPlan);
    return context !== null && previous?.nativeTurnId === context.nativeTurnId
      ? previous.markdown
      : undefined;
  });
  return {
    resolveItemOrdinal,
    resolveSubagentChildOrdinal,
    emitProviderRetry,
    reportProviderRetry,
    lastCapturedProposedPlan,
    captureProposedPlan,
    lastProposedPlanMarkdown,
  };
});
