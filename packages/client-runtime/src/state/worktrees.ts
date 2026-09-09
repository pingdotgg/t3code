import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";
import { vcsCommandScheduler, worktreeCommandConcurrency } from "./vcsCommandScheduler.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

export function createWorktreeEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    list: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:vcs:worktrees",
      tag: WS_METHODS.vcsListWorktrees,
      staleTimeMs: 15_000,
    }),
    changes: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:vcs:worktrees:changes",
      tag: WS_METHODS.subscribeWorktreeInventory,
    }),
    prune: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vcs:worktrees:prune",
      tag: WS_METHODS.vcsPruneWorktrees,
      scheduler: vcsCommandScheduler,
      concurrency: worktreeCommandConcurrency,
    }),
  };
}
