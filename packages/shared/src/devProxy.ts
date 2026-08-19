/**
 * Backend paths the web dev server proxies in single-origin browser dev.
 *
 * Two consumers must agree on this list: the Vite proxy map
 * (apps/web/vite.config.ts) that forwards these to the backend, and the
 * server's dev catch-all (apps/server/src/http.ts) that 404s them instead of
 * redirecting back to Vite. Drift is silent and nasty in both directions — a
 * prefix only Vite knows gets answered with index.html; a prefix only the
 * server knows redirect-loops through the proxy.
 */
export const DEV_PROXIED_PATH_PREFIXES = ["/api", "/oauth", "/.well-known", "/ws"] as const;

/** Internal listener and proxy host for worktree-local development services. */
export const DEV_LOOPBACK_HOST = "127.0.0.1";

/** Host advertised to Chromium so either IPv4 or IPv6 loopback listeners remain reachable. */
export const DEV_BROWSER_LOOPBACK_HOST = "localhost";

export function resolveDevProxyTarget(
  backendPort: string | undefined,
  wsUrl: string | undefined,
  backendHost: string | undefined,
): string | undefined {
  // Browser dev is single-origin: the backend port is proxied through the web
  // server so the app works from any origin (localhost, tailnet, LAN, phone).
  const port = Number(backendPort?.trim());
  if (Number.isInteger(port) && port > 0) {
    const normalizedHost = backendHost?.trim();
    const proxyHost =
      normalizedHost === "::1" ||
      normalizedHost === "[::1]" ||
      normalizedHost === "::" ||
      normalizedHost === "[::]"
        ? "[::1]"
        : normalizedHost === "0.0.0.0" || !normalizedHost
          ? DEV_LOOPBACK_HOST
          : normalizedHost === DEV_BROWSER_LOOPBACK_HOST
            ? DEV_BROWSER_LOOPBACK_HOST
            : normalizedHost.includes(":") && !normalizedHost.startsWith("[")
              ? `[${normalizedHost}]`
              : normalizedHost;
    return `http://${proxyHost}:${port}/`;
  }

  // Desktop dev points the renderer straight at the backend, so fall back to
  // deriving the target from its explicit websocket URL.
  if (!wsUrl) {
    return undefined;
  }

  try {
    const url = new URL(wsUrl);
    if (url.protocol === "ws:") {
      url.protocol = "http:";
    } else if (url.protocol === "wss:") {
      url.protocol = "https:";
    }
    url.pathname = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

export function isDevProxiedPath(pathname: string): boolean {
  return DEV_PROXIED_PATH_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}
