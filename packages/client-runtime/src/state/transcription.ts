import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand } from "./runtime.ts";

export function createTranscriptionEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    createUrl: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:transcription:create-url",
      tag: WS_METHODS.transcriptionCreateUrl,
    }),
  };
}

export type TranscriptionEnvironmentAtoms = ReturnType<typeof createTranscriptionEnvironmentAtoms>;
