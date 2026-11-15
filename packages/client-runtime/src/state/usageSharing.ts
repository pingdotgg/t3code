import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

/** AI Usage Sharing on the chosen environment: the owner's codes and this machine's redeemed ones. */
export function createUsageSharingEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    overview: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:usage-sharing:overview",
      tag: WS_METHODS.usageSharingOverview,
      staleTimeMs: 5_000,
    }),
    setSource: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:usage-sharing:set-source",
      tag: WS_METHODS.usageSharingSetSource,
    }),
    setEndpoint: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:usage-sharing:set-endpoint",
      tag: WS_METHODS.usageSharingSetEndpoint,
    }),
    createGrant: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:usage-sharing:create-grant",
      tag: WS_METHODS.usageSharingCreateGrant,
    }),
    updateGrant: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:usage-sharing:update-grant",
      tag: WS_METHODS.usageSharingUpdateGrant,
    }),
    revokeGrant: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:usage-sharing:revoke-grant",
      tag: WS_METHODS.usageSharingRevokeGrant,
    }),
    rotateGrant: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:usage-sharing:rotate-grant",
      tag: WS_METHODS.usageSharingRotateGrant,
    }),
    redeem: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:usage-sharing:redeem",
      tag: WS_METHODS.usageSharingRedeem,
    }),
    refreshConnection: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:usage-sharing:refresh-connection",
      tag: WS_METHODS.usageSharingRefreshConnection,
    }),
    removeConnection: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:usage-sharing:remove-connection",
      tag: WS_METHODS.usageSharingRemoveConnection,
    }),
  };
}
