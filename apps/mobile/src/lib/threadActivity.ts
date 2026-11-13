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
import { appendActivityGroupRows } from "./threadActivityParts10";

export type PendingApproval = ThreadPendingApproval;
export type PendingUserInput = ThreadPendingUserInput;

export interface ThreadFeedActivity {
  readonly id: string;
  readonly createdAt: string;
  readonly runId: RunId | null;
  readonly attemptId: RunAttemptId | null;
  readonly summary: string;
  readonly detail: string | null;
  readonly canExpand: boolean;
  readonly fetchesDetail: boolean;
  readonly getFullDetail: () => string | null;
  readonly getCopyText: () => string;
  readonly icon:
    | "agent"
    | "alert"
    | "browser"
    | "computer"
    | "code"
    | "check"
    | "command"
    | "edit"
    | "eye"
    | "globe"
    | "search"
    | "stop"
    | "hammer"
    | "lock"
    | "message"
    | "warning"
    | "wrench"
    | "zap";
  readonly logo: T3McpToolLogo | null;
  readonly toolLike: boolean;
  readonly prominent: boolean;
  readonly status: "success" | "failure" | "neutral" | null;
  readonly lifecycleStatus: WorkLogToolLifecycleStatus;
  readonly workEntry: WorkLogPresentationEntry;
  readonly groupedToolDetail?: boolean;
  readonly live?: boolean;
  /** Lone calls carry the group header's label and id until a second call joins. */
  readonly groupStandIn?: { readonly groupId: string; readonly label: string };
  readonly projectedItem: OrchestrationV2ProjectedTurnItem;
}

export interface ThreadFeedMessage {
  readonly context?: import("@t3tools/contracts").OrchestrationMessageContext | undefined;
  readonly id: MessageId;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly runId: RunId | null;
  readonly streaming: boolean;
  readonly inputIntent?: OrchestrationV2UserMessageInputIntent;
  readonly createdBy?: OrchestrationV2Actor;
  readonly creationSource?: OrchestrationV2CreationSource;
  readonly scheduledTaskId?: ScheduledTaskId;
  readonly senderThreadId?: ThreadId;
  readonly idleCompaction?: import("@t3tools/contracts").OrchestrationV2IdleCompaction;
  readonly visibility: OrchestrationV2ProjectedTurnItem["visibility"];
  readonly sourceThreadId: ThreadId;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly projectedItem?: OrchestrationV2ProjectedTurnItem;
  readonly checkpointSummary?: ThreadCheckpointSummary;
}

