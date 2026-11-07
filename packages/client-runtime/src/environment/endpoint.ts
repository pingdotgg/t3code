import { LAN_GATEWAY_ROUTE_PREFIX } from "@t3tools/contracts";
import * as Option from "effect/Option";

export * from "@t3tools/shared/advertisedEndpoint";

/** The `/__t3_gateway/:id` root of a peer reached through a LAN gateway, or "" for any other URL. */
export const gatewayPathPrefix = (url: URL): string => {
  const [, root, peer] = url.pathname.split("/");
  return `/${root}` === LAN_GATEWAY_ROUTE_PREFIX && peer ? `/${root}/${peer}` : "";
};

export const environmentEndpointUrl = (httpBaseUrl: string, pathname: string): string => {
  const next = new URL(httpBaseUrl);
  next.pathname = `${gatewayPathPrefix(next)}${pathname}`;
  next.search = "";
  next.hash = "";
  return next.toString();
};

export const withGatewayTicket = (url: string, ticket: Option.Option<string>): string => {
  if (Option.isNone(ticket)) return url;
  const next = new URL(url);
  next.searchParams.set("gatewayTicket", ticket.value);
  return next.toString();
};
