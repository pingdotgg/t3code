import { useAtomValue } from "@effect/atom-react";
import { useMemo } from "react";

import { environmentShellSummaryAtom } from "./shell";
import { projectWorkspaceState } from "./workspaceModel";
import { environmentCatalog } from "../connection/catalog";
import { environmentPresentations } from "./presentation";
import { createWorkspaceConnectionAtoms } from "./workspace-connection-atoms";

export const workspaceConnections = createWorkspaceConnectionAtoms({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  networkStatusValueAtom: environmentCatalog.networkStatusValueAtom,
  presentationAtom: environmentPresentations.presentationAtom,
});

export function useWorkspaceEnvironments() {
  return useAtomValue(workspaceConnections.environmentsAtom);
}

export function useWorkspaceConnectionState() {
  return useAtomValue(workspaceConnections.stateAtom);
}

export function useConnectionsReady() {
  return useAtomValue(workspaceConnections.isReadyAtom);
}

export function useWorkspaceState() {
  const isReady = useConnectionsReady();
  const networkStatus = useAtomValue(environmentCatalog.networkStatusValueAtom);
  const projectedEnvironments = useWorkspaceEnvironments();
  const shellSummary = useAtomValue(environmentShellSummaryAtom);
  const state = useMemo(
    () =>
      projectWorkspaceState({
        isReady,
        networkStatus,
        environments: projectedEnvironments,
        shellSummary,
      }),
    [isReady, networkStatus, projectedEnvironments, shellSummary],
  );

  return {
    environments: projectedEnvironments,
    state,
  };
}
