import {
  ApprovalRequestId,
  type OrchestrationQueuedFollowUp,
  type OrchestrationQueuedTerminalContext,
  type OrchestrationSession,
  type OrchestrationThreadActivity,
  type UserInputQuestion,
} from "@t3tools/contracts";

export interface DerivedPendingApproval {
  requestId: ApprovalRequestId;
  requestKind: "command" | "file-read" | "file-change";
  createdAt: string;
  detail?: string;
}

export interface DerivedPendingUserInput {
  requestId: ApprovalRequestId;
  createdAt: string;
  questions: ReadonlyArray<UserInputQuestion>;
}

export const IMAGE_ONLY_BOOTSTRAP_PROMPT =
  "[User attached one or more images without additional text. Respond using the conversation context and the attached image(s).]";

export function requestKindFromRequestType(
  requestType: unknown,
): DerivedPendingApproval["requestKind"] | null {
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

  const createdAtComparison = left.createdAt.localeCompare(right.createdAt);
  if (createdAtComparison !== 0) {
    return createdAtComparison;
  }

  return left.id.localeCompare(right.id);
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
          const optionRecord = option as Record<string, unknown>;
          if (
            typeof optionRecord.label !== "string" ||
            typeof optionRecord.description !== "string"
          ) {
            return null;
          }
          return {
            label: optionRecord.label,
            description: optionRecord.description,
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

export function derivePendingApprovals(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): DerivedPendingApproval[] {
  const openByRequestId = new Map<ApprovalRequestId, DerivedPendingApproval>();
  const ordered = [...activities].toSorted(compareActivitiesByOrder);

  for (const activity of ordered) {
    const payload =
      activity.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : null;
    const requestId =
      payload && typeof payload.requestId === "string"
        ? ApprovalRequestId.makeUnsafe(payload.requestId)
        : null;
    const requestKind =
      payload &&
      (payload.requestKind === "command" ||
        payload.requestKind === "file-read" ||
        payload.requestKind === "file-change")
        ? payload.requestKind
        : payload
          ? requestKindFromRequestType(payload.requestType)
          : null;
    const detail = payload && typeof payload.detail === "string" ? payload.detail : undefined;

    if (activity.kind === "approval.requested" && requestId && requestKind) {
      openByRequestId.set(requestId, {
        requestId,
        requestKind,
        createdAt: activity.createdAt,
        ...(detail ? { detail } : {}),
      });
      continue;
    }

    if (activity.kind === "approval.resolved" && requestId) {
      openByRequestId.delete(requestId);
      continue;
    }

    if (
      activity.kind === "provider.approval.respond.failed" &&
      requestId &&
      isStalePendingRequestFailureDetail(detail)
    ) {
      openByRequestId.delete(requestId);
    }
  }

  return [...openByRequestId.values()].toSorted((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
}

export function derivePendingUserInputs(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): DerivedPendingUserInput[] {
  const openByRequestId = new Map<ApprovalRequestId, DerivedPendingUserInput>();
  const ordered = [...activities].toSorted(compareActivitiesByOrder);

  for (const activity of ordered) {
    const payload =
      activity.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : null;
    const requestId =
      payload && typeof payload.requestId === "string"
        ? ApprovalRequestId.makeUnsafe(payload.requestId)
        : null;
    const detail = payload && typeof payload.detail === "string" ? payload.detail : undefined;

    if (activity.kind === "user-input.requested" && requestId) {
      const questions = parseUserInputQuestions(payload);
      if (!questions) {
        continue;
      }
      openByRequestId.set(requestId, {
        requestId,
        createdAt: activity.createdAt,
        questions,
      });
      continue;
    }

    if (activity.kind === "user-input.resolved" && requestId) {
      openByRequestId.delete(requestId);
      continue;
    }

    if (
      activity.kind === "provider.user-input.respond.failed" &&
      requestId &&
      isStalePendingRequestFailureDetail(detail)
    ) {
      openByRequestId.delete(requestId);
    }
  }

  return [...openByRequestId.values()].toSorted((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
}

export function canDispatchQueuedFollowUp(input: {
  session: Pick<OrchestrationSession, "status" | "lastError"> | null;
  activities: ReadonlyArray<OrchestrationThreadActivity>;
  queuedFollowUpCount: number;
  queuedHeadHasError: boolean;
}): boolean {
  if (input.queuedFollowUpCount === 0 || input.queuedHeadHasError) {
    return false;
  }
  if (input.session?.status === "starting" || input.session?.status === "running") {
    return false;
  }
  if (input.session?.lastError) {
    return false;
  }
  if (derivePendingApprovals(input.activities).length > 0) {
    return false;
  }
  if (derivePendingUserInputs(input.activities).length > 0) {
    return false;
  }
  return true;
}

function normalizeQueuedTerminalContextText(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/^\n+|\n+$/g, "");
}

function formatQueuedTerminalContextRange(
  context: Pick<OrchestrationQueuedTerminalContext, "lineStart" | "lineEnd">,
): string {
  return context.lineStart === context.lineEnd
    ? `line ${context.lineStart}`
    : `lines ${context.lineStart}-${context.lineEnd}`;
}

function formatQueuedTerminalContextLabel(
  context: Pick<OrchestrationQueuedTerminalContext, "terminalLabel" | "lineStart" | "lineEnd">,
): string {
  return `${context.terminalLabel} ${formatQueuedTerminalContextRange(context)}`;
}

function buildQueuedTerminalContextBlock(
  contexts: ReadonlyArray<OrchestrationQueuedFollowUp["terminalContexts"][number]>,
): string {
  if (contexts.length === 0) {
    return "";
  }

  const lines: string[] = [];
  for (let index = 0; index < contexts.length; index += 1) {
    const context = contexts[index];
    if (!context) {
      continue;
    }
    const normalizedText = normalizeQueuedTerminalContextText(context.text);
    if (normalizedText.length === 0) {
      continue;
    }
    lines.push(`- ${formatQueuedTerminalContextLabel(context)}:`);
    const bodyLines = normalizedText
      .split("\n")
      .map((line, lineIndex) => `  ${context.lineStart + lineIndex} | ${line}`);
    lines.push(...bodyLines);
    if (index < contexts.length - 1) {
      lines.push("");
    }
  }

  return lines.length > 0 ? ["<terminal_context>", ...lines, "</terminal_context>"].join("\n") : "";
}

export function buildQueuedFollowUpMessageText(input: {
  prompt: string;
  terminalContexts: ReadonlyArray<OrchestrationQueuedFollowUp["terminalContexts"][number]>;
  attachmentCount: number;
}): string {
  const trimmedPrompt = input.prompt.trim();
  const contextBlock = buildQueuedTerminalContextBlock(input.terminalContexts);
  const materializedPrompt =
    contextBlock.length > 0
      ? trimmedPrompt.length > 0
        ? `${trimmedPrompt}\n\n${contextBlock}`
        : contextBlock
      : trimmedPrompt;

  if (materializedPrompt.length > 0) {
    return materializedPrompt;
  }

  return input.attachmentCount > 0 ? IMAGE_ONLY_BOOTSTRAP_PROMPT : "";
}
