// @effect-diagnostics nodeBuiltinImport:off -- the SDK takes a Node ChildProcess for the CLI.
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import type { OrchestrationV2PendingBackgroundTask } from "@t3tools/contracts";

import * as Effect from "effect/Effect";

import * as Ref from "effect/Ref";

import type { BackgroundWorkReport } from "@t3tools/provider-core/server/notification";
import type { ClaudeSessionState } from "./ClaudeSessionState.ts";
import { claudeToolResultBlocksFromAssistantMessage } from "./ClaudeToolClassification.ts";
import { claudeToolResultBlocksFromUserMessage } from "./ClaudeToolClassification.ts";
import { claudeToolUseBlocksFromAssistantMessage } from "./ClaudeToolClassification.ts";

export type Deps = ClaudeSessionState;

export const installWake = (s: Deps) => {
  const { input } = s.env;
  const {
    pendingBackgroundTasksByNativeThread,
    wakeEligibleBackgroundTasksByNativeThread,
    opaqueBackgroundTaskReplayTombstonesByNativeThread,
    wakeReportsByNativeThread,
    lastKnownOpaqueTasks,
    claudeMonitors,
  } = s;
  const recordWakeReport = (nativeThreadId: string, taskId: string, report: BackgroundWorkReport) =>
    Ref.update(wakeReportsByNativeThread, ({ userTurns, reports }) => ({
      userTurns,
      reports: new Map(reports).set(
        nativeThreadId,
        new Map(reports.get(nativeThreadId)).set(taskId, {
          report,
          turn: userTurns.get(nativeThreadId) ?? 0,
        }),
      ),
    }));
  const startUserTurnForWakeReports = (nativeThreadId: string) =>
    Ref.update(wakeReportsByNativeThread, ({ userTurns, reports }) => {
      const turn = (userTurns.get(nativeThreadId) ?? 0) + 1;
      const updatedTurns = new Map(userTurns).set(nativeThreadId, turn);
      const threadReports = reports.get(nativeThreadId);
      if (threadReports === undefined) return { userTurns: updatedTurns, reports };
      const kept = new Map([...threadReports].filter(([, entry]) => entry.turn >= turn - 1));
      const updatedReports = new Map(reports);
      if (kept.size === 0) updatedReports.delete(nativeThreadId);
      else updatedReports.set(nativeThreadId, kept);
      return { userTurns: updatedTurns, reports: updatedReports };
    });
  const takeWakeReports = (nativeThreadId: string) =>
    Ref.modify(wakeReportsByNativeThread, (current) => {
      const taken = current.reports.get(nativeThreadId);
      if (taken === undefined) return [taken, current] as const;
      const reports = new Map(current.reports);
      reports.delete(nativeThreadId);
      return [taken, { userTurns: current.userTurns, reports }] as const;
    });
  const clearWakeReports = (nativeThreadId: string) =>
    takeWakeReports(nativeThreadId).pipe(Effect.asVoid);
  const claudeTaskOutcome = (status: "completed" | "failed" | "stopped") =>
    status === "completed" ? "completed" : status === "stopped" ? "cancelled" : "failed";
  const trackClaudeMonitorCalls = (message: SDKMessage) => {
    const started = claudeToolUseBlocksFromAssistantMessage(message).flatMap((toolUse) =>
      toolUse.name === "Monitor" ? [toolUse.id] : [],
    );
    const returned = [
      ...claudeToolResultBlocksFromAssistantMessage(message),
      ...claudeToolResultBlocksFromUserMessage(message),
    ].map((toolResult) => toolResult.tool_use_id);
    if (started.length === 0 && returned.length === 0) return Effect.void;
    return Ref.update(claudeMonitors, (current) => {
      const linked = new Set([...current.tasks.values()].map((task) => task.toolUseId));
      const opened = started.filter((id) => !linked.has(id) && !current.calls.has(id));
      const closed = returned.filter((id) => current.calls.has(id));
      if (opened.length === 0 && closed.length === 0) return current;
      const calls = new Set([...current.calls, ...opened]);
      for (const id of closed) calls.delete(id);
      return { ...current, calls };
    });
  };
  const isClaudeMonitorTask = (input: {
    readonly nativeThreadId: string;
    readonly taskId: string;
    readonly toolUseId: string | undefined;
  }) =>
    Ref.modify(claudeMonitors, (current) => {
      if (current.tasks.has(input.taskId)) return [true, current] as const;
      if (input.toolUseId === undefined || !current.calls.has(input.toolUseId)) {
        return [false, current] as const;
      }
      const calls = new Set(current.calls);
      calls.delete(input.toolUseId);
      const tasks = new Map(current.tasks).set(input.taskId, {
        toolUseId: input.toolUseId,
        nativeThreadId: input.nativeThreadId,
      });
      return [true, { calls, tasks }] as const;
    });
  const endClaudeMonitorTasks = (
    ended: (taskId: string, task: { readonly nativeThreadId: string }) => boolean,
  ) =>
    Ref.modify(claudeMonitors, (current) => {
      const endedIds = [...current.tasks].filter(([taskId, task]) => ended(taskId, task));
      if (endedIds.length === 0) return [current.tasks, current] as const;
      const tasks = new Map(current.tasks);
      for (const [taskId] of endedIds) tasks.delete(taskId);
      return [tasks, { ...current, tasks }] as const;
    });
  // Reads the roster, so call it before the notification clears the task from it.
  const opaqueTaskWakeReport = Effect.fnUntraced(function* (
    nativeThreadId: string,
    message: Extract<SDKMessage, { readonly subtype: "task_notification" }>,
  ): Effect.fn.Return<BackgroundWorkReport> {
    const task =
      rosterForNativeThread(
        yield* Ref.get(pendingBackgroundTasksByNativeThread),
        nativeThreadId,
      ).get(message.task_id) ?? (yield* Ref.get(lastKnownOpaqueTasks)).get(message.task_id);
    yield* Ref.update(lastKnownOpaqueTasks, (current) => {
      if (!current.has(message.task_id)) return current;
      const updated = new Map(current);
      updated.delete(message.task_id);
      return updated;
    });
    const outcome = claudeTaskOutcome(message.status);
    const label = task?.description;
    switch (task?.kind) {
      case "subagent":
        return { kind: "subagent", label, outcome, childThreadId: task.childThreadId };
      case "monitor":
      case "background_task":
        return { kind: task.kind, label, outcome };
      case "command":
      case undefined:
        return { kind: "command", label, outcome };
    }
  });
  const rosterForNativeThread = (
    all: ReadonlyMap<string, Map<string, OrchestrationV2PendingBackgroundTask>>,
    nativeThreadId: string,
  ): Map<string, OrchestrationV2PendingBackgroundTask> =>
    all.get(nativeThreadId) ?? new Map<string, OrchestrationV2PendingBackgroundTask>();

  const hasPendingBackgroundTaskOnNativeThread = (nativeThreadId: string, taskId: string) =>
    Ref.get(pendingBackgroundTasksByNativeThread).pipe(
      Effect.map((all) => rosterForNativeThread(all, nativeThreadId).has(taskId)),
    );

  const taskIdSetForNativeThread = (
    all: ReadonlyMap<string, Set<string>>,
    nativeThreadId: string,
  ): Set<string> => all.get(nativeThreadId) ?? new Set<string>();

  const addTaskIdsToNativeThreadSet = (
    ref: Ref.Ref<Map<string, Set<string>>>,
    nativeThreadId: string,
    taskIds: ReadonlyArray<string>,
  ) =>
    Ref.update(ref, (current) => {
      if (taskIds.length === 0) {
        return current;
      }
      const next = new Set(taskIdSetForNativeThread(current, nativeThreadId));
      let changed = false;
      for (const taskId of taskIds) {
        if (!next.has(taskId)) {
          next.add(taskId);
          changed = true;
        }
      }
      return changed ? new Map(current).set(nativeThreadId, next) : current;
    });

  const clearTaskIdFromNativeThreadSet = (
    ref: Ref.Ref<Map<string, Set<string>>>,
    nativeThreadId: string,
    taskId: string,
  ) =>
    Ref.update(ref, (current) => {
      const existing = taskIdSetForNativeThread(current, nativeThreadId);
      if (!existing.has(taskId)) {
        return current;
      }
      const next = new Set(existing);
      next.delete(taskId);
      const updated = new Map(current);
      if (next.size === 0) {
        updated.delete(nativeThreadId);
      } else {
        updated.set(nativeThreadId, next);
      }
      return updated;
    });

  const clearNativeThreadTaskIdSet = (
    ref: Ref.Ref<Map<string, Set<string>>>,
    nativeThreadId: string,
  ) =>
    Ref.update(ref, (current) => {
      if (!current.has(nativeThreadId)) {
        return current;
      }
      const updated = new Map(current);
      updated.delete(nativeThreadId);
      return updated;
    });

  const isWakeEligibleOpaqueBackgroundTaskOnNativeThread = (
    nativeThreadId: string,
    taskId: string,
  ) =>
    Ref.get(wakeEligibleBackgroundTasksByNativeThread).pipe(
      Effect.map((all) => taskIdSetForNativeThread(all, nativeThreadId).has(taskId)),
    );

  const hasOpaqueBackgroundTaskReplayTombstoneOnNativeThread = (
    nativeThreadId: string,
    taskId: string,
  ) =>
    Ref.get(opaqueBackgroundTaskReplayTombstonesByNativeThread).pipe(
      Effect.map((all) => taskIdSetForNativeThread(all, nativeThreadId).has(taskId)),
    );

  const isKnownOpaqueBackgroundTaskOnNativeThread =
    /* Provider events include streaming deltas; avoid a span for each update. */
    Effect.fnUntraced(function* (nativeThreadId: string, taskId: string) {
      if (yield* hasPendingBackgroundTaskOnNativeThread(nativeThreadId, taskId)) {
        return true;
      }
      if (yield* isWakeEligibleOpaqueBackgroundTaskOnNativeThread(nativeThreadId, taskId)) {
        return true;
      }
      return yield* hasOpaqueBackgroundTaskReplayTombstoneOnNativeThread(nativeThreadId, taskId);
    });

  const markWakeEligibleOpaqueBackgroundTasks = (
    nativeThreadId: string,
    taskIds: ReadonlyArray<string>,
  ) =>
    addTaskIdsToNativeThreadSet(wakeEligibleBackgroundTasksByNativeThread, nativeThreadId, taskIds);

  const consumeWakeEligibilityForBufferedNotification =
    /* Provider events include streaming deltas; avoid a span for each update. */
    Effect.fnUntraced(function* (nativeThreadId: string, taskId: string) {
      yield* clearTaskIdFromNativeThreadSet(
        wakeEligibleBackgroundTasksByNativeThread,
        nativeThreadId,
        taskId,
      );
      yield* addTaskIdsToNativeThreadSet(
        opaqueBackgroundTaskReplayTombstonesByNativeThread,
        nativeThreadId,
        [taskId],
      );
    });

  const clearOpaqueBackgroundTaskReplayTombstone = (nativeThreadId: string, taskId: string) =>
    clearTaskIdFromNativeThreadSet(
      opaqueBackgroundTaskReplayTombstonesByNativeThread,
      nativeThreadId,
      taskId,
    );

  return {
    recordWakeReport,
    startUserTurnForWakeReports,
    takeWakeReports,
    clearWakeReports,
    claudeTaskOutcome,
    trackClaudeMonitorCalls,
    isClaudeMonitorTask,
    endClaudeMonitorTasks,
    opaqueTaskWakeReport,
    rosterForNativeThread,
    hasPendingBackgroundTaskOnNativeThread,
    taskIdSetForNativeThread,
    addTaskIdsToNativeThreadSet,
    clearTaskIdFromNativeThreadSet,
    clearNativeThreadTaskIdSet,
    isWakeEligibleOpaqueBackgroundTaskOnNativeThread,
    hasOpaqueBackgroundTaskReplayTombstoneOnNativeThread,
    isKnownOpaqueBackgroundTaskOnNativeThread,
    markWakeEligibleOpaqueBackgroundTasks,
    consumeWakeEligibilityForBufferedNotification,
    clearOpaqueBackgroundTaskReplayTombstone,
  };
};
