import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { appAtomRegistry } from "../rpc/atomRegistry";

export const primaryEnvironmentIdAtom = Atom.make((get) => {
  for (const [environmentId, entry] of get(environmentCatalog.catalogValueAtom).entries) {
    if (entry.target._tag === "PrimaryConnectionTarget") {
      return environmentId;
    }
  }
  return null;
}).pipe(Atom.withLabel("web-primary-environment-id"));

const hostEnvironmentIdAtom = Atom.make<string | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("web-host-environment-id"),
);

// Without a primary, only the service sharing the desktop app's T3 home supplies themes.
export function createThemeEnvironmentIdAtom(input: {
  readonly primaryEnvironmentIdAtom: Atom.Atom<EnvironmentId | null>;
  readonly hostEnvironmentIdAtom: Atom.Atom<string | null>;
  readonly catalogValueAtom: Atom.Atom<{ readonly entries: ReadonlyMap<EnvironmentId, unknown> }>;
}) {
  return Atom.make((get) => {
    const primaryEnvironmentId = get(input.primaryEnvironmentIdAtom);
    if (primaryEnvironmentId !== null) return primaryEnvironmentId;
    const hostEnvironmentId = get(input.hostEnvironmentIdAtom);
    for (const environmentId of get(input.catalogValueAtom).entries.keys()) {
      if (environmentId === hostEnvironmentId) return environmentId;
    }
    return null;
  }).pipe(Atom.withLabel("web-theme-environment-id"));
}

export const themeEnvironmentIdAtom = createThemeEnvironmentIdAtom({
  primaryEnvironmentIdAtom,
  hostEnvironmentIdAtom,
  catalogValueAtom: environmentCatalog.catalogValueAtom,
});

export function startHostEnvironmentLookup(): void {
  void window.desktopBridge
    ?.getHostEnvironmentId?.()
    .then((environmentId) => appAtomRegistry.set(hostEnvironmentIdAtom, environmentId))
    .catch(() => {});
}
