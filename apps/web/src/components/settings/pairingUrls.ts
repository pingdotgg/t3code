import type { AdvertisedEndpoint } from "@t3tools/contracts";

import { buildHostedPairingUrl } from "../../hostedPairing";
import { setPairingTokenAsQueryOnUrl, setPairingTokenOnUrl } from "../../pairingUrl";

export function resolveDesktopPairingUrl(endpointUrl: string, credential: string): string {
  const url = new URL(endpointUrl);
  url.pathname = "/pair";
  return setPairingTokenOnUrl(url, credential).toString();
}

export function resolveHostedPairingUrl(endpointUrl: string, credential: string): string | null {
  const url = new URL(endpointUrl);
  if (url.protocol !== "https:") {
    return null;
  }

  return buildHostedPairingUrl({
    host: endpointUrl,
    token: credential,
  });
}

export function resolveMobileBootstrapUrl(endpointUrl: string, credential: string): string {
  const url = new URL(endpointUrl);
  url.pathname = "/m";
  return setPairingTokenAsQueryOnUrl(url, credential).toString();
}

export function resolveAdvertisedEndpointMobileBootstrapUrl(
  endpoint: AdvertisedEndpoint,
  credential: string,
): string {
  return resolveMobileBootstrapUrl(endpoint.httpBaseUrl, credential);
}
