import type { OrchestrationMessage, OrchestrationThreadActivity, TurnId } from "@t3tools/contracts";

export interface TurnActivityTraceEntry {
  readonly id: string;
  readonly createdAt: string;
  readonly kind: string;
  readonly summary: string;
  readonly detail: string | null;
  readonly tone: "info" | "tool" | "approval" | "error" | "assistant";
}

export interface TurnActivityTrace {
  readonly turnId: TurnId | null;
  readonly entries: ReadonlyArray<TurnActivityTraceEntry>;
  readonly providerEventCount: number;
  readonly toolCallCount: number;
  readonly lastFeedbackAt: string | null;
}

export type TurnActivityAssistantMessage = Pick<
  OrchestrationMessage,
  "id" | "role" | "text" | "turnId" | "streaming" | "updatedAt"
>;

function parseTimestamp(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function itemFallsWithinActiveTurn(input: {
  readonly itemTurnId: TurnId | null;
  readonly activeTurnId: TurnId | null;
  readonly createdAt: string;
  readonly activeTurnStartedAt: string | null;
}): boolean {
  if (
    input.activeTurnId !== null &&
    input.itemTurnId !== null &&
    input.itemTurnId !== input.activeTurnId
  ) {
    return false;
  }
  if (input.activeTurnId !== null && input.itemTurnId === input.activeTurnId) {
    return true;
  }
  if (input.activeTurnStartedAt === null) {
    return false;
  }
  const itemCreatedAt = parseTimestamp(input.createdAt);
  const turnStartedAt = parseTimestamp(input.activeTurnStartedAt);
  return itemCreatedAt !== null && turnStartedAt !== null && itemCreatedAt >= turnStartedAt;
}

function compactTraceText(value: string, maxLength = 320): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) {
    return compact;
  }
  return `${compact.slice(0, maxLength - 1).trimEnd()}…`;
}

function extractActivityDetail(activity: OrchestrationThreadActivity): string | null {
  const payload =
    activity.payload && typeof activity.payload === "object"
      ? (activity.payload as Record<string, unknown>)
      : null;
  if (!payload) {
    return null;
  }

  // Keep this projection deliberately bounded. In particular, do not stringify
  // arbitrary provider payloads: they can be large and are often not useful in
  // an on-demand waiting-state diagnostic.
  const candidates = [payload.detail, payload.command, payload.title, payload.status];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") {
      continue;
    }
    const detail = compactTraceText(candidate);
    if (detail.length > 0 && detail !== activity.summary) {
      return detail;
    }
  }
  return null;
}

/**
 * Builds an on-demand diagnostic view for a live turn from the raw activity
 * projection. This deliberately includes lifecycle events omitted from the
 * normal work log while keeping arbitrary provider payloads out of the result.
 */
export function deriveTurnActivityTrace(input: {
  readonly threadActivities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly assistantMessages: ReadonlyArray<TurnActivityAssistantMessage>;
  readonly activeTurnId: TurnId | null;
  readonly activeTurnStartedAt: string | null;
}): TurnActivityTrace {
  const activityEntries = input.threadActivities
    .filter((activity) =>
      itemFallsWithinActiveTurn({
        itemTurnId: activity.turnId,
        activeTurnId: input.activeTurnId,
        createdAt: activity.createdAt,
        activeTurnStartedAt: input.activeTurnStartedAt,
      }),
    )
    .map(
      (activity): TurnActivityTraceEntry => ({
        id: activity.id,
        createdAt: activity.createdAt,
        kind: activity.kind,
        summary: activity.summary,
        detail: extractActivityDetail(activity),
        tone: activity.tone,
      }),
    );
  const assistantEntries = input.assistantMessages.flatMap((message): TurnActivityTraceEntry[] => {
    if (
      message.role !== "assistant" ||
      !itemFallsWithinActiveTurn({
        itemTurnId: message.turnId,
        activeTurnId: input.activeTurnId,
        createdAt: message.updatedAt,
        activeTurnStartedAt: input.activeTurnStartedAt,
      })
    ) {
      return [];
    }
    const detail = compactTraceText(message.text);
    return [
      {
        id: `assistant-feedback:${message.id}`,
        createdAt: message.updatedAt,
        kind: message.streaming ? "assistant.streaming" : "assistant.updated",
        summary: message.streaming ? "Assistant update streaming" : "Assistant update",
        detail: detail.length > 0 ? detail : null,
        tone: "assistant",
      },
    ];
  });
  const entries = [...activityEntries, ...assistantEntries].toSorted(
    (left, right) =>
      right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
  );

  return {
    turnId: input.activeTurnId,
    entries,
    providerEventCount: activityEntries.length,
    toolCallCount: activityEntries.filter((entry) => entry.kind === "tool.started").length,
    lastFeedbackAt: entries[0]?.createdAt ?? null,
  };
}
