import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useMemo } from "react";

import { environmentCatalog } from "../connection/catalog";
import {
  projectEnvironmentConnections,
  projectEnvironmentPresentation,
  type EnvironmentConnectionPresentation,
  type EnvironmentPresentation,
} from "./environmentConnections";
import { environmentPresentations } from "./presentation";
import { useEnvironmentQuery } from "./query";

export type { EnvironmentConnectionPresentation, EnvironmentPresentation };
export { projectEnvironmentPresentation };

export function useEnvironments() {
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const networkStatus = useAtomValue(environmentCatalog.networkStatusValueAtom);
  const presentationById = useAtomValue(environmentPresentations.presentationsAtom);

  const environments = useMemo(
    () =>
      [...presentationById.entries()].map(([environmentId, presentation]) =>
        projectEnvironmentPresentation(environmentId, presentation),
      ),
    [presentationById],
  );

  return {
    isReady: catalog.isReady,
    networkStatus,
    environments,
    presentationById,
  };
}

export function useEnvironmentConnections() {
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const connections = useAtomValue(environmentCatalog.connectionsValueAtom);
  const connectionStates = useAtomValue(environmentCatalog.connectionStatesValueAtom);
  const presentationById = useAtomValue(environmentPresentations.presentationsAtom);

  const environments = useMemo(
    () => projectEnvironmentConnections(connections, connectionStates, presentationById),
    [connectionStates, connections, presentationById],
  );

  return { isReady: catalog.isReady, environments };
}

export function useEnvironmentConnectionState(environmentId: EnvironmentId) {
  return useEnvironmentQuery(environmentCatalog.stateAtom(environmentId));
}
