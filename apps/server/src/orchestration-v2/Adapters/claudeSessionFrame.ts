// @effect-diagnostics nodeBuiltinImport:off -- the SDK takes a Node ChildProcess for the CLI.
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import * as DateTime from "effect/DateTime";

import * as Effect from "effect/Effect";

import * as Ref from "effect/Ref";

import { claudeRateLimitEventToUpdate } from "../../provider/claudeUsageLimits.ts";

import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import type { Deps as PrevDeps } from "./claudeSessionFrameC.ts";
import { installFrameC } from "./claudeSessionFrameC.ts";
import type { ClaudeSdkFrame } from "./claudeSessionFrameTypes.ts";
import type { ClaudeAgentSdkQuerySession } from "./ClaudeQueryRunnerTypes.ts";
import { CLAUDE_PROVIDER } from "./ClaudeProviderIdentity.ts";
import { claudeFocusRequestedPanePlugin } from "./ClaudeSessionTypes.ts";
import { claudeUsageLimitResetAt } from "./ClaudeApprovals.ts";
import { describeClaudeUsageLimit } from "./ClaudeAssistantArtifacts.ts";
import { isClaudeNonSubagentTask } from "./ClaudeToolClassification.ts";

export type Deps = PrevDeps & ReturnType<typeof installFrameC>;

