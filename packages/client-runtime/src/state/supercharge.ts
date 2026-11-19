import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

/** A thread's Supercharge preset, limits, and current run. */
export function createSuperchargeEnvironmentAtoms<R, E>(runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>) {
  return {
    state: createEnvironmentRpcQueryAtomFamily(runtime, { label: "environment-data:supercharge:state", tag: WS_METHODS.superchargeGet, staleTimeMs: 2_000 }),
    configure: createEnvironmentRpcCommand(runtime, { label: "environment-data:supercharge:configure", tag: WS_METHODS.superchargeConfigure }),
    stop: createEnvironmentRpcCommand(runtime, { label: "environment-data:supercharge:stop", tag: WS_METHODS.superchargeStop }),
  };
}
