import { environmentServerUrl } from "@t3tools/shared/advertisedEndpoint";

export * from "@t3tools/shared/advertisedEndpoint";

export const environmentEndpointUrl = (httpBaseUrl: string, pathname: string): string =>
  environmentServerUrl(httpBaseUrl, pathname).toString();
