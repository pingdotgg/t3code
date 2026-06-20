import { PRIMARY_LOCAL_ENVIRONMENT_ID, type DesktopEnvironmentBootstrap } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const PrimaryEnvironmentTargetSource = Schema.Literals([
  "configured",
  "window-origin",
  "desktop-managed",
]);
type PrimaryEnvironmentTargetSource = typeof PrimaryEnvironmentTargetSource.Type;

const PrimaryEnvironmentUrlKind = Schema.Literals([
  "http-base-url",
  "websocket-base-url",
  "development-server-url",
  "window-location-url",
]);
type PrimaryEnvironmentUrlKind = typeof PrimaryEnvironmentUrlKind.Type;

export class PrimaryEnvironmentUrlInvalidError extends Schema.TaggedErrorClass<PrimaryEnvironmentUrlInvalidError>()(
  "PrimaryEnvironmentUrlInvalidError",
  {
    source: PrimaryEnvironmentTargetSource,
    urlKind: PrimaryEnvironmentUrlKind,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not parse ${this.urlKind} for the ${this.source} primary environment target.`;
  }
}

export class PrimaryEnvironmentProtocolUnsupportedError extends Schema.TaggedErrorClass<PrimaryEnvironmentProtocolUnsupportedError>()(
  "PrimaryEnvironmentProtocolUnsupportedError",
  {
    source: PrimaryEnvironmentTargetSource,
    protocol: Schema.String,
  },
) {
  override get message(): string {
    return `The ${this.source} primary environment target uses unsupported protocol ${this.protocol}.`;
  }
}

export class DesktopEnvironmentBootstrapIncompleteError extends Schema.TaggedErrorClass<DesktopEnvironmentBootstrapIncompleteError>()(
  "DesktopEnvironmentBootstrapIncompleteError",
  {
    hasHttpBaseUrl: Schema.Boolean,
    hasWsBaseUrl: Schema.Boolean,
  },
) {
  override get message(): string {
    const missing = [
      ...(this.hasHttpBaseUrl ? [] : ["httpBaseUrl"]),
      ...(this.hasWsBaseUrl ? [] : ["wsBaseUrl"]),
    ];
    return `Desktop bootstrap is missing ${missing.join(" and ")} for the local environment.`;
  }
}

export const isPrimaryEnvironmentUrlInvalidError = Schema.is(PrimaryEnvironmentUrlInvalidError);
export const isPrimaryEnvironmentProtocolUnsupportedError = Schema.is(
  PrimaryEnvironmentProtocolUnsupportedError,
);
export const isDesktopEnvironmentBootstrapIncompleteError = Schema.is(
  DesktopEnvironmentBootstrapIncompleteError,
);

export interface PrimaryEnvironmentTarget {
  readonly source: PrimaryEnvironmentTargetSource;
  readonly target: {
    readonly httpBaseUrl: string;
    readonly wsBaseUrl: string;
  };
}

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "::1", "localhost"]);

function getDesktopLocalEnvironmentBootstrap(): DesktopEnvironmentBootstrap | null {
  // The primary (Windows-native) backend keeps the "primary" id. The
  // plural list may include a second WSL entry; the primary-target
  // resolver only cares about the primary, so just find it.
  const bootstraps = window.desktopBridge?.getLocalEnvironmentBootstraps() ?? [];
  return bootstraps.find((entry) => entry.id === PRIMARY_LOCAL_ENVIRONMENT_ID) ?? null;
}

function parseTargetUrl(input: {
  readonly rawValue: string;
  readonly baseUrl?: string;
  readonly source: PrimaryEnvironmentTargetSource;
  readonly urlKind: PrimaryEnvironmentUrlKind;
}): URL {
  try {
    return input.baseUrl === undefined
      ? new URL(input.rawValue)
      : new URL(input.rawValue, input.baseUrl);
  } catch (cause) {
    throw new PrimaryEnvironmentUrlInvalidError({
      source: input.source,
      urlKind: input.urlKind,
      cause,
    });
  }
}

function currentWindowBaseUrl(): string {
  return window.location.origin === "null" ? window.location.href : window.location.origin;
}

function normalizeBaseUrl(
  rawValue: string,
  source: PrimaryEnvironmentTargetSource,
  urlKind: PrimaryEnvironmentUrlKind,
): string {
  return parseTargetUrl({
    rawValue,
    baseUrl: currentWindowBaseUrl(),
    source,
    urlKind,
  }).toString();
}

function swapBaseUrlProtocol(
  rawValue: string,
  nextProtocol: "http:" | "https:" | "ws:" | "wss:",
  urlKind: PrimaryEnvironmentUrlKind,
): string {
  const url = parseTargetUrl({
    rawValue,
    baseUrl: window.location.origin,
    source: "configured",
    urlKind,
  });
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

function effectiveUrlOrigin(url: URL): string {
  return url.origin === "null" ? `${url.protocol}//${url.host}` : url.origin;
}

function originBaseUrl(origin: string): string {
  return origin.endsWith("/") ? origin : `${origin}/`;
}

function resolveHttpRequestBaseUrl(primaryTarget: PrimaryEnvironmentTarget): string {
  const httpBaseUrl = primaryTarget.target.httpBaseUrl;
  const currentUrl = parseTargetUrl({
    rawValue: window.location.href,
    source: "window-origin",
    urlKind: "window-location-url",
  });
  const targetUrl = parseTargetUrl({
    rawValue: httpBaseUrl,
    source: primaryTarget.source,
    urlKind: "http-base-url",
  });
  const currentOrigin = effectiveUrlOrigin(currentUrl);
  const isCurrentOriginDesktopDevApp =
    currentUrl.protocol === "t3code-dev:" && currentUrl.host === "app";

  if (currentOrigin === targetUrl.origin || !isLoopbackHostname(targetUrl.hostname)) {
    return httpBaseUrl;
  }

  if (isCurrentOriginDesktopDevApp) {
    return originBaseUrl(currentOrigin);
  }

  const configuredDevServerUrl = import.meta.env.VITE_DEV_SERVER_URL?.trim();
  if (!configuredDevServerUrl) {
    return httpBaseUrl;
  }

  const devServerUrl = parseTargetUrl({
    rawValue: configuredDevServerUrl,
    baseUrl: originBaseUrl(currentOrigin),
    source: "configured",
    urlKind: "development-server-url",
  });

  const isCurrentOriginDevServer =
    (currentUrl.protocol === "http:" || currentUrl.protocol === "https:") &&
    currentOrigin === devServerUrl.origin;
  if (!isCurrentOriginDevServer || !isLoopbackHostname(currentUrl.hostname)) {
    return httpBaseUrl;
  }

  return originBaseUrl(currentOrigin);
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
      ? swapBaseUrlProtocol(configuredWsBaseUrl, "https:", "websocket-base-url")
      : swapBaseUrlProtocol(configuredWsBaseUrl!, "http:", "websocket-base-url"));
  const resolvedWsBaseUrl =
    configuredWsBaseUrl ??
    (configuredHttpBaseUrl?.startsWith("https:")
      ? swapBaseUrlProtocol(configuredHttpBaseUrl, "wss:", "http-base-url")
      : swapBaseUrlProtocol(configuredHttpBaseUrl!, "ws:", "http-base-url"));

  return {
    source: "configured",
    target: {
      httpBaseUrl: resolveHttpRequestBaseUrl({
        source: "configured",
        target: {
          httpBaseUrl: normalizeBaseUrl(resolvedHttpBaseUrl, "configured", "http-base-url"),
          wsBaseUrl: normalizeBaseUrl(resolvedWsBaseUrl, "configured", "websocket-base-url"),
        },
      }),
      wsBaseUrl: normalizeBaseUrl(resolvedWsBaseUrl, "configured", "websocket-base-url"),
    },
  };
}

