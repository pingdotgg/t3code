import type { MessageId } from "./baseSchemas.ts";
import type { OrchestrationMessage, OrchestrationThread } from "./orchestration.ts";

// Session adoption takes seconds; an unadopted message beyond this grace is a
// failed/stale start, not pending work. Keep this aligned with client-runtime's
// QUEUED_TURN_START_GRACE_MS in threadSettled.ts.
const QUEUED_TURN_START_GRACE_MS = 2 * 60 * 1_000;
const CORRECTION_PROMPT_PREFIX =
  "Correction to my previous request. Treat the following as the complete replacement for that request:";
const T3_PROMPT_PREFIXES = ["Ultrathink:\n"] as const;
const STRUCTURED_CONTEXT_BOUNDARY =
  /(?:^|\n\n)(?=<(?:terminal_context|element_context|preview_annotation|review_comment)(?:\s|>))/u;

export interface EditableUserMessageParts {
  readonly prefix: string;
  readonly editableText: string;
  readonly suffix: string;
}

export function splitEditableUserMessage(messageText: string): EditableUserMessageParts {
  const prefix = T3_PROMPT_PREFIXES.find((candidate) => messageText.startsWith(candidate)) ?? "";
  const withoutPrefix = messageText.slice(prefix.length);
  const boundary = STRUCTURED_CONTEXT_BOUNDARY.exec(withoutPrefix);
  const suffixStart = boundary?.index ?? withoutPrefix.length;
  return {
    prefix,
    editableText: withoutPrefix.slice(0, suffixStart),
    suffix: withoutPrefix.slice(suffixStart),
  };
}

export function replaceEditableUserText(messageText: string, replacementText: string): string {
  const parts = splitEditableUserMessage(messageText);
  const contextSeparator =
    parts.editableText.length === 0 && parts.suffix.length > 0 && !parts.suffix.startsWith("\n")
      ? "\n\n"
      : "";
  return `${parts.prefix}${replacementText.trim()}${contextSeparator}${parts.suffix}`;
}

export function isCorrectionMessage(message: { readonly correction?: unknown }): boolean {
  return message.correction !== undefined;
}

export function buildThreadMessageCorrectionProviderText(replacementText: string): string {
  return `${CORRECTION_PROMPT_PREFIX}\n\n${replacementText}`;
}

export function applyThreadMessageCorrection(
  messages: ReadonlyArray<OrchestrationMessage>,
  correction: {
    readonly targetMessageId: MessageId;
    readonly correctionMessageId: MessageId;
    readonly replacementText: string;
    readonly providerText: string;
    readonly createdAt: string;
    readonly updatedAt: string;
  },
): ReadonlyArray<OrchestrationMessage> {
  const target = messages.find((message) => message.id === correction.targetMessageId);
  if (target === undefined) {
    return messages;
  }

  const nextMessages = messages.map((message) =>
    message.id === target.id
      ? {
          ...message,
          text: correction.replacementText,
          originalText: message.originalText ?? message.text,
          updatedAt: correction.updatedAt,
        }
      : message,
  );
  if (nextMessages.some((message) => message.id === correction.correctionMessageId)) {
    return nextMessages;
  }
  return [
    ...nextMessages,
    {
      id: correction.correctionMessageId,
      role: "user",
      text: correction.providerText,
      correction: {
        targetMessageId: correction.targetMessageId,
        replacementText: correction.replacementText,
      },
      turnId: null,
      streaming: false,
      createdAt: correction.createdAt,
      updatedAt: correction.updatedAt,
    },
  ];
}

export function reconcileThreadMessageCorrections(
  messages: ReadonlyArray<OrchestrationMessage>,
): ReadonlyArray<OrchestrationMessage> {
  const latestCorrectionByTarget = new Map<MessageId, OrchestrationMessage>();
  for (const message of messages) {
    if (!isCorrectionMessage(message)) continue;
    const targetMessageId = message.correction?.targetMessageId;
    if (targetMessageId === undefined) continue;
    const existing = latestCorrectionByTarget.get(targetMessageId);
    if (
      existing === undefined ||
      existing.createdAt < message.createdAt ||
      (existing.createdAt === message.createdAt && existing.id < message.id)
    ) {
      latestCorrectionByTarget.set(targetMessageId, message);
    }
  }

  return messages.map((message) => {
    if (message.originalText === undefined) return message;
    const latestCorrection = latestCorrectionByTarget.get(message.id);
    if (latestCorrection?.correction !== undefined) {
      return {
        ...message,
        text: latestCorrection.correction.replacementText,
        updatedAt: latestCorrection.updatedAt,
      };
    }
    const { originalText, ...restored } = message;
    return {
      ...restored,
      text: originalText,
      updatedAt: message.createdAt,
    };
  });
}

