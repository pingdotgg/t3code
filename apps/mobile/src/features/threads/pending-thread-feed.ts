import type { QueuedThreadRun } from "@t3tools/client-runtime/state/thread-workflows";
import {
  isCompactionCommandMessage,
  type ThreadGuestMessage,
  type ThreadGuestShare,
} from "@t3tools/contracts";
import { DateTime } from "effect";
import type { ThreadFeedEntry } from "../../lib/threadActivity";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { threadHasCaughtUpTo } from "@t3tools/client-runtime/state/threads";
import type {
  AcknowledgedThreadMessage,
  QueuedThreadMessage,
} from "../../state/thread-outbox-model";

/**
 * A guest's message waiting for the owner's Send or Dismiss. It is a feed row, not the list
 * footer, so the feed follows it arriving and leaving the way it follows any row.
 */
export interface GuestPendingFeedEntry {
  readonly type: "guest-pending";
  readonly id: string;
  readonly createdAt: string;
  readonly guestName: string;
  readonly message: ThreadGuestMessage;
}

export type PendingThreadFeedEntry = ThreadFeedEntry & {
  readonly pendingMessage?: QueuedThreadMessage;
  readonly acknowledged?: boolean;
  /** The server accepted it; its run has not started, so no turn item shows it yet. */
  readonly queued?: true;
};

// An acknowledged row stops being pending once the thread catches up to it,
// even when the feed hides that message (a rolled-back or cancelled run).
export function selectPendingAcknowledgedMessages(
  acknowledged: ReadonlyArray<AcknowledgedThreadMessage>,
  thread: {
    readonly threadKey: string | null;
    readonly queuedMessages: ReadonlyArray<QueuedThreadMessage>;
    readonly sequence: number;
    readonly projectedMessages: ReadonlyArray<{ readonly id: string }> | undefined;
  },
): ReadonlyArray<AcknowledgedThreadMessage> {
  return acknowledged.filter(
    (message) =>
      scopedThreadKey(message.environmentId, message.threadId) === thread.threadKey &&
      !thread.queuedMessages.some((queued) => queued.messageId === message.messageId) &&
      !threadHasCaughtUpTo(message, {
        sequence: thread.sequence,
        messages: thread.projectedMessages,
      }),
  );
}

/** A row of the thread feed's list. */
export type ThreadFeedRow = PendingThreadFeedEntry | GuestPendingFeedEntry;

/** Waiting guest messages go after the transcript, oldest first. */
export function appendGuestPendingMessages(
  presentedFeed: ReadonlyArray<PendingThreadFeedEntry>,
  share: ThreadGuestShare | null,
): ReadonlyArray<ThreadFeedRow> {
  const pending = share?.messages.filter((message) => message.status === "pending") ?? [];
  if (share === null || pending.length === 0) return presentedFeed;
  const guestName = share.guestName ?? "Guest";
  return [
    ...presentedFeed,
    ...pending.map((message): GuestPendingFeedEntry => ({
      type: "guest-pending",
      id: `guest-pending:${message.id}`,
      createdAt: message.submittedAt,
      guestName,
      message,
    })),
  ];
}

export function appendPendingThreadMessages(
  presentedFeed: ReadonlyArray<ThreadFeedEntry>,
  feed: ReadonlyArray<ThreadFeedEntry>,
  queuedMessages: ReadonlyArray<QueuedThreadMessage>,
  queuedRuns: ReadonlyArray<QueuedThreadRun> = [],
): ReadonlyArray<PendingThreadFeedEntry> {
  if (queuedMessages.length === 0 && queuedRuns.length === 0) return presentedFeed;
  const deliveredIds = new Set(
    feed.flatMap((entry) => (entry.type === "message" ? [entry.message.id] : [])),
  );
  const pendingEntries = queuedMessages
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
        attachments: [],
        context: pendingMessage.context,
        createdAt: pendingMessage.createdAt,
        updatedAt: pendingMessage.createdAt,
        runId: null,
        streaming: false,
        visibility: "local",
        sourceThreadId: pendingMessage.threadId,
      },
    }));
  const pendingById = new Map(pendingEntries.map((entry) => [entry.id, entry]));
  const serverIds = new Set<string>(queuedRuns.map(({ messageId }) => messageId));
  return [
    ...presentedFeed.map((entry): PendingThreadFeedEntry => {
      const pendingMessage = queuedMessages.find(
        (message) => message.creation !== undefined && message.messageId === entry.id,
      );
      return pendingMessage ? { ...entry, pendingMessage, acknowledged: false } : entry;
    }),
    ...queuedRuns
      .filter(({ messageId }) => !deliveredIds.has(messageId))
      .map(({ run, text, attachments, messageId, context, message }): PendingThreadFeedEntry => {
        const pendingEntry = pendingById.get(messageId);
        if (pendingEntry) return pendingEntry;
        const createdAt = DateTime.formatIso(run.requestedAt);
        return {
          type: "message",
          id: messageId,
          createdAt,
          queued: true,
          message: {
            ...message,
            id: messageId,
            role: "user",
            text,
            attachments,
            context,
            createdAt,
            updatedAt: createdAt,
            runId: null,
            streaming: false,
            visibility: "local",
            sourceThreadId: run.threadId,
          },
        };
      }),
    ...pendingEntries.filter((entry) => !serverIds.has(entry.id)),
  ];
}

export function isCompactionCommandFeedEntry(entry: PendingThreadFeedEntry): boolean {
  return (
    entry.type === "message" &&
    entry.pendingMessage === undefined &&
    entry.queued === undefined &&
    isCompactionCommandMessage(entry.message)
  );
}
