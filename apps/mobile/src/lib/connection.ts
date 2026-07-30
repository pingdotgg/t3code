import { EnvironmentId } from "@t3tools/contracts";
import { stripPairingTokenFromUrl } from "@t3tools/shared/remote";
import { type EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";

export { authClientMetadata } from "./authClientMetadata";

export interface SavedRemoteConnection {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly pairingUrl: string;
  readonly displayUrl: string;
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly bearerToken: string | null;
  readonly authenticationMethod?: "bearer" | "dpop";
  readonly dpopAccessToken?: string;
  readonly relayManaged?: true;
}

export type RemoteClientConnectionState = EnvironmentConnectionPhase;

export function redactPairingCredential(pairingUrl: string): string {
  const trimmed = pairingUrl.trim();
  try {
    return stripPairingTokenFromUrl(new URL(trimmed)).toString();
  } catch {
    return trimmed;
  }
}

export function isRelayManagedConnection(
  connection: Pick<SavedRemoteConnection, "authenticationMethod" | "relayManaged">,
): boolean {
  return connection.relayManaged === true || connection.authenticationMethod === "dpop";
}

export function toStableSavedRemoteConnection(
  connection: SavedRemoteConnection,
): SavedRemoteConnection {
  if (!isRelayManagedConnection(connection) || !connection.dpopAccessToken) {
    return connection;
  }

  const { dpopAccessToken: _, ...stableConnection } = connection;
  return stableConnection;
}
