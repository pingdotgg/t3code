import { EnvironmentId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useMemo } from "react";

import { Atom } from "effect/reactivity";

import { environmentShell, environmentShellSummaryAtom } from "./shell";
import { environmentIsUnreachable, projectWorkspaceState } from "./workspaceModel";
import { environmentCatalog } from "../connection/catalog";
import { environmentPresentations } from "./presentation";
import { createWorkspaceConnectionAtoms } from "./workspace-connection-atoms";

export const workspaceConnections = createWorkspaceConnectionAtoms({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  networkStatusValueAtom: environmentCatalog.networkStatusValueAtom,
  presentationAtom: environmentPresentations.presentationAtom,
});

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

/**
 * Environments whose rows are marked unreachable. The set keeps its identity
 * until membership changes, so background retries do not invalidate list rows.
 */
export function useUnreachableEnvironmentIds(): ReadonlySet<EnvironmentId> {
  const key = useWorkspaceEnvironments()
    .filter(environmentIsUnreachable)
    .map((environment) => environment.environmentId)
    .join("\n");
  return useMemo(
    () => new Set(key === "" ? [] : key.split("\n").map((id) => EnvironmentId.make(id))),
    [key],
  );
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
  const hasSyncingConnectedEnvironment = useAtomValue(hasSyncingConnectedEnvironmentAtom);
  const state = useMemo(
    () =>
      projectWorkspaceState({
        isReady,
        networkStatus,
        environments: projectedEnvironments,
        shellSummary,
        hasSyncingConnectedEnvironment,
      }),
    [isReady, networkStatus, projectedEnvironments, shellSummary, hasSyncingConnectedEnvironment],
  );

  return {
    environments: projectedEnvironments,
    state,
  };
}
