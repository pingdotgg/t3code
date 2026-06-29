import type {
  ThreadPendingApproval,
  ThreadPendingUserInput,
  ThreadUserInputQuestion,
} from "@t3tools/client-runtime/state/thread-requests";
import type {
  ChatAttachment,
  MessageId,
  OrchestrationV2Actor,
  OrchestrationV2CreationSource,
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2RunStatus,
  OrchestrationV2TurnItem,
  OrchestrationV2UserMessageInputIntent,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import * as DateTime from "effect/DateTime";

export type PendingApproval = ThreadPendingApproval;
export type PendingUserInput = ThreadPendingUserInput;

export interface PendingUserInputDraftAnswer {
  readonly selectedOptionLabel?: string;
  readonly customAnswer?: string;
}

export interface ThreadFeedActivity {
  readonly id: string;
  readonly createdAt: string;
  readonly runId: RunId | null;
  readonly summary: string;
  readonly detail: string | null;
  readonly fullDetail: string | null;
  readonly copyText: string;
  readonly icon:
    | "agent"
    | "alert"
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
  readonly toolLike: boolean;
  readonly prominent: boolean;
  readonly status: "success" | "failure" | "neutral" | null;
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
  readonly projectedItem: OrchestrationV2ProjectedTurnItem;
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

function normalizeDraftAnswer(value: string | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function resolvePendingUserInputAnswer(
  draft: PendingUserInputDraftAnswer | undefined,
): string | null {
  return (
    normalizeDraftAnswer(draft?.customAnswer) ?? normalizeDraftAnswer(draft?.selectedOptionLabel)
  );
}

function capitalizePhrase(value: string): string {
  const trimmed = value.trim();
  return trimmed.length === 0 ? value : `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`;
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
    item.type === "subagent" ||
    item.type === "error"
  );
}

function itemIsProminent(item: OrchestrationV2TurnItem): boolean {
  return item.type === "fork" || item.type === "thread_created" || item.type === "subagent";
}

function itemStatus(item: OrchestrationV2TurnItem): ThreadFeedActivity["status"] {
  if (!itemIsToolLike(item)) return null;
  if (item.type === "error" || item.status === "failed") return "failure";
  return item.status === "completed" ? "success" : "neutral";
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

function itemSummary(item: OrchestrationV2TurnItem): string {
  const title = item.title?.trim();
  if (title) return capitalizePhrase(title);
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
      return item.toolName ?? "Tool call";
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

function toFeedActivity(row: OrchestrationV2ProjectedTurnItem): ThreadFeedActivity {
  const item = row.item;
  const summary = itemSummary(item);
  const detail = itemPreview(item);
  const fullDetail = JSON.stringify(
    {
      visibility: row.visibility,
      sourceThreadId: row.sourceThreadId,
      sourceItemId: row.sourceItemId,
      item,
    },
    null,
    2,
  );
  return {
    id: `${row.visibility}:${row.sourceThreadId}:${row.sourceItemId}`,
    createdAt: DateTime.formatIso(item.startedAt ?? item.updatedAt),
    runId: item.runId,
    summary,
    detail,
    fullDetail,
    icon: itemIcon(item),
    copyText: [summary, detail, fullDetail]
      .filter(
        (value, index, values): value is string =>
          Boolean(value) && values.indexOf(value) === index,
      )
      .join("\n"),
    toolLike: itemIsToolLike(item),
    prominent: itemIsProminent(item),
    status: itemStatus(item),
    projectedItem: row,
  };
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
  for (const entry of entries) {
    if (isEmptyMessage(entry)) continue;
    if (entry.type !== "activity") {
      grouped.push(entry);
      continue;
    }
    const previous = grouped.at(-1);
    if (
      previous?.type === "activity-group" &&
      previous.runId === entry.runId &&
      !entry.activity.prominent &&
      !previous.activities.some((activity) => activity.prominent)
    ) {
      grouped[grouped.length - 1] = {
        ...previous,
        activities: [...previous.activities, entry.activity],
      };
      continue;
    }
    grouped.push({
      type: "activity-group",
      id: entry.id,
      createdAt: entry.createdAt,
      runId: entry.runId,
      activities: [entry.activity],
    });
  }
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
  if (!latestRun) return null;
  return latestRun.completedAt === null ||
    latestRun.status === "preparing" ||
    latestRun.status === "starting" ||
    latestRun.status === "running" ||
    latestRun.status === "waiting"
    ? latestRun.runId
    : null;
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
  for (const entry of feed) {
    if (entry.type === "message" && entry.message.role === "assistant" && entry.message.runId) {
      terminalAssistantMessageIdByRun.set(entry.message.runId, entry.id);
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
): ThreadFeedEntry[] {
  const sourceFeed = feed.filter((entry) => entry.type !== "run-fold");
  const foldsByAnchorId = deriveThreadFeedRunFolds(sourceFeed, latestRun);
  const collapsedEntryIds = new Set<string>();
  for (const fold of foldsByAnchorId.values()) {
    if (!expandedRunIds.has(fold.runId)) {
      for (const entryId of fold.hiddenEntryIds) collapsedEntryIds.add(entryId);
    }
  }
  const result: ThreadFeedEntry[] = [];
  for (const entry of sourceFeed) {
    const fold = foldsByAnchorId.get(entry.id);
    if (fold) {
      result.push({
        type: "run-fold",
        id: `run-fold:${fold.runId}`,
        createdAt: fold.createdAt,
        runId: fold.runId,
        label: fold.label,
        expanded: expandedRunIds.has(fold.runId),
      });
    }
    if (!collapsedEntryIds.has(entry.id)) result.push(entry);
  }
  return result;
}

export function setPendingUserInputCustomAnswer(
  draft: PendingUserInputDraftAnswer | undefined,
  customAnswer: string,
): PendingUserInputDraftAnswer {
  const selectedOptionLabel =
    customAnswer.trim().length > 0 ? undefined : draft?.selectedOptionLabel;
  return { customAnswer, ...(selectedOptionLabel ? { selectedOptionLabel } : {}) };
}

export function buildPendingUserInputAnswers(
  questions: ReadonlyArray<ThreadUserInputQuestion>,
  draftAnswers: Record<string, PendingUserInputDraftAnswer>,
): Record<string, string> | null {
  const answers: Record<string, string> = {};
  for (const question of questions) {
    const answer = resolvePendingUserInputAnswer(draftAnswers[question.id]);
    if (!answer) return null;
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
): ThreadFeedEntry[] {
  const entries = visibleTurnItems.map((row): RawThreadFeedEntry => {
    const item = row.item;
    const createdAt = DateTime.formatIso(item.startedAt ?? item.updatedAt);
    if (item.type === "user_message" || item.type === "assistant_message") {
      const updatedAt = DateTime.formatIso(item.updatedAt);
      return {
        type: "message",
        id: item.messageId,
        createdAt,
        message: {
          id: item.messageId,
          role: item.type === "user_message" ? "user" : "assistant",
          text: item.text,
          attachments: item.type === "user_message" ? item.attachments : [],
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
    }
    const activity = toFeedActivity(row);
    return {
      type: "activity",
      id: activity.id,
      createdAt,
      runId: item.runId,
      activity,
    };
  });
  return groupAdjacentActivities(entries);
}