export function getLastVisibleUserMessage(
  messages: ReadonlyArray<OrchestrationMessage>,
): OrchestrationMessage | undefined {
  return messages.findLast((message) => message.role === "user" && !isCorrectionMessage(message));
}

export function deriveRevertTurnCountByUserMessageId(
  thread: Pick<OrchestrationThread, "messages" | "checkpoints">,
): ReadonlyMap<MessageId, number> {
  const checkpointTurnCountByAssistantMessageId = new Map<MessageId, number>();
  for (const checkpoint of thread.checkpoints) {
    if (
      checkpoint.status === "ready" &&
      checkpoint.checkpointRef !== null &&
      checkpoint.assistantMessageId !== null
    ) {
      checkpointTurnCountByAssistantMessageId.set(
        checkpoint.assistantMessageId,
        checkpoint.checkpointTurnCount,
      );
    }
  }

  const result = new Map<MessageId, number>();
  const visibleMessages = thread.messages.filter((message) => !isCorrectionMessage(message));
  for (let index = 0; index < visibleMessages.length; index += 1) {
    const message = visibleMessages[index];
    if (message?.role !== "user") continue;
    for (let nextIndex = index + 1; nextIndex < visibleMessages.length; nextIndex += 1) {
      const nextMessage = visibleMessages[nextIndex];
      if (nextMessage?.role === "user") break;
      if (nextMessage?.role !== "assistant") continue;
      const checkpointTurnCount = checkpointTurnCountByAssistantMessageId.get(nextMessage.id);
      if (checkpointTurnCount !== undefined) {
        result.set(message.id, Math.max(0, checkpointTurnCount - 1));
        break;
      }
    }
  }
  return result;
}

function isStaleRequestFailureDetail(payload: Record<string, unknown> | null): boolean {
  const detail = typeof payload?.detail === "string" ? payload.detail.toLowerCase() : null;
  if (detail === null) return false;
  return (
    detail.includes("stale pending approval request") ||
    detail.includes("unknown pending approval request") ||
    detail.includes("unknown pending permission request") ||
    detail.includes("stale pending user-input request") ||
    detail.includes("unknown pending user-input request") ||
    detail.includes("unknown pending user input request") ||
    detail.includes("unknown pending codex user input request")
  );
}

export function threadHasOpenBlockingRequest(
  thread: Pick<OrchestrationThread, "activities">,
): boolean {
  // The read model caps this stream at 500. An unresolved request blocks its
  // turn, so it cannot scroll out while hundreds of later activities accrue.
  const openRequestIds = new Set<string>();
  for (const activity of thread.activities) {
    const payload =
      typeof activity.payload === "object" && activity.payload !== null
        ? (activity.payload as Record<string, unknown>)
        : null;
    const requestId = typeof payload?.requestId === "string" ? payload.requestId : null;
    if (requestId === null) continue;
    if (activity.kind === "approval.requested" || activity.kind === "user-input.requested") {
      openRequestIds.add(requestId);
    } else if (activity.kind === "approval.resolved" || activity.kind === "user-input.resolved") {
      openRequestIds.delete(requestId);
    } else if (
      (activity.kind === "provider.approval.respond.failed" ||
        activity.kind === "provider.user-input.respond.failed") &&
      isStaleRequestFailureDetail(payload)
    ) {
      openRequestIds.delete(requestId);
    }
  }
  return openRequestIds.size > 0;
}

