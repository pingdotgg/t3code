import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcSubscriptionAtomFamily } from "./runtime.ts";

export function createCuaEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    /** Live frames of the window the agent is driving; the loop only runs while subscribed. */
    windowPreview: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:cua:window-preview",
      tag: WS_METHODS.subscribeCuaWindowPreview,
      idleTtlMs: 1_000,
    }),
  };
}
