// @effect-diagnostics nodeBuiltinImport:off -- the SDK takes a Node ChildProcess for the CLI.
import { text } from "../unknownField.ts";

import {
  addClaudeLedgerUsage,
  normalizeClaudeTurnTokenUsage,
} from "../../provider/ClaudeTurnTokenUsage.ts";

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";

import type {
  OrchestrationV2ProviderFailure,
  OrchestrationV2PendingBackgroundTask,
  OrchestrationV2ProviderThread,
  OrchestrationV2ProviderTurn,
} from "@t3tools/contracts";

import * as Cause from "effect/Cause";

import * as Context from "effect/Context";

import * as DateTime from "effect/DateTime";

import * as Effect from "effect/Effect";

import * as Ref from "effect/Ref";

import {
  makeProviderFailure,
  makeProviderRetryTurnItem,
} from "@t3tools/provider-core/server/failure";

import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type { Deps as PrevDeps } from "./claudeSessionSubagentRecovery.ts";
import { installSubagentRecovery } from "./claudeSessionSubagentRecovery.ts";
import { CLAUDE_PROVIDER } from "./ClaudeProviderIdentity.ts";
import { ClaudeAgentSdkQueryRunnerError } from "./ClaudeQueryRunnerTypes.ts";
import { buildAssistantArtifacts } from "./ClaudeAssistantArtifacts.ts";
import { claudePendingBackgroundTasksFromRoster } from "./ClaudeToolClassification.ts";
import type { ActiveClaudeSubagent } from "./ClaudeAssistantArtifacts.ts";
import type { ActiveClaudeTurnContext } from "./ClaudeAssistantArtifacts.ts";
import type { ClaudeLiveQueryContext } from "./ClaudeAssistantArtifacts.ts";

export type Deps = PrevDeps & ReturnType<typeof installSubagentRecovery>;

