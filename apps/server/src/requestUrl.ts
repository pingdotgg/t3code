import * as Option from "effect/Option";
import { HttpServerRequest } from "effect/http";

// A TLS-terminating proxy reports `wss` for an upgraded WebSocket request and `https`
// for plain HTTP on the same host, so both mean the client reached us over TLS.
const isHttpsForwardedProto = (proto: string | undefined): boolean =>
  proto === "https" || proto === "wss";

/**
 * `HttpServerRequest.toURL` that honors `X-Forwarded-Proto: https` and `wss`.
 * Effect 4.1 stopped reading it, but TLS-terminating proxies in front of the
 * server (Tailscale Serve, tunnels, Traefik) rely on it for OAuth, DPoP and
 * pairing URLs. DPoP compares the client's signed `htu` against this URL, so a
 * `/ws` upgrade forwarded as `wss` fails with `url_mismatch` when it is missed.
 */
export const requestUrl = (request: HttpServerRequest.HttpServerRequest): Option.Option<URL> =>
  HttpServerRequest.toURL(
    isHttpsForwardedProto(request.headers["x-forwarded-proto"]) &&
      request.protocol !== "https"
      ? request.modify({ protocol: "https" })
      : request,
  );
