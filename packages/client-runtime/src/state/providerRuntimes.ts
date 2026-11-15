import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

/** Automatic provider runtime updates on the chosen environment. */
export function createProviderRuntimeEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    status: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:provider-runtimes:status",
      tag: WS_METHODS.providerRuntimesStatus,
      staleTimeMs: 5_000,
    }),
    updateSettings: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:provider-runtimes:update-settings",
      tag: WS_METHODS.providerRuntimesUpdateSettings,
    }),
    checkNow: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:provider-runtimes:check-now",
      tag: WS_METHODS.providerRuntimesCheckNow,
    }),
    restore: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:provider-runtimes:restore",
      tag: WS_METHODS.providerRuntimesRestore,
    }),
  };
}
