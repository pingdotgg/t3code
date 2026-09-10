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
