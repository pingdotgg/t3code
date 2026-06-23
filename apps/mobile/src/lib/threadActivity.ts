import type {
  EnvironmentThread,
  ThreadConversationMessage,
  ThreadPendingApproval,
  ThreadPendingUserInput,
  ThreadRunSummary,
  ThreadUserInputQuestion,
  ThreadWorkEntry,
} from "@t3tools/client-runtime/state/shell";
import type { RunId } from "@t3tools/contracts";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";

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
  readonly canExpand: boolean;
  readonly getFullDetail: () => string | null;
  readonly getCopyText: () => string;
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
  readonly status: "success" | "failure" | "neutral" | null;
}

type RawThreadFeedEntry =
  | {
      readonly type: "message";
      readonly id: string;
      readonly createdAt: string;
      readonly message: ThreadConversationMessage;
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
      readonly type: "working";
      readonly id: string;
      readonly createdAt: string;
    }
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

export type ThreadFeedLatestRun = Pick<
  ThreadRunSummary,
  "runId" | "status" | "startedAt" | "completedAt"
>;

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

function workEntryIsToolLike(entry: ThreadWorkEntry): boolean {
  return (
    entry.tone === "tool" ||
    entry.tone === "thinking" ||
    entry.tone === "error" ||
    entry.command !== undefined ||
    entry.requestKind !== undefined
  );
}

function workEntryStatus(entry: ThreadWorkEntry): ThreadFeedActivity["status"] {
  if (!workEntryIsToolLike(entry)) return null;
  if (
    entry.tone === "error" ||
    entry.toolLifecycleStatus === "failed" ||
    entry.toolLifecycleStatus === "declined"
  ) {
    return "failure";
  }
  return entry.toolLifecycleStatus === "completed" ? "success" : "neutral";
}

function workEntryIcon(entry: ThreadWorkEntry): ThreadFeedActivity["icon"] {
  switch (entry.itemType) {
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
      return "message";
    case "dynamic_tool":
      return "wrench";
    case "subagent":
      return "hammer";
    case "run_interrupt_request":
    case "run_interrupt_result":
      return "warning";
    case "checkpoint":
      return "check";
    default:
      if (entry.tone === "error") return "alert";
      if (entry.tone === "thinking") return "agent";
      if (entry.tone === "info") return "check";
      return "zap";
  }
}

function workEntryPreview(entry: ThreadWorkEntry): string | null {
  if (entry.command) return entry.command;
  if (entry.detail) return entry.detail;
  const firstPath = entry.changedFiles?.[0];
  if (!firstPath) return null;
  return entry.changedFiles?.length === 1
    ? firstPath
    : `${firstPath} +${(entry.changedFiles?.length ?? 1) - 1} more`;
}

function buildWorkEntryExpandedBody(entry: ThreadWorkEntry): string | null {
  const blocks: string[] = [];
  const append = (value: string | null | undefined) => {
    const trimmed = value?.trim();
    if (trimmed && !blocks.includes(trimmed)) blocks.push(trimmed);
  };
  append(entry.rawCommand ?? entry.command);
  append(entry.detail);
  if (entry.changedFiles?.length) append(entry.changedFiles.join("\n"));
  append(JSON.stringify(entry.structuredPayload, null, 2));
  return blocks.length === 0 ? null : blocks.join("\n\n");
}

function toFeedActivity(entry: ThreadWorkEntry): ThreadFeedActivity {
  const summary = capitalizePhrase(entry.toolTitle ?? entry.label);
  const detail = workEntryPreview(entry);
  const fullDetail = buildWorkEntryExpandedBody(entry);
  return {
    id: entry.id,
    createdAt: entry.createdAt,
    runId: entry.runId,
    summary,
    detail,
    fullDetail,
    icon: workEntryIcon(entry),
    copyText: [summary, detail, fullDetail]
      .filter(
        (value, index, values): value is string =>
          Boolean(value) && values.indexOf(value) === index,
      )
      .join("\n"),
    toolLike: workEntryIsToolLike(entry),
    status: workEntryStatus(entry),
  };
}

function byCreatedAt<A extends { readonly createdAt: string }>(left: A, right: A): number {
  return left.createdAt.localeCompare(right.createdAt);
}

function isEmptyMessage(entry: RawThreadFeedEntry): boolean {
  return (
    entry.type === "message" &&
    entry.message.text.trim().length === 0 &&
    (entry.message.attachments ?? []).length === 0
  );
}

function groupAdjacentActivities(entries: ReadonlyArray<RawThreadFeedEntry>): ThreadFeedEntry[] {
  const grouped: ThreadFeedEntry[] = [];
  for (const entry of entries) {
    if (isEmptyMessage(entry)) continue;
    if (entry.type !== "activity") {
      grouped.push(entry);
      openGroupActivities = null;
      continue;
    }
    const previous = grouped.at(-1);
    if (previous?.type === "activity-group" && previous.runId === entry.runId) {
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
      group.entries.filter((entry) => entry.id !== terminalAssistantId).map((entry) => entry.id),
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
  if (activeWorkStartedAt !== null) {
    result.push({
      type: "working",
      id: "working-indicator-row",
      createdAt: activeWorkStartedAt,
    });
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

export function buildThreadFeed(
  thread: EnvironmentThread,
  options?: { readonly loadedMessages?: ReadonlyArray<ThreadConversationMessage> },
): ThreadFeedEntry[] {
  const loadedMessages = options?.loadedMessages ?? thread.messages;
  const oldestLoadedMessageCreatedAt =
    options?.loadedMessages === undefined ? null : (loadedMessages[0]?.createdAt ?? null);
  const entries: RawThreadFeedEntry[] = [
    ...loadedMessages.map((message) => ({
      type: "message" as const,
      id: message.id,
      createdAt: message.createdAt,
      message,
    })),
    ...thread.workEntries
      .filter(
        (entry) =>
          oldestLoadedMessageCreatedAt === null || entry.createdAt >= oldestLoadedMessageCreatedAt,
      )
      .map((entry) => ({
        type: "activity" as const,
        id: entry.id,
        createdAt: entry.createdAt,
        runId: entry.runId,
        activity: toFeedActivity(entry),
      })),
  ];
  return groupAdjacentActivities(entries.toSorted(byCreatedAt));
}
