// ACP session behaviour extracted from server/adapter.ts (backgroundContinuation).

import {
  acpPostSettleMonitorPromptShouldSuppress,
  acpPostSettleWakeEvidence,
  acpPostSettleWakeShouldBuffer,
  acpPostSettleContinuationOfferEvidence,
  type ActiveAcpTurn,
} from "./acpTurnModel.ts";
import { backgroundWorkNotification } from "@t3tools/provider-core/server/notification";
import { parseSessionUpdateEvent } from "./runtimeModel.ts";
import { toolStatus } from "./acpToolCallProjection.ts";
import * as Effect from "effect/Effect";
import * as EffectAcpSchema from "effect-acp/compat";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import type { AcpSessionCtx9 } from "./acpSessionContext.ts";

export const createAcpBackgroundContinuation = (ctx: AcpSessionCtx9) => {
  ctx.late.offerContinuationRun = Effect.fnUntraced(function* (_sessionId: string) {
    if (ctx.continuationRequests === undefined) {
      return false;
    }
    const pending = yield* ctx.continuationPermit.withPermit(
      Effect.gen(function* () {
        if (yield* Ref.get(ctx.continuationClosed)) return Option.none();
        if (yield* Ref.get(ctx.stoppedRunQuarantine)) return Option.none();
        if (yield* Ref.get(ctx.continuationRequested)) return Option.none();
        const route = yield* Ref.get(ctx.lastTurnRoute);
        if (route === null) return Option.none();
        yield* Ref.set(ctx.continuationRequested, true);
        const generation = yield* Ref.updateAndGet(
          ctx.continuationGeneration,
          (value) => value + 1,
        );
        const reports = yield* Ref.modify(ctx.wakeReports, ({ reports }) => [
          reports,
          { reports, offered: new Set(reports.keys()) },
        ]);
        return Option.some({ route, generation, reports });
      }),
    );
    if (Option.isNone(pending)) return false;
    const { route, generation, reports } = pending.value;
    const notification = backgroundWorkNotification([...reports.values()]);
    yield* Effect.logInfo("orchestration-v2.acp-wake-turn-detected", {
      driver: ctx.driver,
      providerSessionId: ctx.input.providerSessionId,
      threadId: route.threadId,
      providerThreadId: route.providerThreadId,
    });
    yield* ctx.continuationRequests.offer({
      threadId: route.threadId,
      providerThreadId: route.providerThreadId,
      driver: ctx.driver,
      detail: null,
      ...(notification === null ? {} : { notification }),
      clearIfCurrent: () =>
        ctx.continuationPermit.withPermit(
          Effect.gen(function* () {
            if ((yield* Ref.get(ctx.continuationGeneration)) === generation) {
              yield* Ref.set(ctx.continuationRequested, false);
            }
          }),
        ),
      dispatchIfCurrent: (effect) =>
        ctx.continuationPermit.withPermit(
          Effect.gen(function* () {
            const clearIfOwner = Effect.gen(function* () {
              if ((yield* Ref.get(ctx.continuationGeneration)) === generation) {
                yield* Ref.set(ctx.continuationRequested, false);
              }
            });
            if (yield* Ref.get(ctx.stoppedRunQuarantine)) {
              yield* clearIfOwner;
              return Option.none();
            }
            if ((yield* Ref.get(ctx.continuationGeneration)) !== generation) {
              return Option.none();
            }
            if (!(yield* Ref.get(ctx.continuationRequested))) return Option.none();
            // Retain the dispatch flag until continuation starts so late frames cannot enqueue duplicates.
            const exit = yield* Effect.exit(effect);
            if (Exit.isFailure(exit)) {
              yield* clearIfOwner;
              return yield* Effect.failCause(exit.cause);
            }
            return Option.some(exit.value);
          }),
        ),
    });
    return true;
  });
  const applyLateBackgroundMutation = Effect.fnUntraced(function* (
    sessionId: string,
    mutation: {
      readonly taskId: string;
      readonly status: "running" | "completed" | "failed";
    },
  ) {
    const taskAlreadyEnded = (yield* Ref.get(ctx.endedBackgroundTaskIds)).has(mutation.taskId);
    yield* ctx.applyBackgroundTaskMutationRunning(mutation);
    if (mutation.status === "running") {
      if (taskAlreadyEnded && acpPostSettleMonitorPromptShouldSuppress(mutation)) {
        yield* Ref.set(ctx.suppressPostSettleMonitorPrompt, true);
      }
      return;
    }
    // Only a new terminal may un-suppress output; re-delivery must not revive monitor ACK chatter.
    if (!taskAlreadyEnded) {
      yield* Ref.set(ctx.suppressPostSettleMonitorPrompt, false);
    }
    const activeContext = yield* Ref.get(ctx.activeTurn);
    if (activeContext !== null && !activeContext.finalized) {
      const handled = yield* Ref.get(ctx.handledBackgroundTaskIdsInActiveTurn);
      if (
        !activeContext.promptSettled &&
        !handled.has(mutation.taskId) &&
        activeContext.toolCallIdsByBackgroundTaskId.has(mutation.taskId)
      ) {
        yield* Ref.update(ctx.midTurnUnreportedCompletedTaskIds, (current) =>
          new Set(current).add(mutation.taskId),
        );
      }
      return;
    }
    if (
      ctx.postSettleContinuationEnabled &&
      (yield* Ref.get(ctx.activeSessionId)) === sessionId &&
      (yield* Ref.get(ctx.runningBackgroundTaskIds)).size === 0 &&
      ((yield* Ref.get(ctx.wakeBuffer)).length > 0 ||
        (yield* Ref.get(ctx.midTurnUnreportedCompletedTaskIds)).size > 0)
    ) {
      yield* ctx.late.offerContinuationRun(sessionId);
    }
  });
  const finishRegisteredBackgroundTool = Effect.fnUntraced(function* (mutation: {
    readonly taskId: string;
    readonly status: "completed" | "failed";
    readonly output?: string;
  }) {
    const context = yield* Ref.get(ctx.activeTurn);
    if (context === null || context.finalized || !context.promptSettled) return;
    const toolCallId = context.toolCallIdsByBackgroundTaskId.get(mutation.taskId);
    const tool = toolCallId === undefined ? undefined : context.tools.get(toolCallId);
    if (tool === undefined) return;
    const status = toolStatus(tool.status);
    if (
      status !== "pending" &&
      status !== "running" &&
      !context.backgroundCommands.has(mutation.taskId)
    ) {
      return;
    }
    context.awaitingBackgroundHydration.delete(mutation.taskId);
    const finished = { ...tool, status: mutation.status };
    yield* ctx.emitTool(
      context,
      mutation.output === undefined ? finished : ctx.setToolOutputText(finished, mutation.output),
      mutation.status,
    );
    yield* ctx.rearmDeferredFinalize(context);
  });
  const bufferPostSettleWake = Effect.fnUntraced(function* (
    notification: EffectAcpSchema.SessionNotification,
  ) {
    if (!ctx.postSettleContinuationEnabled || ctx.continuationRequests === undefined) {
      return {
        buffered: false,
        offerContinuation: false,
        stopProcessing: false,
      };
    }
    if (yield* Ref.get(ctx.stoppedRunQuarantine)) {
      return {
        buffered: false,
        offerContinuation: false,
        stopProcessing: true,
      };
    }
    const rootSessionId = yield* Ref.get(ctx.activeSessionId);
    if (rootSessionId === null || notification.sessionId !== rootSessionId) {
      return {
        buffered: false,
        offerContinuation: false,
        stopProcessing: false,
      };
    }
    if (!acpPostSettleWakeEvidence(notification, ctx.flavor)) {
      return {
        buffered: false,
        offerContinuation: false,
        stopProcessing: false,
      };
    }
    const update = notification.update;
    let alreadyHandledToolUpdate = false;
    if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
      yield* ctx.trackRunningBackgroundTools(notification);
      // Long-timeout get_command_or_subagent_output consumption ends with TaskOutput alone.
      for (const event of parseSessionUpdateEvent(notification).events) {
        if (event._tag !== "ToolCallUpdated") continue;
        const toolCall = ctx.flavor.normalizeToolCall?.(event.toolCall) ?? event.toolCall;
        const proposedPlanMarkdown = ctx.flavor.extractProposedPlanMarkdown?.(toolCall);
        if (proposedPlanMarkdown !== undefined && proposedPlanMarkdown.length > 0) {
          yield* ctx.captureProposedPlan({ planMarkdown: proposedPlanMarkdown });
        }
        const toolTaskId = ctx.flavor.extractBackgroundTaskId?.(toolCall);
        if (
          toolTaskId !== undefined &&
          (yield* Ref.get(ctx.handledBackgroundTaskIdsInActiveTurn)).has(toolTaskId)
        ) {
          alreadyHandledToolUpdate = true;
        }
        if (ctx.flavor.extractBackgroundTaskCompletion !== undefined) {
          for (const completion of ctx.flavor.extractBackgroundTaskCompletion(toolCall)) {
            alreadyHandledToolUpdate =
              alreadyHandledToolUpdate ||
              (yield* Ref.get(ctx.handledBackgroundTaskIdsInActiveTurn)).has(completion.taskId);
            yield* ctx.applyBackgroundTaskMutationRunning(completion);
          }
        }
      }
    }
    const backgroundWorkRunning = (yield* Ref.get(ctx.runningBackgroundTaskIds)).size > 0;
    const handledInTurnCount = (yield* Ref.get(ctx.handledBackgroundTaskIdsInActiveTurn)).size;
    const isInTurnHandledAgentChatter =
      handledInTurnCount > 0 &&
      (update.sessionUpdate === "agent_message_chunk" ||
        update.sessionUpdate === "agent_thought_chunk");
    // Grok re-prompts for each post-settle monitor event; retaining them would replay the whole burst.
    let buffered = false;
    if (
      !alreadyHandledToolUpdate &&
      !isInTurnHandledAgentChatter &&
      acpPostSettleWakeShouldBuffer(notification, backgroundWorkRunning)
    ) {
      yield* Ref.update(ctx.wakeBuffer, (current) => [...current, notification]);
      buffered = true;
    }
    if (!acpPostSettleContinuationOfferEvidence(notification, ctx.flavor)) {
      return {
        buffered,
        offerContinuation: false,
        stopProcessing: true,
      };
    }
    if (backgroundWorkRunning) {
      return {
        buffered,
        offerContinuation: false,
        stopProcessing: true,
      };
    }
    if (alreadyHandledToolUpdate) {
      if (!(yield* Ref.get(ctx.continuationRequested))) {
        yield* Ref.set(ctx.wakeBuffer, []);
      }
      return {
        buffered,
        offerContinuation: false,
        stopProcessing: true,
      };
    }
    // Preserve wake frames for other tasks until their completion offers.
    if (isInTurnHandledAgentChatter) {
      return {
        buffered,
        offerContinuation: false,
        stopProcessing: true,
      };
    }
    return {
      buffered,
      offerContinuation: true,
      stopProcessing: true,
    };
  });
  let applyFinalizedActiveTurnSubagentTerminal: (
    context: ActiveAcpTurn,
    notification: EffectAcpSchema.SessionNotification,
  ) => Effect.Effect<boolean> = () => Effect.succeed(false);
  return {
    applyLateBackgroundMutation,
    finishRegisteredBackgroundTool,
    bufferPostSettleWake,
    get applyFinalizedActiveTurnSubagentTerminal() {
      return applyFinalizedActiveTurnSubagentTerminal;
    },
    set applyFinalizedActiveTurnSubagentTerminal(value) {
      applyFinalizedActiveTurnSubagentTerminal = value;
    },
  };
};
