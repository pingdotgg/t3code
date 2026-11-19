import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

/** `/improve` jobs for a thread. */
export function createImproveEnvironmentAtoms<R, E>(runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>) {
  return {
    jobs: createEnvironmentRpcQueryAtomFamily(runtime, { label: "environment-data:improve:jobs", tag: WS_METHODS.improveList, staleTimeMs: 2_000 }),
    start: createEnvironmentRpcCommand(runtime, { label: "environment-data:improve:start", tag: WS_METHODS.improveStart }),
    retry: createEnvironmentRpcCommand(runtime, { label: "environment-data:improve:retry", tag: WS_METHODS.improveRetry }),
    dismiss: createEnvironmentRpcCommand(runtime, { label: "environment-data:improve:dismiss", tag: WS_METHODS.improveDismiss }),
  };
}
