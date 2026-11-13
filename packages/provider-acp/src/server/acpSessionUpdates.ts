// ACP session behaviour extracted from server/adapter.ts (sessionUpdates).

import {
  acpRootSessionUpdateIngestsOutput,
  acpSubagentStatusIsTerminal,
  acpCarryoverTerminalShouldClearContinuation,
  acpIsProviderContinuationMessage,
} from "./acpTurnModel.ts";
import { parseSessionUpdateEvent, acpContentBlockDisplayText } from "./runtimeModel.ts";
import { stoppedToolStatus } from "./acpToolCallProjection.ts";
import { type OrchestrationV2ProviderThread } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as EffectAcpSchema from "effect-acp/compat";
import * as Equal from "effect/Equal";
import * as Ref from "effect/Ref";
import type { AcpSessionCtx11 } from "./acpSessionContext.ts";

export const createAcpSessionUpdates = (ctx: AcpSessionCtx11) => {
  const handleSessionUpdate = Effect.fnUntraced(function* (
    notification: EffectAcpSchema.SessionNotification,
  ) {
    const context = yield* Ref.get(ctx.activeTurn);
    const update = notification.update;
    if (
      ctx.followsAgentWorkState &&
      ctx.flavor.extractSubagentSessionEvent !== undefined &&
      notification.sessionId !== (yield* Ref.get(ctx.activeSessionId)) &&
      (yield* Ref.get(ctx.stoppedRunQuarantine))
    )
      return;
    if (yield* ctx.projectAgentTerminalUpdate(notification, context)) return;
    if (
      update.sessionUpdate === "usage_update" ||
      update.sessionUpdate === "session_info_update"
    ) {
      const stateEvent = parseSessionUpdateEvent(notification).events.find(
        (event) => event._tag === "UsageUpdated" || event._tag === "SessionInfoUpdated",
      );
      if (stateEvent === undefined) return;
      if (stateEvent._tag === "UsageUpdated") {
        yield* Ref.update(ctx.contextUsageBySessionId, (current) =>
          new Map(current).set(notification.sessionId, stateEvent.usage),
        );
        if (context?.nativeThreadId === notification.sessionId) {
          context.contextUsage = stateEvent.usage;
        }
      } else {
        const metadata = yield* Ref.modify(ctx.nativeMetadataBySessionId, (current) => {
          const merged = {
            ...current.get(notification.sessionId),
            ...stateEvent.metadata,
          };
          return [merged, new Map(current).set(notification.sessionId, merged)] as const;
        });
        if (context?.nativeThreadId === notification.sessionId) {
          context.nativeMetadata = metadata;
        }
      }
      const knownProviderThread = (yield* Ref.get(ctx.providerThreadByNativeSessionId)).get(
        notification.sessionId,
      );
      if (knownProviderThread !== undefined) {
        const now = yield* DateTime.now;
        const providerThread: OrchestrationV2ProviderThread = {
          ...knownProviderThread,
          contextUsage:
            (yield* Ref.get(ctx.contextUsageBySessionId)).get(notification.sessionId) ??
            knownProviderThread.contextUsage ??
            null,
          nativeMetadata:
            (yield* Ref.get(ctx.nativeMetadataBySessionId)).get(notification.sessionId) ??
            knownProviderThread.nativeMetadata ??
            null,
          updatedAt: now,
        };
        yield* Ref.update(ctx.providerThreadByNativeSessionId, (current) =>
          new Map(current).set(notification.sessionId, providerThread),
        );
        yield* ctx.emitProviderEvent({
          type: "provider_thread.updated",
          driver: ctx.driver,
          providerThread,
        });
      }
      return;
    }
    if (yield* ctx.followNativeChild(notification, context)) return;
    if (
      ctx.followsAgentWorkState &&
      !(yield* Ref.get(ctx.stoppedRunQuarantine)) &&
      notification.sessionId === (yield* Ref.get(ctx.activeSessionId))
    ) {
      if (update.sessionUpdate === "state_update") ctx.agentWork = update;
      if (
        update.sessionUpdate === "user_message" ||
        update.sessionUpdate === "user_message_chunk"
      ) {
        ctx.agentWork = { sessionUpdate: "state_update", state: "running" };
        if (context !== null) {
          context.workAccepted = true;
          if (!context.finalized) return;
        }
      }
      if (
        context !== null &&
        update.sessionUpdate === "state_update" &&
        update.state === "idle"
      ) {
        yield* ctx.settleIdleWork(context);
      } else if (
        context === null &&
        !(yield* Ref.get(ctx.stoppedRunQuarantine)) &&
        (acpRootSessionUpdateIngestsOutput(notification) ||
          update.sessionUpdate === "user_message" ||
          update.sessionUpdate === "user_message_chunk" ||
          (update.sessionUpdate === "state_update" && update.state === "running"))
      ) {
        yield* Ref.update(ctx.wakeBuffer, (current) => [...current, notification]);
        yield* ctx.late.offerContinuationRun(notification.sessionId);
        return;
      }
    }
    if (
      context?.finalized === true &&
      (yield* ctx.applyFinalizedActiveTurnSubagentTerminal(context, notification))
    ) {
      return;
    }
    if (
      context !== null &&
      context.finalized &&
      (yield* Ref.get(ctx.handledBackgroundTaskIdsInActiveTurn)).size > 0 &&
      (update.sessionUpdate === "agent_message_chunk" ||
        update.sessionUpdate === "agent_thought_chunk")
    ) {
      yield* Ref.set(ctx.suppressPostSettleMonitorPrompt, true);
      return;
    }
    if (
      context !== null &&
      (yield* Ref.get(ctx.suppressPostSettleMonitorPrompt)) &&
      (update.sessionUpdate === "agent_message_chunk" ||
        update.sessionUpdate === "agent_thought_chunk")
    ) {
      return;
    }
    if (
      context?.finalized === true &&
      update.sessionUpdate === "user_message_chunk" &&
      update.content.type === "text"
    ) {
      const mutations = ctx.flavor.extractBackgroundToolMutation?.(update.content.text) ?? [];
      for (const mutation of mutations) {
        yield* ctx.applyLateBackgroundMutation(notification.sessionId, mutation);
      }
      return;
    }
    if (context === null) {
      if (yield* Ref.get(ctx.stoppedRunQuarantine)) {
        return;
      }
      const bufferOutcome = yield* ctx.bufferPostSettleWake(notification);
      // Completed roots retain subscribers and can project terminals now; interrupted roots may lack runId ownership.
      const carryover = yield* Ref.get(ctx.carryoverSubagents);
      const rootTerminalCanStillProject =
        carryover !== null &&
        carryover.sessionId === (yield* Ref.get(ctx.activeSessionId)) &&
        carryover.projectsLateTerminals;
      const projectCarryover = rootTerminalCanStillProject;
      let carryoverTerminalized = false;
      if (
        ctx.flavor.extractSubagentUpdate !== undefined &&
        (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update")
      ) {
        for (const event of parseSessionUpdateEvent(notification).events) {
          if (event._tag !== "ToolCallUpdated") continue;
          const toolCall = ctx.flavor.normalizeToolCall?.(event.toolCall) ?? event.toolCall;
          const subagentUpdate = ctx.extractSubagentUpdate(toolCall);
          if (subagentUpdate === undefined) continue;
          if (!acpSubagentStatusIsTerminal(subagentUpdate.status)) {
            continue;
          }
          if (
            yield* ctx.late.updateCarryoverSubagentStatus(
              subagentUpdate.nativeTaskId,
              subagentUpdate.status,
              subagentUpdate.result,
              { project: projectCarryover },
            )
          ) {
            carryoverTerminalized = true;
          }
          if (
            subagentUpdate.childSessionId !== null &&
            (yield* ctx.late.updateCarryoverSubagentStatus(
              subagentUpdate.childSessionId,
              subagentUpdate.status,
              subagentUpdate.result,
              { project: projectCarryover },
            ))
          ) {
            carryoverTerminalized = true;
          }
        }
      }
      if (
        update.sessionUpdate === "user_message_chunk" &&
        update.content.type === "text" &&
        ctx.flavor.extractSubagentEndNotice !== undefined
      ) {
        const notice = ctx.flavor.extractSubagentEndNotice(update.content.text);
        if (
          notice !== undefined &&
          (yield* ctx.late.updateCarryoverSubagentStatus(
            notice.childSessionId,
            notice.status,
            undefined,
            {
              project: projectCarryover,
            },
          ))
        ) {
          carryoverTerminalized = true;
        }
      }
      const continuationOffered = bufferOutcome.offerContinuation
        ? yield* ctx.late.offerContinuationRun(notification.sessionId)
        : false;
      const wakeOutcome = { ...bufferOutcome, continuationOffered };
      if (carryoverTerminalized && !wakeOutcome.buffered) {
        if (
          acpCarryoverTerminalShouldClearContinuation({
            continuationOffered: wakeOutcome.continuationOffered,
            wakeBufferLength: (yield* Ref.get(ctx.wakeBuffer)).length,
          })
        ) {
          yield* Ref.set(ctx.continuationRequested, false);
        }
        return;
      }
      if (wakeOutcome.stopProcessing) {
        return;
      }
      if (
        update.sessionUpdate === "user_message_chunk" ||
        update.sessionUpdate === "agent_message_chunk" ||
        update.sessionUpdate === "agent_thought_chunk"
      ) {
        const text = acpContentBlockDisplayText(update.content);
        if (text === undefined) return;
        const lateBackgroundMutations =
          update.content.type === "text"
            ? (ctx.flavor.extractBackgroundToolMutation?.(text) ?? [])
            : [];
        for (const lateBackgroundMutation of lateBackgroundMutations) {
          yield* ctx.applyLateBackgroundMutation(notification.sessionId, lateBackgroundMutation);
        }
        const lateMonitorChatter =
          /<monitor-event\b/i.test(text) ||
          /Monitor\s+["']?[0-9a-f-]{8,}["']?\s+ended/i.test(text);
        if (
          text.trim().length > 0 &&
          lateBackgroundMutations.length === 0 &&
          !lateMonitorChatter
        ) {
          yield* ctx.appendLoadedHistory(
            notification,
            update.sessionUpdate === "user_message_chunk"
              ? "user"
              : update.sessionUpdate === "agent_thought_chunk"
                ? "thought"
                : "assistant",
            text,
          );
        }
      } else if (
        update.sessionUpdate === "user_message" ||
        update.sessionUpdate === "agent_message" ||
        update.sessionUpdate === "agent_thought"
      ) {
        if (update.content === undefined) return;
        const text = (update.content ?? [])
          .flatMap((content) => {
            const display = acpContentBlockDisplayText(content);
            return display === undefined ? [] : [display];
          })
          .join("\n");
        yield* ctx.appendLoadedHistory(
          notification,
          update.sessionUpdate === "user_message"
            ? "user"
            : update.sessionUpdate === "agent_thought"
              ? "thought"
              : "assistant",
          text,
          true,
        );
      } else if (
        update.sessionUpdate === "tool_call" ||
        update.sessionUpdate === "tool_call_update" ||
        update.sessionUpdate === "plan" ||
        update.sessionUpdate === "plan_update" ||
        update.sessionUpdate === "plan_removed"
      ) {
        yield* Ref.update(ctx.snapshot, (current) => ({
          ...current,
          loadingRole: null,
          loadingMessageId: null,
        }));
      }
      return;
    }
    if (context.finalized) return;
    const rootSessionId = yield* Ref.get(ctx.activeSessionId);
    if (notification.sessionId !== rootSessionId) {
      if (context.finalized) return;
      if (ctx.flavor.extractSubagentUpdate === undefined) return;
      const subagent = context.subagentsBySessionId.get(notification.sessionId);
      if (
        update.sessionUpdate === "tool_call" ||
        update.sessionUpdate === "tool_call_update"
      ) {
        if (subagent === undefined) return;
        const nativeTaskId =
          subagent.task.nativeTaskRef?.nativeId ?? String(subagent.task.id);
        for (const event of parseSessionUpdateEvent(notification).events) {
          if (event._tag !== "ToolCallUpdated") continue;
          const toolCall = ctx.flavor.normalizeToolCall?.(event.toolCall) ?? event.toolCall;
          const subagentUpdate = ctx.extractSubagentUpdate(toolCall);
          if (subagentUpdate !== undefined) {
            if (
              subagentUpdate.nativeTaskId === nativeTaskId ||
              subagentUpdate.childSessionId === notification.sessionId
            ) {
              yield* ctx.emitSubagent(context, subagentUpdate);
            }
            continue;
          }
          yield* ctx.projectSubagentTool(
            subagent,
            notification.sessionId,
            toolCall,
            stoppedToolStatus(context, toolCall),
          );
        }
        return;
      }
      const isDisplayableAssistantUpdate =
        (update.sessionUpdate === "agent_message_chunk" &&
          acpContentBlockDisplayText(update.content) !== undefined) ||
        (update.sessionUpdate === "agent_message" && update.content !== undefined);
      if (!isDisplayableAssistantUpdate) {
        return;
      }
      if (subagent !== undefined) {
        yield* ctx.projectSubagentNotification(subagent, notification);
        return;
      }
      const buffered = context.pendingSubagentNotifications.get(notification.sessionId) ?? [];
      buffered.push(notification);
      context.pendingSubagentNotifications.set(notification.sessionId, buffered);
      return;
    }
    // The activeSessionId yield may let idle/prompt settlement finalize this context.
    if (context.finalized) return;
    if (
      context.promptSettled &&
      !acpIsProviderContinuationMessage(context.input.message) &&
      ctx.flavor.isProviderWakeNotification?.(notification) === true
    ) {
      if (ctx.hasDeferredBackgroundWork(context)) {
        yield* Ref.update(ctx.wakeBuffer, (current) => [...current, notification]);
        return;
      }
      yield* ctx.late.finalizeTurn(context, context.promptSettledStatus ?? "completed");
      const wake = yield* ctx.bufferPostSettleWake(notification);
      if (wake.offerContinuation) {
        yield* ctx.late.offerContinuationRun(notification.sessionId);
      }
      return;
    }
    if (
      update.sessionUpdate !== "tool_call_update" &&
      update.sessionUpdate !== "plan" &&
      update.sessionUpdate !== "plan_update" &&
      update.sessionUpdate !== "plan_removed" &&
      acpRootSessionUpdateIngestsOutput(notification)
    ) {
      yield* ctx.emitProviderRetry(context, "completed");
    }
    if (
      context.outgoingPrompt !== undefined &&
      (update.sessionUpdate === "user_message" ||
        update.sessionUpdate === "user_message_chunk")
    ) {
      // ACP v2 prompt acknowledgments lack a messageId; correlate one full echo by content.
      if (
        context.consumedPromptMessageId === undefined &&
        update.sessionUpdate === "user_message" &&
        Equal.equals(update.content, context.outgoingPrompt)
      ) {
        context.consumedPromptMessageId = update.messageId;
      }
      if (
        context.consumedPromptMessageId !== undefined &&
        context.consumedPromptMessageId === update.messageId
      )
        return;
    }
    switch (update.sessionUpdate) {
      case "state_update": {
        const toolCallId = `${context.nativeTurnId}:requires-action`;
        const existing = context.tools.get(toolCallId);
        if (update.state === "requires_action") {
          yield* ctx.emitTool(context, {
            toolCallId,
            kind: "other",
            title: "Action required",
            status: "requiresAction",
            data: { state: "requires_action" },
          });
        } else if (existing?.status === "requiresAction") {
          yield* ctx.emitTool(context, {
            ...existing,
            status: "completed",
            data: { ...existing.data, state: update.state },
          });
        }
        break;
      }
      case "agent_message_chunk": {
        const text = acpContentBlockDisplayText(update.content);
        if (text !== undefined) {
          const startsNewAssistantSegment = context.assistant.current === null;
          if (context.pendingInjectedReport.size > 0) {
            const reportedTaskIds = [...context.pendingInjectedReport];
            context.pendingInjectedReport.clear();
            yield* ctx.clearMidTurnUnreportedTaskIds(reportedTaskIds);
          } else if (
            startsNewAssistantSegment &&
            context.promptSettled &&
            (yield* Ref.get(ctx.midTurnUnreportedCompletedTaskIds)).size > 0
          ) {
            context.earlyInjectedReportObserved = true;
          }
          yield* ctx.appendText(context, "assistant", text, update.messageId);
        }
        break;
      }
      case "agent_thought_chunk": {
        const text = acpContentBlockDisplayText(update.content);
        if (text !== undefined) {
          yield* ctx.appendText(context, "reasoning", text, update.messageId);
        }
        break;
      }
      case "user_message":
      case "agent_message":
      case "agent_thought": {
        if (update.content === undefined) break;
        const text = (update.content ?? [])
          .flatMap((content) => {
            const display = acpContentBlockDisplayText(content);
            return display === undefined ? [] : [display];
          })
          .join("\n");
        yield* ctx.replaceText(
          context,
          update.sessionUpdate === "user_message"
            ? "user"
            : update.sessionUpdate === "agent_message"
              ? "assistant"
              : "reasoning",
          text,
          update.messageId,
        );
        break;
      }
      case "tool_call_content_chunk": {
        const text =
          update.content.type === "content"
            ? acpContentBlockDisplayText(update.content.content)
            : update.content.type === "diff"
              ? "changes" in update.content
                ? update.content.patch?.text
                : update.content.newText
              : undefined;
        if (text !== undefined) {
          const previous = context.tools.get(update.toolCallId) ?? {
            toolCallId: update.toolCallId,
            status: "inProgress" as const,
            data: { toolCallId: update.toolCallId },
          };
          yield* ctx.emitTool(context, ctx.appendToolOutputText(previous, text));
        }
        break;
      }
      case "compaction_summary_chunk": {
        const text = acpContentBlockDisplayText(update.content);
        if (text !== undefined) {
          const toolCallId = `acp-compaction:${update.compactionId}`;
          const previous = context.tools.get(toolCallId) ?? {
            toolCallId,
            kind: "think",
            title: "Compact context",
            status: "inProgress" as const,
            data: { toolCallId },
          };
          yield* ctx.emitTool(context, ctx.appendToolOutputText(previous, text));
        }
        break;
      }
      case "user_message_chunk": {
        if (update.content.type === "text" && ctx.flavor.extractBackgroundToolMutation) {
          const mutations = ctx.flavor.extractBackgroundToolMutation(update.content.text);
          const terminalTaskIds = mutations
            .filter((mutation) => mutation.status !== "running")
            .map((mutation) => mutation.taskId);
          const reportArrivedBeforeNotice =
            context.earlyInjectedReportObserved && terminalTaskIds.length > 0;
          if (reportArrivedBeforeNotice) {
            context.earlyInjectedReportObserved = false;
            yield* ctx.clearMidTurnUnreportedTaskIds(terminalTaskIds);
          }
          for (const mutation of mutations) {
            const toolCallId = context.toolCallIdsByBackgroundTaskId.get(mutation.taskId);
            const previous =
              toolCallId !== undefined ? context.tools.get(toolCallId) : undefined;
            if (previous !== undefined) {
              let nextStatus =
                mutation.status === "running"
                  ? ("inProgress" as const)
                  : mutation.status === "failed"
                    ? ("failed" as const)
                    : ("completed" as const);
              if (nextStatus !== "inProgress") {
                yield* ctx.markAwaitingBackgroundHydration(context, mutation.taskId);
                nextStatus = "inProgress";
              }
              yield* ctx.emitTool(
                context,
                ctx.appendToolOutputText(
                  { ...previous, status: nextStatus },
                  mutation.appendOutput,
                ),
              );
            }
            yield* ctx.applyBackgroundTaskMutationRunning(mutation);
            if (mutation.status !== "running" && !reportArrivedBeforeNotice) {
              yield* ctx.markPendingInjectedReport(context, mutation.taskId);
            }
          }
        }
        if (update.content.type === "text" && ctx.flavor.extractSubagentEndNotice) {
          const notice = ctx.flavor.extractSubagentEndNotice(update.content.text);
          const subagent =
            notice !== undefined
              ? context.subagentsBySessionId.get(notice.childSessionId)
              : undefined;
          if (
            notice !== undefined &&
            subagent !== undefined &&
            (subagent.task.status === "running" || subagent.task.status === "pending")
          ) {
            // Agents may answer without hydrating output; finish the subagent so deferred finalize can close.
            yield* ctx.emitSubagent(context, {
              nativeTaskId: subagent.task.nativeTaskRef?.nativeId ?? notice.childSessionId,
              prompt: subagent.task.prompt,
              title: subagent.task.title,
              model: subagent.task.model,
              status: notice.status,
              childSessionId: notice.childSessionId,
              result: null,
              suppressNormalTool: true,
            });
          }
        }
        break;
      }
      default: {
        const parsed = parseSessionUpdateEvent(notification);
        for (const event of parsed.events) {
          if (event._tag === "ToolCallUpdated") {
            yield* ctx.emitTool(context, event.toolCall);
          } else if (event._tag === "PlanUpdated") {
            yield* ctx.emitPlan(context, event.payload);
          } else if (event._tag === "NoticeReceived") {
            yield* ctx.emitNotice(context, event);
          } else if (event._tag === "UnknownUpdate") {
            yield* ctx.emitTool(context, {
              toolCallId: `${context.nativeTurnId}:unsupported:${event.updateType}`,
              kind: "other",
              title: `Unsupported ACP update: ${event.updateType}`,
              status: "completed",
              data: { updateType: event.updateType },
            });
          }
        }
      }
    }
    yield* ctx.rearmDeferredFinalize(context);
  });
  return {
    handleSessionUpdate,
  };
};
