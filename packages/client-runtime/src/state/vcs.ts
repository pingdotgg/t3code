// @ts-nocheck
import { type VcsStatusResult, WS_METHODS } from "@t3tools/contracts";
import { applyVcsStatusStreamEvent } from "@t3tools/shared/git";
import * as Stream from "effect/Stream";
import { Atom } from "effect/unstable/reactivity";

import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentSubscriptionAtomFamily,
} from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { subscribe, type EnvironmentRpcInput } from "../rpc/client.ts";
import { vcsCommandConcurrency, vcsCommandScheduler } from "./vcsCommandScheduler.ts";

export function createVcsEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    listRefs: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:vcs:list-refs",
      tag: WS_METHODS.vcsListRefs,
      staleTimeMs: 5_000,
    }),
    status: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: "environment-data:vcs:status",
      subscribe: (input: EnvironmentRpcInput<typeof WS_METHODS.subscribeVcsStatus>) =>
        subscribe(WS_METHODS.subscribeVcsStatus, input).pipe(
          Stream.mapAccum(
            () => null as VcsStatusResult | null,
            (current, event) => {
              const next = applyVcsStatusStreamEvent(current, event);
              return [next, [next]] as const;
            },
          ),
        ),
    }),
    pull: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vcs:pull",
      tag: WS_METHODS.vcsPull,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
    }),
    refreshStatus: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vcs:refresh-status",
      tag: WS_METHODS.vcsRefreshStatus,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
    }),
    createWorktree: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vcs:create-worktree",
      tag: WS_METHODS.vcsCreateWorktree,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
    }),
    removeWorktree: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vcs:remove-worktree",
      tag: WS_METHODS.vcsRemoveWorktree,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
    }),
    createRef: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vcs:create-ref",
      tag: WS_METHODS.vcsCreateRef,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
    }),
    switchRef: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vcs:switch-ref",
      tag: WS_METHODS.vcsSwitchRef,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
    }),
    init: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vcs:init",
      tag: WS_METHODS.vcsInit,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
    }),
  };
}

export * from "./gitActions.ts";
export * from "./vcsAction.ts";
export * from "./vcsRef.ts";
export * from "./vcsStatus.ts";
