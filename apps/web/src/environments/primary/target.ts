import type { DesktopEnvironmentBootstrap } from "@t3tools/contracts";
import type { KnownEnvironment } from "@t3tools/client-runtime";

export interface PrimaryEnvironmentTarget {
  readonly source: KnownEnvironment["source"];
  readonly target: KnownEnvironment["target"];
}

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "::1", "localhost"]);

function getDesktopLocalEnvironmentBootstrap(): DesktopEnvironmentBootstrap | null {
  return window.desktopBridge?.getLocalEnvironmentBootstrap() ?? null;
}

function normalizeBaseUrl(rawValue: string): string {
  return new URL(rawValue, window.location.origin).toString();
}

function swapBaseUrlProtocol(
  rawValue: string,
  nextProtocol: "http:" | "https:" | "ws:" | "wss:",
): string {
  const url = new URL(normalizeBaseUrl(rawValue));
  url.protocol = nextProtocol;
  return url.toString();
}

function normalizeHostname(hostname: string): string {
  return hostname
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1");
}

export function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(normalizeHostname(hostname));
}

function resolveHttpRequestBaseUrl(httpBaseUrl: string): string {
  const configuredDevServerUrl = import.meta.env.VITE_DEV_SERVER_URL?.trim();
  if (!configuredDevServerUrl) {
    return httpBaseUrl;
  }

  const currentUrl = new URL(window.location.href);
  const targetUrl = new URL(httpBaseUrl);
  const devServerUrl = new URL(configuredDevServerUrl, currentUrl.origin);

  const isCurrentOriginDevServer =
    (currentUrl.protocol === "http:" || currentUrl.protocol === "https:") &&
    currentUrl.origin === devServerUrl.origin;

  if (
    !isCurrentOriginDevServer ||
    currentUrl.origin === targetUrl.origin ||
    !isLoopbackHostname(currentUrl.hostname) ||
    !isLoopbackHostname(targetUrl.hostname)
  ) {
    return httpBaseUrl;
  }

  return currentUrl.origin;
}

function resolveConfiguredPrimaryTarget(): PrimaryEnvironmentTarget | null {
  const configuredHttpBaseUrl = import.meta.env.VITE_HTTP_URL?.trim() || undefined;
  const configuredWsBaseUrl = import.meta.env.VITE_WS_URL?.trim() || undefined;

  if (!configuredHttpBaseUrl && !configuredWsBaseUrl) {
    return null;
  }

  const resolvedHttpBaseUrl =
    configuredHttpBaseUrl ??
    (configuredWsBaseUrl?.startsWith("wss:")
      ? swapBaseUrlProtocol(configuredWsBaseUrl, "https:")
      : swapBaseUrlProtocol(configuredWsBaseUrl!, "http:"));
  const resolvedWsBaseUrl =
    configuredWsBaseUrl ??
    (configuredHttpBaseUrl?.startsWith("https:")
      ? swapBaseUrlProtocol(configuredHttpBaseUrl, "wss:")
      : swapBaseUrlProtocol(configuredHttpBaseUrl!, "ws:"));

  return {
    source: "configured",
    target: {
      httpBaseUrl: normalizeBaseUrl(resolvedHttpBaseUrl),
      wsBaseUrl: normalizeBaseUrl(resolvedWsBaseUrl),
    },
  };
}

function resolveWindowOriginPrimaryTarget(): PrimaryEnvironmentTarget {
  const httpBaseUrl = normalizeBaseUrl(window.location.origin);
  const url = new URL(httpBaseUrl);
  if (url.protocol === "http:") {
    url.protocol = "ws:";
  } else if (url.protocol === "https:") {
    url.protocol = "wss:";
  } else {
    throw new Error(`Unsupported HTTP base URL protocol: ${url.protocol}`);
  }
  return {
    source: "window-origin",
    target: {
      httpBaseUrl,
      wsBaseUrl: url.toString(),
    },
  };
}

function resolveDesktopPrimaryTarget(): PrimaryEnvironmentTarget | null {
  const desktopBootstrap = getDesktopLocalEnvironmentBootstrap();
  if (!desktopBootstrap) {
    return null;
  }
  if (!desktopBootstrap.httpBaseUrl && !desktopBootstrap.wsBaseUrl) {
    return null;
  }
  if (!desktopBootstrap.httpBaseUrl || !desktopBootstrap.wsBaseUrl) {
    throw new Error(
      "Desktop bootstrap must provide both httpBaseUrl and wsBaseUrl for the local environment.",
    );
  }

  return {
    source: "desktop-managed",
    target: {
      httpBaseUrl: normalizeBaseUrl(desktopBootstrap.httpBaseUrl),
      wsBaseUrl: normalizeBaseUrl(desktopBootstrap.wsBaseUrl),
    },
  };
}

export function resolvePrimaryEnvironmentHttpUrl(
  pathname: string,
  searchParams?: Record<string, string>,
): string {
  const primaryTarget = readPrimaryEnvironmentTarget();
  if (!primaryTarget) {
    throw new Error("Unable to resolve the primary environment HTTP base URL.");
  }

  const url = new URL(resolveHttpRequestBaseUrl(primaryTarget.target.httpBaseUrl));
  url.pathname = pathname;
  if (searchParams) {
    url.search = new URLSearchParams(searchParams).toString();
  }
  return url.toString();
}

export function readPrimaryEnvironmentTarget(): PrimaryEnvironmentTarget | null {
  return (
    resolveDesktopPrimaryTarget() ??
    resolveConfiguredPrimaryTarget() ??
    resolveWindowOriginPrimaryTarget()
  );
}
