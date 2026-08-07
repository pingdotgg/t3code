import { create } from "zustand";

import type { ComposerImageAttachment } from "./composerDraftStore";
import { revokeBlobPreviewUrl } from "./components/ChatView.logic";

/**
 * A prompt the user submitted while the agent was still busy. It is
 * deliberately not a chat message yet: nothing is dispatched, so the entry can
 * still be dropped or sent by hand before it ever reaches the thread.
 *
 * `text` already carries the folded terminal / element contexts, preview
 * annotations and review comments — those are session bound and cannot be
 * restored later. The model and effort prefix is applied at send time instead,
 * so a queued prompt follows whichever selection is current when it runs.
 *
 * The queue is in-memory on purpose: entries hold live `File` handles and blob
 * preview URLs that no storage backend can round-trip.
 */
export interface QueuedMessage {
  readonly id: string;
  readonly text: string;
  readonly images: readonly ComposerImageAttachment[];
  readonly createdAt: string;
}

/**
 * Upper bound so a stuck agent cannot let the queue grow without limit. The
 * composer reports a refused enqueue instead of dropping the prompt silently.
 */
export const MAX_QUEUED_MESSAGES = 20;

const EMPTY_QUEUE: readonly QueuedMessage[] = [];

interface MessageQueueState {
  readonly queuesByThreadKey: Readonly<Record<string, readonly QueuedMessage[]>>;
  /** Appends to the tail. Returns false when the thread queue is full. */
  readonly enqueueMessage: (threadKey: string, message: QueuedMessage) => boolean;
  /** Puts a failed send back at the head so FIFO order survives the retry. */
  readonly requeueMessage: (threadKey: string, message: QueuedMessage) => void;
  /** Removes and returns an entry for sending — preview URLs stay alive. */
  readonly takeMessage: (threadKey: string, messageId: string) => QueuedMessage | null;
  /** Removes an entry the user dropped, revoking its preview URLs. */
  readonly discardMessage: (threadKey: string, messageId: string) => void;
  readonly clearThreadQueue: (threadKey: string) => void;
}

function writeQueue(
  queuesByThreadKey: Readonly<Record<string, readonly QueuedMessage[]>>,
  threadKey: string,
  queue: readonly QueuedMessage[],
): Readonly<Record<string, readonly QueuedMessage[]>> {
  const next = { ...queuesByThreadKey };
  if (queue.length === 0) {
    delete next[threadKey];
  } else {
    next[threadKey] = queue;
  }
  return next;
}

function revokeMessagePreviewUrls(message: QueuedMessage): void {
  for (const image of message.images) {
    revokeBlobPreviewUrl(image.previewUrl);
  }
}

export const useMessageQueueStore = create<MessageQueueState>()((set, get) => ({
  queuesByThreadKey: {},
  enqueueMessage: (threadKey, message) => {
    if (threadKey.length === 0) {
      return false;
    }
    const queue = get().queuesByThreadKey[threadKey] ?? EMPTY_QUEUE;
    if (queue.length >= MAX_QUEUED_MESSAGES) {
      return false;
    }
    set((state) => ({
      queuesByThreadKey: writeQueue(state.queuesByThreadKey, threadKey, [...queue, message]),
    }));
    return true;
  },
  requeueMessage: (threadKey, message) => {
    if (threadKey.length === 0) {
      return;
    }
    set((state) => {
      const queue = state.queuesByThreadKey[threadKey] ?? EMPTY_QUEUE;
      if (queue.some((entry) => entry.id === message.id)) {
        return state;
      }
      return {
        queuesByThreadKey: writeQueue(state.queuesByThreadKey, threadKey, [message, ...queue]),
      };
    });
  },
  takeMessage: (threadKey, messageId) => {
    const queue = get().queuesByThreadKey[threadKey] ?? EMPTY_QUEUE;
    const message = queue.find((entry) => entry.id === messageId);
    if (!message) {
      return null;
    }
    set((state) => ({
      queuesByThreadKey: writeQueue(
        state.queuesByThreadKey,
        threadKey,
        (state.queuesByThreadKey[threadKey] ?? EMPTY_QUEUE).filter(
          (entry) => entry.id !== messageId,
        ),
      ),
    }));
    return message;
  },
  discardMessage: (threadKey, messageId) => {
    const message = get().queuesByThreadKey[threadKey]?.find((entry) => entry.id === messageId);
    if (!message) {
      return;
    }
    revokeMessagePreviewUrls(message);
    set((state) => ({
      queuesByThreadKey: writeQueue(
        state.queuesByThreadKey,
        threadKey,
        (state.queuesByThreadKey[threadKey] ?? EMPTY_QUEUE).filter(
          (entry) => entry.id !== messageId,
        ),
      ),
    }));
  },
  clearThreadQueue: (threadKey) => {
    const queue = get().queuesByThreadKey[threadKey];
    if (!queue) {
      return;
    }
    for (const message of queue) {
      revokeMessagePreviewUrls(message);
    }
    set((state) => ({
      queuesByThreadKey: writeQueue(state.queuesByThreadKey, threadKey, EMPTY_QUEUE),
    }));
  },
}));

export function useThreadMessageQueue(threadKey: string | null): readonly QueuedMessage[] {
  return useMessageQueueStore((state) =>
    threadKey ? (state.queuesByThreadKey[threadKey] ?? EMPTY_QUEUE) : EMPTY_QUEUE,
  );
}

export function readThreadMessageQueue(threadKey: string): readonly QueuedMessage[] {
  return useMessageQueueStore.getState().queuesByThreadKey[threadKey] ?? EMPTY_QUEUE;
}
