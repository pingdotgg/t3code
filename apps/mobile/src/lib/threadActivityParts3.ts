import type {
  ThreadPendingApproval,
  ThreadPendingUserInput,
} from "@t3tools/client-runtime/state/thread-requests";
import { turnItemIsWorkspacePreparation } from "@t3tools/client-runtime/state/turn-item-presentation";
import type { ThreadCheckpointSummary } from "@t3tools/client-runtime/state/thread-checkpoints";
import { formatSubagentDisplayTitle } from "@t3tools/client-runtime/state/subagent-display";
import { isLiveSubagentTurnItem } from "@t3tools/client-runtime/state/subagentRuntime";
import { extractToolActivityPresentation } from "@t3tools/client-runtime/work-log/tool-presentation";
import {
  turnItemDetailRevision,
  turnItemHasDetail,
  turnItemNeedsDetailFetch,
} from "@t3tools/client-runtime/work-log/item-detail";
import {
  commandDisplayText,
  commandProgramName,
} from "@t3tools/client-runtime/work-log/command-label";
import {
  contextCompactionLabel,
  liveThoughtLine,
  toolItemForDisplay,
  workEntryDisplayIndicatesToolFailure,
  liveActivityToolStatus,
  toolGroupAction,
  resolveWorkEntryToolPresentation,
  summarizeToolGroup,
  toolGroupSummaryKind,
  type ToolGroupSummaryKind,
  type WorkLogPresentationEntry,
  type WorkLogToolLifecycleStatus,
} from "@t3tools/client-runtime/work-log/presentation";
import {
  resolveT3McpToolDefinition,
  resolveT3McpToolPresentation,
  type T3McpToolLogo,
  type T3McpToolPresentation,
} from "@t3tools/shared/t3McpToolPresentation";
import type {
  ChatAttachment,
  MessageId,
  OrchestrationV2Actor,
  OrchestrationV2CreationSource,
  OrchestrationV2ExecutionNode,
  OrchestrationMessageContext,
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2RunAttempt,
  OrchestrationV2RunStatus,
  OrchestrationV2TurnItem,
  OrchestrationV2UserMessageInputIntent,
  RunAttemptId,
  ScheduledTaskId,
  TurnItemId,
} from "@t3tools/contracts";
import { idleCompactionOf, isCompactionCommandMessage, RunId, ThreadId } from "@t3tools/contracts";
import {
  classifyToolActivity,
  collectToolFilePaths,
  dynamicToolTitle,
  isJavaScriptReplTool,
  formatReadToolLabel,
  formatSearchToolLabel,
} from "@t3tools/shared/toolActivity";
import { claudeResumeCompactionAge } from "@t3tools/shared/claudeCompaction";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import { truncate } from "@t3tools/shared/String";
import type { HtmlRenderReference } from "@t3tools/shared/htmlRender";
import type { McpAppReference } from "@t3tools/shared/mcpApp";
import {
  compactDynamicToolOutput,
  htmlRenderFromToolItem,
  mcpAppFromToolItem,
} from "@t3tools/shared/toolOutput";
import * as DateTime from "effect/DateTime";
import {
  IDLE_COMPACTION_TITLES,
  IDLE_COMPACTING_LABELS,
} from "@t3tools/client-runtime/user-message";
import type { ThreadFeedEntry, ThreadFeedLatestRun, ThreadFeedRunFold } from "./threadActivity";
import { computeElapsedMs, isContextCompactionActivityGroup, maxIsoTimestamp, unsettledRunId } from "./threadActivity";

