import type {
  ThreadPendingApproval,
  ThreadPendingUserInput,
  ThreadUserInputQuestion,
} from "@t3tools/client-runtime/state/thread-requests";
import { turnItemIsWorkspacePreparation } from "@t3tools/client-runtime/state/turn-item-presentation";
import { extractToolActivityPresentation } from "@t3tools/client-runtime/work-log/tool-presentation";
import { commandProgramName } from "@t3tools/client-runtime/work-log/command-label";
import {
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
  OrchestrationMessage,
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2RunAttempt,
  OrchestrationV2RunStatus,
  OrchestrationV2TurnItem,
  OrchestrationV2UserMessageInputIntent,
  RunId,
  RunAttemptId,
} from "@t3tools/contracts";
import { ThreadId } from "@t3tools/contracts";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import * as DateTime from "effect/DateTime";

export type PendingApproval = ThreadPendingApproval;
export type PendingUserInput = ThreadPendingUserInput;

export interface PendingUserInputDraftAnswer {
  readonly selectedOptionValues?: ReadonlyArray<string>;
  readonly customAnswer?: string;
}

export interface ThreadFeedActivity {
  readonly id: string;
  readonly createdAt: string;
  readonly runId: RunId | null;
  readonly attemptId: RunAttemptId | null;
  readonly summary: string;
  readonly detail: string | null;
  readonly canExpand: boolean;
  readonly getFullDetail: () => string | null;
  readonly getCopyText: () => string;
  readonly icon:
    | "agent"
    | "alert"
    | "browser"
    | "computer"
    | "check"
    | "command"
    | "edit"
    | "eye"
    | "globe"
    | "hammer"
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
  readonly projectedItem: OrchestrationV2ProjectedTurnItem;
}

export interface ThreadFeedMessage {
  readonly id: MessageId;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly runId: RunId | null;
  readonly streaming: boolean;
  readonly inputIntent?: OrchestrationV2UserMessageInputIntent;
  readonly createdBy?: OrchestrationV2Actor;
  readonly creationSource?: OrchestrationV2CreationSource;
  readonly visibility: OrchestrationV2ProjectedTurnItem["visibility"];
  readonly sourceThreadId: ThreadId;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly projectedItem?: OrchestrationV2ProjectedTurnItem;
}

type RawThreadFeedEntry =
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
    };

export type ThreadFeedEntry =
  | Extract<RawThreadFeedEntry, { type: "message" }>
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
      readonly summaryToolIcon?: "browser" | "t3-code";
      readonly hasFailure: boolean;
      readonly live: boolean;
      readonly shimmer: boolean;
    }
  | {
      readonly type: "run-fold";
      readonly id: string;
      readonly createdAt: string;
      readonly runId: RunId;
      readonly label: string;
      readonly expanded: boolean;
    };

export interface ThreadFeedLatestRun {
  readonly runId: RunId;
  readonly status: OrchestrationV2RunStatus;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
}

type ThreadFeedActivityGroup = Extract<ThreadFeedEntry, { readonly type: "activity-group" }>;

// Immutable source rows let retained history keep its identities while the active item streams.
const projectedEntriesCache = new WeakMap<
  OrchestrationV2ProjectedTurnItem,
  {
    readonly attemptId: RunAttemptId | null;
    readonly entry: RawThreadFeedEntry;
  }
>();
const localMessageEntriesCache = new WeakMap<
  OrchestrationMessage,
  Extract<RawThreadFeedEntry, { readonly type: "message" }>
>();
const activityGroupsCache = new WeakMap<ThreadFeedActivity, ThreadFeedActivityGroup>();
const presentedActivityGroupsCache = new WeakMap<
  ThreadFeedActivityGroup,
  {
    readonly activeRunId: RunId | null;
    readonly isWorking: boolean;
    readonly activeTail: boolean;
    readonly rows: ReadonlyArray<ThreadFeedEntry>;
  }
>();
const runFoldRowsCache = new WeakMap<
  ThreadFeedEntry,
  Extract<ThreadFeedEntry, { readonly type: "run-fold" }>
>();

export function isContextCompactionActivityGroup(entry: ThreadFeedActivityGroup): boolean {
  return (
    entry.activities.length === 1 && entry.activities[0]?.projectedItem.item.type === "compaction"
  );
}

