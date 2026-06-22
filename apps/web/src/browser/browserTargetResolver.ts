import type {
  BrowserNavigationTarget,
  EnvironmentId,
  PreviewUrlResolution,
} from "@t3tools/contracts";
import { isLoopbackHost, normalizePreviewUrl } from "@t3tools/shared/preview";

import { readPreparedConnection } from "~/state/session";

const isPrivateNetworkHost = (host: string): boolean => {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized === "::1" || normalized.endsWith(".local")) {
    return true;
  }
  if (normalized.endsWith(".ts.net")) return true;
  const parts = normalized.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return false;
  return (
    parts[0] === 10 ||
    (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) ||
    (parts[0] === 192 && parts[1] === 168) ||
    parts[0] === 127 ||
    (parts[0] === 169 && parts[1] === 254)
  );
};

const isLocalLoopbackHost = (host: string): boolean => {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
};

export function resolveBrowserNavigationTarget(
  environmentId: EnvironmentId,
  target: BrowserNavigationTarget,
): PreviewUrlResolution {
  if (target.kind === "url") {
    return {
      requestedUrl: target.url,
      resolvedUrl: target.url,
      resolutionKind: "direct",
      environmentId,
    };
  }
  const connection = readPreparedConnection(environmentId);
  if (!connection) throw new Error(`Environment ${environmentId} is not connected.`);
  const environmentUrl = new URL(connection.httpBaseUrl);
  if (!isPrivateNetworkHost(environmentUrl.hostname)) {
    throw new Error(
      "This environment port needs the planned authenticated preview gateway; its server address is not directly private-network reachable.",
    );
  }
  const protocol = target.protocol ?? "http";
  const path = target.path?.startsWith("/") ? target.path : `/${target.path ?? ""}`;
  const requestedUrl = `${protocol}://localhost:${target.port}${path}`;
  const normalizedEnvironmentHost = environmentUrl.hostname.replace(/^\[|\]$/g, "");
  const resolvedHost = normalizedEnvironmentHost.includes(":")
    ? `[${normalizedEnvironmentHost}]`
    : normalizedEnvironmentHost;
  const resolved = new URL(path, `${protocol}://${resolvedHost}:${target.port}`);
  return {
    requestedUrl,
    resolvedUrl: resolved.toString(),
    resolutionKind:
      normalizedEnvironmentHost === "localhost" || normalizedEnvironmentHost === "127.0.0.1"
        ? "direct"
        : "direct-private-network",
    environmentId,
  };
}

export function resolveDiscoveredServerUrl(environmentId: EnvironmentId, rawUrl: string): string {
  try {
    const normalizedUrl = normalizePreviewUrl(rawUrl);
    const parsed = new URL(normalizedUrl);
    if (!isLoopbackHost(parsed.hostname)) return normalizedUrl;
    const connection = readPreparedConnection(environmentId);
    if (!connection) throw new Error(`Environment ${environmentId} is not connected.`);
    const environmentUrl = new URL(connection.httpBaseUrl);
    if (parsed.hostname !== "0.0.0.0" && isLocalLoopbackHost(environmentUrl.hostname)) {
      return normalizedUrl;
    }
    const port = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
    return resolveBrowserNavigationTarget(environmentId, {
      kind: "environment-port",
      port,
      protocol: parsed.protocol === "https:" ? "https" : "http",
      path: `${parsed.pathname}${parsed.search}${parsed.hash}`,
    }).resolvedUrl;
  } catch {
    return rawUrl;
  }
}