export const installFinalize = (s: Deps) => {
  const { idAllocator, input } = s.env;
  const {
    sessionScope,
    now,
    session,
    activeTurn,
    interruptedTurns,
    queryContext,
    resultLedgerUsage,
    providerRetries,
    pendingBackgroundTasksByNativeThread,
    awaitedBackgroundTasksByNativeThread,
    wakeEligibleBackgroundTasksByNativeThread,
    opaqueBackgroundTaskReplayTombstonesByNativeThread,
    goalsByNativeThread,
    goalCheckedTurns,
    sessionSubagentsByTaskId,
    subagentToolCalls,
    settledTurnByNativeThread,
    wakeBuffers,
    claudeTaskOutcome,
    emitProviderEvent,
    rememberProviderThread,
    rosterForNativeThread,
    taskIdSetForNativeThread,
    clearNativeThreadTaskIdSet,
    clearPendingBackgroundTasksForNativeThread,
    resetBackgroundTaskStateForNativeThreadProcess,
    resolveItemOrdinal,
    providerTurnPayload,
    updateClaudeSubagentNode,
    reasoningDeltas,
    endToolCalls,
    liveProcessRunsBackgroundWork,
  } = s;
  const finalizeActiveTurn = Effect.fnUntraced(function* (input: {
    readonly context: ActiveClaudeTurnContext;
    readonly status: Extract<
      OrchestrationV2ProviderTurn["status"],
      "completed" | "interrupted" | "failed" | "cancelled"
    >;
    readonly completedAt: DateTime.Utc;
    readonly failure?: OrchestrationV2ProviderFailure;
    readonly threadDisposition?: "reusable" | "broken";
    readonly result?: SDKResultMessage;
  }) {
    yield* reasoningDeltas.flushTurn(input.context.nativeTurnId);
    if (input.context.compaction?.status === "running") {
      const reason = input.result?.subtype === "success" ? input.result.result.trim() : "";
      yield* emitProviderEvent({
        type: "turn_item.updated",
        driver: CLAUDE_PROVIDER,
        turnItem: {
          ...input.context.compaction,
          status: input.status === "completed" ? "failed" : input.status,
          title:
            input.status === "completed" || input.status === "failed"
              ? "Context compaction failed"
              : "Context compaction stopped",
          ...(reason === "" ? {} : { summary: reason }),
          completedAt: input.completedAt,
          updatedAt: input.completedAt,
        },
      });
    }
    input.context.compaction = null;
    if (input.status !== "completed") {
      const liveQuery = yield* Ref.get(queryContext);
      for (const [taskId, subagent] of yield* Ref.get(sessionSubagentsByTaskId)) {
        if (
          subagent.task.workflow === undefined ||
          subagent.task.status !== "running" ||
          subagent.task.runId !== input.context.input.runId
        )
          continue;
        if (liveQuery !== null && !liveQuery.stopping) {
          // An unanswered stop must not delay turn settlement.
          yield* liveQuery.query
            .stopTask(taskId)
            .pipe(Effect.timeout("15 seconds"), Effect.ignore, Effect.forkIn(sessionScope));
        }
        yield* updateClaudeSubagentNode({
          context: input.context,
          taskId,
          status: input.status === "failed" ? "failed" : "cancelled",
          onlyIfRunningInRun: input.context.input.runId,
        });
      }
    }
    const liveQuery = yield* Ref.get(queryContext);
    const runningChildThreadIds = new Set(
      [...(yield* Ref.get(sessionSubagentsByTaskId)).values()].flatMap((subagent) =>
        subagent.task.status === "running" &&
        (input.status === "completed" ||
          (liveQuery !== null && subagent.task.runId !== input.context.input.runId)) &&
        liveQuery?.subagentsFromEarlierProcesses.has(subagent) !== true
          ? [subagent.childThreadId]
          : [],
      ),
    );
    const endingSubagentCalls = [...subagentToolCalls.values()].filter(
      (toolCall) => !runningChildThreadIds.has(toolCall.threadId),
    );
    yield* endToolCalls({
      context: input.context,
      toolCalls: [...input.context.toolCalls.values(), ...endingSubagentCalls],
      status: input.status === "completed" ? "failed" : input.status,
      completedAt: input.completedAt,
    });
    input.context.toolCalls.clear();
    for (const toolCall of endingSubagentCalls) {
      subagentToolCalls.delete(toolCall.nativeItemId);
    }

    if (
      input.context.assistant.emittedNativeItemIds.size === 0 &&
      input.context.assistant.fallbackText.length > 0
    ) {
      const ordinal = yield* resolveItemOrdinal(
        input.context,
        input.context.assistant.fallbackNativeItemId,
      );
      const artifacts = buildAssistantArtifacts({
        idAllocator,
        turnInput: input.context.input,
        providerTurnId: input.context.providerTurnId,
        nativeItemId: input.context.assistant.fallbackNativeItemId,
        text: input.context.assistant.fallbackText,
        ordinal,
        startedAt: input.context.startedAt,
        completedAt: input.completedAt,
      });
      yield* Effect.all(
        [
          emitProviderEvent({
            type: "node.updated",
            driver: CLAUDE_PROVIDER,
            node: artifacts.node,
          }),
          emitProviderEvent({
            type: "message.updated",
            driver: CLAUDE_PROVIDER,
            message: artifacts.message,
          }),
          emitProviderEvent({
            type: "turn_item.updated",
            driver: CLAUDE_PROVIDER,
            turnItem: artifacts.turnItem,
          }),
        ],
        { concurrency: 1 },
      );
    }

    const providerRetry = yield* Ref.modify(providerRetries, (current) => {
      const retry = current.get(input.context.providerTurnId);
      if (retry === undefined) {
        return [undefined, current] as const;
      }
      const updated = new Map(current);
      updated.delete(input.context.providerTurnId);
      return [retry, updated] as const;
    });
    if (providerRetry !== undefined && input.status !== "failed") {
      yield* emitProviderEvent({
        type: "turn_item.updated",
        driver: CLAUDE_PROVIDER,
        turnItem: makeProviderRetryTurnItem({
          driver: CLAUDE_PROVIDER,
          threadId: input.context.input.threadId,
          runId: input.context.input.runId,
          nodeId: input.context.input.rootNodeId,
          providerThreadId: input.context.input.providerThread.id,
          providerTurnId: input.context.providerTurnId,
          itemOrdinal: providerRetry.itemOrdinal,
          failure: providerRetry.failure,
          retry: providerRetry.retry,
          status: input.status,
          startedAt: providerRetry.startedAt,
          updatedAt: input.completedAt,
        }),
      });
    }

    const threadDisposition = input.threadDisposition ?? "reusable";
    const terminalEvent: ProviderAdapter.ProviderAdapterV2Event =
      input.status === "failed"
        ? {
            type: "turn.terminal",
            driver: CLAUDE_PROVIDER,
            providerThreadId: input.context.input.providerThread.id,
            providerTurnId: input.context.providerTurnId,
            runOrdinal: input.context.input.runOrdinal,
            failureItemOrdinal: yield* resolveItemOrdinal(
              input.context,
              `terminal-failure:${input.context.providerTurnId}`,
            ),
            status: input.status,
            failure: input.failure ?? makeProviderFailure({ class: "provider_error" }),
            ...(providerRetry === undefined
              ? {}
              : {
                  retry: providerRetry.retry,
                  retryStartedAt: providerRetry.startedAt,
                }),
            threadDisposition,
          }
        : {
            type: "turn.terminal",
            driver: CLAUDE_PROVIDER,
            providerThreadId: input.context.input.providerThread.id,
            providerTurnId: input.context.providerTurnId,
            runOrdinal: input.context.input.runOrdinal,
            status: input.status,
            failure: null,
            threadDisposition,
          };
    yield* Effect.all(
      [
        emitProviderEvent({
          type: "provider_turn.updated",
          driver: CLAUDE_PROVIDER,
          providerTurn: {
            ...providerTurnPayload({
              context: input.context,
              status: input.status,
              completedAt: input.completedAt,
            }),
            turnTokenUsage: normalizeClaudeTurnTokenUsage(
              input.result,
              input.context.subagentsByTaskId.size > 0 ||
                input.context.subagentsByToolUseId.size > 0,
              input.status,
              input.context.steeredSegmentUsage,
              {
                rootModels: input.context.rootModels,
                ...(input.result === undefined
                  ? {}
                  : {
                      ledger: addClaudeLedgerUsage(
                        input.context.steeredLedgerUsage,
                        resultLedgerUsage.get(input.result),
                      ),
                    }),
              },
            ),
          },
        }),
        // Emit the roster before root settlement so writeFinalRunEvents preserves it.
        Effect.gen(function* () {
          const nativeThreadId =
            input.context.input.providerThread.nativeThreadRef?.nativeId ?? null;
          if (nativeThreadId !== null) {
            if (input.status !== "completed") {
              yield* clearPendingBackgroundTasksForNativeThread(nativeThreadId);
              yield* clearNativeThreadTaskIdSet(
                wakeEligibleBackgroundTasksByNativeThread,
                nativeThreadId,
              );
              yield* clearNativeThreadTaskIdSet(
                opaqueBackgroundTaskReplayTombstonesByNativeThread,
                nativeThreadId,
              );
            }
          }
          const roster =
            nativeThreadId === null
              ? new Map<string, OrchestrationV2PendingBackgroundTask>()
              : rosterForNativeThread(
                  yield* Ref.get(pendingBackgroundTasksByNativeThread),
                  nativeThreadId,
                );
          const awaitedTaskIds =
            nativeThreadId === null
              ? new Set<string>()
              : taskIdSetForNativeThread(
                  yield* Ref.get(awaitedBackgroundTasksByNativeThread),
                  nativeThreadId,
                );
          // A stopped turn that wrote to the transcript moved past the pinned head.
          const clearConversationHead =
            (input.status === "completed" || input.context.nativeMessageCursor !== null) &&
            input.context.input.providerThread.nativeConversationHeadRef !== null;
          const goal =
            nativeThreadId === null ? undefined : goalsByNativeThread.get(nativeThreadId);
          const goalChecked = goalCheckedTurns.delete(input.context.providerTurnId);
          const terminalReason = input.result?.terminal_reason;
          const liveQuery = yield* Ref.get(queryContext);
          if (
            nativeThreadId !== null &&
            goal?.status === "active" &&
            goalChecked &&
            input.status === "completed" &&
            (terminalReason === undefined || terminalReason === "completed") &&
            roster.size === 0 &&
            !(
              liveQuery?.nativeThreadId === nativeThreadId &&
              (yield* liveProcessRunsBackgroundWork(liveQuery, { forGoalCheck: true }))
            )
          ) {
            goalsByNativeThread.set(nativeThreadId, {
              objective: goal.objective,
              status: "complete",
              ...(goal.checks === undefined ? {} : { checks: goal.checks }),
            });
          }
          const providerThread: OrchestrationV2ProviderThread = {
            ...input.context.input.providerThread,
            providerSessionId: session.id,
            ...(clearConversationHead ? { nativeConversationHeadRef: null } : {}),
            ...(nativeThreadId !== null && goalsByNativeThread.has(nativeThreadId)
              ? { goal: goalsByNativeThread.get(nativeThreadId) ?? null }
              : {}),
            firstRunOrdinal:
              input.context.input.providerThread.firstRunOrdinal ?? input.context.input.runOrdinal,
            lastRunOrdinal: input.context.input.runOrdinal,
            pendingBackgroundTasks: claudePendingBackgroundTasksFromRoster(roster, awaitedTaskIds),
            status: input.status === "completed" ? "active" : "idle",
            updatedAt: input.completedAt,
          };
          yield* rememberProviderThread(providerThread);
          yield* emitProviderEvent({
            type: "provider_thread.updated" as const,
            driver: CLAUDE_PROVIDER,
            providerThread,
          });
        }),
        emitProviderEvent(terminalEvent),
      ],
      { concurrency: 1 },
    );
    yield* Ref.update(activeTurn, (current) =>
      current?.providerTurnId === input.context.providerTurnId ? null : current,
    );
    if (input.status === "completed") {
      settledTurnByNativeThread.set(input.context.nativeThreadId, input.context);
    } else {
      settledTurnByNativeThread.delete(input.context.nativeThreadId);
    }
    yield* Ref.update(interruptedTurns, (current) => {
      const next = new Set(current);
      next.delete(input.context.providerTurnId);
      return next;
    });
  });

  const emitAssistantTextArtifacts = Effect.fnUntraced(function* (input: {
    readonly context: ActiveClaudeTurnContext;
    readonly nativeItemId: string;
    readonly text: string;
  }) {
    if (input.context.assistant.emittedNativeItemIds.has(input.nativeItemId)) {
      return;
    }
    input.context.assistant.emittedNativeItemIds.add(input.nativeItemId);
    const now = yield* DateTime.now;
    const ordinal = yield* resolveItemOrdinal(input.context, input.nativeItemId);
    const artifacts = buildAssistantArtifacts({
      idAllocator,
      turnInput: input.context.input,
      providerTurnId: input.context.providerTurnId,
      nativeItemId: input.nativeItemId,
      text: input.text,
      ordinal,
      startedAt: now,
      completedAt: now,
    });
    yield* Effect.all(
      [
        emitProviderEvent({
          type: "node.updated",
          driver: CLAUDE_PROVIDER,
          node: artifacts.node,
        }),
        emitProviderEvent({
          type: "message.updated",
          driver: CLAUDE_PROVIDER,
          message: artifacts.message,
        }),
        emitProviderEvent({
          type: "turn_item.updated",
          driver: CLAUDE_PROVIDER,
          turnItem: artifacts.turnItem,
        }),
      ],
      { concurrency: 1 },
    );
  });

  const endSubagentsOfClosedQuery = Effect.fnUntraced(function* (input: {
    readonly closedQuery: ClaudeLiveQueryContext;
    readonly context: ActiveClaudeTurnContext;
    readonly subagents: Iterable<readonly [string, ActiveClaudeSubagent]>;
    readonly buffered: ReadonlyArray<SDKMessage> | undefined;
    readonly interrupted: boolean;
  }) {
    for (const [taskId, subagent] of input.subagents) {
      if (
        subagent.task.status !== "running" ||
        input.closedQuery.subagentsFromEarlierProcesses.has(subagent)
      )
        continue;
      const latestLifecycle = input.buffered?.findLast(
        (
          message,
        ): message is Extract<
          SDKMessage,
          { readonly subtype: "task_started" | "task_notification" }
        > =>
          message.type === "system" &&
          (message.subtype === "task_started" || message.subtype === "task_notification") &&
          message.task_id === taskId,
      );
      const completion =
        latestLifecycle?.subtype === "task_notification" ? latestLifecycle : undefined;
      yield* updateClaudeSubagentNode({
        context: input.context,
        taskId,
        status: completion
          ? claudeTaskOutcome(completion.status)
          : input.interrupted
            ? "cancelled"
            : "failed",
        ...(completion === undefined
          ? {}
          : { workflowFrame: completion, result: completion.summary }),
        processExited: true,
        onlyIfRunningInRun: subagent.task.runId,
      });
    }
  });

  // A query opened while this one was closing inherited the subagents it ran, so
  // nothing else ends them. Leave the live query's own turn, roster and subagents alone.
  const endSubagentsOfReplacedQuery = Effect.fnUntraced(function* (
    closedQuery: ClaudeLiveQueryContext,
  ) {
    const context = closedQuery.lastTurn;
    if (context === null) return;
    yield* endSubagentsOfClosedQuery({
      closedQuery,
      context,
      subagents: [...(yield* Ref.get(sessionSubagentsByTaskId))].filter(([, subagent]) =>
        closedQuery.handedOffSubagents.has(subagent),
      ),
      buffered: (yield* Ref.get(wakeBuffers)).get(closedQuery.nativeThreadId)?.messages,
      interrupted:
        closedQuery.stopping || (yield* Ref.get(interruptedTurns)).has(context.providerTurnId),
    });
  });

  const finalizeActiveTurnAfterQueryExit = Effect.fnUntraced(function* (
    closedQuery: ClaudeLiveQueryContext,
    cause?: Cause.Cause<ClaudeAgentSdkQueryRunnerError>,
  ) {
    const current = yield* Ref.get(activeTurn);
    // A replacement query can reuse the native thread id; only this query's turn is ours.
    const context = closedQuery.lastTurn;
    if (context === null) return;
    const interrupted =
      closedQuery.stopping || (yield* Ref.get(interruptedTurns)).has(context.providerTurnId);
    // Finalization can yield to a replacement process; capture ownership and outcomes first.
    const subagents = yield* Ref.get(sessionSubagentsByTaskId);
    const buffered = (yield* Ref.get(wakeBuffers)).get(closedQuery.nativeThreadId)?.messages;
    if (current === context) {
      yield* finalizeActiveTurn({
        context,
        status: interrupted ? "interrupted" : "failed",
        completedAt: yield* DateTime.now,
        ...(interrupted
          ? {}
          : {
              failure: makeProviderFailure({
                cause: cause === undefined ? undefined : Cause.squash(cause),
                class: "transport_error",
              }),
            }),
      });
    } else {
      yield* resetBackgroundTaskStateForNativeThreadProcess(closedQuery.nativeThreadId);
    }
    // Preserve buffered outcomes before Stop clears the wake buffer.
    yield* endSubagentsOfClosedQuery({
      closedQuery,
      context,
      subagents,
      buffered,
      interrupted,
    });
    yield* Ref.update(interruptedTurns, (current) => {
      const next = new Set(current);
      next.delete(context.providerTurnId);
      return next;
    });
    if (cause !== undefined) {
      yield* Effect.logWarning("orchestration-v2.claude-query-stream-failed", {
        providerSessionId: input.providerSessionId,
        providerThreadId: context.input.providerThread.id,
        providerTurnId: context.providerTurnId,
        cause,
      });
    }
  });

  return {
    finalizeActiveTurn,
    emitAssistantTextArtifacts,
    endSubagentsOfClosedQuery,
    endSubagentsOfReplacedQuery,
    finalizeActiveTurnAfterQueryExit,
  };
};
