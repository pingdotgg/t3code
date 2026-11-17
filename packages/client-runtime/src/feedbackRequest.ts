import type { AgentFeedbackPreview, OrchestrationV2TurnItem } from "@t3tools/contracts";

export type FeedbackRequestItem = Extract<
  OrchestrationV2TurnItem,
  { readonly type: "feedback_request" }
>;

export type FeedbackRequestDisplay =
  | { readonly kind: "pending" }
  /** Inherited by a fork: only the thread that asked can answer it. */
  | { readonly kind: "pending-elsewhere"; readonly label: string }
  | { readonly kind: "answered"; readonly outcome: "sent" | "not-sent"; readonly label: string };

export function feedbackRequestDisplay(
  item: Pick<FeedbackRequestItem, "feedbackStatus">,
  visibility: "local" | "inherited" | "synthetic",
): FeedbackRequestDisplay {
  switch (item.feedbackStatus) {
    case "pending":
      return visibility === "local"
        ? { kind: "pending" }
        : { kind: "pending-elsewhere", label: "Waiting in the original thread" };
    case "sent":
      return { kind: "answered", outcome: "sent", label: "Sent" };
    case "declined":
      return { kind: "answered", outcome: "not-sent", label: "Not sent" };
    case "cancelled":
      return { kind: "answered", outcome: "not-sent", label: "Closed without sending" };
  }
}

const KIND_LABELS: Record<AgentFeedbackPreview["kind"], string> = {
  bug: "Bug",
  confusing: "Confusing",
  missing_capability: "Missing capability",
  wrong_docs: "Wrong docs",
  other: "Other",
};

/** The report's fields in reading order, the empty workaround left out. */
export function feedbackPreviewFields(
  preview: AgentFeedbackPreview,
): ReadonlyArray<{ readonly label: string; readonly value: string }> {
  return [
    { label: "Kind", value: KIND_LABELS[preview.kind] },
    { label: "About", value: preview.subject },
    { label: "Expected", value: preview.expected },
    { label: "Happened", value: preview.actual },
    { label: "Did instead", value: preview.workaround },
  ].filter((field) => field.value !== "");
}

const seconds = (ms: number) => `${(ms / 1_000).toFixed(ms < 10_000 ? 1 : 0)} s`;

/** One line per outline entry, plus the message text that goes with it. */
export function feedbackTraceLines(
  trace: NonNullable<AgentFeedbackPreview["trace"]>,
): ReadonlyArray<{ readonly key: string; readonly line: string; readonly text?: string }> {
  return trace.entries.map((entry, index) => {
    const what =
      entry.type === "tool"
        ? [
            entry.tool ?? "tool",
            entry.outcome,
            entry.durationMs === undefined ? undefined : seconds(entry.durationMs),
          ]
            .filter((part) => part !== undefined)
            .join(" · ")
        : `${entry.type === "user" ? "You" : "Agent"} · ${entry.length ?? 0} characters`;
    return {
      key: `${index}`,
      line: `Turn ${entry.turn} · ${what}`,
      ...(entry.text === undefined ? {} : { text: entry.text }),
    };
  });
}

/** What the outline holds, in one line. */
export function feedbackTraceSummary(trace: NonNullable<AgentFeedbackPreview["trace"]>): string {
  const turns = `${trace.turns} recent ${trace.turns === 1 ? "turn" : "turns"}`;
  const text =
    trace.textTurns === 0
      ? "no message text"
      : `message text of the last ${trace.textTurns === 1 ? "turn" : `${trace.textTurns} turns`}`;
  return `Outline of ${turns}, ${text}${trace.truncated ? ", shortened to fit" : ""}`;
}

/** The server's own message for a failed answer, else a generic one. */
export function feedbackRequestFailureMessage(failure: unknown): string {
  return typeof failure === "object" &&
    failure !== null &&
    "_tag" in failure &&
    failure._tag === "AgentFeedbackRequestError" &&
    "message" in failure &&
    typeof failure.message === "string"
    ? failure.message
    : "Could not send your answer. Try again.";
}
