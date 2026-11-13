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
import { capitalizePhrase } from "./threadActivity";

export function itemSummary(
  item: OrchestrationV2TurnItem,
  toolPresentation: T3McpToolPresentation | null = null,
): string {
  if (item.type === "notification") return item.summary;
  if (item.type === "system_notice") return item.message;
  if (item.type === "compaction") return contextCompactionLabel(item);
  const title =
    (item.type === "dynamic_tool"
      ? dynamicToolTitle(item.toolName, item.input, item.title)
      : undefined) ?? item.title?.trim();
  if (item.type === "subagent") return formatSubagentDisplayTitle(title || "Subagent");
  if (title) return toolPresentation?.displayName ?? capitalizePhrase(title);
  switch (item.type) {
    case "reasoning":
      return "Thinking";
    case "command_execution":
      return "Command";
    case "file_change":
      return item.changes !== undefined && item.changes.length > 1
        ? `Changed ${item.changes.length} files`
        : `Changed ${item.fileName}`;
    case "file_search":
      return item.title?.trim() || formatSearchToolLabel(item) || "Searched files";
    case "web_search":
      return "Searched the web";
    case "approval_request":
      return "Approval requested";
    case "user_input_request":
      return "Input requested";
    case "checkpoint":
      return "Checkpoint captured";
    case "run_interrupt_request":
      return "Interrupt requested";
    case "run_interrupt_result":
      return "Run interrupted";
    case "error":
      return item.failure.class === "usage_limit" ? "Usage limit reached" : "Provider error";
    case "handoff":
      return "Context handed off";
    case "fork":
      return "Thread forked";
    case "thread_created":
      return "Thread created";
    case "secret_request":
      return item.label;
    case "link_request":
      return `Link ${item.label ?? item.url ?? "an environment"}`;
    case "dynamic_tool": {
      const classified = classifyToolActivity({
        itemType: "dynamic_tool_call",
        data: { toolName: item.toolName ?? undefined, input: item.input },
      });
      if (classified === "read") {
        const [path] = collectToolFilePaths({ input: item.input });
        return formatReadToolLabel(path ?? "");
      }
      if (classified === "search") {
        return formatSearchToolLabel({ input: item.input }) ?? item.toolName ?? "Tool call";
      }
      return toolPresentation?.displayName ?? item.toolName ?? "Tool call";
    }
    case "proposed_plan":
      return "Proposed plan";
    case "todo_list":
      return "Plan updated";
    case "user_message":
      return "User message";
    case "assistant_message":
      return "Assistant message";
  }
}

