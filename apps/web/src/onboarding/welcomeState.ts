import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

export interface WelcomeImportSelection {
  // Projects listed when the selection changed; projects found later get the defaults.
  readonly knownKeys: ReadonlySet<string>;
  readonly keys: ReadonlySet<string>;
  // Unchecking the main box also leaves out projects found later, until it is checked again.
  readonly optedOut: boolean;
}

/**
 * A computer's project choices on the Welcome page. They survive a visit to Settings during
 * setup, and finishing setup clears them.
 */
export const welcomeImportSelectionAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make<WelcomeImportSelection | null>(null).pipe(
    Atom.keepAlive,
    Atom.withLabel(`welcome-import-selection:${environmentId}`),
  ),
);
