import { type AuthClientPresentationMetadata, EnvironmentId } from "@t3tools/contracts";
import {
  bootstrapRemoteBearerSession,
  fetchRemoteEnvironmentDescriptor,
} from "@t3tools/client-runtime";
import { resolveRemotePairingTarget, stripPairingTokenFromUrl } from "@t3tools/shared/remote";
import { Platform } from "react-native";
import { mobileRemoteHttpRuntime } from "./runtime";

export interface RemoteConnectionInput {
  readonly pairingUrl: string;
}

export interface SavedRemoteConnection {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly pairingUrl: string;
  readonly displayUrl: string;
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly bearerToken: string;
}

export type RemoteClientConnectionState =
  | "idle"
  | "connecting"
  | "ready"
  | "reconnecting"
  | "disconnected";

export function redactPairingCredential(pairingUrl: string): string {
  const trimmed = pairingUrl.trim();
  try {
    return stripPairingTokenFromUrl(new URL(trimmed)).toString();
  } catch {
    return trimmed;
  }
}

export function mobileAuthClientMetadata(): AuthClientPresentationMetadata {
  return {
    label: "T3 Code Mobile",
    deviceType: "mobile",
    ...(Platform.OS === "ios" ? { os: "iOS" } : Platform.OS === "android" ? { os: "Android" } : {}),
  };
}

export async function bootstrapRemoteConnection(
  input: RemoteConnectionInput,
): Promise<SavedRemoteConnection> {
  const target = resolveRemotePairingTarget({
    pairingUrl: input.pairingUrl,
  });

  const descriptor = await mobileRemoteHttpRuntime.runPromise(
    fetchRemoteEnvironmentDescriptor({
      httpBaseUrl: target.httpBaseUrl,
    }),
  );

  const bootstrap = await mobileRemoteHttpRuntime.runPromise(
    bootstrapRemoteBearerSession({
      httpBaseUrl: target.httpBaseUrl,
      credential: target.credential,
      clientMetadata: mobileAuthClientMetadata(),
    }),
  );

  return {
    environmentId: descriptor.environmentId,
    environmentLabel: descriptor.label,
    pairingUrl: redactPairingCredential(input.pairingUrl),
    displayUrl: target.httpBaseUrl,
    httpBaseUrl: target.httpBaseUrl,
    wsBaseUrl: target.wsBaseUrl,
    bearerToken: bootstrap.access_token,
  };
}
