import {
  HEADER_ORIGINAL_URL,
  HEADER_PROXY_SHARED_SECRET,
} from "../core/proxy/ProxyHeaders.shared.ts";
import type { IncomingMessage } from "node:http";
import type { TLSSocket } from "node:tls";
import type { IncomingHttpHeaders } from "node:http";

/**
 * Resolves the client-facing host of an incoming dev-server request.
 *
 * When the dev server runs behind a proxy or tunnel (e.g. ngrok or
 * `cloudflared`), the `Host` header carries the local address while the
 * public host arrives in `X-Forwarded-Host`. Preferring the forwarded host
 * lets the worker see the URL the client actually requested.
 */
export function resolveForwardedHost(
  headers: IncomingHttpHeaders,
  fallbackHost: string,
): string {
  return (
    firstHeaderValue(headers["x-forwarded-host"]) ??
    firstHeaderValue(headers.host) ??
    fallbackHost
  );
}

function firstHeaderValue(
  value: string | Array<string> | undefined,
): string | undefined {
  // Proxy chains may append to a single header ("host1, host2") instead of
  // repeating it; only the first entry is the client-facing host.
  const raw = Array.isArray(value) ? value[0] : value;
  const first = raw?.split(",")[0]?.trim();
  return first ? first : undefined;
}

/** Sign the client-facing URL for the runtime entry worker, including TLS termination. */
export function proxyRequestHeaders(
  request: IncomingMessage,
  target: URL,
  proxySharedSecret: string,
): IncomingHttpHeaders {
  const original = new URL(target);
  const protocol = firstHeaderValue(request.headers["x-forwarded-proto"]);
  original.protocol =
    protocol === "https" || protocol === "http"
      ? `${protocol}:`
      : (request.socket as TLSSocket).encrypted
        ? "https:"
        : "http:";
  original.port = "";
  original.host = resolveForwardedHost(request.headers, target.host);
  return {
    ...request.headers,
    host: original.host,
    [HEADER_ORIGINAL_URL.toLowerCase()]: original.href,
    [HEADER_PROXY_SHARED_SECRET.toLowerCase()]: proxySharedSecret,
  };
}
