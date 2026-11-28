import {
  nodeProcessRuntimeAttributes,
  processServiceInstanceId,
} from "@t3tools/shared/observability";
import * as RelayTracing from "@t3tools/shared/relayTracing";

/** This fork never exports relay traces. */
export const allowedFor = (_env: Readonly<Record<string, string | undefined>>, _policy: unknown) =>
  false;

export const relayLayer = (
  resource: Omit<RelayTracing.RelayClientTracingResource, "serviceInstanceId">,
) =>
  RelayTracing.layer(
    null,
    // Never the operator's own `service.instance.id`: it names their machine for their receiver.
    { ...resource, serviceInstanceId: processServiceInstanceId() },
    { isEnabled: () => false },
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
