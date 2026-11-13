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
import type { ThreadFeedCache, ThreadFeedEntry, ThreadFeedLatestRun } from "./threadActivity";
import { LIVE_ACTIVITY_ROW_ID, appendPresentedFeedEntry, continuedWorkLogRows, deriveThreadFeedRunFolds, failedActivityGroupsCache, failedFeedRunIds, feedEntryRunId, isContextCompactionActivityGroup, isResumeCompactionAnswerGroup, isUserMessageEntry, isWorkLogFeedRow, presentationRestart, runFoldRowsCache, settleSupersededReasoning, thinkingRow, unsettledRunId } from "./threadActivity";

export function deriveThreadFeedPresentation(
  feed: ReadonlyArray<ThreadFeedEntry>,
  latestRun: ThreadFeedLatestRun | null,
  expandedRunIds: ReadonlySet<RunId>,
  expandedWorkGroupIds: ReadonlySet<string> = new Set(),
  activeWorkStartedAt: string | null = null,
  runlessWorkActive = false,
  cache?: ThreadFeedCache,
): ThreadFeedEntry[] {
  const previous = cache?.presentation ?? null;
  const restart = presentationRestart(
    previous,
    feed,
    latestRun,
    expandedRunIds,
    expandedWorkGroupIds,
    activeWorkStartedAt,
    runlessWorkActive,
  );
  const start = restart?.entry ?? 0;
  const result: ThreadFeedEntry[] =
    restart === null ? [] : previous!.rows.slice(0, restart.rowsLength);
  const restarts = restart === null ? [] : previous!.restarts.slice(0, restart.index);
  const firstEntryByRun = new Map<RunId, number>();
  if (restart !== null) {
    for (const [runId, entry] of previous!.firstEntryByRun) {
      if (entry < start) firstEntryByRun.set(runId, entry);
    }
  }
  const tailStart = result.length;
  const lastEntryByRun = new Map<RunId, number>();

  const retainedFeed: Array<
    Exclude<ThreadFeedEntry, { readonly type: "run-fold" | "work-toggle" | "thinking" }>
  > = [];
  const retainedFeedIndices: number[] = [];
  for (let index = start; index < feed.length; index += 1) {
    const entry = feed[index]!;
    if (entry.type === "run-fold" || entry.type === "work-toggle" || entry.type === "thinking")
      continue;
    retainedFeed.push(entry);
    retainedFeedIndices.push(index);
  }
  const sourceFeed = retainedFeed.map((entry, index) =>
    settleSupersededReasoning(entry, index === retainedFeed.length - 1),
  );
  const failedRunIds = failedFeedRunIds(sourceFeed, latestRun);
  const activeTailGroup = sourceFeed.at(-1);
  const activeRunId = unsettledRunId(latestRun);
  // A bare `/compact` turn is the compaction itself: its compaction row stands in for the prompt
  // and the live activity row. An answered "compact before continuing?" question folds into the
  // compaction it asked for.
  const compactionCommandRunIds = new Set<RunId>();
  const compactionItemRunIds = new Set<RunId>();
  for (const entry of feed) {
    if (
      entry.type === "message" &&
      entry.message.runId !== null &&
      isCompactionCommandMessage(entry.message)
    ) {
      compactionCommandRunIds.add(entry.message.runId);
    } else if (
      entry.type === "activity-group" &&
      entry.runId !== null &&
      isContextCompactionActivityGroup(entry)
    ) {
      compactionItemRunIds.add(entry.runId);
    }
  }
  const isWorking = activeWorkStartedAt !== null && latestRun?.status !== "preparing";
  const foldsByAnchorId = deriveThreadFeedRunFolds(
    sourceFeed,
    latestRun,
    isWorking && runlessWorkActive,
    failedRunIds,
  );
  const collapsedEntryIds = new Set<string>();
  for (const fold of foldsByAnchorId.values()) {
    if (!expandedRunIds.has(fold.runId)) {
      for (const entryId of fold.hiddenEntryIds) collapsedEntryIds.add(entryId);
    }
  }
  for (let sourceIndex = 0; sourceIndex < sourceFeed.length; sourceIndex += 1) {
    const entry = sourceFeed[sourceIndex]!;
    const feedIndex = retainedFeedIndices[sourceIndex]!;
    if (isUserMessageEntry(entry)) {
      restarts.push({ entry: feedIndex, rowsLength: result.length });
    }
    const runId = feedEntryRunId(entry);
    if (runId !== null) {
      if (!firstEntryByRun.has(runId)) firstEntryByRun.set(runId, feedIndex);
      lastEntryByRun.set(runId, feedIndex);
    }
    const isActiveTailGroup =
      isWorking &&
      (activeRunId !== null || runlessWorkActive) &&
      entry.type === "activity-group" &&
      activeTailGroup?.type === "activity-group" &&
      activeTailGroup.id === entry.id &&
      entry.runId === activeRunId;
    const fold = foldsByAnchorId.get(entry.id);
    if (fold) {
      const expanded = expandedRunIds.has(fold.runId);
      let row = runFoldRowsCache.get(entry);
      if (
        !row ||
        row.runId !== fold.runId ||
        row.createdAt !== fold.createdAt ||
        row.label !== fold.label ||
        row.expanded !== expanded ||
        row.deferredWorkItemIds?.join("|") !== fold.deferredWorkItemIds?.join("|")
      ) {
        row = {
          type: "run-fold",
          id: `run-fold:${fold.runId}`,
          ...(fold.deferredWorkItemIds ? { deferredWorkItemIds: fold.deferredWorkItemIds } : {}),
          createdAt: fold.createdAt,
          runId: fold.runId,
          label: fold.label,
          expanded,
        };
        runFoldRowsCache.set(entry, row);
      }
      result.push(row);
    }
    if (
      (entry.type === "message" &&
        entry.message.runId !== null &&
        compactionItemRunIds.has(entry.message.runId) &&
        isCompactionCommandMessage(entry.message)) ||
      (entry.type === "activity-group" &&
        entry.runId !== null &&
        compactionItemRunIds.has(entry.runId) &&
        isResumeCompactionAnswerGroup(entry))
    ) {
      continue;
    }
    if (!collapsedEntryIds.has(entry.id)) {
      if (
        entry.type === "activity-group" &&
        entry.runId !== null &&
        failedRunIds.has(entry.runId)
      ) {
        let rows = failedActivityGroupsCache.get(entry);
        if (!rows) {
          rows =
            entry.activities.length === 1
              ? [entry]
              : entry.activities.map((activity) => ({
                  type: "activity-group" as const,
                  id: activity.id,
                  createdAt: activity.createdAt,
                  runId: activity.runId,
                  activities: [activity],
                }));
          failedActivityGroupsCache.set(entry, rows);
        }
        result.push(...rows);
        continue;
      }
      appendPresentedFeedEntry(
        result,
        entry,
        expandedWorkGroupIds,
        activeRunId,
        isWorking,
        isActiveTailGroup,
      );
    }
  }
  if (
    isWorking &&
    activeWorkStartedAt !== null &&
    latestRun?.turnEnded !== true &&
    (activeRunId === null || !compactionCommandRunIds.has(activeRunId)) &&
    !result.some(
      (row) =>
        row.id === LIVE_ACTIVITY_ROW_ID ||
        (row.type === "activity-group" &&
          isContextCompactionActivityGroup(row) &&
          row.runId === activeRunId &&
          row.activities[0]?.projectedItem.item.status === "running"),
    )
  ) {
    result.push(thinkingRow(activeWorkStartedAt, activeRunId));
  }
  const checkpointByRunId = new Map<RunId, ThreadCheckpointSummary>();
  for (const entry of sourceFeed) {
    if (entry.type === "message" && entry.message.checkpointSummary) {
      checkpointByRunId.set(entry.message.checkpointSummary.runId, entry.message.checkpointSummary);
    }
  }
  const workRowByRunId = new Map<RunId, number>();
  for (let index = tailStart; index < result.length; index += 1) {
    const row = result[index]!;
    if (
      (row.type === "run-fold" || row.type === "work-toggle") &&
      row.runId !== null &&
      checkpointByRunId.has(row.runId) &&
      (row.type === "run-fold" || !workRowByRunId.has(row.runId))
    ) {
      workRowByRunId.set(row.runId, index);
    }
  }
  for (const [runId, index] of workRowByRunId) {
    result[index] = { ...result[index]!, checkpointSummary: checkpointByRunId.get(runId)! };
  }
  for (let index = tailStart; index < result.length; index += 1) {
    const row = result[index]!;
    if (
      row.type !== "message" ||
      !row.message.checkpointSummary ||
      !workRowByRunId.has(row.message.checkpointSummary.runId)
    )
      continue;
    const message = { ...row.message };
    delete message.checkpointSummary;
    result[index] = { ...row, message };
  }
  // Reused rows are final: the user message after them never continues a work log.
  for (let index = tailStart; index < result.length; index += 1) {
    const row = result[index]!;
    if (!isWorkLogFeedRow(row) || !isWorkLogFeedRow(result[index + 1])) continue;
    let continued = continuedWorkLogRows.get(row);
    if (!continued) {
      continued = { ...row, continuesWorkLog: true };
      continuedWorkLogRows.set(row, continued);
    }
    result[index] = continued;
  }
  // A run that crosses a user message made the rows before it from entries
  // after it, so a later build cannot restart there even once those entries
  // are gone. Only runs of this build's own entries can cross its restarts.
  const crossings = Array.from({ length: feed.length - start + 1 }, () => 0);
  for (const [runId, last] of lastEntryByRun) {
    const first = firstEntryByRun.get(runId)!;
    if (first >= last) continue;
    crossings[first - start + 1]! += 1;
    crossings[last - start + 1]! -= 1;
  }
  let crossingRuns = 0;
  let crossingIndex = 0;
  const cleanRestarts = restarts.filter((candidate) => {
    if (candidate.entry < start) return true;
    while (crossingIndex <= candidate.entry - start) {
      crossingRuns += crossings[crossingIndex]!;
      crossingIndex += 1;
    }
    return crossingRuns === 0;
  });
  if (cache) {
    cache.presentation = {
      feed,
      latestRun,
      expandedRunIds,
      expandedWorkGroupIds,
      activeWorkStartedAt,
      runlessWorkActive,
      rows: result,
      restarts: cleanRestarts,
      firstEntryByRun,
    };
  }
  return result;
}

