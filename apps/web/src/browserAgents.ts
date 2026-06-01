import type { AdvertisedEndpoint, EnvironmentId, ProjectScript } from "@t3tools/contracts";

import { selectDefaultAdvertisedEndpoint } from "./advertisedEndpointSelection";
import { isLoopbackHostname, readPrimaryEnvironmentTarget } from "./environments/primary/target";
import { useUiStateStore } from "./uiStateStore";

export const DEFAULT_BROWSER_AGENT_DEV_SERVER_URL = "http://localhost:3000/";
const WILDCARD_DEV_SERVER_HOSTNAMES = new Set(["0.0.0.0", "::"]);
const ABSOLUTE_URL_PATTERN = /^[a-z][a-z\d+\-.]*:\/\//iu;
const LOCAL_PORT_URL_PATTERN = /^:\d{1,5}(?:[/?#]|$)/u;

const PORT_PATTERNS = [
  /(?:^|\s)(?:--port|-p)\s+(\d{2,5})\b/,
  /(?:^|\s)(?:--port|-p)=(\d{2,5})\b/,
  /(?:^|\s)(?:PORT|VITE_PORT)=(\d{2,5})\b/,
] as const;

function parsePort(command: string): number | null {
  for (const pattern of PORT_PATTERNS) {
    const match = pattern.exec(command);
    const rawPort = match?.[1];
    if (!rawPort) continue;
    const port = Number.parseInt(rawPort, 10);
    if (Number.isInteger(port) && port > 0 && port <= 65_535) {
      return port;
    }
  }
  return null;
}

function normalizeHostname(hostname: string): string {
  return hostname
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1");
}

function isLocalDevServerHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  return isLoopbackHostname(normalized) || WILDCARD_DEV_SERVER_HOSTNAMES.has(normalized);
}

function parseUrl(rawUrl: string): URL | null {
  try {
    const baseUrl =
      typeof window !== "undefined" &&
      (window.location.protocol === "http:" || window.location.protocol === "https:")
        ? window.location.origin
        : undefined;
    return baseUrl ? new URL(rawUrl, baseUrl) : new URL(rawUrl);
  } catch {
    return null;
  }
}

function looksLikeBareHttpUrl(rawUrl: string): boolean {
  const authority = rawUrl.match(/^[^/?#]+/u)?.[0] ?? "";
  if (!authority || authority.includes("@")) {
    return false;
  }
  if (/^\[[^\]]+\](?::\d{1,5})?$/u.test(authority)) {
    return true;
  }

  return (
    /^[a-z\d.-]+(?::\d{1,5})?$/iu.test(authority) &&
    (/[.:]/u.test(authority) || authority.toLowerCase() === "localhost")
  );
}

export function normalizeBrowserAgentPreviewUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return "";
  }
  if (LOCAL_PORT_URL_PATTERN.test(trimmed)) {
    return `http://localhost${trimmed}`;
  }
  if (trimmed.startsWith("//")) {
    return `http:${trimmed}`;
  }
  if (ABSOLUTE_URL_PATTERN.test(trimmed) || trimmed.startsWith("/")) {
    return trimmed;
  }
  if (looksLikeBareHttpUrl(trimmed)) {
    return `http://${trimmed}`;
  }
  return trimmed;
}

function remoteHttpHost(rawUrl: string | null | undefined): string | null {
  if (!rawUrl) {
    return null;
  }
  const url = parseUrl(rawUrl);
  if (!url || isLocalDevServerHostname(url.hostname)) {
    return null;
  }
  return url.hostname;
}

function currentBrowserRemoteHttpHost(): string | null {
  if (typeof window === "undefined") {
    return null;
  }
  return remoteHttpHost(window.location.origin);
}

function firstTailscaleIpEndpoint(
  endpoints: ReadonlyArray<AdvertisedEndpoint>,
): AdvertisedEndpoint | null {
  return (
    endpoints.find(
      (endpoint) => endpoint.status !== "unavailable" && endpoint.id.startsWith("tailscale-ip:"),
    ) ?? null
  );
}

function preferredAdvertisedEndpoint(
  endpoints: ReadonlyArray<AdvertisedEndpoint>,
  defaultEndpointKey: string | null | undefined,
): AdvertisedEndpoint | null {
  return selectDefaultAdvertisedEndpoint(endpoints, defaultEndpointKey);
}