export interface LocalThreadMessage {
  readonly id: MessageId;
  readonly role: string;
  readonly text: string;
  readonly context?: OrchestrationMessageContext | undefined;
  readonly attachments?: ReadonlyArray<ChatAttachment> | undefined;
  readonly streaming: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type RawThreadFeedEntry =
  | {
      readonly type: "message";
      readonly id: string;
      readonly createdAt: string;
      readonly message: ThreadFeedMessage;
    }
  | {
      readonly type: "activity";
      readonly id: string;
      readonly createdAt: string;
      readonly runId: RunId | null;
      readonly activity: ThreadFeedActivity;
    }
  | {
      readonly type: "html-render";
      readonly id: string;
      readonly createdAt: string;
      readonly runId: RunId | null;
      readonly render: HtmlRenderReference;
    }
  | {
      readonly type: "mcp-app";
      readonly id: string;
      readonly createdAt: string;
      readonly runId: RunId | null;
      /** The thread and item that own the app; a fork's inherited app is its source's. */
      readonly sourceThreadId: ThreadId;
      readonly itemId: TurnItemId;
      readonly revision: string;
      readonly app: McpAppReference;
    };

export type ThreadFeedEntry = ThreadFeedEntryContent & {
  readonly continuesWorkLog?: boolean;
  readonly checkpointSummary?: ThreadCheckpointSummary;
};

type ThreadFeedEntryContent =
  | Extract<RawThreadFeedEntry, { type: "message" | "html-render" | "mcp-app" }>
  | {
      readonly type: "activity-group";
      readonly id: string;
      readonly createdAt: string;
      readonly runId: RunId | null;
      readonly activities: ReadonlyArray<ThreadFeedActivity>;
    }
  | {
      readonly type: "work-toggle";
      readonly id: string;
      readonly createdAt: string;
      readonly runId: RunId | null;
      readonly groupId: string;
      readonly hiddenCount: number;
      readonly expanded: boolean;
      readonly summary: string;
      readonly summaryKind: ToolGroupSummaryKind;
      readonly toolSurface?: WorkLogPresentationEntry["toolSurface"];
      readonly toolIcon?: WorkLogPresentationEntry["toolIcon"];
      readonly summaryToolIcon?: "browser" | "device" | "t3-code" | "pull-request";
      readonly hasFailure: boolean;
      readonly live: boolean;
      readonly shimmer: boolean;
      readonly thought?: string;
    }
  | {
      readonly type: "run-fold";
      readonly deferredWorkItemIds?: ReadonlyArray<string>;
      readonly id: string;
      readonly createdAt: string;
      readonly runId: RunId;
      readonly label: string;
      readonly expanded: boolean;
    }
  | {
      readonly type: "thinking";
      readonly id: string;
      readonly createdAt: string;
      readonly runId: RunId | null;
    };

export interface ThreadFeedLatestRun {
  readonly runId: RunId;
  readonly status: OrchestrationV2RunStatus;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly turnEnded?: boolean;
}

/** Long Android headers can ANR despite one-line display; cap labels only, preserving expanded and copied text. */
const WORK_LOG_LABEL_MAX_LENGTH = 200;

export function compactWorkEntryText(value: string): string {
  return truncate(value.replace(/\s+/gu, " "), WORK_LOG_LABEL_MAX_LENGTH);
}

export function workEntryRowLabel(entry: WorkLogPresentationEntry, expanded = false): string {
  if (entry.itemType === "fork") return entry.label;
  if (expanded && entry.itemType === "reasoning")
    return entry.toolLifecycleStatus === "inProgress" ? "Thinking" : "Thought";
  const presentation = resolveWorkEntryToolPresentation(entry);
  if (presentation) return presentation.displayName;
  if (entry.command?.trim()) return compactWorkEntryText(commandDisplayText(entry.command));
  const action = toolGroupAction(entry);
  const isToolRead = action === "read" && entry.itemType === "dynamic_tool";
  if (action === "code-search" || action === "search") {
    const toolData =
      entry.toolData !== null &&
      typeof entry.toolData === "object" &&
      !Array.isArray(entry.toolData)
        ? (entry.toolData as Record<string, unknown>)
        : undefined;
    const searchLabel =
      entry.itemType === "file_search" ? entry.label : formatSearchToolLabel(toolData);
    if (searchLabel) return searchLabel;
  }
  if (isToolRead) {
    const [firstPath] = entry.changedFiles ?? collectToolFilePaths(entry.toolData);
    if (firstPath) {
      return formatReadToolLabel(firstPath, Math.max(0, (entry.changedFiles?.length ?? 1) - 1));
    }
    if (!expanded) return "Read file";
  }
  const preview =
    entry.command ??
    (isToolRead || (!expanded && (action === "code-search" || action === "search"))
      ? null
      : entry.detail) ??
    (entry.changedFiles?.length
      ? entry.changedFiles.length === 1
        ? entry.changedFiles[0]!
        : `${entry.changedFiles[0]!} +${entry.changedFiles.length - 1} more`
      : null);
  if (expanded) return preview?.trim() ? truncate(preview, WORK_LOG_LABEL_MAX_LENGTH) : entry.label;
  return preview ? compactWorkEntryText(preview) || entry.label : entry.label;
}

export type ThreadFeedActivityGroup = Extract<ThreadFeedEntry, { readonly type: "activity-group" }>;

// Immutable source rows let retained history keep its identities while the active item streams.
export const projectedEntriesCache = new WeakMap<
  OrchestrationV2ProjectedTurnItem,
  {
    readonly attemptId: RunAttemptId | null;
    readonly entry: RawThreadFeedEntry;
  }
>();
export const localMessageEntriesCache = new WeakMap<
  LocalThreadMessage,
  Extract<RawThreadFeedEntry, { readonly type: "message" }>
>();
export const activityGroupsCache = new WeakMap<ThreadFeedActivity, ThreadFeedActivityGroup>();
export const failedActivityGroupsCache = new WeakMap<
  ThreadFeedActivityGroup,
  ReadonlyArray<ThreadFeedActivityGroup>
>();
const presentedActivityGroupsCache = new WeakMap<
  ThreadFeedActivityGroup,
  {
    readonly activeRunId: RunId | null;
    readonly isWorking: boolean;
    readonly activeTail: boolean;
    readonly rows: ReadonlyArray<ThreadFeedEntry>;
  }
>();
export const runFoldRowsCache = new WeakMap<
  ThreadFeedEntry,
  Extract<ThreadFeedEntry, { readonly type: "run-fold" }>
>();
let cachedThinkingRow: Extract<ThreadFeedEntry, { readonly type: "thinking" }> | null = null;

export function isContextCompactionActivityGroup(entry: ThreadFeedActivityGroup): boolean {
  return (
    entry.activities.length === 1 && entry.activities[0]?.projectedItem.item.type === "compaction"
  );
}

export function threadFeedCompactionLabels(feed: ReadonlyArray<ThreadFeedEntry>) {
  const labelsByRunId = new Map<RunId, { title: string; compacting: string }>();
  const labelsByEntryId = new Map<string, { title: string; compacting: string }>();
  const pendingResumeAgeByRunId = new Map<RunId, string>();
  for (const entry of feed) {
    const reason = entry.type === "message" ? idleCompactionOf(entry.message) : undefined;
    if (entry.type === "message" && entry.message.runId !== null && reason !== undefined) {
      labelsByRunId.set(entry.message.runId, {
        title: IDLE_COMPACTION_TITLES[reason],
        compacting: IDLE_COMPACTING_LABELS[reason],
      });
    } else if (entry.type === "activity-group" && entry.runId !== null) {
      if (isContextCompactionActivityGroup(entry)) {
        const age = pendingResumeAgeByRunId.get(entry.runId);
        const labels =
          labelsByRunId.get(entry.runId) ??
          (age === undefined
            ? undefined
            : {
                title: `Context compacted after ${age} idle`,
                compacting: "Compacting…",
              });
        if (labels) labelsByEntryId.set(entry.id, labels);
        pendingResumeAgeByRunId.delete(entry.runId);
      }
      for (const activity of entry.activities) {
        const age = activity.workEntry.questionAnswer
          ? claudeResumeCompactionAge(activity.workEntry.questionAnswer)
          : null;
        if (age !== null) pendingResumeAgeByRunId.set(entry.runId, age);
      }
    }
  }
  return labelsByEntryId;
}

export function isResumeCompactionAnswerGroup(entry: ThreadFeedActivityGroup): boolean {
  return entry.activities.every((activity) => {
    const answer = activity.workEntry.questionAnswer;
    return answer !== undefined && claudeResumeCompactionAge(answer) !== null;
  });
}

export function isContextHandoffActivityGroup(entry: ThreadFeedActivityGroup): boolean {
  return (
    entry.activities.length === 1 && entry.activities[0]?.projectedItem.item.type === "handoff"
  );
}

export function isSecretRequestActivityGroup(entry: ThreadFeedActivityGroup): boolean {
  return (
    entry.activities.length === 1 &&
    entry.activities[0]?.projectedItem.item.type === "secret_request"
  );
}

export function isLinkRequestActivityGroup(entry: ThreadFeedActivityGroup): boolean {
  return (
    entry.activities.length === 1 && entry.activities[0]?.projectedItem.item.type === "link_request"
  );
}

function isUserInputActivityGroup(entry: ThreadFeedActivityGroup): boolean {
  return entry.activities.some((activity) => activity.workEntry.questionAnswer !== undefined);
}

export function capitalizePhrase(value: string): string {
  const trimmed = value.trim();
  return trimmed.length === 0 ? value : `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`;
}

export function memoizeValue<T>(build: () => T): () => T {
  let value: T;
  let initialized = false;
  return () => {
    if (!initialized) {
      value = build();
      initialized = true;
    }
    return value;
  };
}

export function itemIsToolLike(item: OrchestrationV2TurnItem): boolean {
  return (
    item.type === "reasoning" ||
    item.type === "command_execution" ||
    item.type === "file_change" ||
    item.type === "file_search" ||
    item.type === "web_search" ||
    item.type === "approval_request" ||
    item.type === "user_input_request" ||
    item.type === "dynamic_tool" ||
    item.type === "subagent"
  );
}

export function itemIsProminent(item: OrchestrationV2TurnItem): boolean {
  return (
    item.type === "fork" ||
    item.type === "thread_created" ||
    item.type === "system_notice" ||
    item.type === "proposed_plan" ||
    item.type === "secret_request" ||
    item.type === "link_request"
  );
}

export function itemStatus(item: OrchestrationV2TurnItem): ThreadFeedActivity["status"] {
  if (item.type === "notification") return item.outcome === "failed" ? "failure" : null;
  if (item.type === "error") {
    if (item.status === "failed")
      return item.failure.class === "usage_limit" ? "neutral" : "failure";
    return item.status === "completed" ? "success" : "neutral";
  }
  if (!itemIsToolLike(item)) return null;
  if (item.status === "failed") return "failure";
  return item.status === "completed" ? "success" : "neutral";
}

export function itemLifecycleStatus(item: OrchestrationV2TurnItem): WorkLogToolLifecycleStatus {
  switch (item.status) {
    case "pending":
    case "running":
    case "waiting":
      return "inProgress";
    case "idle":
      return "idle";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
    case "interrupted":
      return "stopped";
  }
}

export function itemWorkLogTone(item: OrchestrationV2TurnItem): WorkLogPresentationEntry["tone"] {
  if (item.type === "error") return "info";
  if (item.type === "reasoning") return "thinking";
  switch (item.type) {
    case "command_execution":
    case "file_change":
    case "file_search":
    case "web_search":
    case "dynamic_tool":
    case "subagent":
      return "tool";
    default:
      return "info";
  }
}

export function itemToolPresentation(item: OrchestrationV2TurnItem): T3McpToolPresentation | null {
  if (item.type !== "dynamic_tool") {
    return null;
  }
  return (
    resolveT3McpToolPresentation(item.toolName, item.input) ??
    resolveT3McpToolPresentation(item.title, item.input)
  );
}

export function itemPreview(item: OrchestrationV2TurnItem): string | null {
  switch (item.type) {
    case "reasoning":
      return item.text || null;
    case "command_execution":
      return item.input || null;
    case "file_change":
      return item.fileName;
    case "file_search":
      return item.pattern ?? null;
    case "web_search":
      return item.patterns?.join(", ") ?? null;
    case "approval_request":
      return item.prompt ?? null;
    case "user_input_request":
      return item.questions.map((question) => question.question).join(" · ") || null;
    case "checkpoint":
      return item.files.length === 1
        ? (item.files[0]?.path ?? null)
        : `${item.files.length} changed files`;
    case "run_interrupt_request":
    case "run_interrupt_result":
    case "system_notice":
      return item.message || null;
    case "error":
      return item.failure.message;
    case "compaction":
    case "handoff":
      return item.summary ?? null;
    case "fork":
    case "thread_created":
      return item.targetThreadId;
    case "secret_request":
    case "link_request":
      return item.reason || null;
    case "subagent":
      return item.result ?? item.progress ?? item.prompt;
    case "dynamic_tool":
      return null;
    case "notification":
      return item.detail ?? null;
    case "proposed_plan":
      return item.markdown || null;
    case "todo_list":
      return `${item.steps.filter((step) => step.status === "completed").length}/${item.steps.length} completed`;
    case "user_message":
    case "assistant_message":
      return item.text || null;
  }
}

export function formatItemFullDetail(
  row: OrchestrationV2ProjectedTurnItem,
  item: OrchestrationV2TurnItem,
): string {
  return JSON.stringify(
    {
      visibility: row.visibility,
      sourceThreadId: row.sourceThreadId,
      sourceItemId: row.sourceItemId,
      item: toolItemForDisplay(item),
    },
    null,
    2,
  );
}

export function singleToolCallLabel(activity: ThreadFeedActivity, expanded: boolean): string {
  if (activity.workEntry.itemType === "reasoning")
    return expanded
      ? "Thought"
      : compactWorkEntryText(activity.workEntry.detail ?? "") || "Thought";
  const presentation = resolveWorkEntryToolPresentation(activity.workEntry, "completed");
  if (presentation) return presentation.displayName;
  const command = activity.workEntry.command?.trim();
  return command ? truncate(command, WORK_LOG_LABEL_MAX_LENGTH) : activity.summary;
}

export function isEmptyMessage(entry: RawThreadFeedEntry): boolean {
  return (
    entry.type === "message" &&
    entry.message.text.trim().length === 0 &&
    entry.message.attachments.length === 0
  );
}

/**
 * `onRestart` hears each entry after which no group is open, with the grouped
 * length so far: the entries before it group the same whatever follows.
 */
export function computeElapsedMs(startIso: string, endIso: string): number | null {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : null;
}

export function maxIsoTimestamp(left: string | null, right: string | null): string | null {
  if (left === null) return right;
  if (right === null) return left;
  return Date.parse(right) > Date.parse(left) ? right : left;
}

export function unsettledRunId(latestRun: ThreadFeedLatestRun | null): RunId | null {
  return threadFeedRunIsUnsettled(latestRun) ? latestRun.runId : null;
}

export function threadFeedRunIsUnsettled(
  run: ThreadFeedLatestRun | null,
): run is ThreadFeedLatestRun {
  if (run === null || run.status === "queued") return false;
  return (
    run.completedAt === null ||
    run.status === "preparing" ||
    run.status === "starting" ||
    run.status === "running" ||
    run.status === "waiting"
  );
}

export function threadFeedActivityIsVisible(
  activity: Pick<ThreadFeedActivity, "prominent" | "status" | "toolLike"> &
    Partial<Pick<ThreadFeedActivity, "lifecycleStatus">>,
): boolean {
  return (
    activity.prominent ||
    activity.lifecycleStatus === "stopped" ||
    activity.lifecycleStatus === "declined" ||
    activity.lifecycleStatus === "idle" ||
    !(activity.toolLike && activity.status === "neutral")
  );
}

export interface ThreadFeedRunFold {
  readonly deferredWorkItemIds?: ReadonlyArray<string>;
  readonly runId: RunId;
  readonly createdAt: string;
  readonly hiddenEntryIds: ReadonlySet<string>;
  readonly label: string;
}

export function failedFeedRunIds(
  feed: ReadonlyArray<ThreadFeedEntry>,
  latestRun: ThreadFeedLatestRun | null,
) {
  const failed = new Set<RunId>();
  if (latestRun?.status === "failed") failed.add(latestRun.runId);
  for (const entry of feed) {
    if (entry.type !== "activity-group") continue;
    for (const activity of entry.activities) {
      const item = activity.projectedItem.item;
      if (
        item.type === "error" &&
        item.status === "failed" &&
        item.parentItemId === null &&
        item.runId !== null
      )
        failed.add(item.runId);
    }
  }
  return failed;
}

/**
 * The key a run fold uses for the message `entryId`: its run, or for an
 * imported message with no run, the runless key of the user message before
 * it. Null for user messages, which never fold.
 */
export function messageFoldRunId(
  feed: ReadonlyArray<ThreadFeedEntry>,
  entryId: string,
): RunId | null {
  let runlessKey: RunId | null = null;
  for (const entry of feed) {
    if (entry.type !== "message") continue;
    if (entry.message.role === "user") {
      if (entry.id === entryId) return null;
      runlessKey = entry.message.runId == null ? RunId.make(`runless:${entry.id}`) : null;
    } else if (entry.id === entryId) {
      return entry.message.runId ?? runlessKey;
    }
  }
  return null;
}

const supersededReasoningGroups = new WeakMap<ThreadFeedActivityGroup, ThreadFeedActivityGroup>();
const trailingReasoningGroups = new WeakMap<ThreadFeedActivityGroup, ThreadFeedActivityGroup>();

export function settleSupersededReasoning(
  entry: Exclude<ThreadFeedEntry, { readonly type: "run-fold" | "work-toggle" | "thinking" }>,
  tail: boolean,
) {
  if (entry.type !== "activity-group") return entry;
  const cache = tail ? trailingReasoningGroups : supersededReasoningGroups;
  const cached = cache.get(entry);
  if (cached) return cached;
  const activities = entry.activities.map((activity, index) =>
    activity.workEntry.itemType === "reasoning" &&
    activity.lifecycleStatus === "inProgress" &&
    (!tail || index < entry.activities.length - 1)
      ? {
          ...activity,
          lifecycleStatus: "completed" as const,
          status: "success" as const,
          workEntry: { ...activity.workEntry, toolLifecycleStatus: "completed" as const },
        }
      : activity,
  );
  const settled = activities.some((activity, index) => activity !== entry.activities[index])
    ? { ...entry, activities }
    : entry;
  cache.set(entry, settled);
  return settled;
}

interface ThreadFeedPresentationBuild {
  readonly feed: ReadonlyArray<ThreadFeedEntry>;
  readonly latestRun: ThreadFeedLatestRun | null;
  readonly expandedRunIds: ReadonlySet<RunId>;
  readonly expandedWorkGroupIds: ReadonlySet<string>;
  readonly activeWorkStartedAt: string | null;
  readonly runlessWorkActive: boolean;
  readonly rows: ReadonlyArray<ThreadFeedEntry>;
  /** Feed entry `entry` is a user message whose rows start at `rowsLength`. */
  readonly restarts: ReadonlyArray<{ readonly entry: number; readonly rowsLength: number }>;
  /** Where each run's entries begin, so a reused prefix never shares a run with the rest. */
  readonly firstEntryByRun: ReadonlyMap<RunId, number>;
}

function latestRunsEqual(left: ThreadFeedLatestRun | null, right: ThreadFeedLatestRun | null) {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.runId === right.runId &&
      left.status === right.status &&
      left.startedAt === right.startedAt &&
      left.completedAt === right.completedAt &&
      left.turnEnded === right.turnEnded)
  );
}

