import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";
import { appAtomRegistry } from "./atom-registry";
import type { QueuedThreadMessage } from "./thread-outbox-model";
import { environmentThreadDetails } from "./threads";

// Keep acknowledged rows until their subscribed projection arrives; command receipts can precede messages.
// Render hides rows the projection has echoed, so dropping them here only frees memory.
export const acknowledgedThreadMessagesAtom = Atom.make<ReadonlyArray<QueuedThreadMessage>>(
  [],
).pipe(Atom.keepAlive);

// Peeks at a thread only when something already has it in the registry: reading
// it through the registry would open a snapshot load and a live stream of its own.
function isEchoedInMountedThread(message: QueuedThreadMessage): boolean {
  const threadAtom = environmentThreadDetails.threadAtom({
    environmentId: message.environmentId,
    threadId: message.threadId,
  });
  const node = appAtomRegistry.getNodes().get(threadAtom);
  if (node === undefined) return false;
  const loaded: Option.Option<Atom.Type<typeof threadAtom>> = node.valueOption();
  const thread = Option.getOrNull(loaded);
  return thread?.projection.messages.some((entry) => entry.id === message.messageId) ?? false;
}

function writeAcknowledgedThreadMessages(
  update: (current: ReadonlyArray<QueuedThreadMessage>) => ReadonlyArray<QueuedThreadMessage>,
) {
  const current = appAtomRegistry.get(acknowledgedThreadMessagesAtom);
  const next = update(current).filter((entry) => !isEchoedInMountedThread(entry));
  if (next.length === current.length && next.every((entry, index) => entry === current[index])) {
    return;
  }
  appAtomRegistry.set(acknowledgedThreadMessagesAtom, next);
}

export function retainAcknowledgedThreadMessage(message: QueuedThreadMessage) {
  writeAcknowledgedThreadMessages((current) =>
    current.some((entry) => entry.messageId === message.messageId)
      ? current
      : [...current, message],
  );
}

export function forgetAcknowledgedThreadMessage(message: QueuedThreadMessage) {
  writeAcknowledgedThreadMessages((current) =>
    current.filter((entry) => entry.messageId !== message.messageId),
  );
}
