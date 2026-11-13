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
import type { ThreadFeedActivity } from "./threadActivity";

export function itemIcon(item: OrchestrationV2TurnItem): ThreadFeedActivity["icon"] {
  if (item.type === "notification") {
    const source = item.source;
    switch (source.kind) {
      case "subagent":
      case "delegated_task":
        return "hammer";
      case "command":
        return "command";
      case "monitor":
        return "eye";
      case "background_task":
      case "system":
        return "zap";
      default:
        source satisfies never;
        return "zap";
    }
  }
  if (item.type === "dynamic_tool") {
    const classified = classifyToolActivity({
      itemType: "dynamic_tool_call",
      data: { toolName: item.toolName ?? undefined, input: item.input },
    });
    if (classified === "read") {
      return "eye";
    }
    if (classified === "search") return "search";
  }
  switch (item.type) {
    case "reasoning":
      return "agent";
    case "command_execution":
      return "command";
    case "file_change":
      return "edit";
    case "file_search":
      return "search";
    case "web_search":
      return "globe";
    case "approval_request":
      return item.requestKind === "permission" ? "lock" : "message";
    case "user_input_request":
    case "user_message":
    case "assistant_message":
      return "message";
    case "dynamic_tool":
      return isJavaScriptReplTool(item.toolName) ? "code" : "wrench";
    case "subagent":
      return "hammer";
    case "run_interrupt_request":
    case "run_interrupt_result":
      return "stop";
    case "system_notice":
      return "warning";
    case "error":
      return item.failure.class === "usage_limit"
        ? item.status === "completed"
          ? "check"
          : "warning"
        : "alert";
    case "checkpoint":
    case "proposed_plan":
    case "todo_list":
      return "check";
    case "compaction":
    case "handoff":
    case "fork":
    case "thread_created":
      return "zap";
    case "secret_request":
      return "lock";
    case "link_request":
      return "globe";
  }
}