export function feedEntryRunId(entry: ThreadFeedEntry): RunId | null {
  return entry.type === "message" ? (entry.message.runId ?? null) : entry.runId;
}

export function isUserMessageEntry(entry: ThreadFeedEntry | undefined): boolean {
  return entry?.type === "message" && entry.message.role === "user";
}

/**
 * A user message starts every fold and is never hidden or grouped, so the
 * rows before it depend only on the entries before it, their runs, and the
 * shared inputs. Returns the user message entry to restart from, or null to
 * present the whole feed.
 */
export function presentationRestart(
  previous: ThreadFeedPresentationBuild | null,
  feed: ReadonlyArray<ThreadFeedEntry>,
  latestRun: ThreadFeedLatestRun | null,
  expandedRunIds: ReadonlySet<RunId>,
  expandedWorkGroupIds: ReadonlySet<string>,
  activeWorkStartedAt: string | null,
  runlessWorkActive: boolean,
): { readonly entry: number; readonly rowsLength: number; readonly index: number } | null {
  if (
    previous === null ||
    !latestRunsEqual(previous.latestRun, latestRun) ||
    previous.activeWorkStartedAt !== activeWorkStartedAt ||
    previous.runlessWorkActive !== runlessWorkActive ||
    !setsEqual(previous.expandedRunIds, expandedRunIds) ||
    !setsEqual(previous.expandedWorkGroupIds, expandedWorkGroupIds)
  ) {
    return null;
  }
  const firstChanged = firstChangedIndex(previous.feed, feed);
  let index = previous.restarts.length - 1;
  while (index >= 0 && previous.restarts[index]!.entry > firstChanged) index -= 1;
  const restart = previous.restarts[index];
  if (restart === undefined || !isUserMessageEntry(feed[restart.entry])) return null;
  for (let entryIndex = restart.entry; entryIndex < feed.length; entryIndex += 1) {
    const runId = feedEntryRunId(feed[entryIndex]!);
    const firstEntry = runId === null ? undefined : previous.firstEntryByRun.get(runId);
    if (firstEntry !== undefined && firstEntry < restart.entry) return null;
  }
  return { ...restart, index };
}

