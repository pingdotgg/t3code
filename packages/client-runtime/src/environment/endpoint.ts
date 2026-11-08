export * from "@t3tools/shared/advertisedEndpoint";

export const environmentEndpointUrl = (httpBaseUrl: string, pathname: string): string => {
  const url = new URL(httpBaseUrl);
  const endpoint = new URL(pathname, "http://endpoint.invalid/");
  url.pathname = `${url.pathname.replace(/\/+$/, "")}${endpoint.pathname}`;
  url.search = endpoint.search;
  url.hash = endpoint.hash;
  return url.toString();
};
