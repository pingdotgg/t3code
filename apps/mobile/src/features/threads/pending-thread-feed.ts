import type { ThreadFeedEntry } from "../../lib/threadActivity";
import type { QueuedThreadMessage } from "../../state/thread-outbox-model";

export type PendingThreadFeedEntry = ThreadFeedEntry & {
  readonly pendingMessage?: QueuedThreadMessage;
  readonly acknowledged?: boolean;
};

/** Append the outbox after all presented activity, until the server echoes each message. */
export function appendPendingThreadMessages(
  presentedFeed: ReadonlyArray<ThreadFeedEntry>,
  feed: ReadonlyArray<ThreadFeedEntry>,
  queuedMessages: ReadonlyArray<QueuedThreadMessage>,
): ReadonlyArray<PendingThreadFeedEntry> {
  if (queuedMessages.length === 0) return presentedFeed;
  const deliveredIds = new Set(
    feed.flatMap((entry) => (entry.type === "message" ? [entry.message.id] : [])),
  );
  return [
    ...presentedFeed,
    ...queuedMessages
      .filter((message) => !deliveredIds.has(message.messageId))
      .map((pendingMessage): PendingThreadFeedEntry => ({
        type: "message",
        id: pendingMessage.messageId,
        createdAt: pendingMessage.createdAt,
        pendingMessage,
        message: {
          id: pendingMessage.messageId,
          role: "user",
          text: pendingMessage.text,
          createdAt: pendingMessage.createdAt,
          updatedAt: pendingMessage.createdAt,
          turnId: null,
          streaming: false,
        },
      })),
  ];
}
