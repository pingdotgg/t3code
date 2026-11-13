// @effect-diagnostics nodeBuiltinImport:off -- the SDK takes a Node ChildProcess for the CLI.
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import type {
  OrchestrationV2PendingBackgroundTask,
  OrchestrationV2ProviderThread,
} from "@t3tools/contracts";

import * as DateTime from "effect/DateTime";

import * as Effect from "effect/Effect";

import * as Ref from "effect/Ref";

import { makeProviderRetryTurnItem } from "@t3tools/provider-core/server/failure";
import type { Deps as PrevDeps } from "./claudeSessionWake.ts";
import { installWake } from "./claudeSessionWake.ts";
import { CLAUDE_PROVIDER } from "./ClaudeProviderIdentity.ts";
import { claudeAutoCompactThreshold } from "./ClaudeProviderIdentity.ts";
import { claudeMessageInputTokens } from "./ClaudeProviderIdentity.ts";
import { claudePendingBackgroundTasksFromRoster } from "./ClaudeToolClassification.ts";
import { claudeProviderTurnTokenUsage } from "./ClaudeProviderIdentity.ts";
import { isClaudeRootTurnFrame } from "./ClaudeToolClassification.ts";
import { nextClaudeGoal } from "./ClaudeProviderMessages.ts";
import { providerGoalsEqual } from "./ClaudeProviderMessages.ts";
import type { ActiveClaudeTurnContext } from "./ClaudeAssistantArtifacts.ts";
import type { ClaudeMessageUsage } from "./ClaudeProviderIdentity.ts";

export type Deps = PrevDeps & ReturnType<typeof installWake>;

