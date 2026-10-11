import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

/** Provider cloud environments on a host: listing, repositories, configurations, and changes. */
export function createCloudEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    list: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:providers:cloud-environments",
      tag: WS_METHODS.providerListCloudEnvironments,
      staleTimeMs: 30_000,
      idleTtlMs: 5 * 60_000,
    }),
    repositories: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:providers:cloud-repositories",
      tag: WS_METHODS.providerListCloudRepositories,
      staleTimeMs: 60_000,
      idleTtlMs: 5 * 60_000,
    }),
    configuration: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:providers:cloud-configuration",
      tag: WS_METHODS.providerReadCloudConfiguration,
      staleTimeMs: 5_000,
      idleTtlMs: 5 * 60_000,
    }),
    mutate: createEnvironmentRpcCommand(runtime, {
      label: "cloud environment",
      tag: WS_METHODS.providerMutateCloudEnvironment,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => `${environmentId}:${input.instanceId}`,
      },
    }),
  };
}
