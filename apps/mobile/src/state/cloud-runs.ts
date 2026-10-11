import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

export const providerCloudEnvironments = createEnvironmentRpcQueryAtomFamily(
  connectionAtomRuntime,
  {
    label: "environment-data:providers:cloud-environments",
    tag: WS_METHODS.providerListCloudEnvironments,
    staleTimeMs: 30_000,
    idleTtlMs: 5 * 60_000,
  },
);

export const providerCloudRepositories = createEnvironmentRpcQueryAtomFamily(
  connectionAtomRuntime,
  {
    label: "environment-data:providers:cloud-repositories",
    tag: WS_METHODS.providerListCloudRepositories,
    staleTimeMs: 60_000,
    idleTtlMs: 5 * 60_000,
  },
);
export const providerCloudConfiguration = createEnvironmentRpcQueryAtomFamily(
  connectionAtomRuntime,
  {
    label: "environment-data:providers:cloud-configuration",
    tag: WS_METHODS.providerReadCloudConfiguration,
    staleTimeMs: 5_000,
    idleTtlMs: 5 * 60_000,
  },
);
export const mutateCloudEnvironment = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "cloud environment",
  tag: WS_METHODS.providerMutateCloudEnvironment,
  concurrency: {
    mode: "singleFlight",
    key: ({ environmentId, input }) => `${environmentId}:${input.instanceId}`,
  },
});
