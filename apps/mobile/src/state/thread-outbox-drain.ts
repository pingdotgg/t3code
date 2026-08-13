import type { QueuedThreadMessage, ThreadOutboxFailureAction } from "./thread-outbox-model";

/**
 * Settles one start-turn result. `true` means the drain must not schedule an
 * automatic retry; a held message remains queued and is intentionally treated
 * as settled for this attempt.
 */
export async function settleThreadOutboxDelivery(input: {
  readonly message: QueuedThreadMessage;
  readonly failureAction: ThreadOutboxFailureAction | null;
  readonly confirmDelivered?: (message: QueuedThreadMessage) => Promise<boolean>;
  readonly hold: (message: QueuedThreadMessage) => Promise<boolean>;
  readonly remove: (message: QueuedThreadMessage) => Promise<void>;
  readonly onConfirmDeliveredError?: (error: unknown) => void;
  readonly onHoldError: (error: unknown) => void;
  readonly onRemoveError: (error: unknown) => void;
}): Promise<boolean> {
  if (input.failureAction === "retry") {
    return false;
  }
  if (input.failureAction === "hold") {
    try {
      await input.hold(input.message);
    } catch (error) {
      input.onHoldError(error);
    }
    return true;
  }

  if (input.failureAction === null && input.confirmDelivered !== undefined) {
    try {
      // Persist positive knowledge before deleting. If deletion fails, a later
      // drain (including after app restart) can retry cleanup without sending
      // the already-accepted command again.
      await input.confirmDelivered(input.message);
    } catch (error) {
      input.onConfirmDeliveredError?.(error);
    }
  }

  try {
    await input.remove(input.message);
    return true;
  } catch (error) {
    input.onRemoveError(error);
    return false;
  }
}
