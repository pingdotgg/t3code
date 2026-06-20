import {
  type BrowserNavigationTarget,
  EnvironmentId,
  type PreviewUrlResolution,
} from "@t3tools/contracts";
import { isLoopbackHost, normalizePreviewUrl } from "@t3tools/shared/preview";
import { getUrlDiagnostics } from "@t3tools/shared/urlDiagnostics";
import * as Schema from "effect/Schema";

import { readPreparedConnection } from "~/state/session";

export class BrowserTargetEnvironmentDisconnectedError extends Schema.TaggedErrorClass<BrowserTargetEnvironmentDisconnectedError>()(
  "BrowserTargetEnvironmentDisconnectedError",
  {
    environmentId: EnvironmentId,
  },
) {
  override get message(): string {
    return `Environment ${this.environmentId} is not connected.`;
  }
}

export class BrowserTargetEnvironmentUrlInvalidError extends Schema.TaggedErrorClass<BrowserTargetEnvironmentUrlInvalidError>()(
  "BrowserTargetEnvironmentUrlInvalidError",
  {
    environmentId: EnvironmentId,
    httpBaseUrlInputLength: Schema.Number,
    httpBaseUrlProtocol: Schema.optionalKey(Schema.String),
    httpBaseUrlHostname: Schema.optionalKey(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Environment ${this.environmentId} has an invalid HTTP base URL input of length ${this.httpBaseUrlInputLength}.`;
  }
}

export class BrowserTargetPrivateNetworkRequiredError extends Schema.TaggedErrorClass<BrowserTargetPrivateNetworkRequiredError>()(
  "BrowserTargetPrivateNetworkRequiredError",
  {
    environmentId: EnvironmentId,
    hostname: Schema.String,
  },
) {
  override get message(): string {
    return `Environment ${this.environmentId} host ${this.hostname} needs the planned authenticated preview gateway because it is not directly private-network reachable.`;
  }
}

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
  if (!connection) {
    throw new BrowserTargetEnvironmentDisconnectedError({ environmentId });
  }
  let environmentUrl: URL;
  try {
    environmentUrl = new URL(connection.httpBaseUrl);
  } catch (cause) {
    const diagnostics = getUrlDiagnostics(connection.httpBaseUrl);
    throw new BrowserTargetEnvironmentUrlInvalidError({
      environmentId,
      httpBaseUrlInputLength: diagnostics.inputLength,
      ...(diagnostics.protocol === undefined ? {} : { httpBaseUrlProtocol: diagnostics.protocol }),
      ...(diagnostics.hostname === undefined ? {} : { httpBaseUrlHostname: diagnostics.hostname }),
      cause,
    });
  }
  if (!isPrivateNetworkHost(environmentUrl.hostname)) {
    throw new BrowserTargetPrivateNetworkRequiredError({
      environmentId,
      hostname: environmentUrl.hostname,
    });
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
