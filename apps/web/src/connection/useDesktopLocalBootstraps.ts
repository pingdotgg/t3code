import { useAtomValue } from "@effect/atom-react";
import { PRIMARY_LOCAL_ENVIRONMENT_ID } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { readDesktopLocalBootstraps } from "./desktopLocal";

const DESKTOP_LOCAL_BOOTSTRAP_POLL_MS = 2_000;

/**
 * The bridge exposes no change event, so this re-reads on an interval while
 * anything reads it; failed reads retain the latest successful snapshot, while
 * a successful empty read clears it. The reader returns the same array while
 * nothing changed, so an unchanged poll notifies no one.
 */
export const desktopLocalBootstrapsAtom = Atom.make((get) => {
  const interval = setInterval(
    () => get.setSelf(readDesktopLocalBootstraps()),
    DESKTOP_LOCAL_BOOTSTRAP_POLL_MS,
  );
  get.addFinalizer(() => clearInterval(interval));
  return readDesktopLocalBootstraps();
}).pipe(Atom.withLabel("desktop-local-bootstraps"));

export function useDesktopLocalBootstraps() {
  return useAtomValue(desktopLocalBootstrapsAtom).filter(
    (entry) => entry.id !== PRIMARY_LOCAL_ENVIRONMENT_ID,
  );
}
