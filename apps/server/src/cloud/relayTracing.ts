import { makeRelayClientTracingLayer } from "@t3tools/shared/relayTracing";

import { resolveRelayClientTracingConfig } from "./publicConfig.ts";

const relayClientTracingConfig = resolveRelayClientTracingConfig();

export const headlessRelayClientTracingLayer = makeRelayClientTracingLayer(
  relayClientTracingConfig,
  {
    serviceName: "t3-headless-relay-client",
    runtime: "node",
    client: "headless-cli",
  },
);

export const serverRelayBrokerTracingLayer = makeRelayClientTracingLayer(relayClientTracingConfig, {
  serviceName: "t3-server",
  runtime: "node",
  client: "environment-server",
  component: "relay-broker",
});
