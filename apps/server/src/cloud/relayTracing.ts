import { nodeProcessRuntimeAttributes } from "@t3tools/shared/observability";
import * as RelayTracing from "@t3tools/shared/relayTracing";

import { resolveRelayClientTracingConfig } from "./publicConfig.ts";

const relayClientTracingConfig = resolveRelayClientTracingConfig();

export const layerHeadlessRelayClient = RelayTracing.layer(relayClientTracingConfig, {
  serviceName: "t3code-server",
  attributes: nodeProcessRuntimeAttributes(),
  client: "headless-cli",
});

export const layerServerRelayBroker = RelayTracing.layer(relayClientTracingConfig, {
  serviceName: "t3code-server",
  attributes: nodeProcessRuntimeAttributes(),
  client: "environment-server",
  component: "relay-broker",
});