export const continuedWorkLogRows = new WeakMap<ThreadFeedEntry, ThreadFeedEntry>();

export function isWorkLogFeedRow(row: ThreadFeedEntry | undefined): boolean {
  return (
    row !== undefined &&
    (row.type === "work-toggle" ||
      row.type === "thinking" ||
      (row.type === "activity-group" &&
        !isContextCompactionActivityGroup(row) &&
        !isContextHandoffActivityGroup(row) &&
        row.activities.every(
          (activity) =>
            !activity.prominent &&
            activity.projectedItem.item.type !== "notification" &&
            activity.projectedItem.item.type !== "subagent",
        )))
  );
}

export const LIVE_ACTIVITY_ROW_ID = "live-activity-row";

export function thinkingRow(createdAt: string, runId: RunId | null) {
  if (cachedThinkingRow?.createdAt !== createdAt || cachedThinkingRow.runId !== runId) {
    cachedThinkingRow = { type: "thinking", id: LIVE_ACTIVITY_ROW_ID, createdAt, runId };
  }
  return cachedThinkingRow;
}

export function appendPresentedFeedEntry(
  result: ThreadFeedEntry[],
  entry: Exclude<ThreadFeedEntry, { readonly type: "run-fold" | "work-toggle" | "thinking" }>,
  expandedWorkGroupIds: ReadonlySet<string>,
  activeRunId: RunId | null,
  isWorking: boolean,
  activeTail: boolean,
): void {
  if (entry.type !== "activity-group") {
    result.push(entry);
    return;
  }
  if (
    isContextCompactionActivityGroup(entry) ||
    isContextHandoffActivityGroup(entry) ||
    isUserInputActivityGroup(entry) ||
    entry.activities[0]?.projectedItem.item.type === "subagent"
  ) {
    result.push(entry);
    return;
  }

  let cached = presentedActivityGroupsCache.get(entry);
  if (
    !cached ||
    cached.activeRunId !== activeRunId ||
    cached.isWorking !== isWorking ||
    cached.activeTail !== activeTail ||
    cached.rows.some(
      (row) => row.type === "work-toggle" && expandedWorkGroupIds.has(row.groupId) !== row.expanded,
    )
  ) {
    const rows: ThreadFeedEntry[] = [];
    appendActivityGroupRows(rows, entry, expandedWorkGroupIds, activeRunId, isWorking, activeTail);
    cached = { activeRunId, isWorking, activeTail, rows };
    presentedActivityGroupsCache.set(entry, cached);
  }
  for (const row of cached.rows) {
    result.push(row);
  }
}

