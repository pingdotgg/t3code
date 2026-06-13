import Constants from "expo-constants";
import * as Layer from "effect/Layer";
import type { HttpClient } from "effect/unstable/http";
import { OtlpSerialization, OtlpTracer } from "effect/unstable/observability";

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
): Layer.Layer<never, never, HttpClient.HttpClient> {
  if (config === null) {
    return Layer.empty;
  }

  return OtlpTracer.layer({
    url: config.tracesUrl,
    headers: {
      Authorization: `Bearer ${config.tracesToken}`,
      "X-Axiom-Dataset": config.tracesDataset,
    },
    resource: {
      serviceName: "t3-mobile",
      serviceVersion: resource.serviceVersion,
      attributes: {
        "service.runtime": "react-native",
        "service.component": "mobile",
        "deployment.environment.name": resource.appVariant,
      },
    },
  }).pipe(Layer.provide(OtlpSerialization.layerJson));
}

export const mobileTracingLayer = makeMobileTracingLayer(resolveMobileTracingConfig(), {
  serviceVersion: Constants.expoConfig?.version,
  appVariant:
    typeof Constants.expoConfig?.extra?.appVariant === "string"
      ? Constants.expoConfig.extra.appVariant
      : "unknown",
});
