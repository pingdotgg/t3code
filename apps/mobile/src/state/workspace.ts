import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";

import { environmentShell, environmentShellSummaryAtom } from "./shell";
import { projectWorkspaceState } from "./workspaceModel";
import { environmentCatalog } from "../connection/catalog";
import { environmentPresentations } from "./presentation";
import { createWorkspaceConnectionAtoms } from "./workspace-connection-atoms";

export const workspaceConnections = createWorkspaceConnectionAtoms({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  networkStatusValueAtom: environmentCatalog.networkStatusValueAtom,
  presentationAtom: environmentPresentations.presentationAtom,
});

// A disconnected environment's retries also leave its shell synchronizing.
const hasSyncingConnectedEnvironmentAtom = Atom.make((get) =>
  get(workspaceConnections.environmentsAtom).some(
    (environment) =>
      environment.isEnabled &&
      environment.connectionState === "connected" &&
      get(environmentShell.stateValueAtom(environment.environmentId)).status === "synchronizing",
  ),
).pipe(Atom.withLabel("mobile:has-syncing-connected-environment"));

export function useWorkspaceEnvironments() {
  return useAtomValue(workspaceConnections.environmentsAtom);
}

export function useWorkspaceConnectionState() {
  return useAtomValue(workspaceConnections.stateAtom);
}

export function useConnectionsReady() {
  return useAtomValue(workspaceConnections.isReadyAtom);
}

export const workspaceStateAtom = Atom.make((get) =>
  projectWorkspaceState({
    isReady: get(workspaceConnections.isReadyAtom),
    networkStatus: get(environmentCatalog.networkStatusValueAtom),
    environments: get(workspaceConnections.environmentsAtom),
    shellSummary: get(environmentShellSummaryAtom),
    hasSyncingConnectedEnvironment: get(hasSyncingConnectedEnvironmentAtom),
  }),
).pipe(Atom.withLabel("mobile:workspace-state"));

export function useWorkspaceState() {
  return {
    environments: useWorkspaceEnvironments(),
    state: useAtomValue(workspaceStateAtom),
  };
}
