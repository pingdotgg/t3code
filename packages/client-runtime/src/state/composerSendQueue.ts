// @effect-diagnostics globalDate:off -- The queue stamps a message with the wall-clock time it was queued. That stamp is a plain number on a plain object, read in an event handler, and Effect's Clock is not available in the React scope that creates the queue.

/**
 * A local queue for a message typed while a send is still in flight.
 *
 * The composer used to drop the message. The send guard returns early while
 * `isSendBusy` or `sendInFlightRef.current` is set, and it did so silently:
 * the text the user typed was never sent, never queued, and never reported.
 * The only visible sign was a spinner that never resolved.
 *
 * This module holds the message instead of discarding it. The queue is drained
 * when the composer is free again.
 *
 * It is deliberately separate from the server-side follow-up queue. That queue
 * holds a message once the SERVER has accepted it, and it needs a live turn to
 * attach to. This queue holds a message the client has not been able to send
 * at all, so it has to survive the client being the thing that is busy.
 *
 * The payload is generic: the queue carries whatever the caller queued, so the
 * web composer can queue a whole draft (text, attachments and contexts) rather
 * than text alone, and this module stays free of any composer's types.
 */

/** One queued message, in the order the user typed it. */
export interface QueuedComposerMessage<T> {
  readonly id: string;
  /** What was queued. The queue does not interpret it. */
  readonly payload: T;
  /** When the message was queued, in epoch milliseconds. */
  readonly queuedAtMs: number;
}

export interface ComposerSendQueue<T> {
  /**
   * Appends a message.
   *
   * The queue stamps the message itself. A caller in a React render scope
   * would otherwise have to read the clock, and reading the clock during
   * render is an impurity the React compiler rejects.
   */
  readonly enqueue: (message: { readonly id: string; readonly payload: T }) => void;
  /**
   * The queued messages, oldest first, and clears the queue. The caller sends
   * them; if a send fails, the caller puts the message back with `restore`.
   */
  readonly drain: () => ReadonlyArray<QueuedComposerMessage<T>>;
  /**
   * Puts a drained message back at the front, for a send that failed.
   *
   * Restoring several messages must therefore restore them from LAST to
   * FIRST: each restore goes to the front, so restoring in the order the
   * messages were queued would reverse them.
   */
  readonly restore: (message: QueuedComposerMessage<T>) => void;
  /** The queued messages, oldest first, without clearing. */
  readonly peek: () => ReadonlyArray<QueuedComposerMessage<T>>;
  /** How many messages are queued. */
  readonly size: () => number;
}

export const makeComposerSendQueue = <T>(options?: {
  /** The clock, injected so the queue can be tested without a real one. */
  readonly now?: () => number;
}): ComposerSendQueue<T> => {
  const now = options?.now ?? (() => Date.now());
  let messages: Array<QueuedComposerMessage<T>> = [];

  return {
    enqueue: (message) => {
      messages.push({
        id: message.id,
        payload: message.payload,
        queuedAtMs: now(),
      });
    },
    drain: () => {
      const drained = messages;
      messages = [];
      return drained;
    },
    restore: (message) => {
      // A restored message goes back at the FRONT: it was typed first, and it
      // is the one the user is waiting on.
      messages = [message, ...messages];
    },
    peek: () => messages,
    size: () => messages.length,
  };
};