export function liveToolActivitySummary(activity: ThreadFeedActivity, presentTense: boolean): string {
  const status = liveActivityToolStatus(activity.lifecycleStatus, presentTense);
  if (activity.workEntry.itemType === "reasoning") {
    return compactWorkEntryText(
      activity.workEntry.detail?.trim() || (status === "inProgress" ? "Thinking" : "Thought"),
    );
  }
  const presentation = resolveWorkEntryToolPresentation({
    ...activity.workEntry,
    toolLifecycleStatus: status,
  });
  if (presentation) return presentation.displayName;
  const command = activity.workEntry.command?.trim();
  if (command) {
    const program = commandProgramName(command);
    const verb =
      status === "inProgress"
        ? "Running"
        : status === "failed"
          ? "Failed"
          : status === "declined"
            ? "Declined"
            : status === "stopped"
              ? "Stopped"
              : "Ran";
    return `${verb} ${program ?? "command"}`;
  }
  return compactWorkEntryText(activity.detail ?? activity.summary);
}

interface ThreadFeedBuild {
  readonly rows: ReadonlyArray<OrchestrationV2ProjectedTurnItem>;
  readonly attempts: ReadonlyArray<OrchestrationV2RunAttempt> | undefined;
  readonly nodes: ReadonlyArray<OrchestrationV2ExecutionNode> | undefined;
  readonly checkpointSummaries: ReadonlyArray<ThreadCheckpointSummary> | undefined;
  readonly foldedAnswerMessageIds: ReadonlySet<string>;
  readonly delegatedChildrenByRun: ReadonlyMap<RunId, ReadonlySet<string>>;
  readonly feed: ReadonlyArray<ThreadFeedEntry>;
  /** Grouping is empty before `row`: the rows before it produced `feed.slice(0, feedLength)`. */
  readonly restarts: ReadonlyArray<{ readonly row: number; readonly feedLength: number }>;
}

