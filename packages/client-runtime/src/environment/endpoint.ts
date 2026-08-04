export * from "@t3tools/shared/advertisedEndpoint";

export const environmentEndpointUrl = (httpBaseUrl: string, pathname: string): string => {
  const url = new URL(httpBaseUrl);
  const basePath = url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`;
  url.pathname = `${basePath}${pathname.replace(/^\/+/, "")}`;
  url.search = "";
  url.hash = "";
  return url.toString();
};

export const environmentWebSocketUrl = (wsBaseUrl: string): URL => {
  const url = new URL(wsBaseUrl);
  const basePath = url.pathname.replace(/\/+$/, "");
  url.pathname = basePath === "/ws" || basePath.endsWith("/ws") ? basePath : `${basePath}/ws`;
  url.search = "";
  url.hash = "";
  return url;
};
