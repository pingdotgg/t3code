import * as Option from "effect/Option";
import { HttpServerRequest } from "effect/http";

/**
 * `HttpServerRequest.toURL` that honors `X-Forwarded-Proto: https` and
 * `X-Forwarded-Host`. Effect reads neither, but proxies in front of the server
 * (Tailscale Serve, tunnels) rely on them for OAuth, DPoP and pairing URLs.
 */
export const requestUrl = (request: HttpServerRequest.HttpServerRequest): Option.Option<URL> => {
  const url = HttpServerRequest.toURL(
    request.headers["x-forwarded-proto"] === "https" && request.protocol !== "https"
      ? request.modify({ protocol: "https" })
      : request,
  );
  const forwardedHost = request.headers["x-forwarded-host"]?.split(",")[0]?.trim();
  if (!forwardedHost || Option.isNone(url)) return url;
  const { protocol, pathname, search, hash } = url.value;
  try {
    // `.` keeps a pathname starting with `//` from replacing the host, as in `toURL`.
    return Option.some(new URL(`.${pathname}${search}${hash}`, `${protocol}//${forwardedHost}`));
  } catch {
    return Option.none();
  }
};
