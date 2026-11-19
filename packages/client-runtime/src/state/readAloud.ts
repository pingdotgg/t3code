import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

/** Read aloud with the host machine's speech engine. */
export function createReadAloudEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    status: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:read-aloud:status",
      tag: WS_METHODS.readAloudStatus,
      staleTimeMs: 60_000,
    }),
    speak: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:read-aloud:speak",
      tag: WS_METHODS.readAloudSpeak,
    }),
    stop: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:read-aloud:stop",
      tag: WS_METHODS.readAloudStop,
    }),
  };
}
