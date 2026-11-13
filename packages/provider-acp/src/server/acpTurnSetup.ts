// ACP session behaviour extracted from server/adapter.ts (turnSetup).

import {
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderTurn,
} from "@t3tools/contracts";
import { acpCompletedTurnShouldTerminalizeTool, type ActiveAcpTurn } from "./acpTurnModel.ts";
import { acpPerTurnPromptUsage } from "./acpAdapterConfig.ts";
import { toolStatus } from "./acpToolCallProjection.ts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import type { AcpSessionCtx18 } from "./acpSessionContext.ts";

export const createAcpTurnSetup = Effect.fn("acpSession.turnSetup")(function* (ctx: AcpSessionCtx18) {
  yield* ctx.configureSession(ctx.started, ctx.input.modelSelection, ctx.input.runtimePolicy);
  yield* Ref.set(ctx.activeSelection, ctx.input.modelSelection);
  yield* Ref.set(ctx.activeInteractionMode, ctx.input.runtimePolicy.interactionMode);
  const createdAt = yield* DateTime.now;
  const providerSession: OrchestrationV2ProviderSession = {
    id: ctx.input.providerSessionId,
    driver: ctx.driver,
    providerInstanceId: ctx.options.instanceId,
    status: "ready",
    cwd: ctx.input.runtimePolicy.cwd ?? process.cwd(),
    model: ctx.input.modelSelection.model,
    capabilities: ctx.capabilities,
    createdAt,
    updatedAt: createdAt,
    lastError: null,
  };
  const providerTurnPayload = (
    context: ActiveAcpTurn,
    status: OrchestrationV2ProviderTurn["status"],
    completedAt: DateTime.Utc | null,
  ): OrchestrationV2ProviderTurn => ({
    id: context.providerTurnId,
    providerThreadId: context.input.providerThread.id,
    nodeId: context.input.rootNodeId,
    runAttemptId: context.input.attemptId,
    nativeTurnRef:
      context.nativePromptId === undefined
        ? { driver: ctx.driver, nativeId: context.nativeTurnId, strength: "weak" }
        : { driver: ctx.driver, nativeId: context.nativePromptId, strength: "strong" },
    ordinal: context.input.providerTurnOrdinal,
    status,
    startedAt: context.startedAt,
    completedAt,
    ...(status === "running" || status === "pending"
      ? {}
      : {
          // The prompt tap only captures usage for flavors that declared
          // per-turn counters, so undeclared agents stay unavailable here.
          turnTokenUsage: acpPerTurnPromptUsage(
            context.promptUsage,
            context.subagents.size > 0,
            status,
            ctx.flavor.geminiPromptUsage,
          ),
        }),
  });
  const terminalizeOpenRunOwnedItems = Effect.fnUntraced(function* (
    context: ActiveAcpTurn,
    options: { readonly terminalizeSubagents: boolean },
  ) {
    for (const tool of context.tools.values()) {
      const status = toolStatus(tool.status);
      if (status === "pending" || status === "running" || status === "waiting") {
        yield* ctx.emitTool(context, tool, "interrupted");
      }
    }
    if (!options.terminalizeSubagents) return;
    for (const subagent of context.subagents.values()) {
      yield* ctx.terminalizeSubagentTools(subagent);
      if (subagent.task.status !== "running" && subagent.task.status !== "pending") {
        continue;
      }
      yield* ctx.emitSubagent(context, {
        nativeTaskId: subagent.task.nativeTaskRef?.nativeId ?? subagent.task.id,
        prompt: subagent.task.prompt,
        title: subagent.task.title,
        model: subagent.task.model,
        status: "interrupted",
        childSessionId: subagent.childSessionId,
        result: subagent.task.result,
        suppressNormalTool: true,
      });
    }
  });
  const terminalizeOpenForegroundTools = Effect.fnUntraced(function* (
    context: ActiveAcpTurn,
    status: "completed" | "failed" = "completed",
  ) {
    for (const tool of context.tools.values()) {
      if (!acpCompletedTurnShouldTerminalizeTool(tool, { ...ctx.flavor, extractSubagentUpdate: ctx.extractSubagentUpdate }))
        continue;
      yield* ctx.emitTool(context, tool, status);
    }
  });
  const promptStillRunsAfterHold = Effect.fnUntraced(function* (context: ActiveAcpTurn) {
    const hold = ctx.flavor.cancelAfterPromptStarts;
    if (hold === undefined) return true;
    if (yield* Deferred.isDone(context.promptStarted)) return true;
    yield* ctx.options.testHooks?.onCancelHeld?.() ?? Effect.void;
    const boundPassed = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const elapsed = now - (context.promptSentAt ?? now);
      yield* Effect.sleep(
        Duration.millis(Math.max(0, Duration.toMillis(hold.bound) - elapsed)),
      );
    });
    return yield* Effect.raceFirst(
      Effect.raceFirst(Deferred.await(context.promptStarted), boundPassed).pipe(
        Effect.as(true),
      ),
      Deferred.await(context.completed).pipe(Effect.as(false)),
    );
  });
  const quarantineStoppedRun = Effect.fnUntraced(function* () {
    yield* ctx.continuationPermit.withPermit(
      Effect.gen(function* () {
        yield* Ref.update(ctx.continuationGeneration, (value) => value + 1);
        yield* Ref.set(ctx.stoppedRunQuarantine, true);
        yield* Ref.set(ctx.wakeBuffer, []);
        yield* Ref.set(ctx.wakeReports, ctx.noWakeReports);
        yield* Ref.set(ctx.continuationRequested, false);
        yield* Ref.set(ctx.runningBackgroundTaskIds, new Set());
        yield* Ref.set(ctx.midTurnUnreportedCompletedTaskIds, new Set());
        yield* Ref.set(ctx.carryoverSubagents, null);
        yield* Ref.set(ctx.lastTurnRoute, null);
      }),
    );
  });
  return {
    createdAt,
    providerSession,
    providerTurnPayload,
    terminalizeOpenRunOwnedItems,
    terminalizeOpenForegroundTools,
    promptStillRunsAfterHold,
    quarantineStoppedRun,
  };
});
