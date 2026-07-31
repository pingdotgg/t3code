import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";

/**
 * Environment-scoped queries and commands for adopting existing Codex
 * conversations. The history list is short-lived so reopening the dialog
 * naturally discovers sessions created in Codex since the previous visit.
 */
export function createCodexSessionEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const importScheduler = createAtomCommandScheduler();
  return {
    list: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:codex-sessions:list",
      tag: WS_METHODS.codexListSessions,
      staleTimeMs: 0,
      idleTtlMs: 0,
    }),
    import: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:codex-sessions:import",
      tag: WS_METHODS.codexImportSessions,
      scheduler: importScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.projectId, input.providerInstanceId]),
      },
    }),
  };
}
