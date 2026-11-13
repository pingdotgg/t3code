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
import type { ThreadFeedActivity, ThreadFeedEntry } from "./threadActivity";
import { LIVE_ACTIVITY_ROW_ID, compactWorkEntryText, liveToolActivitySummary, singleToolCallLabel } from "./threadActivity";

export function appendToolGroupRows(
  result: ThreadFeedEntry[],
  sourceGroup: Extract<ThreadFeedEntry, { readonly type: "activity-group" }>,
  activities: ReadonlyArray<ThreadFeedActivity>,
  groupId: string,
  expandedWorkGroupIds: ReadonlySet<string>,
  activeRunId: RunId | null,
  isWorking: boolean,
  activeTail: boolean,
): void {
  const expanded = expandedWorkGroupIds.has(groupId);
  const latestActiveActivity = activities.findLast(
    (activity) =>
      isWorking && activity.lifecycleStatus === "inProgress" && activity.runId === activeRunId,
  );
  const active = latestActiveActivity !== undefined;
  const live = activeTail || active;
  const latestActivity = latestActiveActivity ?? activities.at(-1)!;
  const shimmer = activeTail && (active || latestActivity.status === "success");
  const singleActivity = activities.length === 1 ? latestActivity : null;
  const groupSummary = summarizeToolGroup(activities.map((activity) => activity.workEntry));
  const latestThought =
    live && !expanded
      ? activities.findLast(
          (activity) =>
            activity.workEntry.itemType === "reasoning" &&
            (activity.workEntry.detail?.trim() ?? "") !== "",
        )?.workEntry.detail
      : undefined;
  const thought = latestThought ? compactWorkEntryText(liveThoughtLine(latestThought)) : "";
  const summary = live
    ? (expanded || thought) && latestActivity.workEntry.itemType === "reasoning"
      ? latestActivity.lifecycleStatus === "inProgress"
        ? "Thinking"
        : "Thought"
      : liveToolActivitySummary(latestActivity, live)
    : singleActivity !== null &&
        singleActivity.toolLike &&
        toolGroupAction(singleActivity.workEntry) !== "edit"
      ? singleToolCallLabel(singleActivity, expanded)
      : singleActivity !== null && !singleActivity.toolLike
        ? singleActivity.workEntry.label
        : groupSummary.summary;
  const id = shimmer ? LIVE_ACTIVITY_ROW_ID : `${live ? "work-live" : "work-toggle"}:${groupId}`;
  // Lone calls replace the header and disclose directly; lone thoughts retain the header to show text on expansion.
  if (singleActivity !== null && singleActivity.workEntry.itemType !== "reasoning") {
    result.push({
      type: "activity-group",
      id,
      createdAt: singleActivity.createdAt,
      runId: singleActivity.runId,
      activities: [{ ...singleActivity, live: shimmer, groupStandIn: { groupId, label: summary } }],
      // No trailing margin lets Thinking or a growing group replace the row without shifting the feed.
      continuesWorkLog: true,
    });
    return;
  }
  const primarySourceActivity = activities.find(
    (activity) => activity.workEntry.toolSource !== undefined,
  );
  const primarySourceKey = primarySourceActivity?.workEntry.toolSource?.key;
  const primarySourceIcon = primarySourceKey
    ? (activities.find(
        (activity) =>
          activity.workEntry.toolSource?.key === primarySourceKey &&
          activity.workEntry.toolIcon !== undefined,
      )?.workEntry.toolIcon ?? primarySourceActivity?.workEntry.toolSource?.icon)
    : undefined;
  const groupToolSurface =
    primarySourceActivity?.workEntry.toolSurface ??
    latestActivity.workEntry.toolSurface ??
    activities.findLast((activity) => activity.workEntry.toolSurface !== undefined)?.workEntry
      .toolSurface;
  const groupToolIcon =
    primarySourceIcon ??
    latestActivity.workEntry.toolIcon ??
    activities.findLast((activity) => activity.workEntry.toolIcon !== undefined)?.workEntry
      .toolIcon;
  const summaryToolIcon = live
    ? resolveWorkEntryToolPresentation(latestActivity.workEntry)?.icon
    : undefined;
  result.push({
    type: "work-toggle",
    id,
    createdAt: sourceGroup.createdAt,
    runId: sourceGroup.runId,
    groupId,
    hiddenCount: activities.length,
    expanded,
    summary,
    summaryKind: toolGroupSummaryKind(
      (live ? [latestActivity] : activities).map((activity) => activity.workEntry),
    ),
    ...(groupToolSurface ? { toolSurface: groupToolSurface } : {}),
    ...(groupToolIcon ? { toolIcon: groupToolIcon } : {}),
    ...(summaryToolIcon ? { summaryToolIcon } : {}),
    ...(thought ? { thought } : {}),
    hasFailure: (() => {
      const lastToolLike = activities.findLast((activity) => activity.toolLike);
      return (
        lastToolLike !== undefined && workEntryDisplayIndicatesToolFailure(lastToolLike.workEntry)
      );
    })(),
    live,
    shimmer,
  });
  if (!expanded) return;
  result.push({
    type: "activity-group",
    id: `work-details:${groupId}`,
    createdAt: activities[0]!.createdAt,
    runId: activities[0]!.runId,
    activities: activities.map((activity) => ({
      ...activity,
      groupedToolDetail: true,
      live:
        isWorking &&
        activity.id === latestActivity.id &&
        activity.lifecycleStatus === "inProgress" &&
        activity.runId === activeRunId,
    })),
  });
}

