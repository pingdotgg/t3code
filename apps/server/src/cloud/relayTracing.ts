import {
  nodeProcessRuntimeAttributes,
  processServiceInstanceId,
} from "@t3tools/shared/observability";
import * as RelayTracing from "@t3tools/shared/relayTracing";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import { resolveRelayClientTracingConfig } from "./publicConfig.ts";

/**
 * Relay traces leave the machine for T3 Connect, so a policy with `telemetry: false` stops them.
 * Without `tracingConfig`, the environment and the telemetry setting read at startup decide.
 */
export const relayLayer = (
  resource: Omit<RelayTracing.RelayClientTracingResource, "serviceInstanceId">,
  tracingConfig?: ReturnType<typeof resolveRelayClientTracingConfig>,
) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const policy = yield* ManagedPolicy.ManagedPolicy;
      return RelayTracing.layer(
        ManagedPolicy.deniedBy(policy, "telemetry") === undefined
          ? tracingConfig === undefined
            ? resolveRelayClientTracingConfig(
                process.env,
                undefined,
                config.telemetryEnabledInSettings,
              )
            : tracingConfig
          : null,
        {
          ...resource,
          serviceInstanceId: processServiceInstanceId(config.otelEnvironment.resourceAttributes),
        },
      );
    }),
  );

export const layerHeadlessRelayClient = relayLayer({
  serviceName: "t3code-server",
  runtime: "node",
  attributes: nodeProcessRuntimeAttributes(),
  client: "headless-cli",
});

export const layerServerRelayBroker = relayLayer({
  serviceName: "t3code-server",
  runtime: "node",
  attributes: nodeProcessRuntimeAttributes(),
  client: "environment-server",
  component: "relay-broker",
});
