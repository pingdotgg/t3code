import * as Option from "effect/Option";
import { HttpServerRequest } from "effect/http";

// Traefik forwards `wss` instead of `https` on WebSocket upgrades.
const SECURE_FORWARDED_PROTOS = new Set(["https", "wss"]);

/**
 * `HttpServerRequest.toURL` that honors `X-Forwarded-Proto: https`. Effect 4.1
 * stopped reading it, but TLS-terminating proxies in front of the server
 * (Tailscale Serve, tunnels) rely on it for OAuth, DPoP and pairing URLs.
 */
export const requestUrl = (request: HttpServerRequest.HttpServerRequest): Option.Option<URL> => {
  const forwardedProto = request.headers["x-forwarded-proto"];
  return HttpServerRequest.toURL(
    forwardedProto !== undefined &&
      SECURE_FORWARDED_PROTOS.has(forwardedProto) &&
      request.protocol !== "https"
      ? request.modify({ protocol: "https" })
      : request,
  );
};
