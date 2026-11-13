// @effect-diagnostics nodeBuiltinImport:off -- the SDK takes a Node ChildProcess for the CLI.
import { text } from "../unknownField.ts";

import {
  hasClaudeWorkflowSnapshot,
  mergeClaudeWorkflowProgress,
} from "./claudeWorkflowProgress.ts";

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import type {
  OrchestrationV2PendingBackgroundTask,
  OrchestrationV2Subagent,
} from "@t3tools/contracts";

import * as DateTime from "effect/DateTime";

import * as Effect from "effect/Effect";

import * as Ref from "effect/Ref";

import { backgroundWorkNotification } from "@t3tools/provider-core/server/notification";
import type { Deps as PrevDeps } from "./claudeSessionFinalize.ts";
import { installFinalize } from "./claudeSessionFinalize.ts";
import { CLAUDE_PROVIDER } from "./ClaudeProviderIdentity.ts";
import { claudePendingBackgroundTask } from "./ClaudeToolClassification.ts";
import { claudeTaskTypeFromSdkMessage } from "./ClaudeToolClassification.ts";
import { claudeToolResultBlocksFromAssistantMessage } from "./ClaudeToolClassification.ts";
import { claudeToolResultBlocksFromUserMessage } from "./ClaudeToolClassification.ts";
import { isClaudeBackgroundTasksChangedMessage } from "./ClaudeToolClassification.ts";
import { isClaudeNonSubagentTask } from "./ClaudeToolClassification.ts";
import { isClaudeRootTurnFrame } from "./ClaudeToolClassification.ts";
import { isClaudeTurnStartMessage } from "./ClaudeToolClassification.ts";
import { parentToolUseIdFromSdkMessage } from "./ClaudeToolClassification.ts";
import { parseClaudeBackgroundTaskEntry } from "./ClaudeToolClassification.ts";
import type { ActiveClaudeTurnContext } from "./ClaudeAssistantArtifacts.ts";

export type Deps = PrevDeps & ReturnType<typeof installFinalize>;

