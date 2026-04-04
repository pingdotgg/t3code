import type {
  ApprovalRequestId,
  OrchestrationThread,
  OrchestrationThreadActivity,
  ThreadId,
  UserInputQuestion,
} from "@t3tools/contracts";

import type { DraftComposerImageAttachment } from "./composerImages";
import { sortCopy } from "./arrayCompat";

export interface PendingApproval {
  readonly requestId: ApprovalRequestId;
  readonly requestKind: "command" | "file-read" | "file-change";
  readonly createdAt: string;
  readonly detail?: string;
}

export interface PendingUserInput {
  readonly requestId: ApprovalRequestId;
  readonly createdAt: string;
  readonly questions: ReadonlyArray<UserInputQuestion>;
}

export interface PendingUserInputDraftAnswer {
  readonly selectedOptionLabel?: string;
  readonly customAnswer?: string;
}

export interface QueuedThreadMessage {
  readonly id: string;
  readonly threadId: ThreadId;
  readonly messageId: string;
  readonly commandId: string;
  readonly text: string;
  readonly attachments: ReadonlyArray<DraftComposerImageAttachment>;
  readonly createdAt: string;
}

export interface ThreadFeedActivity {
  readonly id: string;
  readonly createdAt: string;
  readonly summary: string;
  readonly detail: string | null;
  readonly status: string | null;
}

type RawThreadFeedEntry =
  | {
      readonly type: "message";
      readonly id: string;
      readonly createdAt: string;
      readonly message: OrchestrationThread["messages"][number];
    }
  | {
      readonly type: "queued-message";
      readonly id: string;
      readonly createdAt: string;
      readonly queuedMessage: QueuedThreadMessage;
      readonly sending: boolean;
    }
  | {
      readonly type: "activity";
      readonly id: string;
      readonly createdAt: string;
      readonly activity: ThreadFeedActivity;
    };

export type ThreadFeedEntry =
  | Extract<RawThreadFeedEntry, { type: "message" | "queued-message" }>
  | {
      readonly type: "activity-group";
      readonly id: string;
      readonly createdAt: string;
      readonly activities: ReadonlyArray<ThreadFeedActivity>;
    };

