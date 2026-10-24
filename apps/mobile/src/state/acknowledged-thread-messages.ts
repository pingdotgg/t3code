import { Atom } from "effect/reactivity";
import { appAtomRegistry } from "./atom-registry";
import type { QueuedThreadMessage } from "./thread-outbox-model";
import type { MessageId, ScopedThreadRef } from "@t3tools/contracts";

interface AcknowledgedThreadMessage extends QueuedThreadMessage {
  readonly acknowledgedSequence?: number;
}

export function unsettledAcknowledgedThreadMessages(
  messages: ReadonlyArray<AcknowledgedThreadMessage>,
  echoedIds: ReadonlySet<MessageId>,
  history?: ScopedThreadRef & {
    readonly hasMoreHistory: boolean;
    readonly snapshotSequence?: number;
  },
): ReadonlyArray<AcknowledgedThreadMessage> {
  return messages.filter((message) => {
    if (
      history !== undefined &&
      (message.environmentId !== history.environmentId || message.threadId !== history.threadId)
    ) {
      return true;
    }
    if (echoedIds.has(message.messageId)) return false;
    // A bounded snapshot taken after the send committed can omit its echo.
    // Client timestamps cannot establish this ordering, especially after offline sends.
    return !(
      history?.hasMoreHistory &&
      history.snapshotSequence !== undefined &&
      message.acknowledgedSequence !== undefined &&
      message.acknowledgedSequence <= history.snapshotSequence
    );
  });
}

// A command acknowledgment can precede its message in the subscribed timeline.
// Keep the visible row until that projection arrives, independently of outbox cleanup.
export const acknowledgedThreadMessagesAtom = Atom.make<ReadonlyArray<AcknowledgedThreadMessage>>(
  [],
).pipe(Atom.keepAlive);

export function retainAcknowledgedThreadMessage(
  message: QueuedThreadMessage,
  acknowledgedSequence?: number,
) {
  const current = appAtomRegistry.get(acknowledgedThreadMessagesAtom);
  const acknowledgedMessage =
    acknowledgedSequence === undefined ? message : { ...message, acknowledgedSequence };
  appAtomRegistry.set(
    acknowledgedThreadMessagesAtom,
    current.some((entry) => entry.messageId === message.messageId)
      ? current
      : [...current, acknowledgedMessage],
  );
}

export function forgetAcknowledgedThreadMessage(message: QueuedThreadMessage) {
  const current = appAtomRegistry.get(acknowledgedThreadMessagesAtom);
  appAtomRegistry.set(
    acknowledgedThreadMessagesAtom,
    current.filter((entry) => entry.messageId !== message.messageId),
  );
}
