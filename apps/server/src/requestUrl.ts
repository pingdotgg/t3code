import * as Option from "effect/Option";
import { HttpServerRequest } from "effect/http";

/**
 * `HttpServerRequest.toURL` that honors `X-Forwarded-Proto: https`. Effect 4.1
 * stopped reading it, but TLS-terminating proxies in front of the server
 * (Tailscale Serve, tunnels) rely on it for OAuth, DPoP and pairing URLs.
 */
export const requestUrl = (request: HttpServerRequest.HttpServerRequest): Option.Option<URL> =>
  HttpServerRequest.toURL(
    request.headers["x-forwarded-proto"] === "https" && request.protocol !== "https"
      ? request.modify({ protocol: "https" })
      : request,
  );

const FORWARDED_PREFIX = /^\/(?!\/)[^?#\s]*[^/?#\s]$/u;
const FORWARDED_HOST = /^(?:[a-z0-9.-]+|\[[0-9a-f:.]+\])(?::\d{1,5})?$/iu;

/**
 * The URL the client addressed. A path-routing relay serves this server under a prefix such as
 * `/env/<key>` and strips it, saying so in `X-Forwarded-Prefix`; proofs sign the full URL. Its
 * WebSockets reach this server with a local Host, so the relay's host comes in `X-Forwarded-Host`.
 */
export const publicRequestUrl = (
  request: HttpServerRequest.HttpServerRequest,
): Option.Option<URL> =>
  Option.map(requestUrl(request), (url) => {
    const prefix = forwardedPrefix(request);
    if (prefix !== undefined) {
      url.pathname = `${prefix}${url.pathname}`;
      const host = request.headers["x-forwarded-host"];
      if (host !== undefined && FORWARDED_HOST.test(host)) {
        // Setting a host without a port keeps the old port.
        url.port = "";
        url.host = host;
      }
    }
    return url;
  });

/** Where this server's routes start for the client: its public origin, plus a relay's prefix. */
export const publicBaseUrl = (
  request: HttpServerRequest.HttpServerRequest,
): Option.Option<string> =>
  Option.map(publicRequestUrl(request), (url) => `${url.origin}${forwardedPrefix(request) ?? ""}`);

const forwardedPrefix = (request: HttpServerRequest.HttpServerRequest) => {
  const prefix = request.headers["x-forwarded-prefix"];
  return prefix !== undefined && FORWARDED_PREFIX.test(prefix) ? prefix : undefined;
};
