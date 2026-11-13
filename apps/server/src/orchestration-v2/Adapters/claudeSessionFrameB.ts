// @effect-diagnostics nodeBuiltinImport:off -- the SDK takes a Node ChildProcess for the CLI.
import { tailClaudeTaskOutput } from "./ClaudeTaskOutputTail.ts";

import { field, text } from "../unknownField.ts";

import { CLAUDE_WORKFLOW_TASK_TYPE, hasClaudeWorkflowSnapshot } from "./claudeWorkflowProgress.ts";

import type { OrchestrationV2ProviderRetry } from "@t3tools/contracts";

import * as DateTime from "effect/DateTime";

import * as Deferred from "effect/Deferred";

import * as Effect from "effect/Effect";

import * as FileSystem from "effect/FileSystem";

import * as Path from "effect/Path";

import * as Ref from "effect/Ref";

import { makeProviderRetryTurnItem } from "@t3tools/provider-core/server/failure";
import type { Deps as PrevDeps } from "./claudeSessionFrameA.ts";
import { installFrameA } from "./claudeSessionFrameA.ts";
import type { ClaudeSdkFrame } from "./claudeSessionFrameTypes.ts";
import { CLAUDE_PROVIDER } from "./ClaudeProviderIdentity.ts";
import { PENDING_CLAUDE_SUBAGENT_CAP } from "./ClaudeSessionTypes.ts";
import { PENDING_CLAUDE_SUBAGENT_FRAME_CAP } from "./ClaudeSessionTypes.ts";
import { canonicalClaudeSubagentModel } from "./ClaudeSessionTypes.ts";
import { claudeMessageInputTokens } from "./ClaudeProviderIdentity.ts";
import { claudeTaskTypeFromSdkMessage } from "./ClaudeToolClassification.ts";
import { isClaudeBackgroundTasksChangedMessage } from "./ClaudeToolClassification.ts";
import { isClaudeNonSubagentTask } from "./ClaudeToolClassification.ts";
import { isClaudeProviderContinuationTurn } from "./ClaudeApprovals.ts";
import { parentToolUseIdFromSdkMessage } from "./ClaudeToolClassification.ts";
import { providerFailureFromApiRetry } from "./ClaudeApprovals.ts";
import { rememberPendingClaudeSubagentLaunch } from "./ClaudeSessionTypes.ts";
import type { ActiveClaudeProviderRetry } from "./ClaudeAssistantArtifacts.ts";

export type Deps = PrevDeps & ReturnType<typeof installFrameA>;

