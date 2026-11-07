import { LAN_GATEWAY_ROUTE_PREFIX, type EnvironmentId } from "@t3tools/contracts";
import { gatewayPathPrefix } from "@t3tools/shared/advertisedEndpoint";
import * as Option from "effect/Option";

export * from "@t3tools/shared/advertisedEndpoint";

export { gatewayPathPrefix };

/** Join a gateway host origin with `/__t3_gateway/:peerId/` for pairing or learned routes. */
export const gatewayPeerHttpBaseUrl = (
  gatewayHttpBaseUrl: string,
  peerEnvironmentId: EnvironmentId,
): string => {
  const origin = new URL(gatewayHttpBaseUrl).origin;
  return `${origin}${LAN_GATEWAY_ROUTE_PREFIX}/${peerEnvironmentId}/`;
};

export const environmentEndpointUrl = (httpBaseUrl: string, pathname: string): string => {
  const next = new URL(httpBaseUrl);
  next.pathname = `${gatewayPathPrefix(next)}${pathname}`;
  next.search = "";
  next.hash = "";
  return next.toString();
};

const RELATIVE_URL_BASE = "http://relative.invalid";

/** Takes an absolute URL or a server-relative one, and returns the same kind. */
export const withGatewayTicket = (url: string, ticket: Option.Option<string>): string => {
  if (Option.isNone(ticket)) return url;
  const next = new URL(url, RELATIVE_URL_BASE);
  next.searchParams.set("gatewayTicket", ticket.value);
  return next.origin === RELATIVE_URL_BASE
    ? `${next.pathname}${next.search}${next.hash}`
    : next.toString();
};
