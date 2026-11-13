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
import type { RawThreadFeedEntry, ThreadFeedActivity, ThreadFeedActivityGroup, ThreadFeedEntry } from "./threadActivity";
import { activityGroupsCache, isEmptyMessage } from "./threadActivity";

export function groupAdjacentActivities(
  entries: ReadonlyArray<RawThreadFeedEntry>,
  childrenByRun: ReadonlyMap<RunId, ReadonlySet<string>>,
  onRestart?: (entryIndex: number, groupedLength: number) => void,
): ThreadFeedEntry[] {
  const grouped: ThreadFeedEntry[] = [];
  let firstActivityEntry: Extract<RawThreadFeedEntry, { readonly type: "activity" }> | null = null;
  let openGroupActivities: ThreadFeedActivity[] = [];
  const flushGroup = () => {
    if (firstActivityEntry === null) return;
    const cached = activityGroupsCache.get(firstActivityEntry.activity);
    if (
      cached &&
      cached.activities.length === openGroupActivities.length &&
      cached.activities.every((activity, index) => activity === openGroupActivities[index])
    ) {
      grouped.push(cached);
    } else {
      const group: ThreadFeedActivityGroup = {
        type: "activity-group",
        id: firstActivityEntry.id,
        createdAt: firstActivityEntry.createdAt,
        runId: firstActivityEntry.runId,
        activities: openGroupActivities,
      };
      activityGroupsCache.set(firstActivityEntry.activity, group);
      grouped.push(group);
    }
    firstActivityEntry = null;
    openGroupActivities = [];
  };

  for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
    const entry = entries[entryIndex]!;
    if (entry.type === "activity") {
      const item = entry.activity.projectedItem.item;
      if (
        item.type === "dynamic_tool" &&
        item.runId !== null &&
        (item.status === "running" || item.status === "completed") &&
        resolveT3McpToolDefinition(item.toolName)?.summaryAction === "delegate" &&
        !workEntryDisplayIndicatesToolFailure(entry.activity.workEntry)
      ) {
        const output = compactDynamicToolOutput(item.output);
        if (
          !output?.isError &&
          output?.taskId !== undefined &&
          childrenByRun.get(item.runId)?.has(output.taskId)
        )
          continue;
      }
    }
    if (isEmptyMessage(entry)) {
      continue;
    }

    if (entry.type !== "activity") {
      flushGroup();
      grouped.push(entry);
      onRestart?.(entryIndex, grouped.length);
      continue;
    }

    const isStandaloneActivity =
      entry.activity.workEntry.questionAnswer !== undefined ||
      entry.activity.projectedItem.item.type === "compaction" ||
      entry.activity.projectedItem.item.type === "handoff" ||
      entry.activity.projectedItem.item.type === "notification";
    if (
      isStandaloneActivity ||
      entry.activity.prominent ||
      (entry.activity.projectedItem.item.type === "subagent") !==
        (firstActivityEntry?.activity.projectedItem.item.type === "subagent") ||
      firstActivityEntry?.runId !== entry.runId ||
      (entry.activity.projectedItem.item.type === "subagent" &&
        firstActivityEntry?.activity.projectedItem.item.providerTurnId !==
          entry.activity.projectedItem.item.providerTurnId) ||
      (entry.activity.projectedItem.item.type !== "subagent" &&
        firstActivityEntry?.activity.attemptId !== entry.activity.attemptId)
    ) {
      flushGroup();
    }
    firstActivityEntry ??= entry;
    openGroupActivities.push(entry.activity);
    if (isStandaloneActivity || entry.activity.prominent) {
      flushGroup();
    }
  }
  flushGroup();
  return grouped;
}

