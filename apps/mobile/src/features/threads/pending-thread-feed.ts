import {
  isCompactionCommandMessage,
  type ThreadGuestMessage,
  type ThreadGuestShare,
} from "@t3tools/contracts";
import { LIVE_ACTIVITY_ROW_ID, type ThreadFeedEntry } from "../../lib/threadActivity";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { threadHasCaughtUpTo } from "@t3tools/client-runtime/state/threads";
import { resolveUserMessageGrouping } from "@t3tools/client-runtime/user-message";
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

/**
 * Holds the turn's fold slot while a sent message waits for its run, so the live "Working for"
 * row replaces it in place instead of being inserted.
 */
export interface PendingFoldFeedEntry {
  readonly type: "pending-fold";
  readonly id: string;
  readonly createdAt: string;
  readonly messageId: string;
}

/** A row of the thread feed's list. */
export type ThreadFeedRow = PendingThreadFeedEntry | GuestPendingFeedEntry | PendingFoldFeedEntry;

export type GroupedThreadFeedRow = ThreadFeedRow & {
  readonly userMessageGrouping: ReturnType<typeof resolveUserMessageGrouping>;
};

export function createThreadFeedGrouping() {
  const rows = new WeakMap<ThreadFeedRow, GroupedThreadFeedRow>();
  const ungrouped = resolveUserMessageGrouping(undefined, undefined, undefined);
  return (
    feed: ReadonlyArray<ThreadFeedRow>,
    options: { readonly workflowOpeningMessageId?: string; readonly setupAnchorIndex?: number },
  ): ReadonlyArray<GroupedThreadFeedRow> => {
    const groupingMessage = (index: number) => {
      const entry = feed[index];
      return entry?.type === "message" &&
        entry.message.role === "user" &&
        !isCompactionCommandFeedEntry(entry) &&
        entry.message.id !== options.workflowOpeningMessageId
        ? entry.message
        : undefined;
    };
    return feed.map((entry, index) => {
      const message = groupingMessage(index);
      const grouping =
        message === undefined
          ? ungrouped
          : resolveUserMessageGrouping(
              message,
              index - 1 === options.setupAnchorIndex ? undefined : groupingMessage(index - 1),
              index === options.setupAnchorIndex ? undefined : groupingMessage(index + 1),
            );
      const previous = rows.get(entry);
      if (
        previous?.userMessageGrouping.groupedWithPrevious === grouping.groupedWithPrevious &&
        previous.userMessageGrouping.groupedWithNext === grouping.groupedWithNext &&
        previous.userMessageGrouping.continuesSteer === grouping.continuesSteer
      )
        return previous;
      const row = { ...entry, userMessageGrouping: grouping };
      rows.set(entry, row);
      return row;
    });
  };
}

/** Waiting guest messages go after the transcript, oldest first. */
export function appendGuestPendingMessages(
  presentedFeed: ReadonlyArray<PendingThreadFeedEntry | PendingFoldFeedEntry>,
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
): ReadonlyArray<PendingThreadFeedEntry> {
  if (queuedMessages.length === 0) return presentedFeed;
  const deliveredIds = new Set(
    feed.flatMap((entry) => (entry.type === "message" ? [entry.message.id] : [])),
  );
  return [
    ...presentedFeed.map((entry): PendingThreadFeedEntry => {
      const pendingMessage = queuedMessages.find(
        (message) => message.creation !== undefined && message.messageId === entry.id,
      );
      return pendingMessage ? { ...entry, pendingMessage, acknowledged: false } : entry;
    }),
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
          attachments: [],
          context: pendingMessage.context,
          createdAt: pendingMessage.createdAt,
          updatedAt: pendingMessage.createdAt,
          runId: null,
          streaming: false,
          visibility: "local",
          sourceThreadId: pendingMessage.threadId,
        },
      })),
  ];
}

/**
 * Messages the server accepted but has not projected yet. A new thread's first message stays
 * anchored until the server's copy loads, and keeps its local attachments so its media does
 * not drop out of the feed in between.
 */
export function appendAcceptedThreadMessages(
  feed: ReadonlyArray<ThreadFeedEntry>,
  acknowledged: ReadonlyArray<QueuedThreadMessage>,
  creation: QueuedThreadMessage | null,
): ReadonlyArray<PendingThreadFeedEntry> {
  const accepted = creation === null ? acknowledged : [...acknowledged, creation];
  if (accepted.length === 0) return feed;
  return appendPendingThreadMessages(feed, feed, accepted).map((entry) =>
    entry.pendingMessage ? { ...entry, acknowledged: true } : entry,
  );
}

/**
 * Ends the feed with the rows a starting run will fill, while its last row is a sent message no
 * run has picked up: the fold slot and the live activity row, under the activity row's own key.
 * The run's rows then replace them in place instead of being inserted.
 */
export function createPendingTurnAppender() {
  let fold: PendingFoldFeedEntry | null = null;
  let activity: Extract<ThreadFeedEntry, { readonly type: "thinking" }> | null = null;
  return (
    feed: ReadonlyArray<PendingThreadFeedEntry>,
    options: { readonly zen: boolean },
  ): ReadonlyArray<PendingThreadFeedEntry | PendingFoldFeedEntry> => {
    const last = feed.at(-1);
    if (
      last?.type !== "message" ||
      last.message.role !== "user" ||
      last.pendingMessage === undefined ||
      last.pendingMessage.creation !== undefined ||
      isCompactionCommandMessage(last.message) ||
      feed.some(
        (entry) =>
          (entry.type === "run-fold" && entry.workingSince !== undefined) ||
          entry.type === "thinking",
      )
    ) {
      return feed;
    }
    const label = last.acknowledged ? "Starting…" : "Sending…";
    if (activity?.createdAt !== last.createdAt || activity.label !== label) {
      activity = {
        type: "thinking",
        id: LIVE_ACTIVITY_ROW_ID,
        createdAt: last.createdAt,
        runId: null,
        label,
      };
    }
    if (options.zen) return [...feed, activity];
    if (fold?.messageId !== last.id) {
      fold = {
        type: "pending-fold",
        id: `pending-fold:${last.id}`,
        createdAt: last.createdAt,
        messageId: last.id,
      };
    }
    return [...feed, fold, activity];
  };
}

export function isCompactionCommandFeedEntry(entry: PendingThreadFeedEntry): boolean {
  return (
    entry.type === "message" &&
    entry.pendingMessage === undefined &&
    isCompactionCommandMessage(entry.message)
  );
}
