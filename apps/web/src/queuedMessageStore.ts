import type {
  ModelSelection,
  PreviewAnnotationPayload,
  ProviderInteractionMode,
  RuntimeMode,
} from "@t3tools/contracts";
import { create } from "zustand";

import type { LocalDispatchSnapshot } from "./components/ChatView.logic";
import type { ComposerFileAttachment, ComposerImageAttachment } from "./composerDraftStore";
import type { TerminalContextDraft } from "./lib/terminalContext";
import { randomUUID } from "./lib/utils";
import type { ReviewCommentContext } from "./reviewCommentContext";

/**
 * The composer's model and modes when the message was queued. The send uses
 * these instead of the live composer, so it can go out while the user is on
 * another thread.
 */
export interface QueuedMessageSendSettings {
  modelSelection: ModelSelection;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
  /** Effort written into the prompt text, for providers that read it there. */
  promptEffort: string | null;
}

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
  sendSettings: QueuedMessageSendSettings;
  /**
   * The newest completed tool activity at queue time. A different id later
   * means a tool call finished after the user queued, which is the boundary
   * the message goes out on.
   */
  queuedAfterToolActivityId: string | null;
  /**
   * Set when the message was created by Stop or a failed restore, not by the
   * user pressing send. It waits for Send now instead of leaving on its own.
   */
  holdUntilUserAction?: boolean;
  /**
   * Set while a send is under way; the row stays until it settles. Stop can
   * still take a "preparing" message back (uploads, thread settings), but not
   * a "dispatching" one, whose turn start is already on the wire.
   */
  sending?: "preparing" | "dispatching";
  createdAt: string;
}

/**
 * The thread as it was when its last queued turn start went out. The next
 * message waits until the server has moved past it, so a send that starts a
 * new turn and the message after it do not leave on one boundary.
 */
interface QueuedDispatch {
  /** The message that went out, or null for a dispatch restored after a failure. */
  messageId: string | null;
  thread: LocalDispatchSnapshot;
  /** The dispatch this one replaced. If this send fails, that one still counts. */
  previous: LocalDispatchSnapshot | null;
}

interface QueuedMessageStoreState {
  queuesByThreadKey: Record<string, QueuedComposerMessage[]>;
  lastDispatchByThreadKey: Record<string, QueuedDispatch>;
  enqueue: (threadKey: string, message: Omit<QueuedComposerMessage, "id">) => QueuedComposerMessage;
  /**
   * Marks one message as sending and returns it, or null when it is gone or
   * the thread already has a send under way. The other messages are
   * re-anchored to `toolActivityId` so only one leaves per tool boundary.
   */
  beginSend: (
    threadKey: string,
    id: string,
    toolActivityId: string | null,
  ) => QueuedComposerMessage | null;
  /** The turn start is going out. False when Stop took the message back first. */
  markDispatching: (threadKey: string, id: string, thread: LocalDispatchSnapshot) => boolean;
  /** Drops a message whose send went out, or that had nothing left to send. */
  finishSend: (threadKey: string, id: string) => void;
  /**
   * Moves a message whose send failed back to the head, held for user action.
   * The queue keeps its order and nothing behind it overtakes. False when
   * Stop already took the message back.
   */
  failSend: (threadKey: string, id: string) => boolean;
  /** Removes one message without touching the others' anchors. Null when gone or sending. */
  remove: (threadKey: string, id: string) => QueuedComposerMessage | null;
  /** Removes and returns every message for the thread that is not already on the wire. */
  drain: (threadKey: string) => QueuedComposerMessage[];
}

const EMPTY_QUEUE: QueuedComposerMessage[] = [];

type QueueState = Pick<QueuedMessageStoreState, "queuesByThreadKey" | "lastDispatchByThreadKey">;

/** Replaces one thread's queue. `lastDispatch` null forgets it; an empty queue always does. */
function withQueue(
  state: QueueState,
  threadKey: string,
  queue: QueuedComposerMessage[],
  lastDispatch?: QueuedDispatch | null,
): QueueState {
  const queuesByThreadKey = { ...state.queuesByThreadKey, [threadKey]: queue };
  const lastDispatchByThreadKey = { ...state.lastDispatchByThreadKey };
  if (lastDispatch) lastDispatchByThreadKey[threadKey] = lastDispatch;
  if (queue.length === 0) delete queuesByThreadKey[threadKey];
  if (queue.length === 0 || lastDispatch === null) delete lastDispatchByThreadKey[threadKey];
  return { queuesByThreadKey, lastDispatchByThreadKey };
}

