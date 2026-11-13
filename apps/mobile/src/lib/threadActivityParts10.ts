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
import { appendToolGroupRows } from "./threadActivityParts4";
import { itemIcon } from "./threadActivityParts6";
import { toWorkLogEntry } from "./threadActivityParts7";
import { itemSummary } from "./threadActivityParts8";
import type { ThreadFeedActivity, ThreadFeedActivityGroup, ThreadFeedEntry } from "./threadActivity";
import { threadFeedActivityIsVisible } from "./threadActivity";

export function appendActivityGroupRows(
  result: ThreadFeedEntry[],
  entry: ThreadFeedActivityGroup,
  expandedWorkGroupIds: ReadonlySet<string>,
  activeRunId: RunId | null,
  isWorking: boolean,
  activeTail: boolean,
): void {
  const groupAnchorIdByActivityId = new Map<string, string>();
  let groupAnchorId: string | null = null;
  for (const activity of entry.activities) {
    const item = activity.projectedItem.item;
    if (activity.prominent || (item.type === "error" && item.status === "failed")) {
      groupAnchorId = null;
      continue;
    }
    groupAnchorId ??= activity.id;
    groupAnchorIdByActivityId.set(activity.id, groupAnchorId);
  }
  const activities = entry.activities.filter(
    (activity) =>
      threadFeedActivityIsVisible(activity) ||
      (isWorking && activity.lifecycleStatus === "inProgress" && activity.runId === activeRunId),
  );
  if (activities.length === 0) {
    return;
  }

  let groupableRun: ThreadFeedActivity[] = [];
  const flushGroupableRun = (isTrailingRun: boolean) => {
    if (groupableRun.length === 0) return;
    appendToolGroupRows(
      result,
      entry,
      groupableRun,
      `work-group:${groupAnchorIdByActivityId.get(groupableRun[0]!.id) ?? groupableRun[0]!.id}`,
      expandedWorkGroupIds,
      activeRunId,
      isWorking,
      activeTail && isTrailingRun,
    );
    groupableRun = [];
  };
  for (const activity of activities) {
    const item = activity.projectedItem.item;
    const severeProviderError = item.type === "error" && item.status === "failed";
    if (!activity.prominent && !severeProviderError && item.type !== "notification") {
      groupableRun.push(activity);
      continue;
    }
    flushGroupableRun(false);
    result.push({
      type: "activity-group",
      id: activity.id,
      createdAt: activity.createdAt,
      runId: activity.runId,
      activities: [activity],
    });
  }
  flushGroupableRun(true);
}

