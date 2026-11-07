import { useAtomValue } from "@effect/atom-react";
import type { DesktopEnvironmentBootstrap } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { readDesktopSecondaryBootstraps } from "./desktopLocal";

const DESKTOP_LOCAL_BOOTSTRAP_POLL_MS = 2_000;

/**
 * The bridge exposes no change event, so this re-reads on an interval while
 * anything reads it; failed reads retain the latest successful snapshot, while
 * a successful empty read clears it. The reader returns the same array while
 * nothing changed, so an unchanged poll notifies no one.
 */
const desktopLocalBootstrapsAtom = Atom.make((get) => {
  const interval = setInterval(
    () => get.setSelf(readDesktopSecondaryBootstraps()),
    DESKTOP_LOCAL_BOOTSTRAP_POLL_MS,
  );
  get.addFinalizer(() => clearInterval(interval));
  return readDesktopSecondaryBootstraps();
}).pipe(Atom.withLabel("desktop-local-bootstraps"));

export function useDesktopLocalBootstraps(): ReadonlyArray<DesktopEnvironmentBootstrap> {
  return useAtomValue(desktopLocalBootstrapsAtom);
}
