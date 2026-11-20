import { ORCHESTRATION_PROTOCOL_VERSION } from "@t3tools/contracts";
import type { ConnectionCatalogDocument } from "@t3tools/client-runtime/platform";

export function phoneConnections(document: ConnectionCatalogDocument) {
  const environments = new Set<string>();
  return document.targets.flatMap((target) => {
    if (
      target._tag !== "BearerConnectionTarget" ||
      document.disabledEnvironmentIds.includes(target.environmentId) ||
      environments.has(target.environmentId)
    )
      return [];
    const profile = document.profiles.find((entry) => entry.connectionId === target.connectionId);
    const credential = document.credentials.find(
      (entry) => entry.connectionId === target.connectionId,
    );
    if (
      profile?._tag !== "BearerConnectionProfile" ||
      profile.authorization === "t3-connect" ||
      // The native service sends a plain bearer token; it cannot sign DPoP proofs.
      credential?.credential._tag !== "BearerConnectionCredential"
    )
      return [];
    environments.add(target.environmentId);
    return [
      {
        environmentId: target.environmentId,
        label: target.label,
        protocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
        httpBaseUrl: profile.httpBaseUrl,
        wsBaseUrl: profile.wsBaseUrl,
        token: credential.credential.token,
      },
    ];
  });
}
