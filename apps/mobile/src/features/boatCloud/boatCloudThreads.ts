import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { createBoatCloudThreadListAtoms } from "@t3tools/client-runtime/state/threads";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect } from "react";

import { environmentCatalog } from "../../connection/catalog";
import { appAtomRegistry } from "../../state/atom-registry";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";

const MAX_REMEMBERED = 500;
const NONE: ReadonlyArray<ScopedThreadRef> = [];

const openedThreadsAtom = Atom.make(
  (get) =>
    AsyncResult.getOrElse(get(mobilePreferencesAtom), () => null)?.boatCloudOpenedThreads ?? NONE,
).pipe(Atom.withLabel("mobile-boat-cloud-opened-threads"));

/** Boat cloud VM threads this phone started or opened, the only VM threads its lists show. */
export const boatCloudThreadList = createBoatCloudThreadListAtoms({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  openedThreadsAtom,
});

const preferencesLoadedAtom = Atom.make((get) => AsyncResult.isSuccess(get(mobilePreferencesAtom)));
const NO_ENVIRONMENT_ATOM = Atom.make(false);

/** Lists an opened VM thread here from now on; the catalog and preferences load after the route. */
export function useRememberOpenedBoatCloudThread(ref: ScopedThreadRef | null): void {
  const environmentId = ref?.environmentId ?? null;
  const threadId = ref?.threadId ?? null;
  const onBoatCloud = useAtomValue(
    environmentId === null
      ? NO_ENVIRONMENT_ATOM
      : boatCloudThreadList.onBoatCloudAtom(environmentId),
  );
  const loaded = useAtomValue(preferencesLoadedAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- records the visit in stored preferences, outside React
  useEffect(() => {
    if (!onBoatCloud || !loaded || environmentId === null || threadId === null) return;
    const opened = appAtomRegistry.get(openedThreadsAtom);
    if (
      opened.some((other) => other.environmentId === environmentId && other.threadId === threadId)
    ) {
      return;
    }
    savePreferences({
      boatCloudOpenedThreads: [...opened, { environmentId, threadId }].slice(-MAX_REMEMBERED),
    });
  }, [onBoatCloud, loaded, environmentId, threadId, savePreferences]);
}
