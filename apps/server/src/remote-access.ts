import * as OS from "node:os";

export interface RemoteConnectUrlInput {
  readonly host: string | undefined;
  readonly port: number;
  readonly authToken: string | undefined;
}

type NetworkInterfaces = ReturnType<typeof OS.networkInterfaces>;

function normalizeFamily(value: string | number): "IPv4" | "IPv6" | null {
  if (value === "IPv4" || value === 4) return "IPv4";
  if (value === "IPv6" || value === 6) return "IPv6";
  return null;
}

export function isWildcardHost(host: string | undefined): boolean {
  return host === "0.0.0.0" || host === "::" || host === "[::]";
}

export function formatHostForUrl(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

export function isTailscaleAddress(address: string): boolean {
  if (address.includes(":")) {
    return address.toLowerCase().startsWith("fd7a:115c:a1e0:");
  }

  const octets = address.split(".").map((segment) => Number.parseInt(segment, 10));
  if (octets.length !== 4 || octets.some((value) => Number.isNaN(value) || value < 0 || value > 255)) {
    return false;
  }

  const first = octets[0];
  const second = octets[1];
  if (first === undefined || second === undefined) {
    return false;
  }
  return first === 100 && second >= 64 && second <= 127;
}

export function detectPreferredRemoteHost(
  host: string | undefined,
  interfaces: NetworkInterfaces = OS.networkInterfaces(),
): string | null {
  if (host && !isWildcardHost(host)) {
    return host;
  }

  const tailscaleCandidates: Array<{ address: string; family: "IPv4" | "IPv6" }> = [];
  const generalCandidates: Array<{ address: string; family: "IPv4" | "IPv6" }> = [];

  for (const [name, entries] of Object.entries(interfaces)) {
    if (!entries) continue;

    for (const entry of entries) {
      const family = normalizeFamily(entry.family);
      if (!family || entry.internal) continue;

      const candidate = { address: entry.address, family };
      if (name.toLowerCase().includes("tailscale") || isTailscaleAddress(entry.address)) {
        tailscaleCandidates.push(candidate);
        continue;
      }
      generalCandidates.push(candidate);
    }
  }

  const pick = (candidates: Array<{ address: string; family: "IPv4" | "IPv6" }>) =>
    candidates.find((candidate) => candidate.family === "IPv4") ??
    candidates.find((candidate) => candidate.family === "IPv6") ??
    null;

  return pick(tailscaleCandidates)?.address ?? pick(generalCandidates)?.address ?? null;
}

export function buildRemoteConnectUrl(
  input: RemoteConnectUrlInput,
  interfaces?: NetworkInterfaces,
): string | null {
  const host = detectPreferredRemoteHost(input.host, interfaces);
  if (!host) {
    return null;
  }

  const url = new URL(`http://${formatHostForUrl(host)}:${input.port}/`);
  if (input.authToken && input.authToken.trim().length > 0) {
    url.searchParams.set("token", input.authToken.trim());
  }
  return url.toString();
}
