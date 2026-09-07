import { Atom } from "effect/unstable/reactivity";
import { appAtomRegistry } from "./atom-registry";
import type { QueuedThreadMessage } from "./thread-outbox-model";

// A command acknowledgment can precede its message in the subscribed timeline.
// Keep the visible row until that projection arrives, independently of outbox cleanup.
export const acknowledgedThreadMessagesAtom = Atom.make<ReadonlyArray<QueuedThreadMessage>>(
  [],
).pipe(Atom.keepAlive);

export function retainAcknowledgedThreadMessage(message: QueuedThreadMessage) {
  const current = appAtomRegistry.get(acknowledgedThreadMessagesAtom);
  appAtomRegistry.set(
    acknowledgedThreadMessagesAtom,
    current.some((entry) => entry.messageId === message.messageId)
      ? current
      : [...current, message],
  );
}

export function forgetAcknowledgedThreadMessage(message: QueuedThreadMessage) {
  const current = appAtomRegistry.get(acknowledgedThreadMessagesAtom);
  appAtomRegistry.set(
    acknowledgedThreadMessagesAtom,
    current.filter((entry) => entry.messageId !== message.messageId),
  );
}
