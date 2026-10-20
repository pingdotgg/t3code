import { Atom } from "effect/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { readDesktopHomeEnvironmentId } from "../localEnvironment";

export const primaryEnvironmentIdAtom = Atom.make((get) => {
  for (const [environmentId, entry] of get(environmentCatalog.catalogValueAtom).entries) {
    if (entry.target._tag === "PrimaryConnectionTarget") {
      return environmentId;
    }
  }
  return null;
}).pipe(Atom.withLabel("web-primary-environment-id"));

// With Local environment off, a background service can still own the desktop's
// T3 home. It runs on this machine just as the desktop's own backend would.
export const desktopHomeEnvironmentIdAtom = Atom.make(readDesktopHomeEnvironmentId).pipe(
  Atom.keepAlive,
  Atom.withLabel("web-desktop-home-environment-id"),
);

export const localMachineEnvironmentIdAtom = Atom.make(
  (get) => get(primaryEnvironmentIdAtom) ?? get(desktopHomeEnvironmentIdAtom),
).pipe(Atom.withLabel("web-local-machine-environment-id"));
