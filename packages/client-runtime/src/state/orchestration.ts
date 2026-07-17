import { ORCHESTRATION_WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

export function createOrchestrationEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const workspaceRestoreScheduler = createAtomCommandScheduler();

  return {
    turnDiff: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:turn-diff",
      tag: ORCHESTRATION_WS_METHODS.getTurnDiff,
    }),
    fullThreadDiff: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:full-thread-diff",
      tag: ORCHESTRATION_WS_METHODS.getFullThreadDiff,
    }),
    restoreWorkspaceCheckpoint: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:orchestration:restore-workspace-checkpoint",
      tag: ORCHESTRATION_WS_METHODS.restoreWorkspaceCheckpoint,
      scheduler: workspaceRestoreScheduler,
      concurrency: {
        mode: "singleFlight",
        // Include full input so file-scoped restores are not coalesced with each
        // other (or with a full-thread restore) for the same environment/thread.
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input]),
      },
    }),
    archivedShellSnapshot: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:archived-shell-snapshot",
      tag: ORCHESTRATION_WS_METHODS.getArchivedShellSnapshot,
    }),
  };
}
