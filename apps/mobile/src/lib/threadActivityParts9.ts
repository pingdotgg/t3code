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
import type { ThreadFeedActivity } from "./threadActivity";
import { formatItemFullDetail, itemIsProminent, itemIsToolLike, itemLifecycleStatus, itemPreview, itemStatus, itemToolPresentation, memoizeValue } from "./threadActivity";

export function toFeedActivity(
  row: OrchestrationV2ProjectedTurnItem,
  attemptId: RunAttemptId | null,
): ThreadFeedActivity {
  const item = row.item;
  const toolPresentation = itemToolPresentation(item);
  const summary = itemSummary(item, toolPresentation);
  const detail = item.type === "notification" ? null : itemPreview(item);
  const createdAt = DateTime.formatIso(item.startedAt ?? item.updatedAt);
  const workEntry = toWorkLogEntry(item, createdAt, summary, detail);
  const readPaths =
    item.type === "dynamic_tool" && toolGroupAction(workEntry) === "read"
      ? collectToolFilePaths(item)
      : null;
  const getFullDetail = memoizeValue(() =>
    item.type === "proposed_plan"
      ? item.markdown
      : readPaths
        ? readPaths.join("\n") || null
        : item.type === "notification"
          ? item.detail?.trim() || null
          : formatItemFullDetail(row, item),
  );
  const getCopyText = memoizeValue(() =>
    item.type === "proposed_plan"
      ? `${item.markdown.trimEnd()}\n`
      : [summary, detail, getFullDetail()]
          .filter(
            (value, index, values): value is string =>
              Boolean(value) && values.indexOf(value) === index,
          )
          .join("\n"),
  );
  return {
    id: `${row.visibility}:${row.sourceThreadId}:${row.sourceItemId}`,
    createdAt,
    runId: item.runId,
    attemptId,
    summary,
    detail,
    canExpand:
      !(item.type === "error" && item.status === "failed") &&
      (readPaths
        ? readPaths.length > 0 || turnItemNeedsDetailFetch(item)
        : turnItemHasDetail(item) || workEntry.questionAnswer !== undefined),
    fetchesDetail: turnItemNeedsDetailFetch(item),
    getFullDetail,
    getCopyText,
    icon: workEntry.toolSurface ?? itemIcon(item),
    logo: toolPresentation?.logo ?? null,
    toolLike: itemIsToolLike(item),
    prominent: itemIsProminent(item) || (item.type === "error" && item.status === "failed"),
    status:
      item.type === "error" && item.failure.class === "usage_limit"
        ? itemStatus(item)
        : workEntryDisplayIndicatesToolFailure(workEntry)
          ? "failure"
          : itemStatus(item),
    lifecycleStatus: itemLifecycleStatus(item),
    workEntry,
    projectedItem: row,
  };
}

