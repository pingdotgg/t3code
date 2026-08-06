import type { OrchestrationThread } from "@t3tools/contracts";

const ENTRY_LIMIT = 520;
const CONTEXT_LIMIT = 8_000;

function collapse(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function cap(value: string): string {
  const normalized = collapse(value);
  return normalized.length <= ENTRY_LIMIT
    ? normalized
    : `${normalized.slice(0, ENTRY_LIMIT - 1).trimEnd()}…`;
}

/**
 * Build a small chronological activity digest for subtitle generation.
 * Full thread history never leaves the projection query: only recent message
 * prose, attachment names, and already-summarized activity labels are kept.
 */
export function formatThreadSubtitleContext(
  thread: Pick<OrchestrationThread, "messages" | "activities">,
): string {
  // Projection collections are chronological. Bound the candidates before
  // allocating or sorting so subtitle generation stays cheap on long-lived
  // threads with thousands of messages and activities.
  const messageEntries = thread.messages.slice(-24).flatMap((message) => {
    if (message.role === "system" || message.streaming) return [];
    const text = cap(message.text);
    const attachments = (message.attachments ?? []).map((attachment) => attachment.name).join(", ");
    if (!text && !attachments) return [];
    return [
      {
        createdAt: message.createdAt,
        value: `${message.role.toUpperCase()}: ${[
          text,
          attachments ? `attachments: ${attachments}` : "",
        ]
          .filter(Boolean)
          .join(" · ")}`,
      },
    ];
  });
  const activityEntries = thread.activities.slice(-24).flatMap((activity) => {
    const summary = cap(activity.summary);
    return summary
      ? [{ createdAt: activity.createdAt, value: `ACTIVITY: ${activity.kind} · ${summary}` }]
      : [];
  });
  const entries = [...messageEntries, ...activityEntries]
    .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt))
    .slice(-14);

  let context = "";
  for (const entry of entries.toReversed()) {
    const next = context ? `${entry.value}\n${context}` : entry.value;
    if (next.length > CONTEXT_LIMIT) break;
    context = next;
  }
  return context;
}
