import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { environmentThreadDetails, threadEnvironment } from "../../state/threads";
import { toastManager } from "../ui/toast";

/** A request for the thread's open timeline to scroll to one entry. `key` tells repeats apart. */
export interface EntryRevealRequest {
  readonly threadKey: string;
  readonly entryId: string;
  readonly key: number;
}

const entryRevealRequestAtom = Atom.make<EntryRevealRequest | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("timeline-entry-reveal"),
);

export function useEntryRevealRequest(threadKey: string): EntryRevealRequest | null {
  const request = useAtomValue(entryRevealRequestAtom);
  return request?.threadKey === threadKey ? request : null;
}

function isEntryLoaded(ref: ScopedThreadRef, entryId: string): boolean {
  const thread = appAtomRegistry.get(environmentThreadDetails.quietThreadAtom(ref));
  return (
    thread?.projection.visibleTurnItems.some(
      ({ item }) =>
        ("messageId" in item ? item.messageId : undefined) === entryId || item.id === entryId,
    ) ?? false
  );
}

/** Loads history through the entry when it is older than the loaded page, then reveals it. */
export async function revealThreadEntry(ref: ScopedThreadRef, entryId: string) {
  if (
    !isEntryLoaded(ref, entryId) &&
    appAtomRegistry.get(environmentThreadDetails.historyAtom(ref)).hasMoreHistory
  ) {
    const result = await runAtomCommand(
      appAtomRegistry,
      threadEnvironment.loadEarlierHistory,
      {
        environmentId: ref.environmentId,
        input: { threadId: ref.threadId, throughEntryId: entryId },
      },
      { label: "load pinned entry history", reportFailure: false },
    );
    if (result._tag === "Failure" || !isEntryLoaded(ref, entryId)) {
      toastManager.add({ type: "error", title: "Could not load the pinned item" });
      return;
    }
  }
  const previous = appAtomRegistry.get(entryRevealRequestAtom);
  appAtomRegistry.set(entryRevealRequestAtom, {
    threadKey: scopedThreadKey(ref),
    entryId,
    key: (previous?.key ?? 0) + 1,
  });
}
