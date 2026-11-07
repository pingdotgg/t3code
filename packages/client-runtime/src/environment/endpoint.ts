export * from "@t3tools/shared/advertisedEndpoint";

/** Keeps the LAN-gateway hop ticket across path rewrites for proxied peer requests. */
const retainGatewayTicket = (from: URL, to: URL) => {
  const gatewayTicket = from.searchParams.get("gatewayTicket");
  if (gatewayTicket !== null && gatewayTicket.length > 0) {
    to.searchParams.set("gatewayTicket", gatewayTicket);
  }
};

export const environmentEndpointUrl = (httpBaseUrl: string, pathname: string): string => {
  const url = new URL(httpBaseUrl);
  const next = new URL(httpBaseUrl);
  next.pathname = pathname;
  next.search = "";
  next.hash = "";
  retainGatewayTicket(url, next);
  return next.toString();
};

export const appendGatewayTicket = (url: string, ticket: string): string => {
  const next = new URL(url);
  next.searchParams.set("gatewayTicket", ticket);
  return next.toString();
};
