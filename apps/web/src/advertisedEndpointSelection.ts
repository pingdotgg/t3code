import type { AdvertisedEndpoint } from "@t3tools/contracts";

export const TAILSCALE_IP_DEFAULT_ENDPOINT_KEY = "tailscale:ip:http";

function isEndpointAvailable(endpoint: AdvertisedEndpoint): boolean {
  return endpoint.status !== "unavailable";
}

export function isTailscaleHttpsEndpoint(endpoint: AdvertisedEndpoint): boolean {
  return endpoint.id.startsWith("tailscale-magicdns:");
}

function isAvailableTailscaleHttpsEndpoint(endpoint: AdvertisedEndpoint): boolean {
  return (
    isTailscaleHttpsEndpoint(endpoint) &&
    endpoint.status === "available" &&
    endpoint.compatibility.hostedHttpsApp === "compatible"
  );
}

export function endpointDefaultPreferenceKey(endpoint: AdvertisedEndpoint): string {
  if (endpoint.id.startsWith("desktop-loopback:")) {
    return "desktop-core:loopback:http";
  }
  if (endpoint.id.startsWith("desktop-lan:")) {
    return "desktop-core:lan:http";
  }
  if (endpoint.id.startsWith("tailscale-ip:")) {
    return "tailscale:ip:http";
  }
  if (isTailscaleHttpsEndpoint(endpoint)) {
    return "tailscale:magicdns:https";
  }

  let scheme = "unknown";
  try {
    scheme = new URL(endpoint.httpBaseUrl).protocol.replace(/:$/u, "");
  } catch {
    // Keep the stored preference stable even if a custom endpoint is malformed.
  }

  return `${endpoint.provider.id}:${endpoint.reachability}:${scheme}:${endpoint.label}`;
}

export function selectDefaultAdvertisedEndpoint(
  endpoints: ReadonlyArray<AdvertisedEndpoint>,
  defaultEndpointKey?: string | null,
): AdvertisedEndpoint | null {
  const availableEndpoints = endpoints.filter(isEndpointAvailable);
  if (defaultEndpointKey === TAILSCALE_IP_DEFAULT_ENDPOINT_KEY) {
    const tailscaleHttpsEndpoint = availableEndpoints.find(isAvailableTailscaleHttpsEndpoint);
    if (tailscaleHttpsEndpoint) {
      return tailscaleHttpsEndpoint;
    }
  }
  if (defaultEndpointKey) {
    const selectedEndpoint = availableEndpoints.find(
      (endpoint) => endpointDefaultPreferenceKey(endpoint) === defaultEndpointKey,
    );
    if (selectedEndpoint) {
      return selectedEndpoint;
    }
  }

  return availableEndpoints.find((endpoint) => endpoint.isDefault) ?? null;
}

export function selectPairingEndpoint(
  endpoints: ReadonlyArray<AdvertisedEndpoint>,
  defaultEndpointKey?: string | null,
): AdvertisedEndpoint | null {
  const availableEndpoints = endpoints.filter(isEndpointAvailable);
  const defaultEndpoint = selectDefaultAdvertisedEndpoint(availableEndpoints, defaultEndpointKey);
  if (defaultEndpoint) {
    return defaultEndpoint;
  }
  return (
    availableEndpoints.find((endpoint) => endpoint.reachability !== "loopback") ??
    availableEndpoints.find((endpoint) => endpoint.compatibility.hostedHttpsApp === "compatible") ??
    null
  );
}
