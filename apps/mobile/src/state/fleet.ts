import { createFleetAtom } from "@cz/client-runtime/state/fleet";

import { environmentCatalog } from "../connection/catalog";
import { serverEnvironment } from "./server";
import { environmentSnapshotAtom } from "./shell";

/** Every paired machine with its health and the agents running there. */
export const fleetAtom = createFleetAtom({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  connectionStateAtom: environmentCatalog.stateAtom,
  shellSnapshotAtom: environmentSnapshotAtom,
  hostResourcesAtom: (environmentId) =>
    serverEnvironment.hostResources({ environmentId, input: {} }),
  onlinePeersAtom: (environmentId) => serverEnvironment.onlinePeers({ environmentId, input: {} }),
});