export function threadHasQueuedTurnStart(
  thread: Pick<OrchestrationThread, "messages" | "latestTurn" | "session">,
  occurredAt: string,
): boolean {
  const latestUserMessageAtMs = thread.messages.reduce(
    (latest, message) =>
      message.role === "user" ? Math.max(latest, Date.parse(message.createdAt)) : latest,
    Number.NEGATIVE_INFINITY,
  );
  const latestTurnAtMs =
    thread.latestTurn === null
      ? Number.NEGATIVE_INFINITY
      : Math.max(
          ...[
            thread.latestTurn.requestedAt,
            thread.latestTurn.startedAt,
            thread.latestTurn.completedAt,
          ].map((candidate) =>
            candidate == null ? Number.NEGATIVE_INFINITY : Date.parse(candidate),
          ),
        );
  const queuedAgeMs = Date.parse(occurredAt) - latestUserMessageAtMs;
  // Client timestamps can be ahead of the server. Bounding both directions
  // prevents clock skew from extending this grace window indefinitely.
  return (
    thread.session?.status !== "error" &&
    Number.isFinite(latestUserMessageAtMs) &&
    latestUserMessageAtMs > latestTurnAtMs &&
    Math.abs(queuedAgeMs) <= QUEUED_TURN_START_GRACE_MS
  );
}

export type ThreadMessageCorrectionRejectionReason =
  | "target-missing"
  | "target-not-visible-user-message"
  | "target-not-last-visible-user-message"
  | "target-has-revert"
  | "thread-archived"
  | "session-active"
  | "queued-turn-start"
  | "blocking-request"
  | "replacement-empty"
  | "replacement-unchanged";

export type ThreadMessageCorrectionEligibility =
  | { readonly eligible: true }
  | {
      readonly eligible: false;
      readonly reason: ThreadMessageCorrectionRejectionReason;
      readonly detail: string;
    };

const rejectCorrection = (
  reason: ThreadMessageCorrectionRejectionReason,
  detail: string,
): ThreadMessageCorrectionEligibility => ({ eligible: false, reason, detail });

export function getThreadMessageCorrectionEligibility(input: {
  readonly thread: OrchestrationThread;
  readonly targetMessageId: MessageId;
  readonly occurredAt: string;
  readonly replacementText?: string;
  readonly revertTurnCountByUserMessageId?: ReadonlyMap<MessageId, number>;
}): ThreadMessageCorrectionEligibility {
  const target = input.thread.messages.find((message) => message.id === input.targetMessageId);
  if (target === undefined) {
    return rejectCorrection("target-missing", "The message no longer exists.");
  }
  if (target.role !== "user" || isCorrectionMessage(target)) {
    return rejectCorrection(
      "target-not-visible-user-message",
      "Only a visible user message can be edited.",
    );
  }
  if (getLastVisibleUserMessage(input.thread.messages)?.id !== target.id) {
    return rejectCorrection(
      "target-not-last-visible-user-message",
      "A newer user message has already been sent.",
    );
  }
  if (input.thread.archivedAt !== null) {
    return rejectCorrection("thread-archived", "Archived threads cannot be edited.");
  }
  if (input.thread.session?.status === "starting" || input.thread.session?.status === "running") {
    return rejectCorrection("session-active", "Wait for the current turn to finish.");
  }
  if (threadHasQueuedTurnStart(input.thread, input.occurredAt)) {
    return rejectCorrection("queued-turn-start", "Wait for the queued turn to start.");
  }
  if (threadHasOpenBlockingRequest(input.thread)) {
    return rejectCorrection(
      "blocking-request",
      "Resolve the pending approval or question before editing.",
    );
  }
  const revertTurnCountByUserMessageId =
    input.revertTurnCountByUserMessageId ?? deriveRevertTurnCountByUserMessageId(input.thread);
  if (revertTurnCountByUserMessageId.has(target.id)) {
    return rejectCorrection(
      "target-has-revert",
      "Revert is available for this message instead of Edit.",
    );
  }
  if (input.replacementText !== undefined) {
    if (input.replacementText.trim().length === 0) {
      return rejectCorrection("replacement-empty", "The replacement message cannot be empty.");
    }
    if (input.replacementText.trim() === target.text.trim()) {
      return rejectCorrection("replacement-unchanged", "The replacement message is unchanged.");
    }
  }
  return { eligible: true };
}
