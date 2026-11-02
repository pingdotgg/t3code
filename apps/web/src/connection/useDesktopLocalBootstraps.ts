import { useAtomValue } from "@effect/atom-react";
import type { DesktopEnvironmentBootstrap } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { readDesktopSecondaryBootstraps, subscribeDesktopTopologyChanges } from "./desktopLocal";

const desktopLocalBootstrapsAtom = Atom.make((get) => {
  get.addFinalizer(
    subscribeDesktopTopologyChanges(() => get.setSelf(readDesktopSecondaryBootstraps())),
  );
  return readDesktopSecondaryBootstraps();
}).pipe(Atom.withLabel("desktop-local-bootstraps"));

export function useDesktopLocalBootstraps(): ReadonlyArray<DesktopEnvironmentBootstrap> {
  return useAtomValue(desktopLocalBootstrapsAtom);
}
