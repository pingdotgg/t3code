export * from "@t3tools/shared/advertisedEndpoint";

export const environmentEndpointUrl = (httpBaseUrl: string, pathname: string): string => {
  const url = new URL(httpBaseUrl);
  url.pathname = url.pathname.replace(/\/+$/, "") + "/" + pathname.replace(/^\/+/, "");
  url.search = "";
  url.hash = "";
  return url.toString();
};
