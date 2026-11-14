import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { use, useState } from "react";

import { TimelineRowCtx } from "./timelineRowContext";

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

/** One pin click opens a collapsed fold once. Collapsing it afterward stays collapsed. */
export function entryRevealExpands(
  request: Pick<EntryRevealRequest, "entryId" | "key"> | null,
  entryId: string,
  claimedKey: number | null,
): { readonly expand: boolean; readonly claimedKey: number | null } {
  if (request === null || request.entryId !== entryId || claimedKey === request.key) {
    return { expand: false, claimedKey };
  }
  return { expand: true, claimedKey: request.key };
}

/** True once for the pin click that names this entry, so the row can open its fold. */
export function useExpandRevealedEntry(entryId: string): boolean {
  const ctx = use(TimelineRowCtx);
  const request = useEntryRevealRequest(ctx.threadRef ? scopedThreadKey(ctx.threadRef) : "");
  const [claimedKey, setClaimedKey] = useState<number | null>(null);
  const expansion = entryRevealExpands(request, entryId, claimedKey);
  if (expansion.claimedKey !== claimedKey) setClaimedKey(expansion.claimedKey);
  return expansion.expand;
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

/** One history fetch stops at a size cap, so a pin further back needs another page. */
export const MAX_PIN_HISTORY_PAGES = 20;

export interface PinHistorySnapshot {
  readonly loaded: boolean;
  readonly hasMoreHistory: boolean;
}

export type PinHistoryPage = "loaded" | "noop" | "busy" | "error";

/**
 * Keeps loading older pages until the entry is in the open window. A page that
 * misses it is not a failure while older history remains.
 */
export async function pageUntilPinnedEntry(input: {
  readonly read: () => PinHistorySnapshot;
  readonly loadPage: () => Promise<PinHistoryPage>;
}): Promise<boolean> {
  for (let pages = 0; ; pages += 1) {
    const snapshot = input.read();
    if (snapshot.loaded) return true;
    if (!snapshot.hasMoreHistory || pages >= MAX_PIN_HISTORY_PAGES) return false;
    const page = await input.loadPage();
    if (page !== "loaded") return false;
  }
}

/** Loads history through the entry when it is older than the loaded page, then reveals it. */
export async function revealThreadEntry(ref: ScopedThreadRef, entryId: string) {
  const found = await pageUntilPinnedEntry({
    read: () => ({
      loaded: isEntryLoaded(ref, entryId),
      hasMoreHistory: appAtomRegistry.get(environmentThreadDetails.historyAtom(ref)).hasMoreHistory,
    }),
    loadPage: async () => {
      const result = await runAtomCommand(
        appAtomRegistry,
        threadEnvironment.loadEarlierHistory,
        {
          environmentId: ref.environmentId,
          input: { threadId: ref.threadId, throughEntryId: entryId },
        },
        { label: "load pinned entry history", reportFailure: false },
      );
      if (result._tag === "Failure") return "error";
      return result.value._tag === "loaded" ? "loaded" : result.value._tag;
    },
  });
  if (!found) {
    toastManager.add({ type: "error", title: "Could not load the pinned item" });
    return;
  }
  const previous = appAtomRegistry.get(entryRevealRequestAtom);
  appAtomRegistry.set(entryRevealRequestAtom, {
    threadKey: scopedThreadKey(ref),
    entryId,
    key: (previous?.key ?? 0) + 1,
  });
}
