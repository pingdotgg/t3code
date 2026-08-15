import {
  AVAILABLE_CONNECTION_STATE,
  connectionCatalogDisplayUrl,
  type ConnectionCatalogEntry,
  type EnvironmentPresentation as BaseEnvironmentPresentation,
  presentEnvironmentConnection,
  type SupervisorConnectionState,
} from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";

export interface EnvironmentPresentation extends BaseEnvironmentPresentation {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly displayUrl: string | null;
  readonly relayManaged: boolean;
}

export interface EnvironmentConnectionPresentation extends EnvironmentPresentation {
  readonly connectionId: string;
}

export function projectEnvironmentPresentation(
  environmentId: EnvironmentId,
  presentation: BaseEnvironmentPresentation,
): EnvironmentPresentation {
  return {
    ...presentation,
    environmentId,
    label: presentation.entry.target.label,
    displayUrl: connectionCatalogDisplayUrl(presentation.entry),
    relayManaged: presentation.entry.target._tag === "RelayConnectionTarget",
  };
}

export function projectEnvironmentConnections(
  connections: ReadonlyMap<string, ConnectionCatalogEntry>,
  connectionStates: ReadonlyMap<string, SupervisorConnectionState>,
  presentationById: ReadonlyMap<EnvironmentId, BaseEnvironmentPresentation>,
): ReadonlyArray<EnvironmentConnectionPresentation> {
  return [...connections.entries()].map(([connectionId, entry]) => ({
    ...projectEnvironmentPresentation(entry.target.environmentId, {
      entry,
      connection: presentEnvironmentConnection(
        connectionStates.get(connectionId) ?? AVAILABLE_CONNECTION_STATE,
      ),
      serverConfig: presentationById.get(entry.target.environmentId)?.serverConfig ?? null,
    }),
    connectionId,
  }));
}
