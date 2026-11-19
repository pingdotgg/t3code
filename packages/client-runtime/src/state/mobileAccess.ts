import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

/** Phone connections the host refused recently, and why. */
export function createMobileAccessEnvironmentAtoms<R, E>(runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>) {
  return {
    status: createEnvironmentRpcQueryAtomFamily(runtime, { label: "environment-data:mobile-access:status", tag: WS_METHODS.mobileAccessStatus, staleTimeMs: 5_000 }),
  };
}
