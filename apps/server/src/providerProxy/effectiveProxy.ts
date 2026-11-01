import { providerProxyHost, type ServerSettings } from "@t3tools/contracts";
import {
  normalizeProviderProxyUrl,
  type ProviderProxyRoute,
} from "@t3tools/provider-core/server/providerProxy";

/** The loopback CLIProxyAPI this environment runs; its keys live in the secret store. */
export interface ManagedProxyEndpoint {
  readonly url: string;
  readonly apiKey: string;
  readonly managementKey: string;
}

export interface ProxyManagementEndpoint {
  readonly url: string;
  readonly managementKey: string;
}

/** Where `useProxy` instances send model traffic, or `undefined` when there is no proxy. */
export function resolveProviderProxyRoute(
  settings: ServerSettings,
  managed: ManagedProxyEndpoint | undefined,
): ProviderProxyRoute | undefined {
  switch (providerProxyHost(settings.providerProxy)) {
    case "off":
      return undefined;
    case "managed":
      return managed === undefined ? undefined : { url: managed.url, apiKey: managed.apiKey };
    case "external": {
      const url = normalizeProviderProxyUrl(settings.providerProxy.url);
      return url === "" ? undefined : { url, apiKey: settings.providerProxy.apiKey };
    }
  }
}

/** The proxy whose management API this environment may call: accounts and usage limits. */
export function resolveProxyManagement(
  settings: ServerSettings,
  managed: ManagedProxyEndpoint | undefined,
): ProxyManagementEndpoint | undefined {
  switch (providerProxyHost(settings.providerProxy)) {
    case "off":
      return undefined;
    case "managed":
      return managed === undefined
        ? undefined
        : { url: managed.url, managementKey: managed.managementKey };
    case "external": {
      const url = normalizeProviderProxyUrl(settings.providerProxy.url);
      const { managementKey } = settings.providerProxy;
      return url === "" || managementKey === "" ? undefined : { url, managementKey };
    }
  }
}
