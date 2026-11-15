import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

/** Project Memory Vaults on the chosen environment. */
export function createMemoryVaultEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    overview: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:memory-vaults:overview",
      tag: WS_METHODS.memoryVaultsOverview,
      staleTimeMs: 5_000,
    }),
    updateSettings: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:memory-vaults:update-settings",
      tag: WS_METHODS.memoryVaultsUpdateSettings,
    }),
    manage: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:memory-vaults:manage",
      tag: WS_METHODS.memoryVaultsManage,
    }),
    readFile: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:memory-vaults:read-file",
      tag: WS_METHODS.memoryVaultsReadFile,
    }),
    writeFile: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:memory-vaults:write-file",
      tag: WS_METHODS.memoryVaultsWriteFile,
    }),
    search: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:memory-vaults:search",
      tag: WS_METHODS.memoryVaultsSearch,
    }),
    select: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:memory-vaults:select",
      tag: WS_METHODS.memoryVaultsSelect,
    }),
  };
}
