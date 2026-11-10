import { resolveEnvironmentUrl } from "@t3tools/shared/advertisedEndpoint";

export * from "@t3tools/shared/advertisedEndpoint";

export const environmentEndpointUrl = (httpBaseUrl: string, pathname: string): string => {
  const url = resolveEnvironmentUrl(httpBaseUrl, pathname);
  url.search = "";
  url.hash = "";
  return url.toString();
};