/** In-memory only: a queued message is a live intent, not a draft worth persisting. */
export const useQueuedMessageStore = create<QueuedMessageStoreState>()((set, get) => {
  const queueOf = (threadKey: string) => get().queuesByThreadKey[threadKey] ?? EMPTY_QUEUE;
  const update = (
    threadKey: string,
    queue: QueuedComposerMessage[],
    lastDispatch?: QueuedDispatch | null,
  ) => set((state) => withQueue(state, threadKey, queue, lastDispatch));
  return {
    queuesByThreadKey: {},
    lastDispatchByThreadKey: {},
    enqueue: (threadKey, message) => {
      const entry: QueuedComposerMessage = { ...message, id: randomUUID() };
      update(threadKey, [...queueOf(threadKey), entry]);
      return entry;
    },
    beginSend: (threadKey, id, toolActivityId) => {
      const queue = queueOf(threadKey);
      const entry = queue.find((message) => message.id === id);
      if (!entry || queue.some((message) => message.sending)) return null;
      update(
        threadKey,
        queue.map((message) =>
          message.id === id
            ? { ...message, sending: "preparing" }
            : message.queuedAfterToolActivityId === toolActivityId
              ? message
              : { ...message, queuedAfterToolActivityId: toolActivityId },
        ),
      );
      return entry;
    },
    markDispatching: (threadKey, id, thread) => {
      const queue = queueOf(threadKey);
      if (!queue.some((message) => message.id === id && message.sending)) return false;
      update(
        threadKey,
        queue.map((message) =>
          message.id === id ? { ...message, sending: "dispatching" } : message,
        ),
        {
          messageId: id,
          thread,
          previous: get().lastDispatchByThreadKey[threadKey]?.thread ?? null,
        },
      );
      return true;
    },
    finishSend: (threadKey, id) => {
      const queue = queueOf(threadKey);
      if (!queue.some((message) => message.id === id)) return;
      update(
        threadKey,
        queue.filter((message) => message.id !== id),
      );
    },
    failSend: (threadKey, id) => {
      const queue = queueOf(threadKey);
      const entry = queue.find((message) => message.id === id);
      if (!entry) return false;
      const { sending: _sending, ...rest } = entry;
      // This send never reached the server, so only an earlier one is worth
      // waiting for.
      const dispatch = get().lastDispatchByThreadKey[threadKey];
      update(
        threadKey,
        [{ ...rest, holdUntilUserAction: true }, ...queue.filter((message) => message.id !== id)],
        dispatch?.messageId !== id
          ? undefined
          : dispatch.previous && { messageId: null, thread: dispatch.previous, previous: null },
      );
      return true;
    },
    remove: (threadKey, id) => {
      const queue = queueOf(threadKey);
      const entry = queue.find((message) => message.id === id);
      if (!entry || entry.sending) return null;
      update(
        threadKey,
        queue.filter((message) => message.id !== id),
      );
      return entry;
    },
    drain: (threadKey) => {
      const queue = queueOf(threadKey);
      const drained = queue.filter((message) => message.sending !== "dispatching");
      if (drained.length === 0) return EMPTY_QUEUE;
      update(
        threadKey,
        queue.filter((message) => message.sending === "dispatching"),
      );
      return drained;
    },
  };
});

/**
 * The newest finished tool call. Its id changing is the boundary a queued
 * message goes out on. Live arrays are sorted, but a snapshot loaded from the
 * database is not, so pick by sequence rather than position.
 */
export function latestCompletedToolActivityId(
  activities: ReadonlyArray<{
    readonly id: string;
    readonly kind: string;
    readonly sequence?: number | undefined;
    readonly createdAt: string;
  }>,
): string | null {
  let latest: (typeof activities)[number] | null = null;
  for (const activity of activities) {
    if (activity.kind !== "tool.completed") continue;
    if (
      latest === null ||
      (activity.sequence ?? -1) > (latest.sequence ?? -1) ||
      ((activity.sequence ?? -1) === (latest.sequence ?? -1) &&
        activity.createdAt > latest.createdAt)
    ) {
      latest = activity;
    }
  }
  return latest?.id ?? null;
}

/**
 * A queued message is due mid-turn once a tool call finished after it was
 * queued, and as soon as the turn is over otherwise. "connecting" is the gap
 * between a send and the provider picking it up, so nothing is due there.
 */
export function isQueuedMessageDue(input: {
  message: Pick<QueuedComposerMessage, "queuedAfterToolActivityId" | "holdUntilUserAction">;
  phase: "connecting" | "running" | "ready" | "disconnected";
  latestToolActivityId: string | null;
}): boolean {
  if (input.message.holdUntilUserAction) return false;
  if (input.phase === "connecting") return false;
  if (input.phase !== "running") return true;
  return input.latestToolActivityId !== input.message.queuedAfterToolActivityId;
}

export function useQueuedMessages(threadKey: string): QueuedComposerMessage[] {
  return useQueuedMessageStore((state) => state.queuesByThreadKey[threadKey] ?? EMPTY_QUEUE);
}
