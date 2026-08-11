import {
  createEnvironmentShellAtoms,
  createEnvironmentShellSummaryAtom,
  createEnvironmentSnapshotAtom,
  createShellEnvironmentAtoms,
} from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";

export const shellEnvironment = createShellEnvironmentAtoms(connectionAtomRuntime);
export const environmentShell = createEnvironmentShellAtoms(connectionAtomRuntime);
export const environmentSnapshotAtom = createEnvironmentSnapshotAtom(environmentShell.stateAtom);
export const environmentShellSummaryAtom = createEnvironmentShellSummaryAtom({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  shellStateValueAtom: environmentShell.stateValueAtom,
});

let previousLiveEnvironmentIds: ReadonlySet<EnvironmentId> = new Set();
export const liveEnvironmentIdsAtom = Atom.make((get): ReadonlySet<EnvironmentId> => {
  const next = new Set<EnvironmentId>();
  for (const environmentId of get(environmentCatalog.catalogValueAtom).entries.keys()) {
    if (get(environmentShell.stateValueAtom(environmentId)).status === "live") {
      next.add(environmentId);
    }
  }
  if (
    next.size === previousLiveEnvironmentIds.size &&
    [...next].every((environmentId) => previousLiveEnvironmentIds.has(environmentId))
  ) {
    return previousLiveEnvironmentIds;
  }
  previousLiveEnvironmentIds = next;
  return previousLiveEnvironmentIds;
}).pipe(Atom.withLabel("mobile-live-environment-ids"));
