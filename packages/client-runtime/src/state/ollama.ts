import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcStreamCommand,
} from "./runtime.ts";

/** Local models through Ollama on the chosen environment. */
export function createOllamaEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    overview: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:ollama:overview",
      tag: WS_METHODS.ollamaGetOverview,
      staleTimeMs: 10_000,
    }),
    start: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:ollama:start",
      tag: WS_METHODS.ollamaStart,
    }),
    deleteModel: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:ollama:delete-model",
      tag: WS_METHODS.ollamaDeleteModel,
    }),
    setAgentIntegration: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:ollama:set-agent-integration",
      tag: WS_METHODS.ollamaSetAgentIntegration,
    }),
    install: createEnvironmentRpcStreamCommand(runtime, {
      label: "environment-data:ollama:install",
      tag: WS_METHODS.ollamaInstall,
      concurrency: { mode: "singleFlight", key: ({ environmentId }) => environmentId },
    }),
    pull: createEnvironmentRpcStreamCommand(runtime, {
      label: "environment-data:ollama:pull",
      tag: WS_METHODS.ollamaPullModel,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => `${environmentId}:${input.input.model}`,
      },
    }),
  };
}