export const installWakeBuffer = (s: Deps) => {
  const { continuationRequests, input } = s.env;
  const {
    now,
    lastTurnRouteByNativeThread,
    wakeEligibleBackgroundTasksByNativeThread,
    lastProviderThreadByNativeThread,
    sessionSubagentsByTaskId,
    sessionSubagentTaskIdsByToolUseId,
    settledTurnByNativeThread,
    bufferedResultArrivals,
    wakeBuffers,
    isNestedSubagentTask,
    recordWakeReport,
    takeWakeReports,
    isClaudeMonitorTask,
    endClaudeMonitorTasks,
    claudeTaskOutcome,
    opaqueTaskWakeReport,
    requestedContinuations,
    emitProviderEvent,
    clearTaskIdFromNativeThreadSet,
    isWakeEligibleOpaqueBackgroundTaskOnNativeThread,
    consumeWakeEligibilityForBufferedNotification,
    emitProviderThreadRoster,
    replacePendingBackgroundTasks,
    upsertPendingBackgroundTask,
    clearPendingBackgroundTask,
    forgetAbsorbedWake,
    withWorkflowMemberThreadIds,
    projectClaudeWorkflowMembers,
    findToolCall,
  } = s;
  const applyWorkflowProgressWithoutTurn = Effect.fnUntraced(function* (message: SDKMessage) {
    if (message.type !== "system" || message.subtype !== "task_progress") return;
    if (!hasClaudeWorkflowSnapshot(message)) return;
    const taskId = message.task_id;
    const registered = (yield* Ref.get(sessionSubagentsByTaskId)).get(taskId);
    if (
      registered === undefined ||
      registered.task.workflow === undefined ||
      registered.task.status !== "running"
    )
      return;
    const workflow = mergeClaudeWorkflowProgress({
      previous: registered.task.workflow,
      message,
    });
    if (workflow === undefined) return;
    const now = yield* DateTime.now;
    const progress = text(message.description);
    const workflowWithThreads = withWorkflowMemberThreadIds(workflow, registered.childThreadId);
    const task = {
      ...registered.task,
      ...(progress === undefined ? {} : { progress }),
      workflow: workflowWithThreads,
      updatedAt: now,
    } satisfies OrchestrationV2Subagent;
    const coordinator = { ...registered, task };
    const accepted = yield* Ref.modify(sessionSubagentsByTaskId, (current) => {
      const latest = current.get(taskId);
      if (latest !== registered || latest.task.status !== "running") {
        return [false, current] as const;
      }
      return [true, new Map(current).set(taskId, coordinator)] as const;
    });
    if (!accepted) return;
    yield* emitProviderEvent({
      type: "subagent.updated",
      driver: CLAUDE_PROVIDER,
      subagent: task,
    });
    yield* projectClaudeWorkflowMembers({
      coordinator,
      workflow: workflowWithThreads,
    });
  });

  const bufferWakeMessage = Effect.fnUntraced(function* (wakeInput: {
    readonly nativeThreadId: string;
    readonly message: SDKMessage;
  }) {
    const message = wakeInput.message;
    const isNotification = message.type === "system" && message.subtype === "task_notification";
    const isPendingTaskNotification =
      isNotification &&
      (yield* isWakeEligibleOpaqueBackgroundTaskOnNativeThread(
        wakeInput.nativeThreadId,
        message.task_id,
      ));
    const bufferedMessages =
      (yield* Ref.get(wakeBuffers)).get(wakeInput.nativeThreadId)?.messages ?? [];
    const isNestedSubagentNotification =
      isNotification &&
      !isPendingTaskNotification &&
      (yield* isNestedSubagentTask(message.task_id));
    const isPendingSubagentNotification =
      isNotification &&
      !isPendingTaskNotification &&
      !isNestedSubagentNotification &&
      ((yield* Ref.get(sessionSubagentsByTaskId)).get(message.task_id)?.task.status === "running" ||
        bufferedMessages.some(
          (entry) =>
            entry.type === "system" &&
            entry.subtype === "task_started" &&
            entry.task_id === message.task_id,
        ));
    // Idle-wake task_started must reach the continuation drain before child frames can find their owner.
    const isNewSubagentTaskStarted =
      message.type === "system" &&
      message.subtype === "task_started" &&
      !isClaudeNonSubagentTask(message);
    const isKnownSubagentTaskStarted =
      message.type === "system" &&
      message.subtype === "task_started" &&
      (yield* Ref.get(sessionSubagentsByTaskId)).has(message.task_id);
    if (
      isKnownSubagentTaskStarted &&
      message.type === "system" &&
      message.subtype === "task_started"
    ) {
      const now = yield* DateTime.now;
      yield* Ref.update(sessionSubagentsByTaskId, (current) => {
        const registered = current.get(message.task_id);
        if (registered === undefined || registered.task.status === "running") {
          return current;
        }
        const { progress: _staleProgress, ...priorTask } = registered.task;
        return new Map(current).set(message.task_id, {
          ...registered,
          confirmedOutcome: undefined,
          task: {
            ...priorTask,
            status: "running",
            result: null,
            startedAt: now,
            completedAt: null,
            updatedAt: now,
          },
        });
      });
    }
    const isWakeTurnStart = isClaudeTurnStartMessage(message);
    const isWakeEvidence =
      isPendingTaskNotification ||
      isPendingSubagentNotification ||
      isNestedSubagentNotification ||
      isKnownSubagentTaskStarted ||
      isNewSubagentTaskStarted ||
      isWakeTurnStart ||
      message.type === "assistant" ||
      message.type === "user" ||
      message.type === "result" ||
      message.type === "rate_limit_event";
    if (!isWakeEvidence) {
      return;
    }
    const notificationSummary =
      isNotification && typeof message.summary === "string" && message.summary.length > 0
        ? message.summary
        : null;
    if (isPendingTaskNotification) {
      yield* recordWakeReport(
        wakeInput.nativeThreadId,
        message.task_id,
        yield* opaqueTaskWakeReport(wakeInput.nativeThreadId, message),
      );
    } else if (isPendingSubagentNotification) {
      const registered = (yield* Ref.get(sessionSubagentsByTaskId)).get(message.task_id);
      const started = bufferedMessages.find(
        (entry) =>
          entry.type === "system" &&
          entry.subtype === "task_started" &&
          entry.task_id === message.task_id,
      );
      yield* recordWakeReport(wakeInput.nativeThreadId, message.task_id, {
        kind: "subagent",
        label:
          registered?.task.title ??
          (started?.type === "system" && started.subtype === "task_started"
            ? started.description
            : undefined),
        outcome: claudeTaskOutcome(message.status),
        childThreadId: registered?.childThreadId,
      });
    }
    if (message.type === "result") {
      bufferedResultArrivals.set(message, yield* DateTime.now);
    }
    if (isClaudeRootTurnFrame(message)) {
      yield* forgetAbsorbedWake(wakeInput.nativeThreadId);
    }
    yield* Ref.update(wakeBuffers, (current) => {
      const existing = current.get(wakeInput.nativeThreadId);
      const updated = new Map(current);
      updated.set(wakeInput.nativeThreadId, {
        messages: [...(existing?.messages ?? []), message],
        detail: notificationSummary ?? existing?.detail ?? null,
      });
      return updated;
    });
    if (isPendingTaskNotification) {
      yield* consumeWakeEligibilityForBufferedNotification(
        wakeInput.nativeThreadId,
        message.task_id,
      );
    }
    // Open continuations only after root init, user, assistant, or result frames prove a wake began.
    // Background child frames can stream while the root is idle.
    const buffered = (yield* Ref.get(wakeBuffers)).get(wakeInput.nativeThreadId);
    const hasBufferedNotification =
      buffered?.messages.some(
        (entry) => entry.type === "system" && entry.subtype === "task_notification",
      ) ?? false;
    const isNativeOpaqueWakeFrame =
      hasBufferedNotification &&
      (message.type === "assistant" || message.type === "user") &&
      parentToolUseIdFromSdkMessage(message) === null;
    if (
      !isPendingSubagentNotification &&
      !isNativeOpaqueWakeFrame &&
      !isWakeTurnStart &&
      message.type !== "result"
    ) {
      return;
    }
    const route = (yield* Ref.get(lastTurnRouteByNativeThread)).get(wakeInput.nativeThreadId);
    if (route === undefined) {
      yield* Effect.logWarning("orchestration-v2.claude-wake-turn-unroutable", {
        providerSessionId: input.providerSessionId,
        nativeThreadId: wakeInput.nativeThreadId,
      });
      return;
    }
    const shouldOffer = yield* Ref.modify(requestedContinuations, (current) => {
      if (current.has(wakeInput.nativeThreadId)) {
        return [false, current] as const;
      }
      const updated = new Set(current);
      updated.add(wakeInput.nativeThreadId);
      return [true, updated] as const;
    });
    if (!shouldOffer) {
      return;
    }
    const detail = (yield* Ref.get(wakeBuffers)).get(wakeInput.nativeThreadId)?.detail ?? null;
    const reports = yield* takeWakeReports(wakeInput.nativeThreadId);
    const notification = backgroundWorkNotification(
      [...(reports?.values() ?? [])].map((entry) => entry.report),
    );
    yield* Effect.logInfo("orchestration-v2.claude-wake-turn-detected", {
      providerSessionId: input.providerSessionId,
      threadId: route.threadId,
      providerThreadId: route.providerThreadId,
    });
    yield* continuationRequests.offer({
      threadId: route.threadId,
      providerThreadId: route.providerThreadId,
      driver: CLAUDE_PROVIDER,
      detail,
      ...(notification === null ? {} : { notification }),
    });
  });

  // Untraced like the roster message handling: it runs for every streamed roster change.
  const emitRosterUpdate = Effect.fnUntraced(function* (
    nativeThreadId: string,
    activeContext: ActiveClaudeTurnContext | null,
  ) {
    const baseThread =
      activeContext?.input.providerThread ??
      (yield* Ref.get(lastProviderThreadByNativeThread)).get(nativeThreadId);
    if (baseThread === undefined) {
      return;
    }
    const status =
      activeContext === null
        ? ("idle" as const)
        : baseThread.status === "idle"
          ? ("active" as const)
          : baseThread.status;
    yield* emitProviderThreadRoster({ nativeThreadId, providerThread: baseThread, status });
  });

  const applyBackgroundTaskRosterMessage = Effect.fnUntraced(function* (input: {
    readonly nativeThreadId: string;
    readonly message: SDKMessage;
    readonly activeContext: ActiveClaudeTurnContext | null;
  }) {
    const message = input.message;
    let rosterChanged = false;

    if (isClaudeBackgroundTasksChangedMessage(message)) {
      const roster = Reflect.get(message, "tasks");
      if (!Array.isArray(roster)) {
        return false;
      }
      const nextTasks: OrchestrationV2PendingBackgroundTask[] = [];
      const listedTaskIds = new Set(
        roster.flatMap((entry) => {
          const taskId =
            entry !== null && typeof entry === "object" ? Reflect.get(entry, "task_id") : undefined;
          return typeof taskId === "string" ? [taskId] : [];
        }),
      );
      const monitorTasks = yield* endClaudeMonitorTasks(
        (taskId, task) =>
          task.nativeThreadId === input.nativeThreadId && !listedTaskIds.has(taskId),
      );
      for (const entry of roster) {
        const task = parseClaudeBackgroundTaskEntry(entry, monitorTasks);
        if (task !== null) {
          nextTasks.push(task);
        }
      }
      yield* replacePendingBackgroundTasks(input.nativeThreadId, nextTasks);
      rosterChanged = true;
    } else if (message.type === "system" && message.subtype === "task_started") {
      if (!isClaudeNonSubagentTask(message) || message.is_backgrounded === false) {
        return false;
      }
      yield* upsertPendingBackgroundTask(
        input.nativeThreadId,
        claudePendingBackgroundTask({
          taskId: message.task_id,
          taskType: claudeTaskTypeFromSdkMessage(message),
          startedByMonitor: yield* isClaudeMonitorTask({
            nativeThreadId: input.nativeThreadId,
            taskId: message.task_id,
            toolUseId: message.tool_use_id,
          }),
          description: typeof message.description === "string" ? message.description : undefined,
          parentTaskId: Reflect.get(message, "parent_task_id"),
        }),
      );
      rosterChanged = true;
    } else if (message.type === "system" && message.subtype === "task_notification") {
      yield* endClaudeMonitorTasks((taskId) => taskId === message.task_id);
      const removed = yield* clearPendingBackgroundTask(input.nativeThreadId, message.task_id);
      yield* clearTaskIdFromNativeThreadSet(
        wakeEligibleBackgroundTasksByNativeThread,
        input.nativeThreadId,
        message.task_id,
      );
      rosterChanged = removed;
    }

    if (!rosterChanged) {
      return false;
    }

    yield* emitRosterUpdate(input.nativeThreadId, input.activeContext);
    return true;
  });

  const settledTurnForSubagentFrame = Effect.fnUntraced(function* (
    nativeThreadId: string,
    message: SDKMessage,
  ) {
    const settled = settledTurnByNativeThread.get(nativeThreadId);
    if (settled === undefined) {
      return null;
    }
    const userResults = claudeToolResultBlocksFromUserMessage(message);
    if (
      message.type === "user" &&
      userResults.length > 0 &&
      userResults.length === message.message.content.length &&
      userResults.every((toolResult) => findToolCall(settled, toolResult.tool_use_id) !== undefined)
    ) {
      return settled;
    }
    const bufferedStarts = (
      (yield* Ref.get(wakeBuffers)).get(nativeThreadId)?.messages ?? []
    ).flatMap((entry) =>
      entry.type === "system" && entry.subtype === "task_started" && !isClaudeNonSubagentTask(entry)
        ? [entry]
        : [],
    );
    const parentToolUseId = parentToolUseIdFromSdkMessage(message);
    const taskId =
      message.type === "system" && message.subtype === "task_progress"
        ? message.task_id
        : parentToolUseId === null
          ? undefined
          : (yield* Ref.get(sessionSubagentTaskIdsByToolUseId)).get(parentToolUseId);
    const returnedToolUseIds = new Set(
      [...claudeToolResultBlocksFromAssistantMessage(message), ...userResults].map(
        (toolResult) => toolResult.tool_use_id,
      ),
    );
    if (
      bufferedStarts.some(
        (start) =>
          start.task_id === taskId ||
          (start.tool_use_id !== undefined &&
            (start.tool_use_id === parentToolUseId || returnedToolUseIds.has(start.tool_use_id))),
      )
    ) {
      return null;
    }
    if (taskId === undefined) {
      return parentToolUseId === null ? null : settled;
    }
    if (
      returnedToolUseIds.size > 0 &&
      bufferedStarts.some((start) => start.tool_use_id === undefined)
    ) {
      return null;
    }
    const subagent = (yield* Ref.get(sessionSubagentsByTaskId)).get(taskId);
    return subagent?.task.status === "running" ? settled : null;
  });

  return {
    applyWorkflowProgressWithoutTurn,
    bufferWakeMessage,
    emitRosterUpdate,
    applyBackgroundTaskRosterMessage,
    settledTurnForSubagentFrame,
  };
};
