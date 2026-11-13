// @effect-diagnostics nodeBuiltinImport:off -- the SDK takes a Node ChildProcess for the CLI.
import { text } from "../unknownField.ts";

import { parseClaudeWorkflowRunHandles } from "./claudeWorkflowProgress.ts";

import { addClaudeLedgerUsage } from "../../provider/ClaudeTurnTokenUsage.ts";

import { isCompactionCommandMessage } from "@t3tools/contracts";

import * as DateTime from "effect/DateTime";

import * as Effect from "effect/Effect";

import * as FileSystem from "effect/FileSystem";

import * as Path from "effect/Path";

import * as Ref from "effect/Ref";

import { mcpToolPresentation } from "@t3tools/provider-core/server/mcpToolPresentation";

import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import type { Deps as PrevDeps } from "./claudeSessionFrameB.ts";
import { installFrameB } from "./claudeSessionFrameB.ts";
import type { ClaudeSdkFrame } from "./claudeSessionFrameTypes.ts";
import { CLAUDE_TASK_TOOL_NAMES } from "./ClaudeSessionTypes.ts";
import { EMPTY_CLAUDE_NATIVE_TOOL_INPUT } from "./ClaudeToolClassification.ts";
import { applyClaudeTaskTool } from "./ClaudeSessionTypes.ts";
import { assistantTextFromSdkMessage } from "./ClaudeProviderMessages.ts";
import { claudeNativeToolInputFromUnknown } from "./ClaudeToolClassification.ts";
import { claudeNativeToolInputValue } from "./ClaudeToolClassification.ts";
import { claudeNativeToolOutputValue } from "./ClaudeToolClassification.ts";
import { claudeSubagentResultText } from "./ClaudeToolClassification.ts";
import { claudeTaskField } from "./ClaudeSessionTypes.ts";
import { claudeTaskSteps } from "./ClaudeSessionTypes.ts";
import { claudeTodoSteps } from "./ClaudeSessionTypes.ts";
import { claudeToolNonExecutionKind } from "./ClaudeToolClassification.ts";
import { claudeToolPresentationsFromAssistantMessage } from "./ClaudeToolClassification.ts";
import { claudeToolResultEntriesFromMessage } from "./ClaudeToolClassification.ts";
import { claudeToolUseBlocksFromAssistantMessage } from "./ClaudeToolClassification.ts";
import { isClaudeActiveSteeringAbortResult } from "./ClaudeApprovals.ts";
import { isClaudeGoalAcknowledgement } from "./ClaudeProviderMessages.ts";
import { isClaudeProviderContinuationTurn } from "./ClaudeApprovals.ts";
import { isClaudeSubagentAsyncLaunchAck } from "./ClaudeToolClassification.ts";
import { isClaudeTaskNotificationOriginResult } from "./ClaudeApprovals.ts";
import { isClaudeToolResultError } from "./ClaudeToolClassification.ts";
import { normalizeClaudeResultText } from "./ClaudeProviderMessages.ts";
import { parentToolUseIdFromSdkMessage } from "./ClaudeToolClassification.ts";
import { providerFailureFromResult } from "./ClaudeApprovals.ts";
import { readClaudeTaskList } from "./ClaudeSessionTypes.ts";
import { rememberClaudeSubagentLaunch } from "./ClaudeSessionTypes.ts";
import { resultTextFromSdkMessage } from "./ClaudeProviderMessages.ts";
import { terminalStatusFromResult } from "./ClaudeApprovals.ts";
import { toolNameFromClaudeToolResult } from "./ClaudeToolClassification.ts";

export type Deps = PrevDeps & ReturnType<typeof installFrameB>;