function resolveWindowOriginPrimaryTarget(): PrimaryEnvironmentTarget {
  const url = parseTargetUrl({
    rawValue: window.location.origin,
    source: "window-origin",
    urlKind: "http-base-url",
  });
  const httpBaseUrl = url.toString();
  if (url.protocol === "http:") {
    url.protocol = "ws:";
  } else if (url.protocol === "https:") {
    url.protocol = "wss:";
  } else {
    throw new PrimaryEnvironmentProtocolUnsupportedError({
      source: "window-origin",
      protocol: url.protocol,
    });
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
    throw new DesktopEnvironmentBootstrapIncompleteError({
      hasHttpBaseUrl: Boolean(desktopBootstrap.httpBaseUrl),
      hasWsBaseUrl: Boolean(desktopBootstrap.wsBaseUrl),
    });
  }

  return {
    source: "desktop-managed",
    target: {
      httpBaseUrl: resolveHttpRequestBaseUrl({
        source: "desktop-managed",
        target: {
          httpBaseUrl: normalizeBaseUrl(
            desktopBootstrap.httpBaseUrl,
            "desktop-managed",
            "http-base-url",
          ),
          wsBaseUrl: normalizeBaseUrl(
            desktopBootstrap.wsBaseUrl,
            "desktop-managed",
            "websocket-base-url",
          ),
        },
      }),
      wsBaseUrl: normalizeBaseUrl(
        desktopBootstrap.wsBaseUrl,
        "desktop-managed",
        "websocket-base-url",
      ),
    },
  };
}

export function resolvePrimaryEnvironmentHttpUrl(
  pathname: string,
  searchParams?: Record<string, string>,
): string {
  const primaryTarget = readPrimaryEnvironmentTarget();

  const url = parseTargetUrl({
    rawValue: resolveHttpRequestBaseUrl(primaryTarget),
    source: primaryTarget.source,
    urlKind: "http-base-url",
  });
  url.pathname = pathname;
  if (searchParams) {
    url.search = new URLSearchParams(searchParams).toString();
  }
  return url.toString();
}

export function readPrimaryEnvironmentTarget(): PrimaryEnvironmentTarget {
  return (
    resolveDesktopPrimaryTarget() ??
    resolveConfiguredPrimaryTarget() ??
    resolveWindowOriginPrimaryTarget()
  );
}
