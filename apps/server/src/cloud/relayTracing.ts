import type { ManagedPolicySummary } from "@t3tools/contracts";
import {
  nodeProcessRuntimeAttributes,
  processServiceInstanceId,
} from "@t3tools/shared/observability";
import { isRelayTracingEnabled } from "@t3tools/shared/otelEnvironment";
import * as RelayTracing from "@t3tools/shared/relayTracing";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import { resolveRelayClientTracingConfig } from "./publicConfig.ts";

const relayClientTracingConfig = resolveRelayClientTracingConfig();

/** What clients are told: `false` once the environment or a managed policy opted out. */
export const allowedFor = (
  env: Readonly<Record<string, string | undefined>>,
  policy: ManagedPolicySummary | undefined,
) => policy?.limits?.telemetry !== false && isRelayTracingEnabled(env);

/** Relay traces leave the machine for T3 Connect, so a policy with `telemetry: false` stops them. */
export const relayLayer = (
  resource: Omit<RelayTracing.RelayClientTracingResource, "serviceInstanceId">,
  tracingConfig = relayClientTracingConfig,
) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const policy = yield* ManagedPolicy.ManagedPolicy;
      return RelayTracing.layer(
        ManagedPolicy.deniedBy(policy, "telemetry") === undefined ? tracingConfig : null,
        // Never the operator's own `service.instance.id`: it names their machine for their receiver.
        { ...resource, serviceInstanceId: processServiceInstanceId() },
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
