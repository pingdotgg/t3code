import { EnvironmentId } from "@t3tools/contracts";
import {
  bootstrapRemoteBearerSession,
  fetchRemoteEnvironmentDescriptor,
} from "@t3tools/client-runtime";
import { resolveRemotePairingTarget, stripPairingTokenFromUrl } from "@t3tools/shared/remote";
import * as Effect from "effect/Effect";
import { mobileRuntime } from "./runtime";

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
  readonly bearerToken: string | null;
  readonly authenticationMethod?: "bearer" | "dpop";
  readonly dpopAccessToken?: string;
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

export async function bootstrapRemoteConnection(
  input: RemoteConnectionInput,
): Promise<SavedRemoteConnection> {
  const target = resolveRemotePairingTarget({
    pairingUrl: input.pairingUrl,
  });

  const { descriptor, bootstrap } = await mobileRuntime.runPromise(
    Effect.all(
      {
        descriptor: fetchRemoteEnvironmentDescriptor({
          httpBaseUrl: target.httpBaseUrl,
        }),
        bootstrap: bootstrapRemoteBearerSession({
          httpBaseUrl: target.httpBaseUrl,
          credential: target.credential,
        }),
      },
      { concurrency: "unbounded" },
    ),
  );

  return {
    environmentId: descriptor.environmentId,
    environmentLabel: descriptor.label,
    pairingUrl: redactPairingCredential(input.pairingUrl),
    displayUrl: target.httpBaseUrl,
    httpBaseUrl: target.httpBaseUrl,
    wsBaseUrl: target.wsBaseUrl,
    bearerToken: bootstrap.sessionToken,
    authenticationMethod: "bearer",
  };
}
