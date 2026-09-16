import type { EnvironmentPresentation, NetworkStatus } from "@t3tools/client-runtime/connection";
import type { EnvironmentCatalogState } from "@t3tools/client-runtime/state/connections";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom } from "effect/unstable/reactivity";

import {
  projectWorkspaceConnectionState,
  projectWorkspaceEnvironment,
  type WorkspaceEnvironment,
} from "./workspaceModel";

export function createWorkspaceConnectionAtoms(input: {
  readonly catalogValueAtom: Atom.Atom<EnvironmentCatalogState>;
  readonly networkStatusValueAtom: Atom.Atom<NetworkStatus>;
  readonly presentationAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<EnvironmentPresentation | null>;
}) {
  const environmentAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => {
      const presentation = get(input.presentationAtom(environmentId));
      if (presentation === null) return null;
      const next = projectWorkspaceEnvironment(environmentId, presentation);
      const previous = Option.getOrNull(get.self<WorkspaceEnvironment | null>());
      // Provider refreshes and transport heartbeats do not change connection UI.
      if (
        previous !== null &&
        previous.environmentId === next.environmentId &&
        previous.environmentLabel === next.environmentLabel &&
        previous.displayUrl === next.displayUrl &&
        previous.isRelayManaged === next.isRelayManaged &&
        previous.isEnabled === next.isEnabled &&
        previous.connectionState === next.connectionState &&
        previous.connectionError === next.connectionError &&
        previous.connectionErrorTraceId === next.connectionErrorTraceId
      )
        return previous;
      return next;
    }),
  );
  const environmentsAtom = Atom.make((get) => {
    const next: Array<WorkspaceEnvironment> = [];
    for (const environmentId of get(input.catalogValueAtom).entries.keys()) {
      const environment = get(environmentAtom(environmentId));
      if (environment !== null) next.push(environment);
    }
    const previous = Option.getOrNull(get.self<ReadonlyArray<WorkspaceEnvironment>>());
    return previous !== null &&
      previous.length === next.length &&
      next.every((value, index) => value === previous[index])
      ? previous
      : next;
  }).pipe(Atom.withLabel("mobile:workspace-connections"));
  const isReadyAtom = input.catalogValueAtom.pipe(Atom.map((catalog) => catalog.isReady));
  const stateAtom = Atom.make((get) =>
    projectWorkspaceConnectionState({
      isReady: get(isReadyAtom),
      networkStatus: get(input.networkStatusValueAtom),
      environments: get(environmentsAtom),
    }),
  ).pipe(Atom.withLabel("mobile:workspace-connection-state"));
  return { environmentsAtom, stateAtom, isReadyAtom };
}