function compareActivitiesByOrder(
  left: OrchestrationThreadActivity,
  right: OrchestrationThreadActivity,
): number {
  if (left.sequence !== undefined && right.sequence !== undefined) {
    if (left.sequence !== right.sequence) {
      return left.sequence - right.sequence;
    }
  } else if (left.sequence !== undefined) {
    return 1;
  } else if (right.sequence !== undefined) {
    return -1;
  }

  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

function requestKindFromRequestType(requestType: unknown): PendingApproval["requestKind"] | null {
  switch (requestType) {
    case "command_execution_approval":
    case "exec_command_approval":
      return "command";
    case "file_read_approval":
      return "file-read";
    case "file_change_approval":
    case "apply_patch_approval":
      return "file-change";
    default:
      return null;
  }
}

function isStalePendingRequestFailureDetail(detail: string | undefined): boolean {
  const normalized = detail?.toLowerCase();
  if (!normalized) {
    return false;
  }
  return (
    normalized.includes("stale pending approval request") ||
    normalized.includes("stale pending user-input request") ||
    normalized.includes("unknown pending approval request") ||
    normalized.includes("unknown pending permission request") ||
    normalized.includes("unknown pending user-input request")
  );
}

function parseUserInputQuestions(
  payload: Record<string, unknown> | null,
): ReadonlyArray<UserInputQuestion> | null {
  const questions = payload?.questions;
  if (!Array.isArray(questions)) {
    return null;
  }

  const parsed = questions
    .map<UserInputQuestion | null>((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const question = entry as Record<string, unknown>;
      if (
        typeof question.id !== "string" ||
        typeof question.header !== "string" ||
        typeof question.question !== "string" ||
        !Array.isArray(question.options)
      ) {
        return null;
      }
      const options = question.options
        .map<UserInputQuestion["options"][number] | null>((option) => {
          if (!option || typeof option !== "object") return null;
          const record = option as Record<string, unknown>;
          if (typeof record.label !== "string" || typeof record.description !== "string") {
            return null;
          }
          return {
            label: record.label,
            description: record.description,
          };
        })
        .filter((option): option is UserInputQuestion["options"][number] => option !== null);
      if (options.length === 0) {
        return null;
      }
      return {
        id: question.id,
        header: question.header,
        question: question.question,
        options,
      };
    })
    .filter((question): question is UserInputQuestion => question !== null);

  return parsed.length > 0 ? parsed : null;
}

function normalizeDraftAnswer(value: string | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function resolvePendingUserInputAnswer(
  draft: PendingUserInputDraftAnswer | undefined,
): string | null {
  const customAnswer = normalizeDraftAnswer(draft?.customAnswer);
  if (customAnswer) {
    return customAnswer;
  }
  return normalizeDraftAnswer(draft?.selectedOptionLabel);
}

function coercePayloadRecord(payload: unknown): Record<string, unknown> | null {
  return payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
}

function isToolActivity(activity: OrchestrationThreadActivity): boolean {
  return (
    activity.kind === "tool.started" ||
    activity.kind === "tool.updated" ||
    activity.kind === "tool.completed"
  );
}

function activityDetail(activity: OrchestrationThreadActivity): string | null {
  const payload = coercePayloadRecord(activity.payload);
  const detail =
    typeof payload?.detail === "string"
      ? payload.detail
      : typeof payload?.error === "string"
        ? payload.error
        : typeof payload?.message === "string"
          ? payload.message
          : null;
  if (detail && detail.trim().length > 0) {
    return detail;
  }
  return null;
}

function activityStatus(activity: OrchestrationThreadActivity): string | null {
  const payload = coercePayloadRecord(activity.payload);
  const status =
    typeof payload?.status === "string"
      ? payload.status
      : typeof payload?.state === "string"
        ? payload.state
        : null;
  if (status && status.trim().length > 0) {
    return status;
  }
  return null;
}

function compareFeedEntries(left: RawThreadFeedEntry, right: RawThreadFeedEntry): number {
  const byCreatedAt = left.createdAt.localeCompare(right.createdAt);
  if (byCreatedAt !== 0) {
    return byCreatedAt;
  }
  return left.id.localeCompare(right.id);
}

function groupAdjacentActivities(entries: ReadonlyArray<RawThreadFeedEntry>): ThreadFeedEntry[] {
  const grouped: ThreadFeedEntry[] = [];

  for (const entry of entries) {
    if (entry.type !== "activity") {
      grouped.push(entry);
      continue;
    }

    const previous = grouped.at(-1);
    if (previous?.type === "activity-group") {
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
      activities: [entry.activity],
    });
  }

  return grouped;
}

export function derivePendingApprovals(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): PendingApproval[] {
  const openByRequestId = new Map<ApprovalRequestId, PendingApproval>();
  const ordered = sortCopy(activities, compareActivitiesByOrder);

  for (const activity of ordered) {
    const payload =
      activity.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : null;
    const requestId = payload?.requestId;
    const requestKind =
      payload?.requestKind === "command" ||
      payload?.requestKind === "file-read" ||
      payload?.requestKind === "file-change"
        ? payload.requestKind
        : requestKindFromRequestType(payload?.requestType);
    const detail = typeof payload?.detail === "string" ? payload.detail : undefined;

    if (activity.kind === "approval.requested" && typeof requestId === "string" && requestKind) {
      openByRequestId.set(requestId as ApprovalRequestId, {
        requestId: requestId as ApprovalRequestId,
        requestKind,
        createdAt: activity.createdAt,
        ...(detail ? { detail } : {}),
      });
      continue;
    }

    if (activity.kind === "approval.resolved" && typeof requestId === "string") {
      openByRequestId.delete(requestId as ApprovalRequestId);
      continue;
    }

    if (
      activity.kind === "provider.approval.respond.failed" &&
      typeof requestId === "string" &&
      isStalePendingRequestFailureDetail(detail)
    ) {
      openByRequestId.delete(requestId as ApprovalRequestId);
    }
  }

  return sortCopy([...openByRequestId.values()], (left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
}

export function derivePendingUserInputs(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): PendingUserInput[] {
  const openByRequestId = new Map<ApprovalRequestId, PendingUserInput>();
  const ordered = sortCopy(activities, compareActivitiesByOrder);

  for (const activity of ordered) {
    const payload =
      activity.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : null;
    const requestId = payload?.requestId;
    const detail = typeof payload?.detail === "string" ? payload.detail : undefined;

    if (activity.kind === "user-input.requested" && typeof requestId === "string") {
      const questions = parseUserInputQuestions(payload);
      if (!questions) {
        continue;
      }
      openByRequestId.set(requestId as ApprovalRequestId, {
        requestId: requestId as ApprovalRequestId,
        createdAt: activity.createdAt,
        questions,
      });
      continue;
    }

    if (activity.kind === "user-input.resolved" && typeof requestId === "string") {
      openByRequestId.delete(requestId as ApprovalRequestId);
      continue;
    }

    if (
      activity.kind === "provider.user-input.respond.failed" &&
      typeof requestId === "string" &&
      isStalePendingRequestFailureDetail(detail)
    ) {
      openByRequestId.delete(requestId as ApprovalRequestId);
    }
  }

  return sortCopy([...openByRequestId.values()], (left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
}

export function setPendingUserInputCustomAnswer(
  draft: PendingUserInputDraftAnswer | undefined,
  customAnswer: string,
): PendingUserInputDraftAnswer {
  const selectedOptionLabel =
    customAnswer.trim().length > 0 ? undefined : draft?.selectedOptionLabel;
  return {
    customAnswer,
    ...(selectedOptionLabel ? { selectedOptionLabel } : {}),
  };
}

export function buildPendingUserInputAnswers(
  questions: ReadonlyArray<UserInputQuestion>,
  draftAnswers: Record<string, PendingUserInputDraftAnswer>,
): Record<string, string> | null {
  const answers: Record<string, string> = {};

  for (const question of questions) {
    const answer = resolvePendingUserInputAnswer(draftAnswers[question.id]);
    if (!answer) {
      return null;
    }
    answers[question.id] = answer;
  }

  return answers;
}

export function buildThreadFeed(
  thread: OrchestrationThread,
  queuedMessages: ReadonlyArray<QueuedThreadMessage>,
  dispatchingQueuedMessageId: string | null,
  options?: {
    readonly loadedMessages?: ReadonlyArray<OrchestrationThread["messages"][number]>;
  },
): ThreadFeedEntry[] {
  const loadedMessages = options?.loadedMessages ?? thread.messages;
  const oldestLoadedMessageCreatedAt =
    options?.loadedMessages !== undefined ? (loadedMessages[0]?.createdAt ?? null) : null;
  const entries = sortCopy(
    [
      ...loadedMessages.map<RawThreadFeedEntry>((message) => ({
        type: "message",
        id: message.id,
        createdAt: message.createdAt,
        message,
      })),
      ...queuedMessages.map<RawThreadFeedEntry>((queuedMessage) => ({
        type: "queued-message",
        id: queuedMessage.id,
        createdAt: queuedMessage.createdAt,
        queuedMessage,
        sending: queuedMessage.id === dispatchingQueuedMessageId,
      })),
      ...thread.activities
        .filter((activity) => {
          if (!isToolActivity(activity)) {
            return false;
          }
          if (options?.loadedMessages === undefined) {
            return true;
          }
          return (
            oldestLoadedMessageCreatedAt === null ||
            activity.createdAt >= oldestLoadedMessageCreatedAt
          );
        })
        .map<RawThreadFeedEntry>((activity) => ({
          type: "activity",
          id: activity.id,
          createdAt: activity.createdAt,
          activity: {
            id: activity.id,
            createdAt: activity.createdAt,
            summary: activity.summary,
            detail: activityDetail(activity),
            status: activityStatus(activity),
          },
        })),
    ],
    compareFeedEntries,
  );

  return groupAdjacentActivities(entries);
}
