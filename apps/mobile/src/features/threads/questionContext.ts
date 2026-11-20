import type { MessageId } from "@t3tools/contracts";

import type { ThreadFeedActivity, ThreadFeedEntry } from "../../lib/threadActivity";

/** The text the agent wrote last, before a question, among the given assistant messages. */
export function questionContextMarkdown(
  feed: ReadonlyArray<ThreadFeedEntry>,
  messageIds: ReadonlyArray<MessageId> | undefined,
): string | undefined {
  if (!messageIds || messageIds.length === 0) return undefined;
  const textById = new Map<string, string>();
  for (const entry of feed) {
    if (entry.type === "message" && entry.message.role === "assistant") {
      textById.set(entry.message.id, entry.message.text);
    }
  }
  for (let index = messageIds.length - 1; index >= 0; index -= 1) {
    const text = textById.get(messageIds[index]!)?.trim();
    if (text) return text;
  }
  return undefined;
}

/**
 * The feed without the grey summary row of the question the panel is asking: the panel shows the
 * question itself, so the row would say it twice. An answered question keeps its row.
 */
export function feedWithoutOpenQuestionRow(
  feed: ReadonlyArray<ThreadFeedEntry>,
  openRequestId: string | null,
): ReadonlyArray<ThreadFeedEntry> {
  if (openRequestId === null) return feed;
  const isOpenRow = (activity: ThreadFeedActivity) => {
    const item = activity.workEntry.structuredPayload;
    return (
      item?.type === "user_input_request" &&
      item.requestId === openRequestId &&
      !item.questionAnswer
    );
  };
  let changed = false;
  const next = feed.flatMap((entry): ThreadFeedEntry[] => {
    if (entry.type !== "activity-group" || !entry.activities.some(isOpenRow)) return [entry];
    changed = true;
    const activities = entry.activities.filter((activity) => !isOpenRow(activity));
    return activities.length === 0 ? [] : [{ ...entry, activities }];
  });
  return changed ? next : feed;
}
