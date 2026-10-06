import { makeRelayClientTracingLayer } from "@t3tools/shared/relayTracing";

import { resolveRelayClientTracingConfig } from "./publicConfig.ts";

const relayClientTracingConfig = resolveRelayClientTracingConfig();

export const layerHeadlessRelayClient = makeRelayClientTracingLayer(relayClientTracingConfig, {
  serviceName: "t3code-server",
  runtime: "node",
  client: "headless-cli",
});

export const layerServerRelayBroker = makeRelayClientTracingLayer(relayClientTracingConfig, {
  serviceName: "t3code-server",
  runtime: "node",
  client: "environment-server",
  component: "relay-broker",
});
