import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type { MessageId, ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { environmentThreadDetails, threadEnvironment } from "../../state/threads";
import { toastManager } from "../ui/toast";

/** A request for the thread's open timeline to scroll to one message. `key` tells repeats apart. */
export interface MessageRevealRequest {
  readonly threadKey: string;
  readonly messageId: MessageId;
  readonly key: number;
}

const messageRevealRequestAtom = Atom.make<MessageRevealRequest | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("timeline-message-reveal"),
);

export function useMessageRevealRequest(threadKey: string): MessageRevealRequest | null {
  const request = useAtomValue(messageRevealRequestAtom);
  return request?.threadKey === threadKey ? request : null;
}

function isMessageLoaded(ref: ScopedThreadRef, messageId: MessageId): boolean {
  const thread = appAtomRegistry.get(environmentThreadDetails.quietThreadAtom(ref));
  return (
    thread?.projection.visibleTurnItems.some(
      ({ item }) =>
        (item.type === "user_message" || item.type === "assistant_message") &&
        item.messageId === messageId,
    ) ?? false
  );
}

/** Loads history through the message when it is older than the loaded page, then reveals it. */
export async function revealThreadMessage(ref: ScopedThreadRef, messageId: MessageId) {
  if (
    !isMessageLoaded(ref, messageId) &&
    appAtomRegistry.get(environmentThreadDetails.historyAtom(ref)).hasMoreHistory
  ) {
    const result = await runAtomCommand(
      appAtomRegistry,
      threadEnvironment.loadEarlierHistory,
      {
        environmentId: ref.environmentId,
        input: { threadId: ref.threadId, throughEntryId: messageId },
      },
      { label: "load pinned message history", reportFailure: false },
    );
    if (result._tag === "Failure" || !isMessageLoaded(ref, messageId)) {
      toastManager.add({ type: "error", title: "Could not load the pinned message" });
      return;
    }
  }
  const previous = appAtomRegistry.get(messageRevealRequestAtom);
  appAtomRegistry.set(messageRevealRequestAtom, {
    threadKey: scopedThreadKey(ref),
    messageId,
    key: (previous?.key ?? 0) + 1,
  });
}
