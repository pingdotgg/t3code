import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export function createElectronicsEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    state: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:electronics:state",
      tag: WS_METHODS.subscribeElectronicsState,
    }),
    listFiles: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:electronics:list-files",
      tag: WS_METHODS.electronicsListFiles,
    }),
    inspect: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:electronics:inspect",
      tag: WS_METHODS.electronicsInspect,
    }),
    tracePath: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:electronics:trace-path",
      tag: WS_METHODS.electronicsTracePath,
    }),
    validate: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:electronics:validate",
      tag: WS_METHODS.electronicsValidate,
    }),
    simulate: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:electronics:simulate",
      tag: WS_METHODS.electronicsSimulate,
    }),
    toolchainStatus: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:electronics:toolchain-status",
      tag: WS_METHODS.electronicsToolchainStatus,
    }),
    openPanel: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:electronics:open-panel",
      tag: WS_METHODS.electronicsOpenPanel,
    }),
    closePanel: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:electronics:close-panel",
      tag: WS_METHODS.electronicsClosePanel,
    }),
  };
}
