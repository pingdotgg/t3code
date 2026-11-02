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

// A background service can create the identity file after this window opens.
export const desktopHomeEnvironmentIdAtom = Atom.make((get) => {
  get(environmentCatalog.catalogValueAtom);
  return readDesktopHomeEnvironmentId();
}).pipe(Atom.keepAlive, Atom.withLabel("web-desktop-home-environment-id"));
