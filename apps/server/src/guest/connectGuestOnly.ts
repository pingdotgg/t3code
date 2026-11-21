import { GUEST_PAGE_PATH, GUEST_ROUTE_PREFIX } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

// T3 Dulli uses T3 Connect only to let guests in. Cloudflare sets these headers on requests that
// come through the tunnel, and a client cannot remove them, so such a request reaches only the
// guest page and its routes. Local, LAN and tailnet requests never carry them. Either one counts,
// in case a Cloudflare setting drops the visitor IP header.
const CONNECT_REQUEST_HEADERS = ["cf-connecting-ip", "cf-ray"];

// The relay checks a linked environment over the tunnel; its request is signed.
const RELAY_HEALTH_PATH = "/api/t3-connect/health";
// The web build's hashed files, and the icons and manifest at the root of its public folder.
const BUILD_ASSET_PREFIX = "/assets/";
const PUBLIC_FILE = /^\/[\w-]+\.(?:ico|png|svg|webmanifest)$/;

/** Whether a request that came through T3 Connect may reach this path. */
export function allowsConnectRequest(method: string, url: string): boolean {
  const path = url.split("?", 1)[0] ?? "";
  // Other routes match the raw path, so a path a router could resolve elsewhere is refused.
  if (/\/\.|%|\\|\/\//.test(path)) return false;
  const read = method === "GET" || method === "HEAD";
  if (path.startsWith(`${GUEST_ROUTE_PREFIX}/`)) return true;
  if (path === RELAY_HEALTH_PATH) return method === "POST";
  return (
    read &&
    (path === GUEST_PAGE_PATH || path.startsWith(BUILD_ASSET_PREFIX) || PUBLIC_FILE.test(path))
  );
}

export const layer = HttpRouter.middleware(
  (httpEffect) =>
    Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
      CONNECT_REQUEST_HEADERS.every((header) => request.headers[header] === undefined) ||
      allowsConnectRequest(request.method, request.url)
        ? httpEffect
        : Effect.succeed(HttpServerResponse.text("Not Found", { status: 404 })),
    ),
  { global: true },
);