export const installFrameC = (s: Deps) => {
  const { adapterOptions, fileSystem, path, subagentModelCatalog } = s.env;
  const {
    now,
    interruptedTurns,
    steeredTurns,
    resultLedgerUsage,
    resultsReportingNewContextWindow,
    taskListsByNativeThread,
    pendingSubagentLaunchesByToolUseId,
    bufferedResultArrivals,
    clearWakeReports,
    heldProposedPlansByToolUseId,
    emitContextUsage,
    markAbsorbedWake,
    emitSubagentConversationMessage,
    updateClaudeSubagentNode,
    emitClaudePlanProjection,
    resolveSubagentByToolUseId,
    findToolCall,
    toolCallsFor,
    ensureToolCallStarted,
    subagentProjectionTarget,
    settleToolCall,
    emitSubagentThinking,
    finalizeActiveTurn,
    emitAssistantTextArtifacts,
  } = s;
  const handleFramePartC = Effect.fnUntraced(function* (frame: ClaudeSdkFrame) {
    const { message, liveQuery, context } = frame;
    const toolPresentations = claudeToolPresentationsFromAssistantMessage(message);
    for (const toolUse of claudeToolUseBlocksFromAssistantMessage(message)) {
      const nativeToolInput = claudeNativeToolInputFromUnknown(toolUse.input);
      if (toolUse.name === "Agent") {
        rememberClaudeSubagentLaunch(
          subagentModelCatalog,
          context,
          pendingSubagentLaunchesByToolUseId,
          toolUse.id,
          nativeToolInput,
          parentToolUseIdFromSdkMessage(message),
        );
        continue;
      }
      if (toolUse.name === "TodoWrite" && parentToolUseIdFromSdkMessage(message) === null) {
        yield* emitClaudePlanProjection({
          context,
          nativeItemId: toolUse.id,
          kind: "todo_list",
          steps: claudeTodoSteps(nativeToolInput),
        }).pipe(Effect.orDie);
      }
      yield* ensureToolCallStarted({
        context,
        nativeItemId: toolUse.id,
        toolName: toolUse.name,
        toolInput: nativeToolInput,
        parentToolUseId: parentToolUseIdFromSdkMessage(message),
        presentation:
          toolPresentations.get(toolUse.id) ??
          mcpToolPresentation({
            toolName: toolUse.name.replace(/^mcp__claude_ai_/u, "mcp__"),
          }),
      });
      const heldPlan = heldProposedPlansByToolUseId.get(toolUse.id);
      if (heldPlan !== undefined) {
        heldProposedPlansByToolUseId.delete(toolUse.id);
        yield* emitClaudePlanProjection({
          context,
          nativeItemId: toolUse.id,
          kind: "proposed_plan",
          markdown: heldPlan,
        }).pipe(Effect.orDie);
      }
    }

    for (const { toolResult, output } of claudeToolResultEntriesFromMessage(message)) {
      // A foreground fork's stream opens with a placeholder result for its own launch call.
      if (parentToolUseIdFromSdkMessage(message) === toolResult.tool_use_id) continue;
      const subagent = yield* resolveSubagentByToolUseId(context, toolResult.tool_use_id);
      const runHandles = parseClaudeWorkflowRunHandles(claudeNativeToolOutputValue(output));
      if (subagent !== undefined && runHandles !== undefined) {
        yield* updateClaudeSubagentNode({
          context,
          taskId: subagent.task.nativeTaskRef?.nativeId ?? String(subagent.task.id),
          toolUseId: toolResult.tool_use_id,
          workflowRunHandles: runHandles,
          status: "running",
        });
      }
      // Resume tool results only acknowledge delivery; only Agent launch results may settle subagents.
      // Agent tool_uses project as subagent rows and never enter toolCalls.
      if (subagent !== undefined && findToolCall(context, toolResult.tool_use_id) === undefined) {
        // Background Agent launches ACK immediately; only task_notification settles them.
        if (
          !isClaudeToolResultError(toolResult) &&
          (runHandles !== undefined || isClaudeSubagentAsyncLaunchAck(output))
        ) {
          continue;
        }
        const result = claudeSubagentResultText(output);
        yield* updateClaudeSubagentNode({
          context,
          taskId: subagent.task.nativeTaskRef?.nativeId ?? String(subagent.task.id),
          toolUseId: toolResult.tool_use_id,
          ...(result.length === 0 ? {} : { result }),
          status: isClaudeToolResultError(toolResult) ? "failed" : "completed",
        });
        continue;
      }
      const parentToolUseId = parentToolUseIdFromSdkMessage(message);
      const toolCall =
        findToolCall(context, toolResult.tool_use_id) ??
        (yield* ensureToolCallStarted({
          context,
          nativeItemId: toolResult.tool_use_id,
          toolName: toolNameFromClaudeToolResult(toolResult),
          toolInput: EMPTY_CLAUDE_NATIVE_TOOL_INPUT,
          parentToolUseId,
        }));
      yield* settleToolCall({
        context,
        toolCall,
        registry: toolCallsFor(context, toolCall),
        message,
        toolResult,
        output,
        completedAt: yield* DateTime.now,
      });
      // Subagents write to the session's shared task store, so their
      // task tools update the parent turn's list. Failed or never-run
      // calls changed nothing.
      if (
        claudeToolNonExecutionKind(message, toolResult.tool_use_id) === undefined &&
        !isClaudeToolResultError(toolResult) &&
        CLAUDE_TASK_TOOL_NAMES.has(toolCall.toolName)
      ) {
        const taskLists = yield* Ref.get(taskListsByNativeThread);
        const knownTaskList = taskLists.get(liveQuery.nativeThreadId);
        const outputValue = claudeNativeToolOutputValue(output);
        // A structured TaskList already supplies a snapshot. Anything else, including
        // a subagent's text-only TaskList, needs Claude's persisted list once;
        // afterward the cache also records an unavailable store.
        const storedTaskList =
          !taskLists.has(liveQuery.nativeThreadId) &&
          !(
            toolCall.toolName === "TaskList" && Array.isArray(claudeTaskField(outputValue, "tasks"))
          )
            ? yield* readClaudeTaskList({
                environment: adapterOptions.environment,
                cwd: context.input.runtimePolicy.cwd,
                nativeThreadId: liveQuery.nativeThreadId,
              }).pipe(
                Effect.provideService(FileSystem.FileSystem, fileSystem),
                Effect.provideService(Path.Path, path),
              )
            : undefined;
        const taskList =
          applyClaudeTaskTool(
            knownTaskList ?? storedTaskList ?? new Map(),
            toolCall.toolName,
            claudeNativeToolInputValue(toolCall.input),
            outputValue,
          ) ?? storedTaskList;
        yield* Ref.set(
          taskListsByNativeThread,
          new Map(taskLists).set(liveQuery.nativeThreadId, taskList ?? knownTaskList),
        );
        if (taskList !== undefined) {
          yield* emitClaudePlanProjection({
            context,
            nativeItemId: `claude-tasks:${context.providerTurnId}`,
            kind: "todo_list",
            steps: claudeTaskSteps(taskList),
          }).pipe(Effect.orDie);
        }
      }
    }

    const assistantParentToolUseId = parentToolUseIdFromSdkMessage(message);
    if (message.type === "assistant" && assistantParentToolUseId !== null) {
      const thinking = message.message.content.flatMap((block) =>
        block.type === "thinking" && block.thinking.trim().length > 0 ? [block.thinking] : [],
      );
      const subagent =
        thinking.length === 0
          ? undefined
          : yield* resolveSubagentByToolUseId(context, assistantParentToolUseId);
      if (subagent !== undefined) {
        yield* emitSubagentThinking(
          subagentProjectionTarget(subagent),
          message,
          yield* DateTime.now,
        );
      }
    }
    const assistantText = assistantTextFromSdkMessage(message);
    if (
      assistantText !== null &&
      assistantText.text.length > 0 &&
      assistantParentToolUseId !== null
    ) {
      const subagent = yield* resolveSubagentByToolUseId(context, assistantParentToolUseId);
      if (subagent === undefined) {
        return true;
      }
      const now = yield* DateTime.now;
      const nativeMessageId =
        message.type === "assistant" && typeof message.message.id === "string"
          ? message.message.id
          : null;
      subagent.lastAssistantText =
        nativeMessageId !== null && nativeMessageId === subagent.lastAssistantMessageId
          ? `${subagent.lastAssistantText ?? ""}\n${assistantText.text}`
          : assistantText.text;
      subagent.lastAssistantMessageId = nativeMessageId;
      yield* emitSubagentConversationMessage({
        nativeItemId: assistantText.nativeItemId,
        threadId: subagent.childThreadId,
        rootNodeId: subagent.childRootNodeId,
        role: "assistant",
        text: assistantText.text,
        ordinal: ++subagent.nextChildItemOrdinal,
        now,
      });
      return true;
    }
    if (isClaudeGoalAcknowledgement(message)) {
      // The CLI repeats a local command's output as the turn's result text.
      if (assistantText !== null) {
        context.assistant.noticeTexts.add(normalizeClaudeResultText(assistantText.text));
      }
      return true;
    }
    // Claude Code echoes /compact's stdout ("Not enough messages to compact.") as a
    // synthetic assistant message. The compaction item reports that outcome; it is not a
    // reply.
    if (
      message.type === "assistant" &&
      "local_command_source" in message &&
      isCompactionCommandMessage({ role: "user", ...context.input.message })
    ) {
      return true;
    }
    if (assistantText !== null && assistantText.text.length > 0) {
      yield* emitAssistantTextArtifacts({
        context,
        nativeItemId: assistantText.nativeItemId,
        text: assistantText.text,
      });
      return true;
    }

    if (
      isClaudeTaskNotificationOriginResult(message) &&
      !isClaudeProviderContinuationTurn(context.input) &&
      message.num_turns === 0
    ) {
      yield* Effect.logDebug("orchestration-v2.claude-task-notification-result-dropped", {
        providerTurnId: context.providerTurnId,
        num_turns: message.num_turns,
        stop_reason: message.stop_reason,
        terminal_reason: message.terminal_reason,
        uuid: message.uuid,
        session_id: message.session_id,
        createdBy: context.input.message.createdBy,
        creationSource: context.input.message.creationSource,
      });
      return true;
    }

    if (
      isClaudeTaskNotificationOriginResult(message) &&
      !isClaudeProviderContinuationTurn(context.input)
    ) {
      yield* clearWakeReports(liveQuery.nativeThreadId);
      yield* Effect.logInfo("orchestration-v2.claude-task-notification-result-accepted", {
        providerTurnId: context.providerTurnId,
        num_turns: message.num_turns,
        stop_reason: message.stop_reason,
        terminal_reason: message.terminal_reason,
        uuid: message.uuid,
        session_id: message.session_id,
        createdBy: context.input.message.createdBy,
        creationSource: context.input.message.creationSource,
      });
    }

    const resultText =
      message.type === "result" &&
      ((message.subtype === "success" && message.is_error) ||
        terminalStatusFromResult(message) === "failed")
        ? null
        : resultTextFromSdkMessage(message);
    if (
      // A /compact's result text reports the compaction ("Not enough messages to
      // compact."), which its compaction item already carries; it is not a reply.
      !(
        message.type === "result" &&
        message.subtype === "success" &&
        message.local_command === "compact"
      ) &&
      context.assistant.emittedNativeItemIds.size === 0 &&
      context.assistant.fallbackText.length === 0 &&
      resultText !== null &&
      resultText.text.length > 0 &&
      !context.assistant.noticeTexts.has(resultText.text) &&
      !context.assistant.noticeTexts.has(normalizeClaudeResultText(resultText.text))
    ) {
      context.assistant.fallbackText = resultText.text;
      context.assistant.fallbackNativeItemId = resultText.nativeItemId;
    }

    if (message.type === "result") {
      const contextUsage = context.streamUsage?.usage ?? context.compactionTokens;
      if (resultsReportingNewContextWindow.has(message) && contextUsage !== undefined) {
        yield* emitContextUsage(context, contextUsage);
      }
      const completedAt = yield* DateTime.now;
      const interrupted = (yield* Ref.get(interruptedTurns)).has(context.providerTurnId);
      const wasSteered = (yield* Ref.get(steeredTurns)).has(context.providerTurnId);
      if (!interrupted && wasSteered && isClaudeActiveSteeringAbortResult(message)) {
        context.steeredSegmentUsage.push(message.usage);
        context.steeredLedgerUsage = addClaudeLedgerUsage(
          context.steeredLedgerUsage,
          resultLedgerUsage.get(message),
        );
        return true;
      }
      yield* Ref.update(steeredTurns, (current) => {
        const next = new Set(current);
        next.delete(context.providerTurnId);
        return next;
      });
      if (!isClaudeProviderContinuationTurn(context.input)) {
        yield* markAbsorbedWake(liveQuery.nativeThreadId);
      }
      const usageLimited =
        context.authenticationFailureMessage === undefined &&
        (context.rejectedRateLimitTypes.size > 0 || context.latestAssistantRateLimit !== null) &&
        (message.subtype !== "success" ||
          message.api_error_status == null ||
          message.api_error_status === 429) &&
        (message.terminal_reason == null ||
          message.terminal_reason === "api_error" ||
          message.terminal_reason === "blocking_limit");
      // The CLI also labels 403 authentication_failed; show its text because login cannot grant access.
      const permissionDenied = message.subtype === "success" && message.api_error_status === 403;
      const failureHint = permissionDenied
        ? message.result
        : (context.authenticationFailureMessage ??
          (usageLimited
            ? "Claude usage limit reached. Send the message again once the limit resets."
            : undefined));
      // Usage-limited /compact reports success; fail it so queued messages wait for the limit to clear.
      const limitedCompaction =
        usageLimited && message.subtype === "success" && message.local_command === "compact"
          ? context.compactionFailure
          : null;
      const resetTimes = Array.from(context.rateLimitResetTimes.values());
      const assistantLimit = context.latestAssistantRateLimit;
      if (assistantLimit?.type != null && !context.rateLimitResetTimes.has(assistantLimit.type)) {
        resetTimes.push(assistantLimit.resetAt);
      }
      const resetAt =
        resetTimes.length > 0 && resetTimes.every((time) => time !== null)
          ? resetTimes.reduce((latest, time) => (time! > latest ? time! : latest), "")
          : null;
      const resultFailure = interrupted
        ? null
        : limitedCompaction !== null
          ? makeProviderFailure({
              class: "usage_limit",
              message: limitedCompaction.message ?? failureHint,
              code: "compaction_failed",
            })
          : providerFailureFromResult(
              message,
              bufferedResultArrivals.get(message) ?? completedAt,
              failureHint,
              usageLimited,
            );
      const terminalFailure =
        resultFailure?.class === "usage_limit"
          ? { ...resultFailure, resetAt: resetAt ?? resultFailure.resetAt ?? null }
          : resultFailure;
      yield* finalizeActiveTurn({
        context,
        status: interrupted
          ? "interrupted"
          : limitedCompaction !== null
            ? "failed"
            : terminalStatusFromResult(message, failureHint),
        completedAt,
        result: message,
        ...(terminalFailure === null ? {} : { failure: terminalFailure }),
      });
    }
    return false;
  });
  return {
    handleFramePartC,
  };
};