/**
 * Keep one cache per on-screen feed across renders to reuse unchanged prefixes during streaming.
 * Sharing it between threads would make their results evict each other.
 */
export interface ThreadFeedCache {
  feedBuild: ThreadFeedBuild | null;
  presentation: ThreadFeedPresentationBuild | null;
}

export function createThreadFeedCache(): ThreadFeedCache {
  return { feedBuild: null, presentation: null };
}

export function setsEqual<T>(left: ReadonlySet<T>, right: ReadonlySet<T>): boolean {
  if (left.size !== right.size) return false;
  for (const value of left) if (!right.has(value)) return false;
  return true;
}

// Summaries are re-derived whenever messages change, including streamed text,
// so a new array often holds the same checkpoints.
export function checkpointSummariesEqual(
  left: ReadonlyArray<ThreadCheckpointSummary> | undefined,
  right: ReadonlyArray<ThreadCheckpointSummary> | undefined,
): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined || left.length !== right.length) return false;
  return left.every((summary, index) => {
    const other = right[index]!;
    return (
      summary.checkpointId === other.checkpointId &&
      summary.scopeId === other.scopeId &&
      summary.runId === other.runId &&
      summary.checkpointTurnCount === other.checkpointTurnCount &&
      summary.checkpointRef === other.checkpointRef &&
      summary.completedAt === other.completedAt &&
      summary.status === other.status &&
      summary.files === other.files &&
      summary.assistantMessageId === other.assistantMessageId
    );
  });
}

export function setMapsEqual<K, V>(
  left: ReadonlyMap<K, ReadonlySet<V>>,
  right: ReadonlyMap<K, ReadonlySet<V>>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [key, values] of left) {
    const other = right.get(key);
    if (other === undefined || !setsEqual(values, other)) return false;
  }
  return true;
}

/** Index of the first entry that differs, or the shorter length when one extends the other. */
export function firstChangedIndex<T>(previous: ReadonlyArray<T>, next: ReadonlyArray<T>): number {
  const limit = Math.min(previous.length, next.length);
  let index = 0;
  while (index < limit && previous[index] === next[index]) index += 1;
  return index;
}
export * from "./threadActivityParts";
export * from "./threadActivityParts2";
export * from "./threadActivityParts3";
export * from "./threadActivityParts5";
export * from "./threadActivityParts9";
