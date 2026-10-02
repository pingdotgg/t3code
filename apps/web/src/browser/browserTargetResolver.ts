import type { ConnectionTarget } from "@t3tools/client-runtime/connection";
import type { EnvironmentCatalogState } from "@t3tools/client-runtime/state/connections";
import type {
  BrowserNavigationTarget,
  EnvironmentId,
  PreviewUrlResolution,
} from "@t3tools/contracts";
import { isLoopbackHost, normalizePreviewUrl } from "@t3tools/shared/preview";
import { isLocalLoopbackHost, isPrivateNetworkHost } from "@t3tools/shared/hostClassification";

import { environmentCatalog } from "~/connection/catalog";
import { isDesktopLocalConnectionTarget } from "~/connection/desktopLocal";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { readPreparedConnection } from "~/state/session";

/** Advertised server URL plus the connection target used to choose a host. */
interface BrowserSessionConnection {
  readonly httpBaseUrl: string;
  readonly target: ConnectionTarget;
}

/** Prepared session before host selection decides whether the target is required. */
interface PreparedBrowserSession {
  readonly httpBaseUrl: string;
  readonly target: ConnectionTarget | undefined;
}

export {
  normalizeHostname,
  isLocalLoopbackHost,
  isPrivateNetworkHost,
  isPublicFaviconHost,
} from "@t3tools/shared/hostClassification";

/**
 * Target from the mounted environment catalog. That entry is the connection
 * the session was opened with, including desktop-local `local:` ids. Returns
 * undefined when the catalog is not mounted yet so startup does not build it.
 */
const readMountedCatalogTarget = (environmentId: EnvironmentId): ConnectionTarget | undefined => {
  const node = appAtomRegistry.getNodes().get(environmentCatalog.catalogValueAtom);
  if (node === undefined) return undefined;
  const state = node.currentState();
  if (state !== "valid" && state !== "stale") return undefined;
  const catalog: EnvironmentCatalogState = node.value();
  return catalog.entries.get(environmentId)?.target;
};

/** Target carried on a prepared connection. Real sessions can omit it. */
const readPreparedTarget = (connection: {
  readonly target?: ConnectionTarget | undefined;
}): ConnectionTarget | undefined => connection.target;

/**
 * Session used for browser host selection. The mounted catalog target wins;
 * the prepared connection supplies the advertised URL and its target when the
 * catalog entry is not available yet.
 */
const readEnvironmentConnection = (environmentId: EnvironmentId): PreparedBrowserSession => {
  const connection = readPreparedConnection(environmentId);
  if (!connection) throw new Error(`Environment ${environmentId} is not connected.`);
  return {
    httpBaseUrl: connection.httpBaseUrl,
    target: readMountedCatalogTarget(environmentId) ?? readPreparedTarget(connection),
  };
};

/** Requires the connection target once the environment host is privately reachable. */
const requireSessionTarget = (connection: PreparedBrowserSession): BrowserSessionConnection => {
  if (connection.target === undefined) {
    throw new Error("Prepared connection is missing its target.");
  }
  return { httpBaseUrl: connection.httpBaseUrl, target: connection.target };
};

/** True in the desktop renderer, which shares loopback with a local primary backend. */
const isDesktopRenderer = (): boolean =>
  typeof window !== "undefined" && window.desktopBridge !== undefined;

/**
 * Desktop-local backends share the renderer's loopback namespace. WSL2 NAT
 * advertises the distro eth0 address for the T3 server, which is bound on
 * 0.0.0.0 because wslhost forwarding is flaky for that process. A dev server
 * bound only to 127.0.0.1 is reached from the Windows webview at localhost.
 * Saved remote hosts keep their own address.
 */
const prefersClientLoopback = (connection: BrowserSessionConnection): boolean => {
  const target = connection.target;
  if (isDesktopLocalConnectionTarget(target)) return true;
  return target._tag === "PrimaryConnectionTarget" && isDesktopRenderer();
};

/**
 * Builds the preview URL for an environment port. Loopback and desktop-local
 * connections stay on localhost; other private-network hosts keep the
 * environment address.
 */
const resolveEnvironmentPortTarget = (
  environmentId: EnvironmentId,
  target: Extract<BrowserNavigationTarget, { readonly kind: "environment-port" }>,
  connection: PreparedBrowserSession,
  requestedUrl?: string,
  sourceUrl?: URL,
): PreviewUrlResolution => {
  const environmentUrl = new URL(connection.httpBaseUrl);
  if (!isPrivateNetworkHost(environmentUrl.hostname)) {
    throw new Error(
      "This environment port needs the planned authenticated preview gateway; its server address is not directly private-network reachable.",
    );
  }
  const session = requireSessionTarget(connection);
  const protocol = target.protocol ?? "http";
  const path = target.path?.startsWith("/") ? target.path : `/${target.path ?? ""}`;
  const normalizedEnvironmentHost = environmentUrl.hostname.replace(/^\[|\]$/g, "");
  // Loopback environments, and desktop-local ones reached through a
  // non-loopback advertisement, use `localhost` so Chromium's dual-stack
  // lookup can reach a server bound only to ::1 or 127.0.0.1.
  const preserveLoopback =
    prefersClientLoopback(session) || isLocalLoopbackHost(normalizedEnvironmentHost);
  const resolvedHost = preserveLoopback
    ? "localhost"
    : normalizedEnvironmentHost.includes(":")
      ? `[${normalizedEnvironmentHost}]`
      : normalizedEnvironmentHost;
  const resolved = sourceUrl
    ? new URL(sourceUrl)
    : new URL(path, `${protocol}://${resolvedHost}:${target.port}`);
  if (sourceUrl) {
    resolved.hostname = resolvedHost;
    resolved.port = String(target.port);
  }
  return {
    requestedUrl: requestedUrl ?? `${protocol}://localhost:${target.port}${path}`,
    resolvedUrl: resolved.toString(),
    resolutionKind: preserveLoopback ? "direct" : "direct-private-network",
    environmentId,
  };
};

/**
 * Resolves a browser navigation target against the environment connection.
 * Explicit URLs are returned unchanged; environment ports are mapped to
 * localhost or the environment host.
 */
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
  return resolveEnvironmentPortTarget(
    environmentId,
    target,
    readEnvironmentConnection(environmentId),
  );
}

/**
 * Rewrites a discovered loopback server onto the environment host, or keeps
 * localhost when that connection shares the client's loopback namespace.
 * Non-loopback URLs and values that fail to parse are returned unchanged.
 */
export function resolveDiscoveredServerUrl(environmentId: EnvironmentId, rawUrl: string): string {
  try {
    const normalizedUrl = normalizePreviewUrl(rawUrl);
    const parsed = new URL(normalizedUrl);
    if (!isLoopbackHost(parsed.hostname)) return normalizedUrl;
    return resolveEnvironmentPortTarget(
      environmentId,
      {
        kind: "environment-port",
        port: Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80)),
        protocol: parsed.protocol === "https:" ? "https" : "http",
        path: `${parsed.pathname}${parsed.search}${parsed.hash}`,
      },
      readEnvironmentConnection(environmentId),
      rawUrl,
      parsed,
    ).resolvedUrl;
  } catch (error) {
    // Host selection requires the catalog target. Surface that failure
    // instead of opening the raw discovered URL.
    if (error instanceof Error && error.message.includes("missing its target")) throw error;
    return rawUrl;
  }
}
