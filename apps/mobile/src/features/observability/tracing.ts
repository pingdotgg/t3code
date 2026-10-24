import Constants from "expo-constants";
import type { ReleaseChannel } from "@t3tools/shared/releaseResource";
import * as RelayTracing from "@t3tools/shared/relayTracing";

import { hasTracingPublicConfig, resolveCloudPublicConfig } from "../cloud/publicConfig";

export interface TracingConfig {
  readonly tracesUrl: string;
  readonly tracesDataset: string;
  readonly tracesToken: string;
}

export interface TracingResource {
  readonly serviceVersion?: string;
  readonly appVariant: string;
}

const RELEASE_IDENTITY_BY_VARIANT: Readonly<
  Record<string, { readonly environment: string; readonly channel: ReleaseChannel }>
> = {
  development: { environment: "development", channel: "dev" },
  preview: { environment: "staging", channel: "preview" },
  production: { environment: "production", channel: "stable" },
};

export function resolveTracingConfig(): TracingConfig | null {
  const config = resolveCloudPublicConfig();
  if (!hasTracingPublicConfig(config)) {
    return null;
  }
  const { tracesUrl, tracesDataset, tracesToken } = config.observability;
  return { tracesUrl, tracesDataset, tracesToken };
}

export function layerFromConfig(config: TracingConfig | null, resource: TracingResource) {
  const releaseIdentity = Object.hasOwn(RELEASE_IDENTITY_BY_VARIANT, resource.appVariant)
    ? RELEASE_IDENTITY_BY_VARIANT[resource.appVariant]
    : undefined;
  return RelayTracing.layer(config, {
    serviceName: "t3code-mobile",
    serviceVersion: resource.serviceVersion,
    runtime: "react-native",
    client: `mobile-${resource.appVariant}`,
    attributes: releaseIdentity && {
      "deployment.environment.name": releaseIdentity.environment,
      "t3code.release.channel": releaseIdentity.channel,
    },
  });
}

export const layer = layerFromConfig(resolveTracingConfig(), {
  serviceVersion: Constants.expoConfig?.version,
  appVariant:
    typeof Constants.expoConfig?.extra?.appVariant === "string"
      ? Constants.expoConfig.extra.appVariant
      : "unknown",
});
