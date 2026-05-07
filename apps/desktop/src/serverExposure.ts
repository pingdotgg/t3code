import type { NetworkInterfaceInfo } from "node:os";
import {
  createAdvertisedEndpoint,
  type CreateAdvertisedEndpointInput,
} from "@t3tools/client-runtime";
import type {
  AdvertisedEndpoint,
  AdvertisedEndpointProvider,
  DesktopServerExposureMode,
} from "@t3tools/contracts";

const DESKTOP_LOOPBACK_HOST = "127.0.0.1";
const DESKTOP_LAN_BIND_HOST = "0.0.0.0";

export interface DesktopServerExposure {
  readonly mode: DesktopServerExposureMode;
  readonly bindHost: string;
  readonly localHttpUrl: string;
  readonly localWsUrl: string;
  readonly endpointUrl: string | null;
  readonly advertisedHost: string | null;
}

export interface DesktopAdvertisedEndpointInput {
  readonly port: number;
  readonly exposure: DesktopServerExposure;
  readonly customHttpsEndpointUrls?: readonly string[];
}

const DESKTOP_CORE_ENDPOINT_PROVIDER: AdvertisedEndpointProvider = {
  id: "desktop-core",
  label: "Desktop",
  kind: "core",
  isAddon: false,
};

const DESKTOP_MANUAL_ENDPOINT_PROVIDER: AdvertisedEndpointProvider = {
  id: "manual",
  label: "Manual",
  kind: "manual",
  isAddon: false,
};

const normalizeOptionalHost = (value: string | undefined): string | undefined => {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
};

const isUsableLanIpv4Address = (address: string): boolean =>
  !address.startsWith("127.") && !address.startsWith("169.254.");

function isHttpsEndpointUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

export function resolveLanAdvertisedHost(
  networkInterfaces: NodeJS.Dict<NetworkInterfaceInfo[]>,
  explicitHost: string | undefined,
): string | null {
  const normalizedExplicitHost = normalizeOptionalHost(explicitHost);
  if (normalizedExplicitHost) {
    return normalizedExplicitHost;
  }

  for (const interfaceAddresses of Object.values(networkInterfaces)) {
    if (!interfaceAddresses) continue;

    for (const address of interfaceAddresses) {
      if (address.internal) continue;
      if (address.family !== "IPv4") continue;
      if (!isUsableLanIpv4Address(address.address)) continue;
      return address.address;
    }
  }

  return null;
}

export function resolveDesktopServerExposure(input: {
  readonly mode: DesktopServerExposureMode;
  readonly port: number;
  readonly networkInterfaces: NodeJS.Dict<NetworkInterfaceInfo[]>;
  readonly advertisedHostOverride?: string;
}): DesktopServerExposure {
  const localHttpUrl = `http://${DESKTOP_LOOPBACK_HOST}:${input.port}`;
  const localWsUrl = `ws://${DESKTOP_LOOPBACK_HOST}:${input.port}`;

  if (input.mode === "local-only") {
    return {
      mode: input.mode,
      bindHost: DESKTOP_LOOPBACK_HOST,
      localHttpUrl,
      localWsUrl,
      endpointUrl: null,
      advertisedHost: null,
    };
  }

  const advertisedHost = resolveLanAdvertisedHost(
    input.networkInterfaces,
    input.advertisedHostOverride,
  );

  return {
    mode: input.mode,
    bindHost: DESKTOP_LAN_BIND_HOST,
    localHttpUrl,
    localWsUrl,
    endpointUrl: advertisedHost ? `http://${advertisedHost}:${input.port}` : null,
    advertisedHost,
  };
}

function createDesktopEndpoint(
  input: Omit<CreateAdvertisedEndpointInput, "provider" | "source">,
): AdvertisedEndpoint {
  return createAdvertisedEndpoint({
    ...input,
    provider: DESKTOP_CORE_ENDPOINT_PROVIDER,
    source: "desktop-core",
  });
}

function createManualEndpoint(
  input: Omit<CreateAdvertisedEndpointInput, "provider" | "source">,
): AdvertisedEndpoint {
  return createAdvertisedEndpoint({
    ...input,
    provider: DESKTOP_MANUAL_ENDPOINT_PROVIDER,
    source: "user",
  });
}

export function resolveDesktopCoreAdvertisedEndpoints(
  input: DesktopAdvertisedEndpointInput,
): readonly AdvertisedEndpoint[] {
  const endpoints: AdvertisedEndpoint[] = [
    createDesktopEndpoint({
      id: `desktop-loopback:${input.port}`,
      label: "This machine",
      httpBaseUrl: input.exposure.localHttpUrl,
      reachability: "loopback",
      status: "available",
      description: "Loopback endpoint for this desktop app.",
    }),
  ];

  if (input.exposure.endpointUrl) {
    endpoints.push(
      createDesktopEndpoint({
        id: `desktop-lan:${input.exposure.endpointUrl}`,
        label: "Local network",
        httpBaseUrl: input.exposure.endpointUrl,
        reachability: "lan",
        status: "available",
        isDefault: true,
        description: "Reachable from devices on the same network.",
      }),
    );
  }

  for (const customEndpointUrl of input.customHttpsEndpointUrls ?? []) {
    try {
      const isHttpsEndpoint = isHttpsEndpointUrl(customEndpointUrl);
      endpoints.push(
        createManualEndpoint({
          id: `manual:${customEndpointUrl}`,
          label: isHttpsEndpoint ? "Custom HTTPS" : "Custom endpoint",
          httpBaseUrl: customEndpointUrl,
          reachability: "public",
          ...(isHttpsEndpoint ? ({ hostedHttpsCompatibility: "compatible" } as const) : {}),
          status: "unknown",
          description: isHttpsEndpoint
            ? "User-configured HTTPS endpoint for this desktop backend."
            : "User-configured endpoint for this desktop backend.",
        }),
      );
    } catch {
      // Ignore malformed user-configured endpoints without dropping valid endpoints.
    }
  }

  return endpoints;
}
