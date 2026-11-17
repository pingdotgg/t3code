import { useAtomValue } from "@effect/atom-react";
import { createBoatCloudThreadListAtoms } from "@t3tools/client-runtime/state/threads";
import { ScopedThreadRef, type ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Atom } from "effect/reactivity";
import { useEffect } from "react";

import { environmentCatalog } from "../connection/catalog";
import { getLocalStorageItem, setLocalStorageItem } from "../hooks/useLocalStorage";
import { appAtomRegistry } from "../rpc/atomRegistry";

const STORAGE_KEY = "t3code:boat-cloud-opened-threads";
const MAX_REMEMBERED = 500;
const OpenedThreads = Schema.Array(ScopedThreadRef);

function readStored(): ReadonlyArray<ScopedThreadRef> {
  try {
    return getLocalStorageItem(STORAGE_KEY, OpenedThreads) ?? [];
  } catch {
    return [];
  }
}

/** Boat cloud VM threads this browser started or opened, the only VM threads its lists show. */
const openedThreadsAtom = Atom.make(readStored()).pipe(
  Atom.keepAlive,
  Atom.withLabel("boat-cloud-opened-threads"),
);

export const boatCloudThreadList = createBoatCloudThreadListAtoms({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  openedThreadsAtom,
});

/** Call only with a thread on a Boat cloud VM. */
export function rememberOpenedBoatCloudThread(ref: ScopedThreadRef): void {
  const same = (other: ScopedThreadRef) =>
    other.environmentId === ref.environmentId && other.threadId === ref.threadId;
  if (appAtomRegistry.get(openedThreadsAtom).some(same)) return;
  // Re-read storage so another tab's threads survive this write.
  const next = [...readStored().filter((other) => !same(other)), ref].slice(-MAX_REMEMBERED);
  appAtomRegistry.set(openedThreadsAtom, next);
  try {
    setLocalStorageItem(STORAGE_KEY, next, OpenedThreads);
  } catch {
    // The list still holds for this session.
  }
}

const NO_LISTED_THREADS_ATOM = Atom.make<ReadonlySet<ThreadId> | null>(null).pipe(
  Atom.withLabel("boat-cloud-listed-thread-ids:none"),
);

/**
 * Lists a VM thread here once a route opens it. True until then: the thread reads as hidden
 * for that render, and the route must not send the visit home for it.
 */
export function useOpenBoatCloudThread(ref: ScopedThreadRef | null): boolean {
  const environmentId = ref?.environmentId ?? null;
  const threadId = ref?.threadId ?? null;
  const listed = useAtomValue(
    environmentId === null
      ? NO_LISTED_THREADS_ATOM
      : boatCloudThreadList.listedThreadIdsAtom(environmentId),
  );
  const unlisted = listed !== null && threadId !== null && !listed.has(threadId);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- records the visit in browser storage, outside React
  useEffect(() => {
    if (unlisted && environmentId !== null && threadId !== null) {
      rememberOpenedBoatCloudThread({ environmentId, threadId });
    }
  }, [unlisted, environmentId, threadId]);
  return unlisted;
}
