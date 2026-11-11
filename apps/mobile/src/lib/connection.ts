import { EnvironmentId } from "@t3tools/contracts";
import { type EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";

export interface SavedRemoteConnection {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly pairingUrl: string;
  readonly displayUrl: string;
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly bearerToken: string | null;
}

export type RemoteClientConnectionState = EnvironmentConnectionPhase;
