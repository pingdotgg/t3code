import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import { appAtomRegistry } from "../rpc/atomRegistry";

export const selectedSettingsEnvironmentIdAtom = Atom.make<EnvironmentId | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("web-selected-settings-environment-id"),
);

export function setSelectedSettingsEnvironmentId(environmentId: EnvironmentId): void {
  appAtomRegistry.set(selectedSettingsEnvironmentIdAtom, environmentId);
}