function normalizeDraftAnswer(value: string | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function resolvePendingUserInputOptionValue(
  question: ThreadUserInputQuestion,
  value: string,
): string | null {
  if (question.options.some((option) => option.value === value)) {
    return value;
  }

  const label = value.trim();
  return label.length > 0 &&
    question.options.some((option) => option.value === undefined && option.label.trim() === label)
    ? label
    : null;
}

function normalizeSelectedOptionValues(
  question: ThreadUserInputQuestion,
  value: ReadonlyArray<string> | undefined,
): ReadonlyArray<string> {
  if (!Array.isArray(value)) {
    return [];
  }

  return Array.from(
    new Set(
      value
        .map((entry) => resolvePendingUserInputOptionValue(question, entry))
        .filter((entry): entry is string => entry !== null),
    ),
  );
}

function resolvePendingUserInputAnswer(
  question: ThreadUserInputQuestion,
  draft: PendingUserInputDraftAnswer | undefined,
): string | ReadonlyArray<string> | null {
  const customAnswer =
    question.allowCustomAnswer === false ? null : normalizeDraftAnswer(draft?.customAnswer);
  if (customAnswer) {
    return customAnswer;
  }

  const selectedOptionValues = normalizeSelectedOptionValues(question, draft?.selectedOptionValues);
  if (question.multiSelect) {
    return selectedOptionValues.length > 0 ? selectedOptionValues : null;
  }
  return selectedOptionValues[0] ?? null;
}

function capitalizePhrase(value: string): string {
  const trimmed = value.trim();
  return trimmed.length === 0 ? value : `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`;
}

function memoizeValue<T>(build: () => T): () => T {
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

function itemIsToolLike(item: OrchestrationV2TurnItem): boolean {
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

function itemIsProminent(item: OrchestrationV2TurnItem): boolean {
  return item.type === "fork" || item.type === "thread_created" || item.type === "subagent";
}

function itemStatus(item: OrchestrationV2TurnItem): ThreadFeedActivity["status"] {
  if (item.type === "error") {
    if (item.status === "failed") return "failure";
    return item.status === "completed" ? "success" : "neutral";
  }
  if (!itemIsToolLike(item)) return null;
  if (item.status === "failed") return "failure";
  return item.status === "completed" ? "success" : "neutral";
}

function itemLifecycleStatus(item: OrchestrationV2TurnItem): WorkLogToolLifecycleStatus {
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

function itemWorkLogTone(item: OrchestrationV2TurnItem): WorkLogPresentationEntry["tone"] {
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

function itemIcon(item: OrchestrationV2TurnItem): ThreadFeedActivity["icon"] {
  switch (item.type) {
    case "reasoning":
      return "agent";
    case "command_execution":
      return "command";
    case "file_change":
      return "edit";
    case "file_search":
      return "eye";
    case "web_search":
      return "globe";
    case "approval_request":
    case "user_input_request":
    case "user_message":
    case "assistant_message":
      return "message";
    case "dynamic_tool":
      return "wrench";
    case "subagent":
      return "hammer";
    case "run_interrupt_request":
    case "run_interrupt_result":
      return "warning";
    case "error":
      return "alert";
    case "checkpoint":
    case "proposed_plan":
    case "todo_list":
      return "check";
    case "compaction":
    case "handoff":
    case "fork":
    case "thread_created":
      return "zap";
  }
}

function itemToolPresentation(item: OrchestrationV2TurnItem): T3McpToolPresentation | null {
  if (item.type !== "dynamic_tool") {
    return null;
  }
  return resolveT3McpToolPresentation(item.toolName) ?? resolveT3McpToolPresentation(item.title);
}

function itemSummary(
  item: OrchestrationV2TurnItem,
  toolPresentation: T3McpToolPresentation | null = null,
): string {
  const title = item.title?.trim();
  if (title) return toolPresentation?.displayName ?? capitalizePhrase(title);
  switch (item.type) {
    case "reasoning":
      return "Thinking";
    case "command_execution":
      return "Command";
    case "file_change":
      return `Changed ${item.fileName}`;
    case "file_search":
      return "Searched files";
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
      return "Provider error";
    case "compaction":
      return "Context compacted";
    case "handoff":
      return "Context handed off";
    case "fork":
      return "Thread forked";
    case "thread_created":
      return "Thread created";
    case "subagent":
      return "Subagent";
    case "dynamic_tool":
      return toolPresentation?.displayName ?? item.toolName ?? "Tool call";
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

function itemPreview(item: OrchestrationV2TurnItem): string | null {
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
      return item.message || null;
    case "error":
      return item.failure.message;
    case "compaction":
    case "handoff":
      return item.summary ?? null;
    case "fork":
    case "thread_created":
      return item.targetThreadId;
    case "subagent":
      return item.result ?? item.progress ?? item.prompt;
    case "dynamic_tool":
      return null;
    case "proposed_plan":
      return item.markdown || null;
    case "todo_list":
      return `${item.steps.filter((step) => step.status === "completed").length}/${item.steps.length} completed`;
    case "user_message":
    case "assistant_message":
      return item.text || null;
  }
}

function toWorkLogEntry(
  item: OrchestrationV2TurnItem,
  createdAt: string,
  summary: string,
  detail: string | null,
): WorkLogPresentationEntry {
  const title = item.title?.trim() || null;
  const common = {
    ...extractToolActivityPresentation(item),
    id: item.id,
    createdAt,
    label: summary,
    tone: itemWorkLogTone(item),
    itemType: item.type,
    toolLifecycleStatus: itemLifecycleStatus(item),
    structuredPayload: item,
  } as const;

  switch (item.type) {
    case "reasoning":
      return { ...common, ...(item.text ? { detail: item.text } : {}) };
    case "command_execution":
      return {
        ...common,
        command: item.input,
        rawCommand: item.input,
        ...(item.output ? { detail: item.output } : {}),
        toolTitle: title ?? "Command",
        toolData: item,
      };
    case "file_change":
      return {
        ...common,
        changedFiles: [item.fileName],
        ...((item.diffStr ?? item.newStr) ? { detail: item.diffStr ?? item.newStr } : {}),
        toolTitle: title ?? "File change",
        toolData: item,
      };
    case "file_search":
      return {
        ...common,
        ...(item.pattern ? { detail: item.pattern } : {}),
        toolTitle: title ?? "File search",
        toolData: item,
      };
    case "web_search":
      return {
        ...common,
        ...(item.patterns?.length ? { detail: item.patterns.join(", ") } : {}),
        toolTitle: title ?? "Web search",
        toolData: item,
      };
    case "checkpoint":
      return { ...common, changedFiles: item.files.map((file) => file.path), toolData: item };
    case "approval_request":
      return {
        ...common,
        ...(item.prompt ? { detail: item.prompt } : {}),
        requestKind: item.requestKind,
        toolData: item,
      };
    case "dynamic_tool":
      return {
        ...common,
        toolTitle: title ?? item.toolName ?? "Tool",
        toolData: { input: item.input, output: item.output },
      };
    default:
      return { ...common, ...(detail ? { detail } : {}), toolData: item };
  }
}

function toFeedActivity(
  row: OrchestrationV2ProjectedTurnItem,
  attemptId: RunAttemptId | null,
): ThreadFeedActivity {
  const item = row.item;
  const toolPresentation = itemToolPresentation(item);
  const summary = itemSummary(item, toolPresentation);
  const detail = itemPreview(item);
  const createdAt = DateTime.formatIso(item.startedAt ?? item.updatedAt);
  const workEntry = toWorkLogEntry(item, createdAt, summary, detail);
  const getFullDetail = memoizeValue(() =>
    JSON.stringify(
      {
        visibility: row.visibility,
        sourceThreadId: row.sourceThreadId,
        sourceItemId: row.sourceItemId,
        item,
      },
      null,
      2,
    ),
  );
  const getCopyText = memoizeValue(() =>
    [summary, detail, getFullDetail()]
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
    canExpand: true,
    getFullDetail,
    getCopyText,
    icon: workEntry.toolSurface ?? itemIcon(item),
    logo: toolPresentation?.logo ?? null,
    toolLike: itemIsToolLike(item),
    prominent: itemIsProminent(item),
    status: itemStatus(item),
    lifecycleStatus: itemLifecycleStatus(item),
    workEntry,
    projectedItem: row,
  };
}

function singleToolCallLabel(activity: ThreadFeedActivity): string {
  const presentation = resolveWorkEntryToolPresentation(activity.workEntry, "completed");
  if (presentation) return presentation.displayName;
  const command = activity.workEntry.command?.trim();
  return command || activity.summary;
}

function isEmptyMessage(entry: RawThreadFeedEntry): boolean {
  return (
    entry.type === "message" &&
    entry.message.text.trim().length === 0 &&
    entry.message.attachments.length === 0
  );
}

function groupAdjacentActivities(entries: ReadonlyArray<RawThreadFeedEntry>): ThreadFeedEntry[] {
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

  for (const entry of entries) {
    // Skip empty messages so they don't break activity grouping.
    if (isEmptyMessage(entry)) {
      continue;
    }

    if (entry.type !== "activity") {
      flushGroup();
      grouped.push(entry);
      continue;
    }

    const isCompaction = entry.activity.projectedItem.item.type === "compaction";
    if (
      isCompaction ||
      entry.activity.prominent ||
      firstActivityEntry?.runId !== entry.runId ||
      firstActivityEntry?.activity.attemptId !== entry.activity.attemptId
    ) {
      flushGroup();
    }
    firstActivityEntry ??= entry;
    openGroupActivities.push(entry.activity);
    if (isCompaction || entry.activity.prominent) {
      flushGroup();
    }
  }
  flushGroup();
  return grouped;
}

function computeElapsedMs(startIso: string, endIso: string): number | null {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : null;
}

function maxIsoTimestamp(left: string | null, right: string | null): string | null {
  if (left === null) return right;
  if (right === null) return left;
  return Date.parse(right) > Date.parse(left) ? right : left;
}

function unsettledRunId(latestRun: ThreadFeedLatestRun | null): RunId | null {
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

interface ThreadFeedRunFold {
  readonly runId: RunId;
  readonly createdAt: string;
  readonly hiddenEntryIds: ReadonlySet<string>;
  readonly label: string;
}

function deriveThreadFeedRunFolds(
  feed: ReadonlyArray<ThreadFeedEntry>,
  latestRun: ThreadFeedLatestRun | null,
): ReadonlyMap<string, ThreadFeedRunFold> {
  const terminalAssistantMessageIdByRun = new Map<RunId, string>();
  const interruptedRunIds = new Set<RunId>();
  for (const entry of feed) {
    if (entry.type === "message" && entry.message.role === "assistant" && entry.message.runId) {
      terminalAssistantMessageIdByRun.set(entry.message.runId, entry.id);
    }
    if (
      entry.type === "activity-group" &&
      entry.runId !== null &&
      entry.activities.some(
        (activity) => activity.projectedItem.item.type === "run_interrupt_result",
      )
    ) {
      interruptedRunIds.add(entry.runId);
    }
  }

  const groupsByRunId = new Map<
    RunId,
    { entries: ThreadFeedEntry[]; startBoundary: string | null }
  >();
  let pendingUserBoundary: string | null = null;
  for (const entry of feed) {
    if (entry.type === "message" && entry.message.role === "user") {
      pendingUserBoundary = entry.message.createdAt;
      continue;
    }
    const runId =
      entry.type === "message" && entry.message.role === "assistant"
        ? entry.message.runId
        : entry.type === "activity-group"
          ? entry.runId
          : null;
    if (!runId) continue;
    let group = groupsByRunId.get(runId);
    if (!group) {
      group = { entries: [], startBoundary: pendingUserBoundary };
      pendingUserBoundary = null;
      groupsByRunId.set(runId, group);
    }
    group.entries.push(entry);
  }

  const activeRunId = unsettledRunId(latestRun);
  const foldsByAnchorId = new Map<string, ThreadFeedRunFold>();
  for (const [runId, group] of groupsByRunId) {
    if (
      runId === activeRunId ||
      interruptedRunIds.has(runId) ||
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
            !(
              entry.type === "activity-group" &&
              entry.activities.some((activity) => activity.prominent)
            ),
        )
        .map((entry) => entry.id),
    );
    const firstEntry = group.entries[0];
    const lastEntry = group.entries.at(-1);
    if (hiddenEntryIds.size === 0 || !firstEntry || !lastEntry) continue;
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
    foldsByAnchorId.set(firstEntry.id, {
      runId,
      createdAt: firstEntry.createdAt,
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
  return foldsByAnchorId;
}

export function deriveThreadFeedPresentation(
  feed: ReadonlyArray<ThreadFeedEntry>,
  latestRun: ThreadFeedLatestRun | null,
  expandedRunIds: ReadonlySet<RunId>,
  expandedWorkGroupIds: ReadonlySet<string> = new Set(),
  activeWorkStartedAt: string | null = null,
): ThreadFeedEntry[] {
  const sourceFeed = feed.filter(
    (entry) => entry.type !== "run-fold" && entry.type !== "work-toggle",
  );
  const activeTailGroup = sourceFeed.at(-1);
  const foldsByAnchorId = deriveThreadFeedRunFolds(sourceFeed, latestRun);
  const activeRunId = unsettledRunId(latestRun);
  const isWorking = activeWorkStartedAt !== null;
  const collapsedEntryIds = new Set<string>();
  for (const fold of foldsByAnchorId.values()) {
    if (!expandedRunIds.has(fold.runId)) {
      for (const entryId of fold.hiddenEntryIds) collapsedEntryIds.add(entryId);
    }
  }
  const result: ThreadFeedEntry[] = [];
  for (const entry of sourceFeed) {
    const isActiveTailGroup =
      isWorking &&
      activeRunId !== null &&
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
        row.expanded !== expanded
      ) {
        row = {
          type: "run-fold",
          id: `run-fold:${fold.runId}`,
          createdAt: fold.createdAt,
          runId: fold.runId,
          label: fold.label,
          expanded,
        };
        runFoldRowsCache.set(entry, row);
      }
      result.push(row);
    }
    if (!collapsedEntryIds.has(entry.id)) {
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
  return result;
}

function appendPresentedFeedEntry(
  result: ThreadFeedEntry[],
  entry: Exclude<ThreadFeedEntry, { readonly type: "run-fold" | "work-toggle" }>,
  expandedWorkGroupIds: ReadonlySet<string>,
  activeRunId: RunId | null,
  isWorking: boolean,
  activeTail: boolean,
): void {
  if (entry.type !== "activity-group") {
    result.push(entry);
    return;
  }
  if (isContextCompactionActivityGroup(entry)) {
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

function appendActivityGroupRows(
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
    if (!activity.prominent && !severeProviderError) {
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

function appendToolGroupRows(
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
  const latestInProgressActivity = activities.findLast(
    (activity) =>
      isWorking && activity.lifecycleStatus === "inProgress" && activity.runId === activeRunId,
  );
  const live = activeTail || latestInProgressActivity !== undefined;
  const latestActivity = latestInProgressActivity ?? activities.at(-1)!;
  const singleActivity = activities.length === 1 ? latestActivity : null;
  const groupSummary = summarizeToolGroup(activities.map((activity) => activity.workEntry));
  const summary = live
    ? liveToolActivitySummary(latestActivity, live)
    : singleActivity !== null &&
        singleActivity.toolLike &&
        toolGroupAction(singleActivity.workEntry) !== "edit"
      ? singleToolCallLabel(singleActivity)
      : singleActivity !== null && !singleActivity.toolLike
        ? singleActivity.workEntry.label
        : groupSummary.summary;
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
    : singleActivity !== null &&
        singleActivity.toolLike &&
        toolGroupAction(singleActivity.workEntry) !== "edit"
      ? resolveWorkEntryToolPresentation(singleActivity.workEntry, "completed")?.icon
      : undefined;
  result.push({
    type: "work-toggle",
    id: `${live ? "work-live" : "work-toggle"}:${groupId}`,
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
    hasFailure: (() => {
      const lastToolLike = activities.findLast((activity) => activity.toolLike);
      return (
        lastToolLike !== undefined && workEntryDisplayIndicatesToolFailure(lastToolLike.workEntry)
      );
    })(),
    live,
    shimmer:
      isWorking &&
      latestActivity.lifecycleStatus === "inProgress" &&
      latestActivity.runId === activeRunId,
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

function liveToolActivitySummary(activity: ThreadFeedActivity, presentTense: boolean): string {
  const status = liveActivityToolStatus(activity.lifecycleStatus, presentTense);
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
  return activity.detail ?? activity.summary;
}

export function setPendingUserInputCustomAnswer(
  question: ThreadUserInputQuestion,
  draft: PendingUserInputDraftAnswer | undefined,
  customAnswer: string,
): PendingUserInputDraftAnswer {
  if (question.allowCustomAnswer === false) {
    return draft ?? {};
  }

  const selectedOptionValues =
    customAnswer.trim().length > 0
      ? undefined
      : normalizeSelectedOptionValues(question, draft?.selectedOptionValues);
  return {
    customAnswer,
    ...(selectedOptionValues && selectedOptionValues.length > 0 ? { selectedOptionValues } : {}),
  };
}

export function isPendingUserInputOptionSelected(
  question: ThreadUserInputQuestion,
  draft: PendingUserInputDraftAnswer | undefined,
  optionValue: string,
): boolean {
  if (question.allowCustomAnswer !== false && normalizeDraftAnswer(draft?.customAnswer)) {
    return false;
  }

  const resolvedOptionValue = resolvePendingUserInputOptionValue(question, optionValue);
  return (
    resolvedOptionValue !== null &&
    normalizeSelectedOptionValues(question, draft?.selectedOptionValues).includes(
      resolvedOptionValue,
    )
  );
}

export function togglePendingUserInputOptionSelection(
  question: ThreadUserInputQuestion,
  draft: PendingUserInputDraftAnswer | undefined,
  optionValue: string,
): PendingUserInputDraftAnswer {
  const resolvedOptionValue = resolvePendingUserInputOptionValue(question, optionValue);
  if (resolvedOptionValue === null) {
    return draft ?? {};
  }

  if (question.multiSelect) {
    const selectedOptionValues = normalizeSelectedOptionValues(
      question,
      draft?.selectedOptionValues,
    );
    const nextSelectedOptionValues = selectedOptionValues.includes(resolvedOptionValue)
      ? selectedOptionValues.filter((value) => value !== resolvedOptionValue)
      : [...selectedOptionValues, resolvedOptionValue];

    return {
      customAnswer: "",
      ...(nextSelectedOptionValues.length > 0
        ? { selectedOptionValues: nextSelectedOptionValues }
        : {}),
    };
  }

  return {
    customAnswer: "",
    selectedOptionValues: [resolvedOptionValue],
  };
}

export function buildPendingUserInputAnswers(
  questions: ReadonlyArray<ThreadUserInputQuestion>,
  draftAnswers: Record<string, PendingUserInputDraftAnswer>,
): Record<string, string | ReadonlyArray<string>> | null {
  const answers: Record<string, string | ReadonlyArray<string>> = {};

  for (const question of questions) {
    const answer = resolvePendingUserInputAnswer(question, draftAnswers[question.id]);
    if (answer === null) {
      return null;
    }
    answers[question.id] = answer;
  }

  return answers;
}

/**
 * Projects the server-authored visible sequence into mobile row presentation.
 * It deliberately preserves the incoming order and never rebuilds chat from
 * separate message, plan, or work-entry collections.
 */
export function buildThreadFeed(
  visibleTurnItems: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
  options?: {
    readonly localMessages?: ReadonlyArray<OrchestrationMessage>;
    readonly anchoredMessages?: ReadonlyArray<OrchestrationMessage>;
    readonly attempts?: ReadonlyArray<OrchestrationV2RunAttempt>;
    readonly nodes?: ReadonlyArray<OrchestrationV2ExecutionNode>;
  },
): ThreadFeedEntry[] {
  const entries: RawThreadFeedEntry[] = [];
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
  for (const row of visibleTurnItems) {
    const item = row.item;
    if (turnItemIsWorkspacePreparation(item)) continue;
    // Match the web timeline: only the terminal interrupt result is useful to
    // users; the preceding request is transient bookkeeping.
    if (item.type === "run_interrupt_request") {
      continue;
    }
    const attemptId = resolveAttemptId(item);
    const cached = projectedEntriesCache.get(row);
    if (cached?.attemptId === attemptId) {
      entries.push(cached.entry);
      continue;
    }
    const createdAt = DateTime.formatIso(item.startedAt ?? item.updatedAt);
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
          attachments: item.attachments ?? [],
          runId: item.runId,
          streaming: item.type === "assistant_message" && item.streaming,
          ...(item.type === "user_message"
            ? {
                inputIntent: item.inputIntent,
                createdBy: item.createdBy,
                creationSource: item.creationSource,
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
  }
  const retainedMessageIds = new Set(
    entries.flatMap((entry) => (entry.type === "message" ? [entry.id] : [])),
  );
  const appendLocalMessage = (message: OrchestrationMessage): RawThreadFeedEntry => {
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
  for (const message of options?.anchoredMessages ?? []) {
    if (retainedMessageIds.has(message.id)) continue;
    retainedMessageIds.add(message.id);
    const entry = appendLocalMessage(message);
    const insertionIndex = entries.findIndex(
      (candidate) => candidate.createdAt > message.createdAt,
    );
    if (insertionIndex === -1) entries.push(entry);
    else entries.splice(insertionIndex, 0, entry);
  }
  for (const message of options?.localMessages ?? []) {
    if (retainedMessageIds.has(message.id)) continue;
    retainedMessageIds.add(message.id);
    entries.push(appendLocalMessage(message));
  }
  return groupAdjacentActivities(entries);
}
