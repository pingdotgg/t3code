import {
  AVAILABLE_CONNECTION_STATE,
  type SupervisorConnectionState,
} from "@t3tools/client-runtime/connection";
import { createEnvironmentCatalogAtoms } from "@t3tools/client-runtime/state/connections";
import { createEnvironmentProjectAtoms } from "@t3tools/client-runtime/state/projects";
import {
  createEnvironmentShellAtoms,
  createEnvironmentSnapshotAtom,
} from "@t3tools/client-runtime/state/shell";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";

export const environmentCatalog = createEnvironmentCatalogAtoms(connectionAtomRuntime);
const environmentShell = createEnvironmentShellAtoms(connectionAtomRuntime);
const environmentSnapshotAtom = createEnvironmentSnapshotAtom(environmentShell.stateAtom);

export const environmentProjects = createEnvironmentProjectAtoms({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  snapshotAtom: environmentSnapshotAtom,
});

export interface EngineConnection {
  readonly state: SupervisorConnectionState;
  /** Set when the client refuses the engine, for example one that is too old. */
  readonly unsupportedReason: string | undefined;
}

const NOT_REGISTERED: EngineConnection = {
  state: AVAILABLE_CONNECTION_STATE,
  unsupportedReason: undefined,
};

/** The connection to the one engine the app talks to, which is not registered until it answers. */
export const engineConnectionAtom = Atom.make((get): EngineConnection => {
  const [entry] = get(environmentCatalog.catalogValueAtom).entries.values();
  if (entry === undefined) return NOT_REGISTERED;
  return {
    state: AsyncResult.getOrElse(
      get(environmentCatalog.stateAtom(entry.target.environmentId)),
      () => AVAILABLE_CONNECTION_STATE,
    ),
    unsupportedReason: entry.unsupportedReason,
  };
}).pipe(Atom.withLabel("engine-connection"));
