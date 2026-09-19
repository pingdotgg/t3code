import type { PreviewAnnotationPayload } from "@t3tools/contracts";
import { create } from "zustand";

import type { ComposerSubmissionIntent } from "./composer-logic";
import type { ComposerFileAttachment, ComposerImageAttachment } from "./composerDraftStore";
import type { TerminalContextDraft } from "./lib/terminalContext";
import { randomUUID } from "./lib/utils";
import type { ReviewCommentContext } from "./reviewCommentContext";

/**
 * A composer submission held back while the thread's turn is running. It
 * carries the full draft snapshot so the send path can dispatch it later with
 * the same text, attachments, and contexts the user pressed Enter on.
 */
export interface QueuedComposerMessage {
  id: string;
  prompt: string;
  images: ComposerImageAttachment[];
  files: ComposerFileAttachment[];
  terminalContexts: TerminalContextDraft[];
  previewAnnotations: PreviewAnnotationPayload[];
  reviewComments: ReviewCommentContext[];
  submissionIntent: ComposerSubmissionIntent;
  /**
   * Set when the message was created by Stop or a failed restore, not by the
   * user pressing send. It waits for Send now instead of leaving on its own.
   */
  holdUntilUserAction?: boolean;
  createdAt: string;
}

interface QueuedMessageStoreState {
  queuesByThreadKey: Record<string, QueuedComposerMessage[]>;
  /**
   * Bumped by `drain`. A send that took a message before a drain and finishes
   * its upload after it compares this to the value it captured and gives up,
   * so Stop cannot be followed by a queued message starting a new turn.
   */
  drainGeneration: number;
  enqueue: (threadKey: string, message: Omit<QueuedComposerMessage, "id">) => QueuedComposerMessage;
  /** Removes one message and returns it, or null when another caller already took it. */
  remove: (threadKey: string, id: string) => QueuedComposerMessage | null;
  /**
   * Puts a message back at the head, held for user action. Used when its
   * send failed: the queue keeps its order and nothing behind it overtakes.
   */
  holdAtFront: (threadKey: string, message: QueuedComposerMessage) => void;
  /** Removes and returns every queued message for the thread, oldest first. */
  drain: (threadKey: string) => QueuedComposerMessage[];
}

const EMPTY_QUEUE: QueuedComposerMessage[] = [];

/** In-memory only: a queued message is a live intent, not a draft worth persisting. */
export const useQueuedMessageStore = create<QueuedMessageStoreState>()((set, get) => ({
  queuesByThreadKey: {},
  drainGeneration: 0,
  enqueue: (threadKey, message) => {
    const entry: QueuedComposerMessage = { ...message, id: randomUUID() };
    set((state) => ({
      queuesByThreadKey: {
        ...state.queuesByThreadKey,
        [threadKey]: [...(state.queuesByThreadKey[threadKey] ?? EMPTY_QUEUE), entry],
      },
    }));
    return entry;
  },
  remove: (threadKey, id) => {
    const queue = get().queuesByThreadKey[threadKey];
    const entry = queue?.find((message) => message.id === id);
    if (!queue || !entry) {
      return null;
    }
    set((state) => {
      const remaining = (state.queuesByThreadKey[threadKey] ?? EMPTY_QUEUE).filter(
        (message) => message.id !== id,
      );
      const queuesByThreadKey = { ...state.queuesByThreadKey };
      if (remaining.length === 0) {
        delete queuesByThreadKey[threadKey];
      } else {
        queuesByThreadKey[threadKey] = remaining;
      }
      return { queuesByThreadKey };
    });
    return entry;
  },
  holdAtFront: (threadKey, message) => {
    set((state) => {
      const rest = (state.queuesByThreadKey[threadKey] ?? EMPTY_QUEUE).filter(
        (entry) => entry.id !== message.id,
      );
      return {
        queuesByThreadKey: {
          ...state.queuesByThreadKey,
          [threadKey]: [{ ...message, holdUntilUserAction: true }, ...rest],
        },
      };
    });
  },
  drain: (threadKey) => {
    const queue = get().queuesByThreadKey[threadKey];
    if (!queue || queue.length === 0) {
      return EMPTY_QUEUE;
    }
    set((state) => {
      const queuesByThreadKey = { ...state.queuesByThreadKey };
      delete queuesByThreadKey[threadKey];
      return { queuesByThreadKey, drainGeneration: state.drainGeneration + 1 };
    });
    return queue;
  },
}));

/**
 * Queued messages wait for the turn to end. "connecting" is the gap between
 * a send and the provider picking it up, so nothing is due there either.
 */
export function isQueuedMessageDue(input: {
  message: Pick<QueuedComposerMessage, "holdUntilUserAction">;
  phase: "connecting" | "running" | "ready" | "disconnected";
}): boolean {
  return (
    !input.message.holdUntilUserAction && input.phase !== "connecting" && input.phase !== "running"
  );
}

export function useQueuedMessages(threadKey: string): QueuedComposerMessage[] {
  return useQueuedMessageStore((state) => state.queuesByThreadKey[threadKey] ?? EMPTY_QUEUE);
}
