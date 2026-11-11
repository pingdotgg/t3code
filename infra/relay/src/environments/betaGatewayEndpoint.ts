import type { RelayManagedEndpoint } from "@t3tools/contracts/relay";

import { isManagedEndpointHostname, MANAGED_ENDPOINT_KEY_PATTERN } from "../deploymentConfig.ts";

export function betaGatewayEndpoint(
  domain: string | undefined,
  key: string | null | undefined,
  stored?: Pick<RelayManagedEndpoint, "httpBaseUrl" | "wsBaseUrl">,
): RelayManagedEndpoint | null {
  if (!domain || !key || !MANAGED_ENDPOINT_KEY_PATTERN.test(key)) return null;
  const hostname = `${key}.${domain}`;
  if (!isManagedEndpointHostname(hostname, domain)) return null;
  const httpBaseUrl = `https://${hostname}/`;
  const wsBaseUrl = `wss://${hostname}/ws`;
  if (stored && (stored.httpBaseUrl !== httpBaseUrl || stored.wsBaseUrl !== wsBaseUrl)) return null;
  return { httpBaseUrl, wsBaseUrl, providerKind: "t3_relay" };
}
