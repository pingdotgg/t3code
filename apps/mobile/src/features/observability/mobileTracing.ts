import Constants from "expo-constants";
import { makeRelayClientTracingLayer } from "@t3tools/shared/relayTracing";

import { hasMobileTracingPublicConfig, resolveCloudPublicConfig } from "../cloud/publicConfig";

export interface MobileTracingConfig {
  readonly tracesUrl: string;
  readonly tracesDataset: string;
  readonly tracesToken: string;
}

export interface MobileTracingResource {
  readonly serviceVersion?: string;
  readonly appVariant: string;
}

export function resolveMobileTracingConfig(): MobileTracingConfig | null {
  const config = resolveCloudPublicConfig();
  if (!hasMobileTracingPublicConfig(config)) {
    return null;
  }
  const { tracesUrl, tracesDataset, tracesToken } = config.observability;
  return { tracesUrl, tracesDataset, tracesToken };
}

export function makeMobileTracingLayer(
  config: MobileTracingConfig | null,
  resource: MobileTracingResource,
) {
  return makeRelayClientTracingLayer(config, {
    serviceName: "t3-mobile-relay-client",
    serviceVersion: resource.serviceVersion,
    runtime: "react-native",
    client: `mobile-${resource.appVariant}`,
  });
}

export const mobileTracingLayer = makeMobileTracingLayer(resolveMobileTracingConfig(), {
  serviceVersion: Constants.expoConfig?.version,
  appVariant:
    typeof Constants.expoConfig?.extra?.appVariant === "string"
      ? Constants.expoConfig.extra.appVariant
      : "unknown",
});
