import { ORCHESTRATION_V2_WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

export function createOrchestrationEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    v2: {
      dispatchCommand: createEnvironmentRpcCommand(runtime, {
        label: "environment-data:orchestration-v2:dispatch-command",
        tag: ORCHESTRATION_V2_WS_METHODS.dispatchCommand,
      }),
      listAllThreadRefs: createEnvironmentRpcCommand(runtime, {
        label: "environment-data:orchestration-v2:list-all-thread-refs",
        tag: ORCHESTRATION_V2_WS_METHODS.listAllThreadRefs,
      }),
      threadProjection: createEnvironmentRpcQueryAtomFamily(runtime, {
        label: "environment-data:orchestration-v2:thread-projection",
        tag: ORCHESTRATION_V2_WS_METHODS.getThreadProjection,
        staleTimeMs: 0,
        idleTtlMs: 0,
      }),
      shell: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
        label: "environment-data:orchestration-v2:shell",
        tag: ORCHESTRATION_V2_WS_METHODS.subscribeShell,
      }),
      thread: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
        label: "environment-data:orchestration-v2:thread",
        tag: ORCHESTRATION_V2_WS_METHODS.subscribeThread,
        idleTtlMs: 0,
      }),
    },
    turnDiff: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:turn-diff",
      tag: ORCHESTRATION_V2_WS_METHODS.getTurnDiff,
    }),
    workflowScript: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:workflow-script",
      tag: ORCHESTRATION_V2_WS_METHODS.getWorkflowScript,
      // Scripts are immutable per run: cache generously.
      staleTimeMs: 300_000,
      idleTtlMs: 300_000,
    }),
    fullThreadDiff: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:full-thread-diff",
      tag: ORCHESTRATION_V2_WS_METHODS.getFullThreadDiff,
    }),
    threadSearch: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:thread-search",
      tag: ORCHESTRATION_V2_WS_METHODS.searchThreads,
      staleTimeMs: 30_000,
      idleTtlMs: 60_000,
    }),
    archivedShellSnapshot: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:archived-shell-snapshot",
      tag: ORCHESTRATION_V2_WS_METHODS.getArchivedShellSnapshot,
    }),
  };
}
