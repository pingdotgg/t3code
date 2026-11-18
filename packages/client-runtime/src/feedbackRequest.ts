import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";
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
  resolve: MFunctionType = mFallback,
): FeedbackRequestDisplay {
  switch (item.feedbackStatus) {
    case "pending":
      return visibility === "local"
        ? { kind: "pending" }
        : { kind: "pending-elsewhere", label: resolve(msg("Waiting in the original thread")) };
    case "sent":
      return { kind: "answered", outcome: "sent", label: resolve(msg("Sent")) };
    case "declined":
      return { kind: "answered", outcome: "not-sent", label: resolve(msg("Not sent")) };
    case "cancelled":
      return {
        kind: "answered",
        outcome: "not-sent",
        label: resolve(msg("Closed without sending")),
      };
  }
}

const KIND_LABELS: Record<AgentFeedbackPreview["kind"], string> = {
  bug: msg("Bug"),
  confusing: msg("Confusing"),
  missing_capability: msg("Missing capability"),
  wrong_docs: msg("Wrong docs"),
  other: msg("Other"),
};

/** The report's fields in reading order, the empty workaround left out. */
export function feedbackPreviewFields(
  preview: AgentFeedbackPreview,
  resolve: MFunctionType = mFallback,
): ReadonlyArray<{ readonly label: string; readonly value: string }> {
  return [
    { label: resolve(msg("Kind")), value: resolve(KIND_LABELS[preview.kind]) },
    { label: resolve(msg("About")), value: preview.subject },
    { label: resolve(msg("Expected")), value: preview.expected },
    { label: resolve(msg("Happened")), value: preview.actual },
    { label: resolve(msg("Did instead")), value: preview.workaround },
  ].filter((field) => field.value !== "");
}

const seconds = (ms: number) => `${(ms / 1_000).toFixed(ms < 10_000 ? 1 : 0)} s`;

/** One line per outline entry, plus the message text that goes with it. */
export function feedbackTraceLines(
  trace: NonNullable<AgentFeedbackPreview["trace"]>,
  resolve: MFunctionType = mFallback,
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
        : resolve(
            msg("{speaker} · {count} characters", {
              speaker: resolve(entry.type === "user" ? msg("You") : msg("Agent")),
              count: entry.length ?? 0,
            }),
          );
    return {
      key: `${index}`,
      line: resolve(msg("Turn {turn} · {what}", { turn: entry.turn, what })),
      ...(entry.text === undefined ? {} : { text: entry.text }),
    };
  });
}

/** What the outline holds, in one line. */
export function feedbackTraceSummary(
  trace: NonNullable<AgentFeedbackPreview["trace"]>,
  resolve: MFunctionType = mFallback,
): string {
  return resolve(
    msg(
      "Outline of {turns, plural, one {{turns} recent turn} other {{turns} recent turns}}, {textTurns, plural, =0 {no message text} one {message text of the last turn} other {message text of the last {textTurns} turns}}{truncated, select, yes {, shortened to fit} other {}}",
      { turns: trace.turns, textTurns: trace.textTurns, truncated: trace.truncated ? "yes" : "no" },
    ),
  );
}

/** The server's own message for a failed answer, else a generic one. */
export function feedbackRequestFailureMessage(
  failure: unknown,
  resolve: MFunctionType = mFallback,
): string {
  return typeof failure === "object" &&
    failure !== null &&
    "_tag" in failure &&
    failure._tag === "AgentFeedbackRequestError" &&
    "message" in failure &&
    typeof failure.message === "string"
    ? failure.message
    : resolve(msg("Could not send your answer. Try again."));
}
