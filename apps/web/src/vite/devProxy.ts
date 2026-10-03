import { DEV_PROXIED_PATH_PREFIXES } from "@t3tools/shared/devProxy";

export function resolveDevProxyTarget(
  backendPort: string | undefined,
  wsUrl: string | undefined,
): string | undefined {
  const port = Number(backendPort?.trim());
  if (Number.isInteger(port) && port > 0) {
    return `http://localhost:${port}/`;
  }

  if (!wsUrl) return undefined;

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

export function createDevProxyConfig(target: string | undefined) {
  if (!target) return undefined;

  return Object.fromEntries(
    DEV_PROXIED_PATH_PREFIXES.map((prefix) => [
      prefix,
      {
        target,
        changeOrigin: true,
        ...(prefix === "/ws" || prefix === "/api" ? { ws: true } : {}),
      },
    ]),
  );
}