export const installFrameB = (s: Deps) => {
  const { fileSystem, path, idAllocator, subagentModelCatalog } = s.env;
  const {
    sessionScope,
    now,
    taskOutputTails,
    providerRetries,
    sessionSubagentsByTaskId,
    pendingSubagentLaunchesByToolUseId,
    appliedSubagentOutcomes,
    pendingSubagentFramesByToolUseId,
    wakeBuffers,
    backgroundedSubagentTaskIds,
    isNestedSubagentTask,
    recordWakeReport,
    claudeTaskOutcome,
    opaqueTaskWakeReport,
    emitProviderEvent,
    emitContextUsage,
    completeProviderRetry,
    hasPendingBackgroundTaskOnNativeThread,
    isKnownOpaqueBackgroundTaskOnNativeThread,
    clearOpaqueBackgroundTaskReplayTombstone,
    resolveItemOrdinal,
    recoverResumedClaudeSubagent,
    discardBufferedSubagentStarts,
    updateClaudeSubagentNode,
    resolveSubagentByToolUseId,
    findToolCall,
    applyBackgroundTaskRosterMessage,
  } = s;
  const handleFramePartB = Effect.fnUntraced(function* (frame: ClaudeSdkFrame) {
    const { message, liveQuery, context } = frame;
    if (message.type === "system" && message.subtype === "api_retry") {
      const updatedAt = yield* DateTime.now;
      const previous = (yield* Ref.get(providerRetries)).get(context.providerTurnId);
      const retry: OrchestrationV2ProviderRetry = {
        attempt: Math.max(1, Math.trunc(message.attempt)),
        maxAttempts: Math.max(1, Math.trunc(message.max_retries)),
        retryDelayMs: Math.max(0, Math.trunc(message.retry_delay_ms)),
      };
      const failure = providerFailureFromApiRetry(message);
      const itemOrdinal =
        previous?.itemOrdinal ??
        (yield* resolveItemOrdinal(context, `terminal-failure:${context.providerTurnId}`));
      const state: ActiveClaudeProviderRetry = {
        retry,
        failure,
        startedAt: previous?.startedAt ?? updatedAt,
        itemOrdinal,
      };
      yield* Ref.update(providerRetries, (current) => {
        const updated = new Map(current);
        updated.set(context.providerTurnId, state);
        return updated;
      });
      yield* emitProviderEvent({
        type: "turn_item.updated",
        driver: CLAUDE_PROVIDER,
        turnItem: makeProviderRetryTurnItem({
          driver: CLAUDE_PROVIDER,
          threadId: context.input.threadId,
          runId: context.input.runId,
          nodeId: context.input.rootNodeId,
          providerThreadId: context.input.providerThread.id,
          providerTurnId: context.providerTurnId,
          itemOrdinal,
          failure,
          retry,
          status: "running",
          startedAt: state.startedAt,
          updatedAt,
        }),
      });
      return true;
    }

    if (message.type === "assistant" && frame.replayed !== true) {
      const now = yield* DateTime.now;
      yield* completeProviderRetry(context, now);
      // CLI-generated <synthetic> frames report zero usage, not context usage.
      if (
        message.parent_tool_use_id === null &&
        message.message.usage !== undefined &&
        message.message.model !== "<synthetic>"
      ) {
        const snapshotUsage = message.message.usage;
        const stream = context.streamUsage;
        if (stream === null || stream.messageId !== message.message.id) {
          context.streamUsage = { messageId: message.message.id, usage: snapshotUsage };
          yield* emitContextUsage(context, snapshotUsage);
        } else if (
          stream.usage !== null &&
          claudeMessageInputTokens(stream.usage) <= 0 &&
          claudeMessageInputTokens(snapshotUsage) > 0
        ) {
          stream.usage = {
            ...snapshotUsage,
            output_tokens: Math.max(snapshotUsage.output_tokens, stream.usage.output_tokens),
          };
          yield* emitContextUsage(context, stream.usage);
        }
      }
      const parentToolUseId = message.parent_tool_use_id;
      const snapshotModel =
        typeof message.message.model === "string" ? message.message.model.trim() : "";
      // "<synthetic>" identifies CLI notices, not the subagent model.
      const model =
        snapshotModel.length === 0 || snapshotModel === "<synthetic>"
          ? undefined
          : canonicalClaudeSubagentModel(subagentModelCatalog, snapshotModel);
      if (parentToolUseId !== null && model !== undefined) {
        const subagent = yield* resolveSubagentByToolUseId(context, parentToolUseId);
        if (subagent === undefined) {
          rememberPendingClaudeSubagentLaunch(pendingSubagentLaunchesByToolUseId, parentToolUseId, {
            model,
          });
        } else if (subagent.task.status === "running" && subagent.task.model !== model) {
          yield* updateClaudeSubagentNode({
            context,
            taskId: subagent.task.nativeTaskRef?.nativeId ?? String(subagent.task.id),
            toolUseId: parentToolUseId,
            model,
            status: subagent.task.status,
          });
        }
      }
    }

    const frameParentToolUseId = parentToolUseIdFromSdkMessage(message);
    if (
      frameParentToolUseId !== null &&
      (yield* resolveSubagentByToolUseId(context, frameParentToolUseId)) === undefined
    ) {
      const droppedToolUseId = yield* Ref.modify(pendingSubagentFramesByToolUseId, (current) => {
        const frames = current.get(frameParentToolUseId) ?? [];
        if (frames.length >= PENDING_CLAUDE_SUBAGENT_FRAME_CAP) {
          return [frameParentToolUseId, current] as const;
        }
        const next = new Map(current).set(frameParentToolUseId, [...frames, message]);
        const oldest = next.keys().next();
        if (next.size > PENDING_CLAUDE_SUBAGENT_CAP && !oldest.done) {
          next.delete(oldest.value);
          return [oldest.value, next] as const;
        }
        return [null, next] as const;
      });
      if (droppedToolUseId !== null) {
        yield* Effect.logWarning("orchestration-v2.claude-subagent-frames-dropped", {
          providerTurnId: context.providerTurnId,
          parentToolUseId: droppedToolUseId,
        });
      }
      return true;
    }

    if (isClaudeBackgroundTasksChangedMessage(message)) {
      yield* applyBackgroundTaskRosterMessage({
        nativeThreadId: liveQuery.nativeThreadId,
        message,
        activeContext: context,
      });
      return true;
    }

    if (message.type === "system" && message.subtype === "task_started") {
      if (isClaudeNonSubagentTask(message)) {
        const tailedCall =
          message.tool_use_id === undefined
            ? undefined
            : findToolCall(context, message.tool_use_id);
        if (
          liveQuery.taskOutputRoot !== undefined &&
          message.task_type === "local_bash" &&
          // Older Claude Code builds omit the flag on foreground calls.
          message.is_backgrounded !== true &&
          tailedCall?.classification.itemType === "command_execution" &&
          !taskOutputTails.has(tailedCall.nativeItemId)
        ) {
          const itemId = idAllocator.derive.turnItemFromProviderItem({
            driver: CLAUDE_PROVIDER,
            nativeItemId: tailedCall.nativeItemId,
          });
          const stop = yield* Deferred.make<void>();
          const fiber = yield* tailClaudeTaskOutput({
            root: liveQuery.taskOutputRoot,
            sessionId: message.session_id,
            taskId: message.task_id,
            stop,
            onChunk: (chunk) =>
              emitProviderEvent({
                type: "command_output.delta",
                driver: CLAUDE_PROVIDER,
                threadId: tailedCall.threadId,
                itemId,
                chunk,
              }),
          }).pipe(
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provideService(Path.Path, path),
            Effect.forkIn(sessionScope),
          );
          taskOutputTails.set(tailedCall.nativeItemId, { fiber, stop });
        }
        context.ignoredTaskIds.add(message.task_id);
        yield* applyBackgroundTaskRosterMessage({
          nativeThreadId: liveQuery.nativeThreadId,
          message,
          activeContext: context,
        });
      } else {
        const launch =
          message.tool_use_id === undefined
            ? undefined
            : pendingSubagentLaunchesByToolUseId.get(message.tool_use_id);
        if (message.tool_use_id !== undefined) {
          pendingSubagentLaunchesByToolUseId.delete(message.tool_use_id);
        }
        const owner =
          launch?.ownerToolUseId === undefined
            ? undefined
            : yield* resolveSubagentByToolUseId(context, launch.ownerToolUseId);
        // Nested subagents default to their owner's model.
        const model = launch?.model ?? owner?.task.model ?? undefined;
        if (message.is_backgrounded === true && !(yield* isNestedSubagentTask(message.task_id))) {
          yield* Ref.update(backgroundedSubagentTaskIds, (current) =>
            new Set(current).add(message.task_id),
          );
        }
        yield* recoverResumedClaudeSubagent({
          context,
          nativeThreadId: liveQuery.nativeThreadId,
          taskId: message.task_id,
          toolUseId: message.tool_use_id,
          title: message.description,
        });
        const isWorkflow = claudeTaskTypeFromSdkMessage(message) === CLAUDE_WORKFLOW_TASK_TYPE;
        const workflowName = isWorkflow ? text(field(message, "workflow_name")) : undefined;

        yield* updateClaudeSubagentNode({
          context,
          taskId: message.task_id,
          ...(message.task_type === undefined ? {} : { nativeTaskType: message.task_type }),
          ...(message.tool_use_id === undefined ? {} : { toolUseId: message.tool_use_id }),
          ...(message.prompt === undefined ? {} : { prompt: message.prompt }),
          ...(model === undefined ? {} : { model }),
          ...(launch?.effort === undefined ? {} : { effort: launch.effort }),
          ...(owner === undefined ? {} : { owner }),
          ...(isWorkflow
            ? {
                workflowFrame: message,
                ...(workflowName === undefined ? {} : { workflowName }),
              }
            : {}),

          title: message.description,
          status: "running",
          reopen: true,
        });
        yield* Ref.update(wakeBuffers, (current) => {
          const entry = current.get(liveQuery.nativeThreadId);
          if (entry === undefined) return current;
          const replayIndex = entry.messages.indexOf(message);
          const messages = entry.messages.filter(
            (buffered, index) =>
              !(
                (replayIndex === -1 || index < replayIndex) &&
                buffered.type === "system" &&
                (buffered.subtype === "task_started" || buffered.subtype === "task_notification") &&
                buffered.task_id === message.task_id
              ),
          );
          return messages.length === entry.messages.length
            ? current
            : new Map(current).set(liveQuery.nativeThreadId, { ...entry, messages });
        });
      }
    }

    if (message.type === "system" && message.subtype === "task_progress") {
      const progress = message.description.trim();
      const isBackgroundTask = yield* hasPendingBackgroundTaskOnNativeThread(
        liveQuery.nativeThreadId,
        message.task_id,
      );
      const carriesWorkflowTelemetry = hasClaudeWorkflowSnapshot(message);
      const isWorkflowCoordinator =
        (yield* Ref.get(sessionSubagentsByTaskId)).get(message.task_id)?.task.workflow !==
        undefined;
      if (
        (carriesWorkflowTelemetry || (progress.length > 0 && !isWorkflowCoordinator)) &&
        !context.ignoredTaskIds.has(message.task_id) &&
        !isBackgroundTask
      ) {
        yield* updateClaudeSubagentNode({
          context,
          taskId: message.task_id,
          ...(message.tool_use_id === undefined ? {} : { toolUseId: message.tool_use_id }),
          ...(progress.length === 0 ? {} : { progress }),
          workflowFrame: message,
          status: "running",
        });
      }
    }

    if (message.type === "system" && message.subtype === "task_notification") {
      const isRegistered = (yield* Ref.get(sessionSubagentsByTaskId)).has(message.task_id);
      // A task whose start is still held for the next wake drain has no
      // node to finish yet; hold its outcome behind that start, or the
      // drain replays the start alone and the task stays running.
      if (!isRegistered) {
        yield* Ref.update(wakeBuffers, (current) => {
          const entry = current.get(liveQuery.nativeThreadId);
          if (
            entry === undefined ||
            entry.messages.includes(message) ||
            !entry.messages.some(
              (buffered) =>
                buffered.type === "system" &&
                buffered.subtype === "task_started" &&
                buffered.task_id === message.task_id,
            )
          ) {
            return current;
          }
          return new Map(current).set(liveQuery.nativeThreadId, {
            ...entry,
            messages: [...entry.messages, message],
          });
        });
      }
      if (!appliedSubagentOutcomes.has(message) && isRegistered) {
        yield* discardBufferedSubagentStarts(liveQuery.nativeThreadId, message.task_id, message);
      }
      const wasBackgroundTask = yield* isKnownOpaqueBackgroundTaskOnNativeThread(
        liveQuery.nativeThreadId,
        message.task_id,
      );
      if (!isClaudeProviderContinuationTurn(context.input)) {
        if (wasBackgroundTask) {
          yield* recordWakeReport(
            liveQuery.nativeThreadId,
            message.task_id,
            yield* opaqueTaskWakeReport(liveQuery.nativeThreadId, message),
          );
        } else if (
          !wasBackgroundTask &&
          (yield* Ref.get(backgroundedSubagentTaskIds)).has(message.task_id)
        ) {
          const registered = (yield* Ref.get(sessionSubagentsByTaskId)).get(message.task_id);
          yield* recordWakeReport(liveQuery.nativeThreadId, message.task_id, {
            kind: "subagent",
            label: registered?.task.title ?? undefined,
            outcome: claudeTaskOutcome(message.status),
            childThreadId: registered?.childThreadId,
          });
        }
      }
      yield* Ref.update(backgroundedSubagentTaskIds, (current) => {
        if (!current.has(message.task_id)) return current;
        const updated = new Set(current);
        updated.delete(message.task_id);
        return updated;
      });
      yield* applyBackgroundTaskRosterMessage({
        nativeThreadId: liveQuery.nativeThreadId,
        message,
        activeContext: context,
      });
      if (
        !wasBackgroundTask &&
        !context.ignoredTaskIds.has(message.task_id) &&
        !appliedSubagentOutcomes.has(message)
      ) {
        yield* updateClaudeSubagentNode({
          context,
          taskId: message.task_id,
          ...(message.tool_use_id === undefined ? {} : { toolUseId: message.tool_use_id }),
          workflowFrame: message,
          nativeOutcome: message,
          result: message.summary,
          status:
            message.status === "completed"
              ? "completed"
              : message.status === "stopped"
                ? "cancelled"
                : "failed",
        });
      }
      if (wasBackgroundTask) {
        yield* clearOpaqueBackgroundTaskReplayTombstone(liveQuery.nativeThreadId, message.task_id);
      }
    }
    return false;
  });
  return {
    handleFramePartB,
  };
};