export const installRoster = (s: Deps) => {
  const { adapterOptions, claudeContextWindow, input } = s.env;
  const {
    now,
    session,
    activeTurn,
    providerRetries,
    pendingBackgroundTasksByNativeThread,
    awaitedBackgroundTasksByNativeThread,
    wakeEligibleBackgroundTasksByNativeThread,
    opaqueBackgroundTaskReplayTombstonesByNativeThread,
    lastProviderThreadByNativeThread,
    goalsByNativeThread,
    goalCheckedTurns,
    wakeBuffers,
    clearWakeReports,
    lastKnownOpaqueTasks,
    endClaudeMonitorTasks,
    requestedContinuations,
    absorbedWakes,
    emitProviderEvent,
    rosterForNativeThread,
    taskIdSetForNativeThread,
    addTaskIdsToNativeThreadSet,
    clearTaskIdFromNativeThreadSet,
    clearNativeThreadTaskIdSet,
    markWakeEligibleOpaqueBackgroundTasks,
  } = s;
  const rememberProviderThread =
    /* Provider events include streaming deltas; avoid a span for each update. */
    Effect.fnUntraced(function* (providerThread: OrchestrationV2ProviderThread) {
      const nativeThreadId = providerThread.nativeThreadRef?.nativeId;
      if (nativeThreadId === undefined || nativeThreadId === null) {
        return;
      }
      yield* Ref.update(lastProviderThreadByNativeThread, (current) =>
        new Map(current).set(nativeThreadId, providerThread),
      );
    });

  // Claude has no recovered frame; the next assistant message proves recovery.
  // Runs on every model output frame and is almost always a no-op; only a pending retry gets a span.
  const completeProviderRetry = Effect.fnUntraced(function* (
    context: ActiveClaudeTurnContext,
    updatedAt: DateTime.Utc,
  ) {
    const providerRetry = yield* Ref.modify(providerRetries, (current) => {
      const retry = current.get(context.providerTurnId);
      if (retry === undefined) {
        return [undefined, current] as const;
      }
      const updated = new Map(current);
      updated.delete(context.providerTurnId);
      return [retry, updated] as const;
    });
    if (providerRetry === undefined) {
      return;
    }
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
        itemOrdinal: providerRetry.itemOrdinal,
        failure: providerRetry.failure,
        retry: providerRetry.retry,
        status: "completed",
        startedAt: providerRetry.startedAt,
        updatedAt,
      }),
    }).pipe(Effect.withSpan("ClaudeAdapterV2.completeProviderRetry"));
  });

  const persistAttachmentBudget = Effect.fnUntraced(function* (nativeThreadId: string) {
    const providerThread = (yield* Ref.get(lastProviderThreadByNativeThread)).get(nativeThreadId);
    if (providerThread === undefined) return;
    const active = yield* Ref.get(activeTurn);
    yield* emitProviderEvent({
      type: "provider_thread.updated",
      driver: CLAUDE_PROVIDER,
      providerThread: {
        ...providerThread,
        status: active?.nativeThreadId === nativeThreadId ? "active" : providerThread.status,
        updatedAt: yield* DateTime.now,
      },
    });
  });

  // Usage without input is a placeholder, not a context measurement.
  const emitContextUsage = Effect.fnUntraced(function* (
    context: ActiveClaudeTurnContext,
    usage: ClaudeMessageUsage | number,
    requestStarted = false,
  ) {
    const now = yield* DateTime.now;
    // Only message_start marks the request start; an assistant snapshot
    // arrives after generation, so it leaves the cache expiry unknown.
    if (requestStarted && context.streamUsage !== null) context.streamUsage.requestedAt = now;
    const maxTokens = claudeContextWindow(context.input.modelSelection);
    const tokenUsage =
      typeof usage === "number"
        ? {
            usedTokens: usage,
            maxTokens,
            ...claudeAutoCompactThreshold(adapterOptions.settings.autoCompactWindow, maxTokens),
            updatedAt: DateTime.formatIso(now),
          }
        : claudeProviderTurnTokenUsage(
            usage,
            maxTokens,
            DateTime.formatIso(now),
            adapterOptions.settings.autoCompactWindow,
            context.streamUsage?.requestedAt,
          );
    if (typeof usage !== "number") {
      if (claudeMessageInputTokens(usage) <= 0) return;
      context.compactionTokens = undefined;
    }
    yield* emitProviderEvent({
      type: "provider_turn.updated",
      driver: CLAUDE_PROVIDER,
      threadId: context.input.threadId,
      providerTurn: {
        id: context.providerTurnId,
        providerThreadId: context.input.providerThread.id,
        nodeId: context.input.rootNodeId,
        runAttemptId: context.input.attemptId,
        nativeTurnRef: {
          driver: CLAUDE_PROVIDER,
          nativeId: context.nativeTurnId,
          strength: "strong",
        },
        ordinal: context.providerTurnOrdinal,
        status: "running",
        startedAt: context.startedAt,
        completedAt: null,
        tokenUsage,
      },
    });
  });

  const emitProviderThreadRoster = Effect.fnUntraced(function* (input: {
    readonly nativeThreadId: string;
    readonly providerThread: OrchestrationV2ProviderThread;
    readonly status?: OrchestrationV2ProviderThread["status"];
  }) {
    const roster = rosterForNativeThread(
      yield* Ref.get(pendingBackgroundTasksByNativeThread),
      input.nativeThreadId,
    );
    const awaitedTaskIds = taskIdSetForNativeThread(
      yield* Ref.get(awaitedBackgroundTasksByNativeThread),
      input.nativeThreadId,
    );
    const now = yield* DateTime.now;
    const providerThread: OrchestrationV2ProviderThread = {
      ...input.providerThread,
      providerSessionId: session.id,
      ...(input.status === undefined ? {} : { status: input.status }),
      pendingBackgroundTasks: claudePendingBackgroundTasksFromRoster(roster, awaitedTaskIds),
      ...(goalsByNativeThread.has(input.nativeThreadId)
        ? { goal: goalsByNativeThread.get(input.nativeThreadId) ?? null }
        : {}),
      updatedAt: now,
    };
    yield* rememberProviderThread(providerThread);
    yield* emitProviderEvent({
      type: "provider_thread.updated",
      driver: CLAUDE_PROVIDER,
      providerThread,
    });
  });

  const trackClaudeGoal = Effect.fnUntraced(function* (input: {
    readonly nativeThreadId: string;
    readonly context: ActiveClaudeTurnContext;
    readonly message: SDKMessage;
  }) {
    const current = goalsByNativeThread.get(input.nativeThreadId) ?? null;
    if (
      current?.status === "active" &&
      input.message.type === "assistant" &&
      input.message.parent_tool_use_id === null &&
      input.message.message.model !== "<synthetic>"
    ) {
      goalCheckedTurns.add(input.context.providerTurnId);
    }
    const next = nextClaudeGoal(current, input.message);
    if (next === undefined || providerGoalsEqual(current, next)) return;
    goalsByNativeThread.set(input.nativeThreadId, next);
    const providerThread = (yield* Ref.get(lastProviderThreadByNativeThread)).get(
      input.nativeThreadId,
    );
    if (providerThread === undefined) return;
    const updated = { ...providerThread, goal: next, updatedAt: yield* DateTime.now };
    yield* rememberProviderThread(updated);
    yield* emitProviderEvent({
      type: "provider_thread.updated",
      driver: CLAUDE_PROVIDER,
      providerThread: updated,
    });
  });

  const rememberOpaqueTasks = (tasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask>) =>
    tasks.length === 0
      ? Effect.void
      : Ref.update(lastKnownOpaqueTasks, (current) => {
          const updated = new Map(current);
          for (const task of tasks) updated.set(task.taskId, task);
          for (const oldest of updated.keys()) {
            if (updated.size <= 64) break;
            updated.delete(oldest);
          }
          return updated;
        });

  const replacePendingBackgroundTasks =
    /* Provider events include streaming deltas; avoid a span for each update. */
    Effect.fnUntraced(function* (
      nativeThreadId: string,
      tasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask>,
    ) {
      yield* Ref.update(pendingBackgroundTasksByNativeThread, (current) => {
        const updated = new Map(current);
        if (tasks.length === 0) {
          updated.delete(nativeThreadId);
        } else {
          updated.set(nativeThreadId, new Map(tasks.map((task) => [task.taskId, task] as const)));
        }
        return updated;
      });
      yield* rememberOpaqueTasks(tasks);
      if (tasks.length > 0) {
        yield* markWakeEligibleOpaqueBackgroundTasks(
          nativeThreadId,
          tasks.map((task) => task.taskId),
        );
      }
      const listed = new Set(tasks.map((task) => task.taskId));
      yield* Ref.update(awaitedBackgroundTasksByNativeThread, (current) => {
        const awaited = current.get(nativeThreadId);
        if (awaited === undefined) return current;
        const kept = new Set([...awaited].filter((taskId) => listed.has(taskId)));
        if (kept.size === awaited.size) return current;
        const updated = new Map(current);
        if (kept.size === 0) updated.delete(nativeThreadId);
        else updated.set(nativeThreadId, kept);
        return updated;
      });
    });

  const upsertPendingBackgroundTask =
    /* Provider events include streaming deltas; avoid a span for each update. */
    Effect.fnUntraced(function* (
      nativeThreadId: string,
      task: OrchestrationV2PendingBackgroundTask,
    ) {
      yield* Ref.update(pendingBackgroundTasksByNativeThread, (current) => {
        const roster = new Map(rosterForNativeThread(current, nativeThreadId));
        roster.set(task.taskId, task);
        return new Map(current).set(nativeThreadId, roster);
      });
      yield* rememberOpaqueTasks([task]);
      yield* markWakeEligibleOpaqueBackgroundTasks(nativeThreadId, [task.taskId]);
    });

  const clearPendingBackgroundTask = (nativeThreadId: string, taskId: string) =>
    Ref.modify(pendingBackgroundTasksByNativeThread, (current) => {
      const roster = rosterForNativeThread(current, nativeThreadId);
      if (!roster.has(taskId)) {
        return [false, current] as const;
      }
      const nextRoster = new Map(roster);
      nextRoster.delete(taskId);
      const updated = new Map(current);
      if (nextRoster.size === 0) {
        updated.delete(nativeThreadId);
      } else {
        updated.set(nativeThreadId, nextRoster);
      }
      return [true, updated] as const;
    }).pipe(
      Effect.tap(() =>
        clearTaskIdFromNativeThreadSet(
          awaitedBackgroundTasksByNativeThread,
          nativeThreadId,
          taskId,
        ),
      ),
    );

  const clearPendingBackgroundTasksForNativeThread =
    /* Provider events include streaming deltas; avoid a span for each update. */
    Effect.fnUntraced(function* (nativeThreadId: string) {
      yield* Ref.update(pendingBackgroundTasksByNativeThread, (current) => {
        if (!current.has(nativeThreadId)) {
          return current;
        }
        const updated = new Map(current);
        updated.delete(nativeThreadId);
        return updated;
      });
      yield* clearNativeThreadTaskIdSet(awaitedBackgroundTasksByNativeThread, nativeThreadId);
      yield* endClaudeMonitorTasks((_taskId, task) => task.nativeThreadId === nativeThreadId);
    });

  const forgetAbsorbedWake = (nativeThreadId: string) =>
    Ref.update(absorbedWakes, (current) => {
      if (!current.has(nativeThreadId)) return current;
      const updated = new Set(current);
      updated.delete(nativeThreadId);
      return updated;
    });

  const clearWakeStateForNativeThread =
    /* Provider events include streaming deltas; avoid a span for each update. */
    Effect.fnUntraced(function* (nativeThreadId: string) {
      yield* clearWakeReports(nativeThreadId);
      yield* Ref.update(wakeBuffers, (current) => {
        if (!current.has(nativeThreadId)) {
          return current;
        }
        const updated = new Map(current);
        updated.delete(nativeThreadId);
        return updated;
      });
      yield* Ref.update(requestedContinuations, (current) => {
        if (!current.has(nativeThreadId)) {
          return current;
        }
        const updated = new Set(current);
        updated.delete(nativeThreadId);
        return updated;
      });
      yield* forgetAbsorbedWake(nativeThreadId);
    });

  // Claude runs one root turn at a time, so a user turn's result also ends a wake turn it
  // folded in. The continuation replays that wake's buffered frames but gets no result of its own.
  const markAbsorbedWake = Effect.fnUntraced(function* (nativeThreadId: string) {
    const messages = (yield* Ref.get(wakeBuffers)).get(nativeThreadId)?.messages ?? [];
    const lastResult = messages.findLastIndex((entry) => entry.type === "result");
    if (!messages.slice(lastResult + 1).some(isClaudeRootTurnFrame)) return;
    yield* Ref.update(absorbedWakes, (current) => new Set(current).add(nativeThreadId));
  });

  // The SDK emits no initial roster; reset roster and wake eligibility when opening a live query.
  const resetBackgroundTaskStateForNativeThreadProcess = Effect.fnUntraced(function* (
    nativeThreadId: string,
    options?: {
      readonly status?: OrchestrationV2ProviderThread["status"];
    },
  ) {
    const hadRoster =
      rosterForNativeThread(yield* Ref.get(pendingBackgroundTasksByNativeThread), nativeThreadId)
        .size > 0;
    const remembered = (yield* Ref.get(lastProviderThreadByNativeThread)).get(nativeThreadId);
    const hadPersistedRoster = (remembered?.pendingBackgroundTasks?.length ?? 0) > 0;
    const priorOpaqueTombstones = taskIdSetForNativeThread(
      yield* Ref.get(opaqueBackgroundTaskReplayTombstonesByNativeThread),
      nativeThreadId,
    );
    const bufferedTaskNotificationIds = new Set<string>();
    const buffered = (yield* Ref.get(wakeBuffers)).get(nativeThreadId);
    if (buffered !== undefined) {
      for (const message of buffered.messages) {
        if (message.type === "system" && message.subtype === "task_notification") {
          bufferedTaskNotificationIds.add(message.task_id);
        }
      }
    }
    const preservedOpaqueTombstones = [...priorOpaqueTombstones].filter((taskId) =>
      bufferedTaskNotificationIds.has(taskId),
    );
    yield* clearPendingBackgroundTasksForNativeThread(nativeThreadId);
    yield* clearNativeThreadTaskIdSet(wakeEligibleBackgroundTasksByNativeThread, nativeThreadId);
    yield* clearNativeThreadTaskIdSet(
      opaqueBackgroundTaskReplayTombstonesByNativeThread,
      nativeThreadId,
    );
    if (preservedOpaqueTombstones.length > 0) {
      yield* addTaskIdsToNativeThreadSet(
        opaqueBackgroundTaskReplayTombstonesByNativeThread,
        nativeThreadId,
        preservedOpaqueTombstones,
      );
    }
    if (!hadRoster && !hadPersistedRoster) {
      return;
    }
    if (remembered === undefined) {
      return;
    }
    const activeContext = yield* Ref.get(activeTurn);
    const status =
      options?.status ??
      (activeContext === null
        ? ("idle" as const)
        : remembered.status === "idle"
          ? ("active" as const)
          : remembered.status);
    yield* emitProviderThreadRoster({
      nativeThreadId,
      providerThread: remembered,
      status,
    });
  });

  return {
    rememberProviderThread,
    completeProviderRetry,
    persistAttachmentBudget,
    emitContextUsage,
    emitProviderThreadRoster,
    trackClaudeGoal,
    rememberOpaqueTasks,
    replacePendingBackgroundTasks,
    upsertPendingBackgroundTask,
    clearPendingBackgroundTask,
    clearPendingBackgroundTasksForNativeThread,
    forgetAbsorbedWake,
    clearWakeStateForNativeThread,
    markAbsorbedWake,
    resetBackgroundTaskStateForNativeThreadProcess,
  };
};
