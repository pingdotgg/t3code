import * as ChildProcess from "node:child_process";
import type { NetworkInterfaceInfo } from "node:os";

import {
  createAdvertisedEndpoint,
  type CreateAdvertisedEndpointInput,
} from "@t3tools/client-runtime";
import type { AdvertisedEndpoint, AdvertisedEndpointProvider } from "@t3tools/contracts";

const TAILSCALE_ENDPOINT_PROVIDER: AdvertisedEndpointProvider = {
  id: "tailscale",
  label: "Tailscale",
  kind: "private-network",
  isAddon: true,
};

const TAILSCALE_STATUS_TIMEOUT_MS = 1_500;

interface TailscaleStatusSelf {
  readonly DNSName?: unknown;
  readonly TailscaleIPs?: unknown;
}

interface TailscaleStatusJson {
  readonly Self?: TailscaleStatusSelf;
}

function createTailscaleEndpoint(
  input: Omit<CreateAdvertisedEndpointInput, "provider" | "source">,
): AdvertisedEndpoint {
  return createAdvertisedEndpoint({
    ...input,
    provider: TAILSCALE_ENDPOINT_PROVIDER,
    source: "desktop-addon",
  });
}

export function isTailscaleIpv4Address(address: string): boolean {
  const parts = address.split(".");
  if (parts.length !== 4) {
    return false;
  }
  const [first, second, third, fourth] = parts.map((part) => Number.parseInt(part, 10));
  if (
    first === undefined ||
    second === undefined ||
    third === undefined ||
    fourth === undefined ||
    [first, second, third, fourth].some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }
  return first === 100 && second >= 64 && second <= 127;
}

export function resolveTailscaleIpAdvertisedEndpoints(input: {
  readonly port: number;
  readonly networkInterfaces: NodeJS.Dict<NetworkInterfaceInfo[]>;
}): readonly AdvertisedEndpoint[] {
  const seen = new Set<string>();
  const endpoints: AdvertisedEndpoint[] = [];

  for (const interfaceAddresses of Object.values(input.networkInterfaces)) {
    if (!interfaceAddresses) continue;

    for (const address of interfaceAddresses) {
      if (address.internal) continue;
      if (address.family !== "IPv4") continue;
      if (!isTailscaleIpv4Address(address.address)) continue;
      if (seen.has(address.address)) continue;
      seen.add(address.address);

      endpoints.push(
        createTailscaleEndpoint({
          id: `tailscale-ip:http://${address.address}:${input.port}`,
          label: "Tailscale IP",
          httpBaseUrl: `http://${address.address}:${input.port}`,
          reachability: "private-network",
          status: "available",
          description: "Reachable from devices on the same Tailnet.",
        }),
      );
    }
  }

  return endpoints;
}

export function parseTailscaleMagicDnsName(rawStatusJson: string): string | null {
  let parsed: TailscaleStatusJson;
  try {
    parsed = JSON.parse(rawStatusJson) as TailscaleStatusJson;
  } catch {
    return null;
  }

  const dnsName = parsed.Self?.DNSName;
  if (typeof dnsName !== "string") {
    return null;
  }

  const normalized = dnsName.trim().replace(/\.$/u, "");
  return normalized.length > 0 ? normalized : null;
}

export function resolveTailscaleMagicDnsAdvertisedEndpoint(input: {
  readonly dnsName: string | null;
  readonly port: number;
}): AdvertisedEndpoint | null {
  if (!input.dnsName) {
    return null;
  }

  const httpBaseUrl = `https://${input.dnsName}:${input.port}`;
  return createTailscaleEndpoint({
    id: `tailscale-magicdns:${httpBaseUrl}`,
    label: "Tailscale HTTPS",
    httpBaseUrl,
    reachability: "private-network",
    hostedHttpsCompatibility: "requires-configuration",
    status: "unknown",
    description: "MagicDNS hostname. Configure Tailscale Serve for HTTPS access.",
  });
}

async function readTailscaleStatusJson(): Promise<string | null> {
  return await new Promise((resolve) => {
    const child = ChildProcess.execFile(
      "tailscale",
      ["status", "--json"],
      { timeout: TAILSCALE_STATUS_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        resolve(stdout);
      },
    );
    child.once("error", () => resolve(null));
  });
}

export async function resolveTailscaleAdvertisedEndpoints(input: {
  readonly port: number;
  readonly networkInterfaces: NodeJS.Dict<NetworkInterfaceInfo[]>;
  readonly statusJson?: string | null;
}): Promise<readonly AdvertisedEndpoint[]> {
  const ipEndpoints = resolveTailscaleIpAdvertisedEndpoints(input);
  const statusJson =
    input.statusJson === undefined ? await readTailscaleStatusJson() : input.statusJson;
  const magicDnsEndpoint = resolveTailscaleMagicDnsAdvertisedEndpoint({
    dnsName: statusJson ? parseTailscaleMagicDnsName(statusJson) : null,
    port: input.port,
  });

  return magicDnsEndpoint ? [...ipEndpoints, magicDnsEndpoint] : ipEndpoints;
}