async function resolveReachablePreviewHost(): Promise<string | null> {
  const getAdvertisedEndpoints =
    typeof window !== "undefined" ? window.desktopBridge?.getAdvertisedEndpoints : undefined;
  if (getAdvertisedEndpoints) {
    const advertisedEndpoints = await getAdvertisedEndpoints().catch(() => []);
    const selectedEndpoint = preferredAdvertisedEndpoint(
      advertisedEndpoints,
      useUiStateStore.getState().defaultAdvertisedEndpointKey,
    );
    const selectedHost = remoteHttpHost(selectedEndpoint?.httpBaseUrl);
    if (selectedHost) {
      return selectedHost;
    }

    const currentBrowserHost = currentBrowserRemoteHttpHost();
    if (currentBrowserHost) {
      return currentBrowserHost;
    }

    const tailscaleIpEndpoint = firstTailscaleIpEndpoint(advertisedEndpoints);
    const tailscaleIpHost = remoteHttpHost(tailscaleIpEndpoint?.httpBaseUrl);
    if (tailscaleIpHost) {
      return tailscaleIpHost;
    }
  } else {
    const currentBrowserHost = currentBrowserRemoteHttpHost();
    if (currentBrowserHost) {
      return currentBrowserHost;
    }
  }

  try {
    return remoteHttpHost(readPrimaryEnvironmentTarget()?.target.httpBaseUrl);
  } catch {
    return null;
  }
}

function primaryRunnableScript(
  scripts: readonly ProjectScript[] | undefined,
): ProjectScript | null {
  if (!scripts || scripts.length === 0) {
    return null;
  }
  return scripts.find((script) => !script.runOnWorktreeCreate) ?? scripts[0] ?? null;
}

export function inferBrowserAgentDevServerUrl(
  scripts: readonly ProjectScript[] | undefined,
): string {
  const script = primaryRunnableScript(scripts);
  const command = script?.command ?? "";
  const port = parsePort(command);
  if (port !== null) {
    return `http://localhost:${port}/`;
  }

  if (/\b(?:vite|vitest\s+--ui)\b/i.test(command)) {
    return "http://localhost:5173/";
  }
  if (/\bastro\b/i.test(command)) {
    return "http://localhost:4321/";
  }
  if (/\bnext\b/i.test(command)) {
    return DEFAULT_BROWSER_AGENT_DEV_SERVER_URL;
  }

  return DEFAULT_BROWSER_AGENT_DEV_SERVER_URL;
}

export function resolveBrowserAgentPreviewUrl(input: {
  readonly projectPreviewUrl?: string | null | undefined;
  readonly customPreviewUrl: string;
  readonly detectedDevServerUrl: string | null;
  readonly scripts: readonly ProjectScript[] | undefined;
}): string {
  const projectPreviewUrl = normalizeBrowserAgentPreviewUrl(input.projectPreviewUrl ?? "");
  const customPreviewUrl = normalizeBrowserAgentPreviewUrl(input.customPreviewUrl);
  return (
    projectPreviewUrl ||
    customPreviewUrl ||
    input.detectedDevServerUrl ||
    inferBrowserAgentDevServerUrl(input.scripts)
  );
}

export async function resolveBrowserAgentReachablePreviewUrl(
  devServerUrl: string,
): Promise<string> {
  const url = parseUrl(devServerUrl);
  if (!url || !isLocalDevServerHostname(url.hostname)) {
    return devServerUrl;
  }

  const reachableHost = await resolveReachablePreviewHost();
  if (!reachableHost) {
    return url.toString();
  }

  url.hostname = reachableHost;
  return url.toString();
}

export function shouldShowBrowserAgentControls(input: {
  readonly activeProjectName: string | undefined;
  readonly activeThreadEnvironmentId: EnvironmentId;
  readonly primaryEnvironmentId: EnvironmentId | null;
}): boolean {
  return (
    Boolean(input.activeProjectName) &&
    input.primaryEnvironmentId !== null &&
    input.activeThreadEnvironmentId === input.primaryEnvironmentId
  );
}
