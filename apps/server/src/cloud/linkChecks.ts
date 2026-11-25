import type {
  RelayEnvironmentLinkProofPayload,
  RelayLinkProofRequest,
  RelayManagedEndpointOrigin,
} from "@t3tools/contracts/relay";

function endpointRequestPort(url: URL): number {
  return Number(url.port || (url.protocol === "https:" ? 443 : 80));
}

export function parseManagedEndpointLocalOrigin(localOrigin: string) {
  const url = new URL(localOrigin);
  if (
    localOrigin !== localOrigin.trim() ||
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    localOrigin.includes("?") ||
    localOrigin.includes("#")
  ) {
    throw new Error("Invalid local origin");
  }
  const wsUrl = new URL(url.origin);
  wsUrl.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return {
    httpBaseUrl: url.origin,
    wsBaseUrl: wsUrl.origin,
    origin: {
      localHttpHost: url.hostname,
      localHttpPort: endpointRequestPort(url),
    } satisfies RelayManagedEndpointOrigin,
  };
}

export function linkProofScopes(
  request: RelayLinkProofRequest,
): RelayEnvironmentLinkProofPayload["scopes"] {
  return request.endpoint.providerKind === "cloudflare_tunnel"
    ? ["agent_activity_notifications", "managed_tunnels"]
    : ["agent_activity_notifications"];
}
