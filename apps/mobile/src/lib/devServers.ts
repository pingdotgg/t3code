import type { DiscoveredLocalServer } from "@t3tools/contracts";
import {
  isLocalLoopbackHost,
  isLoopbackHost,
  isPrivateNetworkHost,
  normalizePreviewUrl,
} from "@t3tools/shared/preview";

export interface ResolvedDevServer {
  readonly server: DiscoveredLocalServer;
  readonly url: string;
  readonly reachable: boolean;
}

/**
 * Rewrite a dev server's loopback URL onto the environment host so this
 * device can reach it. The phone is never the machine the server scanned, so
 * `localhost:PORT` only works after substituting the address the environment
 * is connected through (LAN IP, tailnet name, …). Marked unreachable when the
 * environment is only reachable through a public host such as a tunnel, which
 * does not forward arbitrary dev ports.
 */
export function resolveDevServerUrl(
  httpBaseUrl: string | null,
  server: DiscoveredLocalServer,
): ResolvedDevServer {
  try {
    const parsed = new URL(normalizePreviewUrl(server.url));
    if (!isLoopbackHost(parsed.hostname)) {
      return { server, url: parsed.href, reachable: true };
    }
    if (httpBaseUrl === null) {
      return { server, url: parsed.href, reachable: false };
    }
    const environmentUrl = new URL(httpBaseUrl);
    if (isLocalLoopbackHost(environmentUrl.hostname)) {
      // The environment address is loopback from this device's point of view
      // (e.g. a simulator whose localhost forwards to its host machine), so
      // the discovered URL already resolves to the right place.
      return { server, url: parsed.href, reachable: true };
    }
    if (!isPrivateNetworkHost(environmentUrl.hostname)) {
      return { server, url: parsed.href, reachable: false };
    }
    const environmentHost = environmentUrl.hostname.replace(/^\[|\]$/g, "");
    const resolvedHost = environmentHost.includes(":") ? `[${environmentHost}]` : environmentHost;
    const rewritten = new URL(
      `${parsed.protocol}//${resolvedHost}:${server.port}${parsed.pathname}${parsed.search}${parsed.hash}`,
    );
    return { server, url: rewritten.href, reachable: true };
  } catch {
    return { server, url: server.url, reachable: false };
  }
}

export function devServerLabel(server: DiscoveredLocalServer): string {
  return `localhost:${server.port}`;
}

export function devServerDescription(resolved: ResolvedDevServer): string {
  if (!resolved.reachable) {
    return "Not reachable over this connection";
  }
  return resolved.server.processName ?? "Linked dev server";
}