export function deriveThreadFeedRunFolds(
  feed: ReadonlyArray<ThreadFeedEntry>,
  latestRun: ThreadFeedLatestRun | null,
  runlessWorkActive: boolean,
  feedFailedRunIds: ReadonlySet<RunId>,
): ReadonlyMap<string, ThreadFeedRunFold> {
  const terminalAssistantMessageIdByRun = new Map<RunId, string>();
  const interruptedRunIds = new Set<RunId>();
  const failedRunIds = new Set(feedFailedRunIds);
  const promptIndexByRunId = new Map<RunId, number>();
  for (const [index, entry] of feed.entries()) {
    if (
      entry.type !== "message" ||
      entry.message.role !== "user" ||
      entry.message.inputIntent === "steer" ||
      entry.message.inputIntent === "promoted_queued_to_steer"
    ) {
      continue;
    }
    const runId = entry.message.runId;
    if (runId != null && !promptIndexByRunId.has(runId)) promptIndexByRunId.set(runId, index);
  }
  const groupsByRunId = new Map<
    RunId,
    { entries: ThreadFeedEntry[]; startBoundary: string | null }
  >();
  let runlessKey: RunId | null = null;
  let responseKey: RunId | null = null;
  let pendingUserBoundary: string | null = null;
  for (const [index, entry] of feed.entries()) {
    if (entry.type === "message" && entry.message.role === "user") {
      pendingUserBoundary = entry.message.createdAt;
      runlessKey = entry.message.runId == null ? RunId.make(`runless:${entry.id}`) : null;
      responseKey = entry.message.runId ?? runlessKey;
      continue;
    }
    const ownRunId =
      entry.type === "message" && entry.message.role === "assistant"
        ? (entry.message.runId ?? runlessKey)
        : entry.type === "activity-group" ||
            entry.type === "html-render" ||
            entry.type === "mcp-app"
          ? (entry.runId ?? runlessKey)
          : null;
    if (!ownRunId) continue;
    // Resumed subagents keep their original turn position and fold, leaving later run folds under their own prompts.
    const runId =
      responseKey !== null && (promptIndexByRunId.get(ownRunId) ?? -1) > index
        ? responseKey
        : ownRunId;
    let group = groupsByRunId.get(runId);
    if (!group) {
      group = { entries: [], startBoundary: pendingUserBoundary };
      pendingUserBoundary = null;
      groupsByRunId.set(runId, group);
    }
    group.entries.push(entry);
    if (entry.type === "message") {
      terminalAssistantMessageIdByRun.set(runId, entry.id);
    }
    if (entry.type !== "activity-group") continue;
    for (const activity of entry.activities) {
      const item = activity.projectedItem.item;
      if (item.type === "run_interrupt_result") interruptedRunIds.add(runId);
      if (
        runId === runlessKey &&
        item.type === "error" &&
        item.status === "failed" &&
        item.parentItemId === null
      ) {
        failedRunIds.add(runId);
      }
    }
  }

  const activeRunId = unsettledRunId(latestRun);
  const foldsByAnchorId = new Map<string, ThreadFeedRunFold>();
  for (const [runId, group] of groupsByRunId) {
    if (
      runId === activeRunId ||
      (runlessWorkActive && runId === runlessKey) ||
      interruptedRunIds.has(runId) ||
      failedRunIds.has(runId) ||
      group.entries.some((entry) => entry.type === "message" && entry.message.streaming)
    ) {
      continue;
    }
    const terminalAssistantId = terminalAssistantMessageIdByRun.get(runId);
    const hiddenEntryIds = new Set(
      group.entries
        .filter(
          (entry) =>
            entry.id !== terminalAssistantId &&
            entry.type !== "html-render" &&
            entry.type !== "mcp-app" &&
            !(entry.type === "activity-group" && isContextCompactionActivityGroup(entry)) &&
            !(
              entry.type === "activity-group" &&
              entry.activities.some(
                (activity) =>
                  activity.prominent ||
                  activity.workEntry.questionAnswer !== undefined ||
                  activity.projectedItem.item.type === "notification" ||
                  activity.projectedItem.item.type === "handoff" ||
                  // A child still working outlives its settled launching run;
                  // its group stays visible while any member is live.
                  isLiveSubagentTurnItem(activity.projectedItem.item),
              )
            ),
        )
        .map((entry) => entry.id),
    );
    const firstEntry = group.entries[0];
    const firstHiddenEntry = group.entries.find((entry) => hiddenEntryIds.has(entry.id));
    const lastEntry = group.entries.at(-1);
    if (!firstHiddenEntry || !firstEntry || !lastEntry) continue;
    const hidesNonCompactionWork = group.entries.some(
      (entry) =>
        hiddenEntryIds.has(entry.id) &&
        !(entry.type === "activity-group" && isContextCompactionActivityGroup(entry)),
    );
    if (!hidesNonCompactionWork) continue;
    const terminalEntry = terminalAssistantId
      ? group.entries.find((entry) => entry.id === terminalAssistantId)
      : null;
    const latestRunMatches = latestRun?.runId === runId;
    const lastEntryEnd =
      lastEntry.type === "message" ? lastEntry.message.updatedAt : lastEntry.createdAt;
    const elapsedMs =
      latestRunMatches && latestRun.startedAt && latestRun.completedAt
        ? computeElapsedMs(latestRun.startedAt, latestRun.completedAt)
        : computeElapsedMs(
            group.startBoundary ?? firstEntry.createdAt,
            maxIsoTimestamp(
              terminalEntry?.type === "message" ? terminalEntry.message.updatedAt : null,
              lastEntryEnd,
            ) ?? lastEntryEnd,
          );
    const duration = elapsedMs === null ? null : formatDuration(elapsedMs);
    const interrupted =
      latestRunMatches && (latestRun.status === "interrupted" || latestRun.status === "cancelled");
    const deferredWorkItemIds = group.entries.flatMap((entry) =>
      entry.type === "activity-group"
        ? entry.activities.flatMap((activity) =>
            activity.projectedItem.item.deferredWork
              ? [String(activity.projectedItem.sourceItemId)]
              : [],
          )
        : [],
    );
    foldsByAnchorId.set(firstHiddenEntry.id, {
      ...(deferredWorkItemIds.length > 0 ? { deferredWorkItemIds } : {}),
      runId,
      createdAt: firstHiddenEntry.createdAt,
      hiddenEntryIds,
      label: interrupted
        ? duration
          ? `You stopped after ${duration}`
          : "You stopped this response"
        : duration
          ? `Worked for ${duration}`
          : "Worked",
    });
  }
  const covered = new Set(
    [...foldsByAnchorId.values()].flatMap((fold) => [...fold.hiddenEntryIds]),
  );
  for (const entry of feed) {
    if (entry.type !== "activity-group" || covered.has(entry.id)) continue;
    const deferredWorkItemIds = entry.activities.flatMap((activity) =>
      activity.projectedItem.item.deferredWork ? [String(activity.projectedItem.sourceItemId)] : [],
    );
    if (deferredWorkItemIds.length === 0) continue;
    foldsByAnchorId.set(entry.id, {
      runId: RunId.make(`deferred-work:${entry.id}`),
      createdAt: entry.createdAt,
      hiddenEntryIds: new Set([entry.id]),
      label: "Earlier work",
      deferredWorkItemIds,
    });
  }
  return foldsByAnchorId;
}

