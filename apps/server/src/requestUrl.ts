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

/**
 * The URL the client addressed. A path-routing relay serves this server under a prefix such as
 * `/env/<key>` and strips it, saying so in `X-Forwarded-Prefix`; proofs sign the full URL.
 */
export const publicRequestUrl = (
  request: HttpServerRequest.HttpServerRequest,
): Option.Option<URL> =>
  Option.map(requestUrl(request), (url) => {
    const prefix = request.headers["x-forwarded-prefix"];
    if (prefix !== undefined && FORWARDED_PREFIX.test(prefix)) {
      url.pathname = `${prefix}${url.pathname}`;
    }
    return url;
  });