export const installFrame = (s: Deps) => {
  const { adapterOptions, idAllocator, input } = s.env;
  const {
    now,
    activeTurn,
    queryContext,
    sessionSubagentsByTaskId,
    settledTurnByNativeThread,
    subagentStopOutcomes,
    wakeBuffers,
    nestedSubagentTaskIds,
    trackClaudeMonitorCalls,
    claudeTaskOutcome,
    emitProviderEvent,
    trackClaudeGoal,
    resolveItemOrdinal,
    discardBufferedSubagentStarts,
    updateClaudeSubagentNode,
    finalizeActiveTurn,
    applyWorkflowProgressWithoutTurn,
    bufferWakeMessage,
    applyBackgroundTaskRosterMessage,
    settledTurnForSubagentFrame,
    handleFramePartA,
    handleFramePartB,
    handleFramePartC,
  } = s;
  const handleSdkMessageFrame = Effect.fnUntraced(function* (input: {
    readonly query: ClaudeAgentSdkQuerySession;
    readonly message: SDKMessage;
    readonly replayed?: boolean;
  }) {
    const liveQuery = yield* Ref.get(queryContext);
    if (liveQuery?.query !== input.query) {
      return;
    }

    const message = input.message;
    // Track before routing: idle-wake Monitors report tasks before replaying their tool calls.
    yield* trackClaudeMonitorCalls(message);
    // Update before routing because the idle wake gate reads this.
    if (
      message.type === "system" &&
      message.subtype === "task_started" &&
      !isClaudeNonSubagentTask(message) &&
      (message.spawn_depth ?? 1) > 1
    ) {
      yield* Ref.update(nestedSubagentTaskIds, (current) =>
        current.has(message.task_id) ? current : new Set(current).add(message.task_id),
      );
    }
    if (message.type === "rate_limit_event") {
      const rateLimitInfo = message.rate_limit_info;
      if (!rateLimitInfo) return;
      const names = adapterOptions.scopedLimitNames
        ? yield* Ref.get(adapterOptions.scopedLimitNames)
        : { overageIncluded: undefined };
      const update = claudeRateLimitEventToUpdate(rateLimitInfo, names);
      const now = yield* DateTime.now;
      if (update && adapterOptions.onUsageLimits) {
        yield* adapterOptions.onUsageLimits({
          ...update,
          checkedAt: DateTime.formatIso(now),
        });
      }
      const context = yield* Ref.get(activeTurn);
      if (context === null) {
        yield* bufferWakeMessage({
          nativeThreadId: liveQuery.nativeThreadId,
          message,
        });
        return;
      }
      const overageAllowed =
        rateLimitInfo.overageStatus === "allowed" ||
        rateLimitInfo.overageStatus === "allowed_warning" ||
        rateLimitInfo.isUsingOverage === true ||
        rateLimitInfo.overageInUse === true;
      const blocked = rateLimitInfo.status === "rejected" && !overageAllowed;
      const limitType = rateLimitInfo.rateLimitType ?? "unknown";
      if (blocked) {
        context.rejectedRateLimitTypes.add(limitType);
        context.rateLimitResetTimes.set(limitType, claudeUsageLimitResetAt(rateLimitInfo.resetsAt));
      } else if (
        rateLimitInfo.status === "allowed" ||
        rateLimitInfo.status === "allowed_warning" ||
        overageAllowed
      ) {
        context.rejectedRateLimitTypes.delete(limitType);
        context.rateLimitResetTimes.delete(limitType);
      }
      if (blocked) {
        const limitKey = `${limitType}:${rateLimitInfo.resetsAt ?? "unknown"}`;
        if (!context.announcedUsageLimits.has(limitKey)) {
          context.announcedUsageLimits.add(limitKey);
          const nativeItemId = `usage-limit:${context.providerTurnId}:${limitKey}`;
          const notice = describeClaudeUsageLimit(
            rateLimitInfo,
            DateTime.toEpochMillis(now),
            names,
          );
          yield* emitProviderEvent({
            type: "turn_item.updated",
            driver: CLAUDE_PROVIDER,
            turnItem: {
              id: idAllocator.derive.turnItemFromProviderItem({
                driver: CLAUDE_PROVIDER,
                nativeItemId,
              }),
              threadId: context.input.threadId,
              runId: context.input.runId,
              nodeId: context.input.rootNodeId,
              providerThreadId: context.input.providerThread.id,
              providerTurnId: context.providerTurnId,
              nativeItemRef: {
                driver: CLAUDE_PROVIDER,
                nativeId: nativeItemId,
                strength: "weak",
              },
              parentItemId: null,
              ordinal: yield* resolveItemOrdinal(context, nativeItemId),
              type: "system_notice",
              status: "completed",
              title: notice,
              message: notice,
              startedAt: now,
              completedAt: now,
              updatedAt: now,
            },
          });
        }
      }
      return;
    }
    const context =
      (yield* Ref.get(activeTurn)) ??
      (yield* settledTurnForSubagentFrame(liveQuery.nativeThreadId, message));
    if (context === null) {
      yield* applyWorkflowProgressWithoutTurn(message);
      // Buffer wake evidence before clearing the task from the roster.
      if (message.type === "system" && message.subtype === "task_notification") {
        yield* bufferWakeMessage({ nativeThreadId: liveQuery.nativeThreadId, message });
        yield* applyBackgroundTaskRosterMessage({
          nativeThreadId: liveQuery.nativeThreadId,
          message,
          activeContext: null,
        });
        const registered = (yield* Ref.get(sessionSubagentsByTaskId)).get(message.task_id);
        const settled = settledTurnByNativeThread.get(liveQuery.nativeThreadId);
        const hasBufferedStart =
          (yield* Ref.get(wakeBuffers))
            .get(liveQuery.nativeThreadId)
            ?.messages.some(
              (entry) =>
                entry.type === "system" &&
                entry.subtype === "task_started" &&
                entry.task_id === message.task_id,
            ) ?? false;
        const canApplyOutcome =
          subagentStopOutcomes.has(message.task_id) ||
          (!hasBufferedStart && registered?.task.workflow === undefined);
        if (registered !== undefined && settled !== undefined && canApplyOutcome) {
          yield* discardBufferedSubagentStarts(liveQuery.nativeThreadId, message.task_id, message);
          yield* updateClaudeSubagentNode({
            context: settled,
            taskId: message.task_id,
            ...(message.tool_use_id === undefined ? {} : { toolUseId: message.tool_use_id }),
            workflowFrame: message,
            nativeOutcome: message,
            result: message.summary,
            status: claudeTaskOutcome(message.status),
            onlyIfRunningInRun: registered.task.runId,
          });
        }
      } else {
        yield* applyBackgroundTaskRosterMessage({
          nativeThreadId: liveQuery.nativeThreadId,
          message,
          activeContext: null,
        });
        yield* bufferWakeMessage({ nativeThreadId: liveQuery.nativeThreadId, message });
      }
      return;
    }
    const focusedPlugin = claudeFocusRequestedPanePlugin(message);
    if (focusedPlugin !== null && context === (yield* Ref.get(activeTurn))) {
      yield* Effect.logWarning("orchestration-v2.claude-mod-pane-focus-unsupported", {
        providerTurnId: context.providerTurnId,
        plugin: focusedPlugin,
      });
      liveQuery.stopping = true;
      yield* finalizeActiveTurn({
        context,
        status: "failed",
        completedAt: yield* DateTime.now,
        failure: makeProviderFailure({
          class: "provider_error",
          code: "claude_mod_ui_unsupported",
          message: `The Claude Code mod "${focusedPlugin}" is waiting for input in its terminal pane, which T3 Code cannot show. Disable the mod for sessions run from T3 Code, or run the task in the Claude Code terminal.`,
        }),
      });
      // Closing ends the CLI process and abandons the held tool call
      // without answering it. Not interrupt: the held CLI may never ack it.
      yield* liveQuery.query.close.pipe(Effect.ignore);
      return;
    }
    yield* trackClaudeGoal({ nativeThreadId: liveQuery.nativeThreadId, context, message });

    const frame: ClaudeSdkFrame = {
      query: input.query,
      message,
      replayed: input.replayed,
      liveQuery,
      context,
    };
    if (yield* handleFramePartA(frame)) return;
    if (yield* handleFramePartB(frame)) return;
    if (yield* handleFramePartC(frame)) return;
  });
  return {
    handleSdkMessageFrame,
  };
};
