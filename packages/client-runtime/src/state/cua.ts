import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcSubscriptionAtomFamily,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";

export function createCuaEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    applications: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:cua:applications",
      tag: WS_METHODS.serverListApplications,
      staleTimeMs: 30_000,
      idleTtlMs: 30_000,
    }),
    /** Live frames of the window the agent is driving; the server captures only while subscribed. */
    windowPreview: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:cua:window-preview",
      tag: WS_METHODS.subscribeCuaWindowPreview,
      idleTtlMs: 1_000,
    }),
  };
}
