import { normalizeHostname } from "./hostClassification.ts";

export const REMOTE_PREVIEW_PROXY_TUNNEL_PATH = "/api/preview-proxy/tunnel";
export const REMOTE_PREVIEW_PROXY_RENEW_PATH = "/api/preview-proxy/renew";
export const REMOTE_PREVIEW_PROXY_REVOKE_PATH = "/api/preview-proxy/revoke";
export const REMOTE_PREVIEW_PROXY_GRANT_HEADER = "x-t3-preview-proxy-grant";

export type RemotePreviewProxyDialHost = "localhost" | "::1" | `127.${string}`;

const isLoopbackIpv4 = (host: string): boolean => {
  const parts = host.split(".");
  return (
    parts.length === 4 &&
    parts.every((part) => /^\d{1,3}$/u.test(part) && Number(part) <= 255) &&
    parts[0] === "127"
  );
};

/**
 * The environment-side host a browser loopback name stands for, or null for any other host.
 * Unspecified addresses (`0.0.0.0`, `::`) and `*.localhost` mean the environment's own loopback.
 */
const ipv4FromMapped = (host: string): string | null => {
  if (!host.startsWith("::ffff:")) return null;
  const suffix = host.slice("::ffff:".length);
  if (suffix.includes(".")) return suffix;
  const hextets = suffix.split(":");
  if (hextets.length !== 2 || hextets.some((part) => !/^[\da-f]{1,4}$/u.test(part))) return null;
  const high = Number.parseInt(hextets[0]!, 16);
  const low = Number.parseInt(hextets[1]!, 16);
  return [high >>> 8, high & 0xff, low >>> 8, low & 0xff].join(".");
};

export const remotePreviewProxyDialHost = (hostname: string): RemotePreviewProxyDialHost | null => {
  const normalized = normalizeHostname(hostname);
  const host = ipv4FromMapped(normalized) ?? normalized;
  if (host === "::1" || host === "0:0:0:0:0:0:0:1") return "::1";
  if (isLoopbackIpv4(host)) return host as `127.${string}`;
  if (host === "0:0:0:0:0:0:0:0") return "localhost";
  if (host === "localhost" || host.endsWith(".localhost") || host === "0.0.0.0" || host === "::") {
    return "localhost";
  }
  return null;
};

/** Only canonical dial hosts are accepted on the wire, so the server never resolves a name. */
export const isRemotePreviewProxyDialHost = (host: string): host is RemotePreviewProxyDialHost =>
  host === "localhost" || host === "::1" || isLoopbackIpv4(host);
