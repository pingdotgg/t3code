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
import type { LocalThreadMessage, RawThreadFeedEntry, ThreadFeedCache, ThreadFeedEntry } from "./threadActivity";
import { checkpointSummariesEqual, firstChangedIndex, groupAdjacentActivities, localMessageEntriesCache, projectedEntriesCache, setMapsEqual, setsEqual, toFeedActivity } from "./threadActivity";

export function buildThreadFeed(
  visibleTurnItems: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
  options?: {
    readonly anchoredMessages?: ReadonlyArray<LocalThreadMessage>;
    readonly attempts?: ReadonlyArray<OrchestrationV2RunAttempt>;
    readonly nodes?: ReadonlyArray<OrchestrationV2ExecutionNode>;
    readonly checkpointSummaries?: ReadonlyArray<ThreadCheckpointSummary>;
    readonly cache?: ThreadFeedCache;
  },
): ThreadFeedEntry[] {
  const anchoredMessages = options?.anchoredMessages ?? [];
  const attemptByRootNodeId = new Map(
    (options?.attempts ?? []).map((attempt) => [attempt.rootNodeId, attempt] as const),
  );
  const nodeById = new Map((options?.nodes ?? []).map((node) => [node.id, node] as const));
  const resolveAttemptId = (item: OrchestrationV2TurnItem): RunAttemptId | null => {
    if (item.nodeId === null || item.runId === null) return null;
    let nodeId: OrchestrationV2ExecutionNode["id"] | null = item.nodeId;
    const visited = new Set<OrchestrationV2ExecutionNode["id"]>();
    while (nodeId !== null && !visited.has(nodeId)) {
      visited.add(nodeId);
      const directAttempt = attemptByRootNodeId.get(nodeId);
      if (directAttempt?.runId === item.runId) return directAttempt.id;
      const node = nodeById.get(nodeId);
      if (node === undefined) return null;
      const rootAttempt = attemptByRootNodeId.get(node.rootNodeId);
      if (rootAttempt?.runId === item.runId) return rootAttempt.id;
      nodeId = node.parentNodeId;
    }
    return null;
  };
  // Thread-wide facts that change rows anywhere in the feed. A cached prefix
  // is reused only while these match the build that produced it.
  const foldedAnswerMessageIds = new Set<string>();
  const delegatedChildrenByRun = new Map<RunId, Set<string>>();
  for (const { item } of visibleTurnItems) {
    if (item.type === "user_input_request" && item.questionAnswer) {
      foldedAnswerMessageIds.add(`async-answer:${item.questionAnswer.requestId}`);
    } else if (item.type === "subagent" && item.origin === "app_owned" && item.runId !== null) {
      const children = delegatedChildrenByRun.get(item.runId) ?? new Set<string>();
      children.add(item.subagentId);
      delegatedChildrenByRun.set(item.runId, children);
    }
  }

  const cache = options?.cache;
  const previous = cache?.feedBuild ?? null;
  let restartIndex = -1;
  if (
    previous !== null &&
    anchoredMessages.length === 0 &&
    previous.attempts === options?.attempts &&
    previous.nodes === options?.nodes &&
    checkpointSummariesEqual(previous.checkpointSummaries, options?.checkpointSummaries) &&
    setsEqual(previous.foldedAnswerMessageIds, foldedAnswerMessageIds) &&
    setMapsEqual(previous.delegatedChildrenByRun, delegatedChildrenByRun)
  ) {
    const firstChanged = firstChangedIndex(previous.rows, visibleTurnItems);
    restartIndex = previous.restarts.length - 1;
    while (restartIndex >= 0 && previous.restarts[restartIndex]!.row > firstChanged) {
      restartIndex -= 1;
    }
  }
  const restart = restartIndex === -1 ? null : previous!.restarts[restartIndex]!;
  const prefix = restart === null ? [] : previous!.feed.slice(0, restart.feedLength);
  const restarts = restart === null ? [] : previous!.restarts.slice(0, restartIndex + 1);

  const entries: RawThreadFeedEntry[] = [];
  const entryRows: number[] = [];
  // A stopped compaction's own row already says it stopped. A `/compact` run stopped
  // before its provider started has no such row, so it keeps the interrupted one.
  const compactPromptRunIds = new Set<RunId>();
  const compactedRunIds = new Set<RunId>();
  for (const { item } of visibleTurnItems) {
    if (item.runId === null) continue;
    if (item.type === "user_message" && isCompactionCommandMessage({ role: "user", ...item })) {
      compactPromptRunIds.add(item.runId);
    } else if (item.type === "compaction") {
      compactedRunIds.add(item.runId);
    }
  }
  for (let index = restart?.row ?? 0; index < visibleTurnItems.length; index += 1) {
    const row = visibleTurnItems[index]!;
    const item = row.item;
    if (turnItemIsWorkspacePreparation(item) && !item.deferredWork) continue;
    if (item.type === "todo_list" || item.type === "checkpoint") continue;
    if (
      item.type === "user_message" &&
      item.inputIntent === "queued_turn" &&
      item.status === "pending"
    )
      continue;
    if (item.type === "user_message" && foldedAnswerMessageIds.has(item.messageId)) continue;
    if (
      item.type === "run_interrupt_request" ||
      (item.type === "run_interrupt_result" &&
        item.runId !== null &&
        compactPromptRunIds.has(item.runId) &&
        compactedRunIds.has(item.runId))
    ) {
      continue;
    }
    const attemptId = resolveAttemptId(item);
    const cached = projectedEntriesCache.get(row);
    if (cached?.attemptId === attemptId) {
      entries.push(cached.entry);
      entryRows.push(index);
      continue;
    }
    const createdAt = DateTime.formatIso(item.startedAt ?? item.updatedAt);
    const render =
      item.type === "dynamic_tool" && item.status === "completed"
        ? htmlRenderFromToolItem(item)
        : undefined;
    if (render) {
      const entry: RawThreadFeedEntry = {
        type: "html-render",
        id: `html-render:${row.visibility}:${row.sourceThreadId}:${row.sourceItemId}`,
        createdAt,
        runId: item.runId,
        render,
      };
      projectedEntriesCache.set(row, { attemptId, entry });
      entries.push(entry);
      entryRows.push(index);
      continue;
    }
    const app = item.type === "dynamic_tool" ? mcpAppFromToolItem(item) : undefined;
    if (app) {
      const entry: RawThreadFeedEntry = {
        type: "mcp-app",
        id: `mcp-app:${row.visibility}:${row.sourceThreadId}:${row.sourceItemId}`,
        createdAt,
        runId: item.runId,
        sourceThreadId: row.sourceThreadId,
        itemId: row.sourceItemId,
        revision: turnItemDetailRevision(item),
        app,
      };
      projectedEntriesCache.set(row, { attemptId, entry });
      entries.push(entry);
      entryRows.push(index);
      continue;
    }
    if (item.type === "user_message" || item.type === "assistant_message") {
      const updatedAt = DateTime.formatIso(item.updatedAt);
      const entry: RawThreadFeedEntry = {
        type: "message",
        id: item.messageId,
        createdAt,
        message: {
          id: item.messageId,
          role: item.type === "user_message" ? "user" : "assistant",
          text: item.text,
          ...(item.type === "user_message" && item.context ? { context: item.context } : {}),
          attachments: item.attachments ?? [],
          runId: item.runId,
          streaming: item.type === "assistant_message" && item.streaming,
          ...(item.type === "user_message"
            ? {
                inputIntent: item.inputIntent,
                createdBy: item.createdBy,
                creationSource: item.creationSource,
                ...(item.scheduledTaskId ? { scheduledTaskId: item.scheduledTaskId } : {}),
                ...(item.senderThreadId ? { senderThreadId: item.senderThreadId } : {}),
                ...(item.idleCompaction ? { idleCompaction: item.idleCompaction } : {}),
              }
            : {}),
          visibility: row.visibility,
          sourceThreadId: row.sourceThreadId,
          createdAt,
          updatedAt,
          projectedItem: row,
        },
      };
      projectedEntriesCache.set(row, { attemptId, entry });
      entries.push(entry);
      entryRows.push(index);
      continue;
    }
    const activity = toFeedActivity(row, attemptId);
    const entry: RawThreadFeedEntry = {
      type: "activity",
      id: activity.id,
      createdAt,
      runId: item.runId,
      activity,
    };
    projectedEntriesCache.set(row, { attemptId, entry });
    entries.push(entry);
    entryRows.push(index);
  }
  const retainedMessageIds = new Set([
    ...foldedAnswerMessageIds,
    ...entries.flatMap((entry) => (entry.type === "message" ? [entry.id] : [])),
  ]);
  const appendLocalMessage = (message: LocalThreadMessage): RawThreadFeedEntry => {
    const cached = localMessageEntriesCache.get(message);
    if (cached) return cached;
    const entry: Extract<RawThreadFeedEntry, { readonly type: "message" }> = {
      type: "message",
      id: message.id,
      createdAt: message.createdAt,
      message: {
        id: message.id,
        role: message.role === "assistant" ? "assistant" : "user",
        text: message.text,
        ...(message.context ? { context: message.context } : {}),
        attachments: message.attachments ?? [],
        runId: null,
        streaming: message.streaming,
        visibility: "local",
        sourceThreadId: ThreadId.make("local-feedback"),
        createdAt: message.createdAt,
        updatedAt: message.updatedAt,
      },
    };
    localMessageEntriesCache.set(message, entry);
    return entry;
  };
  for (const message of anchoredMessages) {
    if (retainedMessageIds.has(message.id)) continue;
    retainedMessageIds.add(message.id);
    const entry = appendLocalMessage(message);
    const insertionIndex = entries.findIndex(
      (candidate) => candidate.createdAt > message.createdAt,
    );
    if (insertionIndex === -1) entries.push(entry);
    else entries.splice(insertionIndex, 0, entry);
  }
  const checkpointByMessageId = new Map(
    (options?.checkpointSummaries ?? [])
      .filter((checkpoint) => checkpoint.status === "ready" && checkpoint.files.length > 0)
      .map((checkpoint) => [checkpoint.assistantMessageId, checkpoint]),
  );
  const grouped = groupAdjacentActivities(
    entries.map((entry) => {
      if (entry.type !== "message" || entry.message.role !== "assistant") return entry;
      const checkpointSummary = checkpointByMessageId.get(entry.message.id);
      if (!checkpointSummary || checkpointSummary.runId !== entry.message.runId) return entry;
      return { ...entry, message: { ...entry.message, checkpointSummary } };
    }),
    delegatedChildrenByRun,
    // Anchored messages shift entries away from their rows; such a build is not reused.
    anchoredMessages.length > 0
      ? undefined
      : (entryIndex, groupedLength) =>
          restarts.push({
            row: entryRows[entryIndex]! + 1,
            feedLength: prefix.length + groupedLength,
          }),
  );
  const feed = prefix.length === 0 ? grouped : prefix.concat(grouped);
  if (cache) {
    cache.feedBuild =
      anchoredMessages.length > 0
        ? null
        : {
            rows: visibleTurnItems,
            attempts: options?.attempts,
            nodes: options?.nodes,
            checkpointSummaries: options?.checkpointSummaries,
            foldedAnswerMessageIds,
            delegatedChildrenByRun,
            feed,
            restarts,
          };
  }
  return feed;
}

